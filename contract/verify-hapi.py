#!/usr/bin/env python3
"""Does the real HAPI (request validation ON) accept the exact JSON the mapper emits?  (needs the stack up)

Posts every golden Observation and Device (contract/golden/*.json, the shapes the Swift mapper must produce) to
HAPI with the synthetic capture user's token, by conditional create, and reports status and any validator messages.

What is changed from the fixtures, and why:
  - identifier.value gets the prefix "golden-" so these resources can never collide with the future synthetic
    stream (a conditional create on a clashing id would silently do nothing);
  - subject/device/patient references are pointed at the real seeded Patient and a real Device (HAPI enforces
    referential integrity on write, so "Patient/example-patient" would be refused for that reason, not for the shape).
Everything else is posted exactly as the generator wrote it. All data is synthetic. Rerunning is a no-op (conditional
create). The resources stay in HAPI (no role may delete); `make stack-reset` clears them.

  python3 contract/verify-hapi.py        exit 0 if HAPI accepted everything with no validator ERROR
"""
import importlib.util
import json
import os
import sys

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


def main():
    token = auth.token("capture")
    pid, status = auth.seed(token)
    if pid is None:
        sys.exit("cannot find or create the seeded Patient (HTTP %s)" % status)
    patient_ref = "Patient/" + pid

    failures = 0
    # 1. a real Device first, so Observation.device resolves
    device_id = None
    for case in load("devices.json"):
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
    for name in ("observations-quantity.json", "observations-sleep.json"):
        for case in load(name):
            if "expected" not in case:
                continue
            obs = json.loads(json.dumps(case["expected"]))
            obs["identifier"][0]["value"] = "golden-" + case["name"]
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
            print("%-52s HTTP %s %s" % (case["name"], st, note))
            count += 1
            if st not in (200, 201) or errors:
                failures += 1
    print()
    print("HAPI ACCEPTED all %d Observations and the Devices" % count if not failures else "HAPI REFUSED %d resource(s)" % failures)
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
