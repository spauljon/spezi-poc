#!/usr/bin/env python3
"""Does the real HAPI (request validation ON) accept the exact JSON the mapper emits?  (needs the stack up)

Posts every golden Observation and Device (contract/golden/*.json, the shapes the Swift mapper must produce) to
HAPI with the synthetic capture user's token, by conditional create, and reports status and any validator messages.

What is changed from the fixtures, and why:
  - identifier.value gets the prefix "golden-" so these resources can never collide with the future synthetic
    stream (a conditional create on a clashing id would silently do nothing);
  - subject/device/patient references are pointed at this script's OWN synthetic Patient (identifier poc-verify) and
    a real Device (HAPI enforces referential integrity on write, so "Patient/example-patient" would be refused for
    that reason, not for the shape). The own patient matters: the golden records include intervals on real dates
    (a sleep interval across the spring-forward night), and on the shared poc-0001 patient they overlapped the web
    live test's sleep fixture and showed up in every rollup and chart.
Everything else is posted exactly as the generator wrote it. All data is synthetic. Rerunning is a no-op (conditional
create). The resources stay in HAPI (no role may delete); `make stack-reset` clears them.

  python3 contract/verify-hapi.py        exit 0 if HAPI accepted everything with no validator ERROR
"""
import importlib.util
import json
import os
import sys
import urllib.parse

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, ".."))
spec = importlib.util.spec_from_file_location("hapiauth", os.path.join(ROOT, "hapi", "auth.py"))
auth = importlib.util.module_from_spec(spec)
spec.loader.exec_module(auth)


def load(name):
    return json.load(open(os.path.join(HERE, "golden", name)))["cases"]


def conditional_create(token, resource, base=auth.BASE):
    ident = resource["identifier"][0]
    cond = "identifier=%s|%s" % (ident["system"], ident["value"])
    status, text = auth.call("POST", base + "/" + resource["resourceType"], token, resource, {"If-None-Exist": cond})
    messages = []
    try:
        for issue in json.loads(text).get("issue", []):
            messages.append((issue.get("severity"), (issue.get("diagnostics") or "")[:150]))
    except ValueError:
        pass
    return status, messages


VERIFY_PATIENT = "poc-verify"


def verify_patient(token):
    """Find or create (conditional create) the Patient that holds only this script's golden resources."""
    ident = "%s|%s" % (auth.PATIENT_SYSTEM, VERIFY_PATIENT)
    resource = {"resourceType": "Patient", "identifier": [{"system": auth.PATIENT_SYSTEM, "value": VERIFY_PATIENT}]}
    status, text = auth.call("POST", auth.BASE + "/Patient", token, resource, {"If-None-Exist": "identifier=" + ident})
    if status not in (200, 201):
        return None, status
    if status == 201:
        return json.loads(text)["id"], status
    q = urllib.parse.urlencode({"identifier": ident, "_elements": "id"})
    st, t = auth.call("GET", auth.BASE + "/Patient?" + q, token)
    entries = json.loads(t).get("entry", []) if st == 200 else []
    return (entries[0]["resource"]["id"] if len(entries) == 1 else None), status


