#!/usr/bin/env python3
"""Offline checks of the contract (no Xcode, no network). Exits 1 on any failure.

  - structure: version, unique ids, every referenced category exists, every sleep stage has a code or is unmapped
  - terminology shape: LOINC codes have a valid check digit (a typo detector; the codes themselves were verified
    against NLM Clinical Tables, recorded in metrics.json), UCUM display equals the UCUM code, no 'beats/min'
  - the iOS bundled copy is byte-identical to contract/metrics.json
  - the golden fixtures are exactly what the independent generator produces

Each refusal check has a positive control: the checker is first shown to accept known-good codes and reject a
mistyped one, so it cannot pass just because it is broken.
"""
import json
import os
import re
import subprocess
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
CONTRACT = os.path.join(ROOT, "contract", "metrics.json")
BUNDLED = os.path.join(ROOT, "ios", "TemplateApplication", "Resources", "metrics.json")
fails = []


def ok(msg):
    print("ok   - " + msg)


def bad(msg):
    print("FAIL - " + msg)
    fails.append(msg)


def check(cond, good, problem):
    ok(good) if cond else bad(problem)


def loinc_valid(code):
    """Luhn over the digits before the hyphen must equal the digit after it (validated against 10 known codes)."""
    m = re.fullmatch(r"(\d+)-(\d)", code)
    if not m:
        return False
    total = 0
    for i, c in enumerate(reversed(m.group(1))):
        n = int(c)
        if i % 2 == 0:
            n *= 2
            n = n - 9 if n > 9 else n
        total += n
    return (10 - total % 10) % 10 == int(m.group(2))


def main():
    c = json.load(open(CONTRACT))

    # --- the checker itself: positive and negative controls
    known = ["8867-4", "40443-4", "112429-6", "93829-0", "93830-8", "93831-6", "93832-4", "103210-1"]
    check(all(loinc_valid(k) for k in known), "check-digit control: 8 codes verified in NLM Clinical Tables all pass",
          "check-digit algorithm rejects a verified code: the checker is broken")
    check(not loinc_valid("8867-5") and not loinc_valid("93831-7"), "check-digit control: mistyped codes are rejected",
          "check-digit algorithm accepts a wrong code: the checker is vacuous")

    # --- structure
    check(re.fullmatch(r"\d+\.\d+\.\d+", c.get("contractVersion", "")) is not None, "contractVersion is semver (%s)" % c.get("contractVersion"), "contractVersion missing or not semver")
    ids = [m["id"] for m in c["metrics"]]
    check(len(ids) == len(set(ids)), "metric ids are unique: " + ", ".join(ids), "duplicate metric ids")
    codes = []
    for m in c["metrics"]:
        check(m["category"] in c["categories"], "%s: category %s is defined" % (m["id"], m["category"]), "%s: unknown category %s" % (m["id"], m["category"]))
        check(m["unit"]["display"] == m["unit"]["ucum"], "%s: unit display equals the UCUM code (%s)" % (m["id"], m["unit"]["ucum"]),
              "%s: unit display %r differs from UCUM code %r" % (m["id"], m["unit"]["display"], m["unit"]["ucum"]))
        check(m["unit"]["ucum"] != "beats/min", "%s: not the invalid UCUM 'beats/min'" % m["id"], "%s uses 'beats/min', which UCUM rejects" % m["id"])
        check(m.get("claimsProfile") is None, "%s: makes no meta.profile claim (spec: Conformance)" % m["id"], "%s claims a profile" % m["id"])
        if m["kind"] == "quantity":
            codes.append(m["loinc"]["code"])
        else:
            check(set(m["stages"]).isdisjoint(m["unmapped"]), "sleep: a stage is mapped or unmapped, never both", "sleep: a stage is both mapped and unmapped")
            expected = {"asleepCore", "asleepDeep", "asleepREM", "asleepUnspecified", "awake", "inBed"}
            check(set(m["stages"]) | set(m["unmapped"]) == expected, "sleep: every HealthKit stage is accounted for", "sleep: stages do not cover the HealthKit set")
            codes.extend(s["code"] for s in m["stages"].values())
    check(len(codes) == len(set(codes)), "no LOINC code is used twice", "a LOINC code is used by two mappings")
    for code in codes:
        check(loinc_valid(code), "LOINC %s has a valid check digit" % code, "LOINC %s fails its check digit (typo?)" % code)
    for url in c["systems"]["identifier"].values():
        check(url.startswith("http://blueysoft.com/fhir/identifier/"), "identifier system %s is in the decided namespace" % url.rsplit("/", 1)[-1], "identifier system outside the namespace: " + url)

    # --- the iOS bundled copy
    if os.path.exists(BUNDLED):
        check(open(BUNDLED, "rb").read() == open(CONTRACT, "rb").read(), "the iOS bundled copy is byte-identical to contract/metrics.json",
              "the iOS bundled copy DIFFERS from contract/metrics.json (run contract/sync.sh)")
    else:
        bad("the iOS bundled copy is missing (run contract/sync.sh)")

    # --- golden fixtures
    r = subprocess.run([sys.executable, os.path.join(ROOT, "contract", "golden", "generate.py"), "--check"], capture_output=True, text=True)
    check(r.returncode == 0, "golden fixtures match the independent generator", "golden fixtures are stale: " + (r.stdout + r.stderr).strip())

    print()
    print("CONTRACT CHECKS PASSED" if not fails else "CONTRACT CHECKS FAILED (%d)" % len(fails))
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
