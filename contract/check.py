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
BUNDLED = os.path.join(ROOT, "ios", "HealthGate", "Resources", "metrics.json")
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


def intake_problems(m, c):
    """What is wrong with an intake metric's contract entry (nothing, for a good one). Pure, so the checker can be shown to
    accept a good entry and to refuse each kind of bad one."""
    out = []
    has_loinc, custom = m.get("loinc"), m.get("customCode")
    if bool(has_loinc) == bool(custom):
        out.append("needs exactly one of loinc and customCode")
    if custom and (custom.get("system") not in c["systems"] or not custom.get("code") or not custom.get("display")):
        out.append("customCode needs a system that exists in systems, a code and a display")
    if m.get("domain") not in c.get("domains", {}):
        out.append("domain is not defined")
    if m.get("zeroAllowed") is not True:
        out.append("an intake metric must allow zero (a food can contain none of a nutrient)")
    r = m.get("plausibleRange") or {}
    if not (isinstance(r.get("min"), (int, float)) and isinstance(r.get("max"), (int, float)) and r["min"] < r["max"]):
        out.append("plausibleRange needs min below max")
    elif m.get("zeroAllowed") and not (r["min"] <= 0 <= r["max"]):
        out.append("zero must lie inside plausibleRange")
    if m.get("category") is not None:
        out.append("an intake metric uses a domain, not an HL7 category")
    return out