def main():
    token = auth.token("capture")
    pid, status = verify_patient(token)
    if pid is None:
        sys.exit("cannot find or create the verification Patient (HTTP %s)" % status)
    patient_ref = "Patient/" + pid

    failures = 0
    # 1. a real Device first, so Observation.device resolves
    device_id = None
    for case in load("devices.json") + load("healthconnect-devices.json"):
        if "expected" not in case:
            continue
        device = json.loads(json.dumps(case["expected"]))
        device["identifier"][0]["value"] = "golden-" + device["identifier"][0]["value"]
        device["patient"] = {"reference": patient_ref}
        st, msgs = conditional_create(token, device)
        errors = [m for m in msgs if m[0] in ("error", "fatal")]
        print("%-52s HTTP %s %s" % (case["name"], st, "ERRORS: %s" % errors if errors else ""))
        if st not in (200, 201) or errors:
            failures += 1
        elif device_id is None:
            q = auth.urllib.parse.urlencode({"identifier": "%s|%s" % (device["identifier"][0]["system"], device["identifier"][0]["value"]), "_elements": "id"})
            s2, t2 = auth.call("GET", auth.BASE + "/Device?" + q, token)
            entries = json.loads(t2).get("entry", []) if s2 == 200 else []
            device_id = entries[0]["resource"]["id"] if entries else None
    if device_id is None:
        sys.exit("no Device could be created or found")

    # 2. every Observation shape
    count = 0
    for name in ("observations-quantity.json", "observations-sleep.json", "healthconnect-observations.json"):
        for case in load(name):
            if "expected" not in case:
                continue
            # a HealthKit-shaped case has one Observation; a Health Connect case has a list (one per sample or nutrient)
            expected = case["expected"] if isinstance(case["expected"], list) else [case["expected"]]
            for index, resource in enumerate(expected):
                obs = json.loads(json.dumps(resource))
                obs["identifier"][0]["value"] = "golden-" + case["name"] + ("-%d" % index if len(expected) > 1 else "")
                obs["subject"] = {"reference": patient_ref}
                if "device" in obs:
                    obs["device"] = {"reference": "Device/" + device_id}
                st, msgs = conditional_create(token, obs)
                errors = [m for m in msgs if m[0] in ("error", "fatal")]
                warns = [m for m in msgs if m[0] == "warning"]
                note = ""
                if errors:
                    note = "ERRORS: %s" % errors
                elif warns:
                    note = "(%d warning: %s)" % (len(warns), warns[0][1][:70])
                print("%-52s HTTP %s %s" % ((case["name"] + ("[%d]" % index if len(expected) > 1 else ""))[:52], st, note))
                count += 1
                if st not in (200, 201) or errors:
                    failures += 1
    # 3. the searches the nutrition design relies on (brief assumption: HAPI answers a search on one of several `category`
    #    entries, on a custom code, and on a Device's second identifier). Each has a positive control below it.
    contract = json.load(open(os.path.join(HERE, "metrics.json")))
    systems = contract["systems"]
    intake = [c for c in load("observations-quantity.json") if c["sample"]["metric"] in {m["id"] for m in contract["metrics"] if m["kind"] == "intake"}]
    lunch = [c for c in intake if (c["sample"].get("meal") or {}).get("code") == "lunch"]
    custom = [c for c in intake if c["sample"]["metric"] == "dietaryFiber"]

    def total(query):
        # a literal "|" in a query string is rejected by the servlet container (HTTP 400): encode it, as a client must
        query = query.replace("|", "%7C")
        # no-cache: HAPI reuses an identical search's result for a while, so a search that follows a create must not be served
        # the answer from before it (the analytics client does the same)
        status, text = auth.call("GET", auth.BASE + "/" + query + ("&" if "?" in query else "?") + "_summary=count", token, None, {"Cache-Control": "no-cache"})
        return json.loads(text).get("total", -1) if status == 200 else -1

    def expect(label, got, at_least=None, exactly=None):
        nonlocal failures
        good = got >= at_least if at_least is not None else got == exactly
        print("%-52s %s %s" % (label, "ok  " if good else "FAIL", "found %d" % got))
        if not good:
            failures += 1

    domain = "%s|nutrition" % systems["observationDomain"]
    meal = "%s|lunch" % systems["mealType"]
    expect("search: category = the nutrition domain", total("Observation?category=" + domain), at_least=len(intake))
    expect("search: category = the lunch meal type", total("Observation?category=" + meal), at_least=len(lunch))
    expect("search: BOTH categories on one Observation", total("Observation?category=%s&category=%s" % (domain, meal)), at_least=len(lunch))
    expect("search: the custom nutrient code (fiber)", total("Observation?code=%s|fiber" % systems["nutrient"]), at_least=len(custom))
    expect("search: a LOINC-coded nutrient (energy)", total("Observation?code=%s|9052-2" % systems["loinc"]), at_least=1)
    expect("search: the source app by its bundle identifier", total("Device?identifier=%s|com.example.nutritionapp" % systems["identifier"]["appBundleId"]), at_least=1)
    # controls: the same queries with a value that does not exist find nothing, so a zero is a real zero
    expect("control: an unknown domain finds nothing", total("Observation?category=%s|no-such-domain" % systems["observationDomain"]), exactly=0)
    expect("control: an unknown meal type finds nothing", total("Observation?category=%s|no-such-meal" % systems["mealType"]), exactly=0)
    expect("control: an unknown bundle identifier finds nothing", total("Device?identifier=%s|com.example.nobody" % systems["identifier"]["appBundleId"]), exactly=0)
    # the domain system alone does not match a meal code: the two systems are not interchangeable
    expect("control: the meal code is not in the domain system", total("Observation?category=%s|lunch" % systems["observationDomain"]), exactly=0)

    # 4. the Health Connect lookups (contract 1.6.0): a record's Observations by the GROUP identifier, one Observation by its
    #    sample identity. A group value can hold '#', so values are percent-encoded as a client must.
    hc = [c for c in load("healthconnect-observations.json") if c.get("expected")]
    by_name = {c["name"]: c for c in hc}
    q = lambda system, value: "%s|%s" % (system, urllib.parse.quote(value, safe=""))
    group_sys, sample_sys = systems["identifier"]["healthConnectGroup"], systems["identifier"]["healthConnect"]
    three = by_name["hc-heart-rate-record-three-samples"]
    nutrition = by_name["hc-nutrition-zero-sodium-is-stored"]  # its content key is its own: no other case shares the group
    expect("search: a heart-rate record's Observations by group", total("Observation?identifier=" + q(group_sys, "rec-hr-0001")), exactly=len(three["expected"]))
    expect("search: a nutrition item's Observations by group (value has #)", total("Observation?identifier=" + q(group_sys, nutrition["nutritionGroup"])), exactly=len(nutrition["expected"]))
    expect("search: one Observation by its golden sample identity", total("Observation?identifier=" + q(sample_sys, "golden-hc-nutrition-zero-sodium-is-stored-0")), exactly=1)
    expect("control: an unknown group finds nothing", total("Observation?identifier=" + q(group_sys, "rec-no-such-record")), exactly=0)
    expect("control: a group value is not a sample identity", total("Observation?identifier=" + q(sample_sys, "rec-hr-0001")), exactly=0)
    expect("control: the systems are not interchangeable", total("Observation?identifier=" + q(group_sys, "golden-hc-nutrition-zero-sodium-is-stored-0")), exactly=0)
    expect("search: the source app Device by its package name", total("Device?identifier=%s|com.example.nutritionapp" % systems["identifier"]["appPackageName"]), at_least=1)
    expect("control: an unknown package name finds nothing", total("Device?identifier=%s|com.example.nobody" % systems["identifier"]["appPackageName"]), exactly=0)
    expect("search: hrvRmssd by its own code", total("Observation?code=%s|hrv-rmssd" % systems["metric"]), at_least=1)

    print()
    print("HAPI ACCEPTED all %d Observations and the Devices; the searches answered" % count if not failures else "HAPI REFUSED or MISANSWERED %d thing(s)" % failures)
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
