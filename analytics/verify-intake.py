#!/usr/bin/env python3
"""Do the analytic API's daily intake totals equal an independent sum read straight from the FHIR Observations?

  python3 analytics/verify-intake.py [identifier]        default identifier: poc-0001 (the synthetic patient)
                                                         use poc-real for your own Apple Health data

Needs the stack up (HAPI, the analytics API through the web relay) and idp/.env.local. Reads every nutrition Observation
of the patient from HAPI (category = the contract's `nutrition` domain), keeps the `final` ones, takes each entry's DAY
AS RECORDED (the date written in its own effectiveDateTime) and its nutrient from the contract, and sums with decimal
arithmetic. It then asks the API for the same days and compares: the same set of days, the same total and entry count
per day, the meals adding up to the day.

It shares no code with analytics/src. It PRINTS COUNTS AND A VERDICT ONLY, never an amount, a date or a meal, so it is
safe to run on real data (root CLAUDE.md: real data never appears in output that is shared). Exit 0 only if everything
agrees and nothing was left unreconciled.
"""
import importlib.util
import json
import os
import ssl
import sys
import urllib.parse
import urllib.request
from collections import defaultdict
from datetime import date, timedelta
from decimal import Decimal

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, ".."))
spec = importlib.util.spec_from_file_location("oidc", os.path.join(ROOT, "idp", "oidc.py"))
oidc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(oidc)

# The worker keeps each amount to a millionth of a unit (analytics/src/intake.ts: sums are exact in micro-units), and a
# value converted from another unit (kJ, oz) can have more digits than that, so a total may differ from the full-precision
# sum by up to half a micro-unit per entry. Anything larger is a real disagreement.
TOLERANCE_PER_ENTRY = Decimal("0.0000005")

CONTRACT = json.load(open(os.path.join(ROOT, "contract", "metrics.json")))
SYSTEMS = CONTRACT["systems"]
HOST = os.environ.get("POC_HOST", "macpro16.local")
FHIR = "https://%s:8443/fhir" % HOST
API = "https://%s:3000/analytics" % HOST
CTX = ssl.create_default_context(cafile=os.path.join(os.path.expanduser(os.environ.get("POC_TLS_DIR", "~/.poc-ca")), "ca.crt"))


def get(url, token):
    req = urllib.request.Request(url, headers={"Authorization": "Bearer " + token, "Accept": "application/json", "Cache-Control": "no-cache"})
    with urllib.request.urlopen(req, context=CTX, timeout=60) as r:
        return json.load(r)


def token(who):
    status, data = oidc.fetch_token(who)
    if status != 200 or "access_token" not in data:
        sys.exit("cannot get a %s token (HTTP %s)" % (who, status))
    return data["access_token"]


def nutrient_of(resource):
    """The contract nutrient id of an Observation's code, or None."""
    for coding in resource.get("code", {}).get("coding", []):
        for m in CONTRACT["metrics"]:
            if m.get("kind") != "intake":
                continue
            system = SYSTEMS[m["customCode"]["system"]] if "customCode" in m else SYSTEMS["loinc"]
            code = (m.get("customCode") or m["loinc"])["code"]
            if coding.get("system") == system and coding.get("code") == code:
                return m["id"], m["unit"]["ucum"]
    return None


def main():
    identifier = sys.argv[1] if len(sys.argv) > 1 else "poc-0001"
    cap = token("capture")
    clin = token("clinician")
    q = urllib.parse.urlencode({"identifier": "%s|%s" % (SYSTEMS["identifier"]["patient"], identifier), "_elements": "id"})
    found = get("%s/Patient?%s" % (FHIR, q), cap).get("entry", [])
    if len(found) != 1:
        sys.exit("expected exactly one Patient with identifier %s, found %d" % (identifier, len(found)))
    pid = found[0]["resource"]["id"]

    # --- the independent reading: raw Observations, day as recorded by string slice, decimal sums
    domain = "%s|%s" % (SYSTEMS["observationDomain"], "nutrition")
    url = "%s/Observation?%s" % (FHIR, urllib.parse.urlencode({"subject": "Patient/" + pid, "category": domain, "_count": "200"}))
    read = skipped = 0
    expect = defaultdict(lambda: [Decimal(0), 0])  # (nutrient, day) -> [total, entries]
    unit = {}
    while url:
        bundle = get(url, cap)
        for e in bundle.get("entry", []):
            r = e["resource"]
            read += 1
            hit = nutrient_of(r)
            when = r.get("effectiveDateTime") or r.get("effectivePeriod", {}).get("start")
            q = r.get("valueQuantity", {})
            if r.get("status") != "final" or not hit or not when or "value" not in q or Decimal(str(q["value"])) < 0:
                skipped += 1
                continue
            if q.get("code") != hit[1]:
                skipped += 1
                continue
            cell = expect[(hit[0], when[:10])]
            cell[0] += Decimal(str(q["value"]))
            cell[1] += 1
            unit[hit[0]] = hit[1]
        url = next((l["url"] for l in bundle.get("link", []) if l["relation"] == "next"), None)
        if url:
            url = url.replace("http://", "https://", 1) if url.startswith("http://") else url

    days = sorted({d for (_, d) in expect})
    print("patient %s: %d nutrition Observations read, %d not final or not summable, %d (nutrient, day) totals expected over %d days"
          % (identifier, read, skipped, len(expect), len(days)))
    if not expect:
        print("nothing to compare (no nutrition data for this patient): this is not a pass")
        return 1

    # --- what the API says, in chunks of at most 366 days
    served = {}
    pending = 0
    first, last = date.fromisoformat(days[0]), date.fromisoformat(days[-1])
    nutrients = sorted({n for (n, _) in expect})
    for nutrient in nutrients:
        start = first
        while start <= last:
            end = min(start + timedelta(days=365), last)
            body = get("%s/v1/patients/%s/nutrition?nutrient=%s&from=%s&to=%s" % (API, pid, nutrient, start, end), clin)
            pending += body["completeness"]["pendingWindows"]
            for d in body["days"]:
                served[(nutrient, d["day"])] = (Decimal(str(d["total"])), d["entries"], sum(Decimal(str(m["total"])) for m in d["byMeal"]), sum(m["entries"] for m in d["byMeal"]))
            start = end + timedelta(days=1)

    problems = defaultdict(int)
    worst = Decimal(0)  # the largest difference between a served total and the exact sum (a size only, never an amount)
    for key, (total, n) in expect.items():
        got = served.get(key)
        if got is None:
            problems["a day with entries has no served total"] += 1
        elif abs(got[0] - total) > TOLERANCE_PER_ENTRY * n:
            problems["total differs by more than rounding"] += 1
            worst = max(worst, abs(got[0] - total))
        elif got[1] == n:
            worst = max(worst, abs(got[0] - total))
        if got is not None and got[1] != n:
            problems["entry count differs"] += 1
    for key, got in served.items():
        if key not in expect:
            problems["a served day has no entries in HAPI"] += 1
        if abs(got[2] - got[0]) > TOLERANCE_PER_ENTRY * got[1] or got[3] != got[1]:
            problems["meals do not add up to the day"] += 1
    print("served %d totals over %d nutrients; windows still pending: %d" % (len(served), len(nutrients), pending))
    if pending:
        problems["windows still pending (rerun in a minute)"] += 1
    if problems:
        for why, count in sorted(problems.items()):
            print("MISMATCH: %s: %d" % (why, count))
        return 1
    print("ALL AGREE: %d totals equal the independent sum to within rounding (largest difference %s), meals add up to every day"
          % (len(expect), "{:.1e}".format(worst) if worst else "0"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