def main():
    c = json.load(open(CONTRACT))

    # --- the checker itself: positive and negative controls
    known = ["8867-4", "40443-4", "112429-6", "93829-0", "93830-8", "93831-6", "93832-4", "103210-1"]
    check(all(loinc_valid(k) for k in known), "check-digit control: 8 codes verified in NLM Clinical Tables all pass",
          "check-digit algorithm rejects a verified code: the checker is broken")
    check(not loinc_valid("8867-5") and not loinc_valid("93831-7"), "check-digit control: mistyped codes are rejected",
          "check-digit algorithm accepts a wrong code: the checker is vacuous")

    good_intake = {"loinc": {"code": "9052-2", "display": "x"}, "domain": "nutrition", "zeroAllowed": True, "plausibleRange": {"min": 0, "max": 10}}
    check(intake_problems(good_intake, c) == [], "intake control: a good entry is accepted", "intake checker refuses a good entry: the checker is broken")
    for name, mutate, expected in [
        ("both loinc and customCode", lambda m: m.update(customCode={"system": "nutrient", "code": "a", "display": "b"}), "exactly one"),
        ("neither code", lambda m: m.pop("loinc"), "exactly one"),
        ("an unknown domain", lambda m: m.update(domain="nope"), "domain is not defined"),
        ("zero not allowed", lambda m: m.update(zeroAllowed=False), "must allow zero"),
        ("an inverted range", lambda m: m.update(plausibleRange={"min": 10, "max": 0}), "min below max"),
        ("a range that excludes zero", lambda m: m.update(plausibleRange={"min": 1, "max": 10}), "zero must lie"),
        ("an HL7 category", lambda m: m.update(category="vital-signs"), "domain, not an HL7 category"),
    ]:
        bad_entry = json.loads(json.dumps(good_intake))
        mutate(bad_entry)
        check(any(expected in p for p in intake_problems(bad_entry, c)), "intake control: %s is refused" % name,
              "intake checker accepts %s: the checker is vacuous" % name)

    # --- structure
    check(re.fullmatch(r"\d+\.\d+\.\d+", c.get("contractVersion", "")) is not None, "contractVersion is semver (%s)" % c.get("contractVersion"), "contractVersion missing or not semver")
    ids = [m["id"] for m in c["metrics"]]
    check(len(ids) == len(set(ids)), "metric ids are unique: " + ", ".join(ids), "duplicate metric ids")
    codes = []
    custom = []
    for m in c["metrics"]:
        if m["kind"] == "intake":
            problems = intake_problems(m, c)
            check(problems == [], "%s: intake entry is well formed" % m["id"], "%s: %s" % (m["id"], "; ".join(problems)))
        else:
            check(m["category"] in c["categories"], "%s: category %s is defined" % (m["id"], m["category"]), "%s: unknown category %s" % (m["id"], m["category"]))
        check(m["unit"]["display"] == m["unit"]["ucum"], "%s: unit display equals the UCUM code (%s)" % (m["id"], m["unit"]["ucum"]),
              "%s: unit display %r differs from UCUM code %r" % (m["id"], m["unit"]["display"], m["unit"]["ucum"]))
        check(m["unit"]["ucum"] != "beats/min", "%s: not the invalid UCUM 'beats/min'" % m["id"], "%s uses 'beats/min', which UCUM rejects" % m["id"])
        check(m.get("claimsProfile") is None, "%s: makes no meta.profile claim (spec: Conformance)" % m["id"], "%s claims a profile" % m["id"])
        if m["kind"] == "quantity":
            codes.append(m["loinc"]["code"])
        elif m["kind"] == "intake":
            if m.get("loinc"):
                codes.append(m["loinc"]["code"])
            else:
                custom.append((m["customCode"]["system"], m["customCode"]["code"]))
        else:
            check(set(m["stages"]).isdisjoint(m["unmapped"]), "sleep: a stage is mapped or unmapped, never both", "sleep: a stage is both mapped and unmapped")
            expected = {"asleepCore", "asleepDeep", "asleepREM", "asleepUnspecified", "awake", "inBed"}
            check(set(m["stages"]) | set(m["unmapped"]) == expected, "sleep: every HealthKit stage is accounted for", "sleep: stages do not cover the HealthKit set")
            codes.extend(s["code"] for s in m["stages"].values())
    check(len(codes) == len(set(codes)), "no LOINC code is used twice", "a LOINC code is used by two mappings")
    for code in codes:
        check(loinc_valid(code), "LOINC %s has a valid check digit" % code, "LOINC %s fails its check digit (typo?)" % code)
    check(len(custom) == len(set(custom)), "no custom code is used twice", "a custom code is used by two metrics")
    for system in ("observationDomain", "mealType", "nutrient"):
        check(c["systems"][system].startswith("http://aboutobjects.com/fhir/CodeSystem/"), "system %s is in the decided namespace" % system, "system %s is outside the namespace" % system)
    check(set(c["mealTypes"]) >= {"breakfast", "lunch", "dinner", "snack", "other"} and all(k == v["code"] for k, v in c["mealTypes"].items()),
          "meal types include breakfast, lunch, dinner, snack and other, each keyed by its code", "meal types are incomplete or mis-keyed")
    check(all(v in c["mealTypes"] and k == k.lower() for k, v in c["mealTypeAliases"].items()), "every meal-type alias is lowercase and points at a defined code",
          "a meal-type alias is not lowercase or points at an undefined code")
    for url in c["systems"]["identifier"].values():
        check(url.startswith("http://aboutobjects.com/fhir/identifier/"), "identifier system %s is in the decided namespace" % url.rsplit("/", 1)[-1], "identifier system outside the namespace: " + url)

    # --- M21: the HAPI retraction rule names the app's own sample-identifier systems; they must equal the contract's
    def retraction_systems(text):
        m = re.search(r"^\s*retraction-identifier-systems:\s*(\S+)\s*$", text, re.M)
        return set(m.group(1).split(",")) if m else None
    sample = {c["systems"]["identifier"]["synthetic"], c["systems"]["identifier"]["healthKit"]}
    check(retraction_systems("a:\n  retraction-identifier-systems: x,y\n") == {"x", "y"} and retraction_systems("nothing here") is None,
          "retraction control: the application.yaml parser reads a list and notices a missing key", "the retraction-systems parser is broken")
    yaml_path = os.path.join(ROOT, "hapi", "application.yaml")
    configured = retraction_systems(open(yaml_path).read())
    check(configured == sample, "hapi/application.yaml retraction-identifier-systems equals the contract's synthetic and healthKit sample systems",
          "hapi/application.yaml retraction-identifier-systems (%s) differs from the contract sample systems (%s)" % (configured, sample))
    check(retraction_systems(open(yaml_path).read().replace("healthkit-sample", "healthkit-samples")) != sample,
          "retraction control: a misspelt system in application.yaml would be caught", "the retraction-systems comparison cannot see a misspelt system")

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
