#!/usr/bin/env python3
"""Generates the golden fixtures for the FHIR mapping (contract/golden/*.json).

This is a SECOND, INDEPENDENT implementation of the rules in contract/metrics.json: Python's own time-zone
database (zoneinfo), its own decimal arithmetic and its own SHA-256, nothing shared with the Swift mapper. The Swift
tests (ios/HealthGateTests/Metrics) check the mapper against these files, so a bug has to be made twice,
identically, to slip through. All data is synthetic.

  python3 contract/golden/generate.py            rewrite the fixtures
  python3 contract/golden/generate.py --check    fail if the committed fixtures differ from what this would write

Requires Python 3.9+ (zoneinfo). The fixtures are committed; running this is only needed when the contract changes.
"""
import hashlib
import json
import os
import sys
from datetime import datetime, timedelta, timezone
from decimal import ROUND_HALF_UP, Decimal
from zoneinfo import ZoneInfo

HERE = os.path.dirname(os.path.abspath(__file__))
CONTRACT = json.load(open(os.path.join(HERE, "..", "metrics.json")))
SYS = CONTRACT["systems"]
PATIENT = "example-patient"
SYN_DEVICE_REF = "Device/example-synthetic-device"
# The sample fields that become meta.tag entries (contract dataQualityFlags). userEntered is provenance; the other
# three are quality flags the capture app evaluates (contract rules.artifactSuspected / lateArrival / duplicateResolved).
FLAG_KEYS = ("userEntered", "artifactSuspected", "duplicateResolved", "lateArrival")


def utc(s):
    """'2026-01-15T16:30:05.250Z' -> aware UTC datetime."""
    return datetime.strptime(s, "%Y-%m-%dT%H:%M:%S.%fZ" if "." in s else "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)


def fmt(instant, tz, always_millis=False):
    """FHIR dateTime in the sample's own zone, offset at THAT instant, fraction only when non-zero (rules.effective)."""
    local = instant.astimezone(ZoneInfo(tz))
    seconds = int(local.utcoffset().total_seconds())
    sign = "+" if seconds >= 0 else "-"
    hours, minutes = divmod(abs(seconds) // 60, 60)
    ms = local.microsecond // 1000
    frac = ".%03d" % ms if (ms or always_millis) else ""
    return "%s%s%s%02d:%02d" % (local.strftime("%Y-%m-%dT%H:%M:%S"), frac, sign, hours, minutes)


def number(d):
    d = Decimal(d)
    return int(d) if d == d.to_integral_value() else float(d)


def metric(metric_id):
    return next(m for m in CONTRACT["metrics"] if m["id"] == metric_id)


def code_concept(m, coding=None):
    """Observation.code (contract rules.intakeCode): LOINC coding, else the custom coding with its display as text."""
    if coding is not None:
        return {"coding": [{"system": SYS["loinc"], "code": coding["code"], "display": coding["display"]}]}
    if m.get("loinc"):
        return {"coding": [{"system": SYS["loinc"], "code": m["loinc"]["code"], "display": m["loinc"]["display"]}]}
    custom = m["customCode"]
    return {"coding": [{"system": SYS[custom["system"]], "code": custom["code"]}], "text": custom["display"]}


def categories(m, sample):
    """Observation.category (contract rules.domain and rules.mealType): the domain is one entry, the meal a separate one."""
    if m["kind"] == "intake":
        domain = CONTRACT["domains"][m["domain"]]
        out = [{"coding": [{"system": SYS["observationDomain"], "code": domain["code"], "display": domain["display"]}]}]
        meal = sample.get("meal")
        if meal:
            out.append({"coding": [{"system": SYS["mealType"], "code": meal["code"]}], "text": meal["label"]})
        return out
    category = CONTRACT["categories"][m["category"]]
    return [{"coding": [{"system": SYS["observationCategory"], "code": category["code"], "display": category["display"]}]}]


def observation(m, sample, code_cc, value, unit, patient, device_ref):
    start, end = utc(sample["start"]), utc(sample["end"])
    tz = sample["timeZone"]
    o = {
        "resourceType": "Observation",
        "meta": {"source": SYS["metaSource"][sample["source"]]},
        "identifier": [{"system": SYS["identifier"][sample["source"]],
                        "value": sample["id"].lower() if sample["source"] == "healthKit" else sample["id"]}],
        "status": CONTRACT["rules"]["status"],
        "category": categories(m, sample),
        "code": code_cc,
        "subject": {"reference": "Patient/" + patient},
        "issued": fmt(utc(sample["issued"]), tz, always_millis=True),
        "valueQuantity": {"value": value, "unit": unit["display"], "system": SYS["ucum"], "code": unit["ucum"]},
    }
    if m["effective"] == "instantOrPeriod" and start == end:
        o["effectiveDateTime"] = fmt(start, tz)
    else:
        o["effectivePeriod"] = {"start": fmt(start, tz), "end": fmt(end, tz)}
    codes = sorted(CONTRACT["dataQualityFlags"][key] for key in FLAG_KEYS if sample.get(key))
    if codes:
        # contract rules.tagOrder: ascending by code. Every flag is stored alongside the value, never instead of it.
        o["meta"]["tag"] = [{"system": SYS["dataQualityFlag"], "code": code} for code in codes]
    if device_ref:
        o["device"] = {"reference": device_ref}
    return o


def quantity_case(name, note, metric_id, value, start, end, issued="2026-01-15T16:31:00Z", tz="America/Los_Angeles",
                  source="synthetic", sid="syn-000001", device_ref=SYN_DEVICE_REF, user_entered=False, flags=(), meal=None):
    m = metric(metric_id)
    sample = {"metric": metric_id, "value": value, "start": start, "end": end, "issued": issued, "timeZone": tz,
              "source": source, "id": sid}
    if user_entered:
        sample["userEntered"] = True
    for key in flags:
        sample[key] = True
    if meal:
        sample["meal"] = meal
    return {"name": name, "note": note, "patientId": PATIENT, "deviceReference": device_ref, "sample": sample,
            "expected": observation(m, sample, code_concept(m), number(value), m["unit"], PATIENT, device_ref)}


def sleep_case(name, note, stage, start, end, issued="2026-01-15T17:55:00Z", tz="America/Los_Angeles",
               source="synthetic", sid="syn-sleep-0001", device_ref=SYN_DEVICE_REF, user_entered=False, flags=()):
    m = metric("sleepStage")
    sample = {"metric": "sleepStage", "stage": stage, "start": start, "end": end, "issued": issued, "timeZone": tz,
              "source": source, "id": sid}
    if user_entered:
        sample["userEntered"] = True
    for key in flags:
        sample[key] = True
    case = {"name": name, "note": note, "patientId": PATIENT, "deviceReference": device_ref, "sample": sample}
    if stage in m["unmapped"]:
        case["expectedOutcome"] = "unmapped"
        return case
    stage_code = m["stages"][stage]
    seconds = (utc(end) - utc(start)).total_seconds()
    minutes = (Decimal(str(seconds)) / Decimal(60)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    case["expected"] = observation(m, sample, code_concept(m, stage_code), number(minutes), m["unit"], PATIENT, device_ref)
    return case


def error_case(name, note, sample, expected_error):
    return {"name": name, "note": note, "patientId": PATIENT, "deviceReference": None, "sample": sample, "expectedError": expected_error}


def device_cases():
    syn = CONTRACT["deviceKey"]

    def hk_key(d):
        fields = [d.get(k, "").strip() for k in ("name", "manufacturer", "model", "hardwareVersion", "softwareVersion")]
        return hashlib.sha256("\u001f".join(fields).encode("utf-8")).hexdigest()

    def hk_device(d):
        r = {"resourceType": "Device",
             "identifier": [{"system": SYS["identifier"]["deviceKey"], "value": hk_key(d)}],
             "status": "active"}
        if d.get("manufacturer", "").strip():
            r["manufacturer"] = d["manufacturer"].strip()
        if d.get("name", "").strip():
            r["deviceName"] = [{"name": d["name"].strip(), "type": "model-name"}]
        if d.get("model", "").strip():
            r["modelNumber"] = d["model"].strip()
        versions = []
        if d.get("hardwareVersion", "").strip():
            versions.append({"type": {"text": "hardware"}, "value": d["hardwareVersion"].strip()})
        if d.get("softwareVersion", "").strip():
            versions.append({"type": {"text": "software"}, "value": d["softwareVersion"].strip()})
        if versions:
            r["version"] = versions
        r["patient"] = {"reference": "Patient/" + PATIENT}
        return r

    def app_key(bundle):
        return hashlib.sha256(("app" + "\u001f" + bundle.strip()).encode("utf-8")).hexdigest()

    def app_device(d):
        """A source application (contract deviceKey.appSource*): keyed by its bundle identifier when it has one."""
        bundle = (d.get("bundleIdentifier") or "").strip()
        name = (d.get("name") or "").strip()
        identifiers = [{"system": SYS["identifier"]["deviceKey"], "value": app_key(bundle) if bundle else hk_key({"name": name})}]
        if bundle:
            identifiers.append({"system": SYS["identifier"]["appBundleId"], "value": bundle})
        r = {"resourceType": "Device", "identifier": identifiers, "status": "active"}
        if name:
            r["deviceName"] = [{"name": name, "type": CONTRACT["deviceKey"]["appSourceNameType"]}]
        r["patient"] = {"reference": "Patient/" + PATIENT}
        return r

    def app_case(name, note, descriptor):
        d = {"kind": "sourceApp", **descriptor}
        bundle = (descriptor.get("bundleIdentifier") or "").strip()
        key = app_key(bundle) if bundle else hk_key({"name": (descriptor.get("name") or "").strip()})
        return {"name": name, "note": note, "patientId": PATIENT, "descriptor": d, "expectedKey": key, "expected": app_device(descriptor)}

    watch = {"name": "Apple Watch", "manufacturer": "Apple Inc.", "model": "Watch7,1", "hardwareVersion": "Watch7,1", "softwareVersion": "11.2"}
    padded = {"name": "  Apple Watch ", "manufacturer": "Apple Inc.", "model": "Watch7,1", "hardwareVersion": "Watch7,1", "softwareVersion": "11.2"}
    minimal = {"name": "Some Sensor"}
    return [
        {"name": "device-synthetic", "note": "The synthetic simulator has a fixed key and fixed descriptive fields.",
         "patientId": PATIENT, "descriptor": {"kind": "synthetic"},
         "expected": {"resourceType": "Device",
                      "identifier": [{"system": SYS["identifier"]["deviceKey"], "value": syn["syntheticValue"]}],
                      "status": "active", "manufacturer": syn["syntheticManufacturer"],
                      "deviceName": [{"name": syn["syntheticName"], "type": "model-name"}],
                      "patient": {"reference": "Patient/" + PATIENT}}},
        {"name": "device-healthkit-full", "note": "All five fields present; the key is SHA-256 over them joined by U+001F.",
         "patientId": PATIENT, "descriptor": {"kind": "healthKit", **watch}, "expectedKey": hk_key(watch), "expected": hk_device(watch)},
        {"name": "device-healthkit-trimmed", "note": "Leading/trailing whitespace is trimmed: same key as the untrimmed device.",
         "patientId": PATIENT, "descriptor": {"kind": "healthKit", **padded}, "expectedKey": hk_key(watch), "expected": hk_device(padded)},
        {"name": "device-healthkit-minimal", "note": "Absent fields are omitted from the resource and are empty strings in the key.",
         "patientId": PATIENT, "descriptor": {"kind": "healthKit", **minimal}, "expectedKey": hk_key(minimal), "expected": hk_device(minimal)},
        {"name": "device-healthkit-empty", "note": "No field present: refused (it would collide with every other unknown device).",
         "patientId": PATIENT, "descriptor": {"kind": "healthKit"}, "expectedError": "emptyDeviceDescriptor"},
        app_case("device-app-source-full", "A source app with a bundle identifier: keyed by it, with two identifiers and a name of type other.",
                 {"name": "Example Nutrition App", "bundleIdentifier": "com.example.nutritionapp"}),
        app_case("device-app-source-renamed", "The same bundle identifier under another display name: the SAME key (one app, one Device).",
                 {"name": "Example Nutrition", "bundleIdentifier": "com.example.nutritionapp"}),
        app_case("device-app-source-padded-bundle", "Whitespace around the bundle identifier is trimmed: the same key again.",
                 {"name": "Example Nutrition App", "bundleIdentifier": "  com.example.nutritionapp "}),
        app_case("device-app-source-no-name", "A bundle identifier alone: keyed by it, and no deviceName.", {"bundleIdentifier": "com.example.nutritionapp"}),
        app_case("device-app-source-no-bundle", "No bundle identifier: the old name-only key rule, a name of type other, no bundle identifier.",
                 {"name": "Some App"}),
        app_case("device-app-source-blank-bundle", "A blank bundle identifier is no bundle identifier: the name-only rule.",
                 {"name": "Some App", "bundleIdentifier": "   "}),
        {"name": "device-app-source-empty", "note": "Neither a name nor a bundle identifier: refused.", "patientId": PATIENT,
         "descriptor": {"kind": "sourceApp"}, "expectedError": "emptyDeviceDescriptor"},
    ]


def normalize_meal(label):
    """contract rules.mealType: trimmed, case-insensitive, a code or an alias, else other; no label, no meal."""
    if label is None:
        return None
    text = label.strip()
    if not text:
        return None
    key = text.lower()
    code = key if key in CONTRACT["mealTypes"] else CONTRACT["mealTypeAliases"].get(key, "other")
    return {"code": code, "label": text}


def meal_cases():
    labels = [
        ("meal-breakfast", "Breakfast", "A code's own name, capitalised."), ("meal-lunch-lowercase", "lunch", "Case does not matter."),
        ("meal-dinner-padded", "  Dinner ", "Whitespace is trimmed, and the trimmed label is kept."), ("meal-snack", "Snack", "snack."),
        ("meal-snacks-alias", "Snacks", "The plural is an alias of snack; the label keeps the source's wording."),
        ("meal-other-keeps-label", "Brunch", "An unknown label is 'other', and the label is kept."),
        ("meal-numbered", "Meal 1", "A numbered meal name is 'other' too."), ("meal-explicit-other", "Other", "other maps to itself."),
        ("meal-empty", "", "An empty label is no meal."), ("meal-blank", "   ", "A blank label is no meal, never an invented one."),
        ("meal-absent", None, "No label at all is no meal."),
    ]
    return [{"name": n, "note": note, "label": label, "expected": normalize_meal(label)} for n, label, note in labels]


def intake_cases():
    """The eight intake metrics (contract kind intake). A source app has no HKDevice, so they carry an app Device."""
    t = "2026-01-15T19:30:00Z"            # 11:30 in Los Angeles
    issued = "2026-01-15T19:31:00Z"
    app = dict(source="healthKit", device_ref="Device/example-app", issued=issued)

    def case(name, note, metric_id, value, uuid, meal=None, **extra):
        return quantity_case(name, note, metric_id, value, t, t, sid=uuid, meal=meal, **{**app, **extra})

    lunch = {"code": "lunch", "label": "Lunch"}
    return [
        case("dietary-energy-with-meal", "Energy, LOINC 9052-2, UCUM kcal, domain nutrition plus a separate lunch entry.", "dietaryEnergy", 450,
             "B0000000-0000-4000-8000-000000000001", lunch),
        case("dietary-protein", "Protein, LOINC 9079-5 'Estimated', grams.", "dietaryProtein", 31.5, "B0000000-0000-4000-8000-000000000002",
             {"code": "breakfast", "label": "Breakfast"}),
        case("dietary-carbohydrates", "Carbohydrate, LOINC 9059-7.", "dietaryCarbohydrates", 62, "B0000000-0000-4000-8000-000000000003",
             {"code": "dinner", "label": "Dinner"}),
        case("dietary-fat", "Total fat, LOINC 9066-2.", "dietaryFat", 14.2, "B0000000-0000-4000-8000-000000000004", {"code": "snack", "label": "Snacks"}),
        case("dietary-water", "Water maps to LOINC 8984-7 Fluid intake, in mL.", "dietaryWater", 250, "B0000000-0000-4000-8000-000000000005"),
        case("dietary-fiber-custom-code", "Fiber has no per-entry LOINC code: the project's nutrient system, code in text.", "dietaryFiber", 7.5,
             "B0000000-0000-4000-8000-000000000006", lunch),
        case("dietary-sugar-custom-code", "Sugar, custom code.", "dietarySugar", 22, "B0000000-0000-4000-8000-000000000007"),
        case("dietary-sodium-custom-code-mg", "Sodium stays in mg under the custom code (no mmol conversion).", "dietarySodium", 620,
             "B0000000-0000-4000-8000-000000000008", lunch),
        case("dietary-sodium-zero-is-stored", "Zero is a valid intake (a food with no sodium): stored as given, never refused.", "dietarySodium", 0,
             "B0000000-0000-4000-8000-000000000009", lunch),
        case("dietary-energy-zero-is-stored", "Zero energy (water, black coffee): stored.", "dietaryEnergy", 0, "B0000000-0000-4000-8000-00000000000a"),
        case("dietary-energy-no-meal-has-one-category", "No meal label: one category entry, never an invented meal.", "dietaryEnergy", 120,
             "B0000000-0000-4000-8000-00000000000b"),
        case("dietary-energy-meal-other-keeps-label", "An unknown meal name is the code other and keeps its label in text.", "dietaryEnergy", 300,
             "B0000000-0000-4000-8000-00000000000c", {"code": "other", "label": "Brunch"}),
        case("dietary-energy-artifact", "A figure no single entry could carry is stored as given and tagged artifact-suspected.", "dietaryEnergy", 7000,
             "B0000000-0000-4000-8000-00000000000d", lunch, flags=("artifactSuspected",)),
        case("dietary-energy-all-flags-sorted", "Every flag with a meal: tags in ascending code order, value untouched.", "dietaryEnergy", 7000.5,
             "B0000000-0000-4000-8000-00000000000e", lunch, user_entered=True, flags=("lateArrival", "duplicateResolved", "artifactSuspected")),
    ]


def evaluate_flags(metric_id, value, end, issued):
    """The quality flags the capture app must set for a sample (contract rules.artifactSuspected and rules.lateArrival).
    duplicateResolved and userEntered are not decided by the sample's own values, so they are not here."""
    flags = []
    m = metric(metric_id)
    bounds = m.get("plausibleRange")
    if bounds is not None and value is not None and (value < bounds["min"] or value > bounds["max"]):
        flags.append(CONTRACT["dataQualityFlags"]["artifactSuspected"])
    late_seconds = CONTRACT["qualityThresholds"]["lateArrivalHours"] * 3600
    if (utc(issued) - utc(end)).total_seconds() > late_seconds:
        flags.append(CONTRACT["dataQualityFlags"]["lateArrival"])
    return sorted(flags)


def flag_case(name, note, metric_id, value, end, issued="2026-01-15T16:31:00Z"):
    sample = {"metric": metric_id, "end": end, "issued": issued}
    if value is not None:
        sample["value"] = value
    else:
        sample["stage"] = "asleepCore"
    return {"name": name, "note": note, "input": sample, "expectedFlags": evaluate_flags(metric_id, value, end, issued)}


def flag_cases():
    t = "2026-01-15T16:30:05Z"
    cases = []
    for mid in [m["id"] for m in CONTRACT["metrics"] if m.get("plausibleRange") and m.get("healthKit")]:
        r = metric(mid)["plausibleRange"]
        lo, hi = r["min"], r["max"]
        cases += [
            flag_case("%s-inside" % mid, "Well inside the range: no flag.", mid, (lo + hi) / 2, t),
            flag_case("%s-at-min-not-flagged" % mid, "Exactly on the lower bound is not flagged.", mid, lo, t),
            flag_case("%s-at-max-not-flagged" % mid, "Exactly on the upper bound is not flagged.", mid, hi, t),
        ]
        if metric(mid)["kind"] != "intake":
            # an intake metric's lower bound is zero and a negative value is refused before it could be flagged
            cases.append(flag_case("%s-just-below-min" % mid, "Just below the lower bound: artifact-suspected.", mid, lo - 0.1, t))
        cases.append(flag_case("%s-just-above-max" % mid, "Just above the upper bound: artifact-suspected.", mid, hi + 0.1, t))
    cases += [
        flag_case("late-just-under-24h", "Issued 23 h 59 min 59 s after the end: not late.", "heartRate", 70, t, issued="2026-01-16T16:30:04Z"),
        flag_case("late-exactly-24h", "Exactly 24 h after the end: not late (strictly more is late).", "heartRate", 70, t, issued="2026-01-16T16:30:05Z"),
        flag_case("late-just-over-24h", "One second over 24 h: late-arrival.", "heartRate", 70, t, issued="2026-01-16T16:30:06Z"),
        flag_case("late-uses-the-period-end", "A period is measured from its END, not its start.", "restingHeartRate", 58,
                  "2026-01-16T08:00:00Z", issued="2026-01-17T07:59:59Z"),
        flag_case("issued-before-end-is-not-late", "A day-long period issued before it ends (as the synthetic source does) is never late.",
                  "restingHeartRate", 58, "2026-01-16T08:00:00Z", issued="2026-01-15T16:31:00Z"),
        flag_case("artifact-and-late-together", "Both flags, listed in ascending code order.", "heartRate", 280, t, issued="2026-01-20T00:00:00Z"),
        flag_case("sleep-is-never-an-artifact", "A sleep interval has no plausibleRange.", "sleepStage", None, t),
        flag_case("sleep-can-be-late", "Lateness applies to every metric.", "sleepStage", None, t, issued="2026-01-20T00:00:00Z"),
    ]
    return cases


# ---------------------------------------------------------------------------------------------------------------------
# Health Connect (contract 1.6.0, section healthConnect). Records are synthetic and shaped like Health Connect's (a record
# class, an id, a data origin, a recording method, times with recorded zone offsets). A nutrition record's nutrient values
# are the numbers the accessor named in the metric's healthConnect entry returns (energy.kilocalories, mass.grams, ...).
# ---------------------------------------------------------------------------------------------------------------------
HC = CONTRACT["healthConnect"]
SEP = "\u001f"
MANUAL_ENTRY = 3
DEVICE_TYPES = ["unknown", "watch", "phone", "scale", "ring", "head_mounted", "fitness_band", "chest_strap", "smart_display"]
MEAL_BY_CODE = {1: "breakfast", 2: "lunch", 3: "dinner", 4: "snack"}


def sha(*fields):
    return hashlib.sha256(SEP.join(fields).encode("utf-8")).hexdigest()


def canonical(value):
    """contract healthConnect.canonicalValue: the shortest decimal that reads back as the same double, plain notation, no '.0'."""
    text = format(Decimal(repr(float(value))).normalize(), "f")
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    return "0" if text in ("", "-0") else text


def millis(instant):
    return str(int(instant.timestamp() * 1000))


def fmt_offset(instant, offset, always_millis=False):
    """FHIR dateTime at a recorded offset ('Z', '+05:30', '-08:00'), used as given (contract healthConnect.effective)."""
    minutes = 0 if offset == "Z" else (1 if offset[0] == "+" else -1) * (int(offset[1:3]) * 60 + int(offset[4:6]))
    local = instant.astimezone(timezone(timedelta(minutes=minutes)))
    sign = "+" if minutes >= 0 else "-"
    hours, mins = divmod(abs(minutes), 60)
    ms = local.microsecond // 1000
    frac = ".%03d" % ms if (ms or always_millis) else ""
    return "%s%s%s%02d:%02d" % (local.strftime("%Y-%m-%dT%H:%M:%S"), frac, sign, hours, mins)


def hc_time(instant, offset, phone_tz, always_millis=False):
    """A time at the record's offset, or, when the record has none, at the phone's zone at that instant (assumption A45)."""
    return fmt_offset(instant, offset, always_millis) if offset is not None else fmt(instant, phone_tz, always_millis)


def hc_flags(record, metric_id, value, end, issued):
    flags = evaluate_flags(metric_id, value, end, issued)
    if record.get("recordingMethod") == MANUAL_ENTRY:
        flags = sorted(flags + [CONTRACT["dataQualityFlags"]["userEntered"]])
    return flags


def hc_observation(m, sample_id, group_id, effective_start, effective_end, offsets, phone_tz, issued, value, code_cc, meal, flags, device_ref):
    """One Observation. offsets = (start offset, end offset), each possibly None."""
    so, eo = offsets
    start, end = utc(effective_start), utc(effective_end)
    o = {
        "resourceType": "Observation",
        "meta": {"source": SYS["metaSource"]["healthConnect"]},
        "identifier": [{"system": SYS["identifier"]["healthConnect"], "value": sample_id},
                       {"system": SYS["identifier"]["healthConnectGroup"], "value": group_id}],
        "status": CONTRACT["rules"]["status"],
        "category": categories(m, {"meal": meal}),
        "code": code_cc,
        "subject": {"reference": "Patient/" + PATIENT},
        "issued": hc_time(utc(issued), so, phone_tz, always_millis=True),
        "valueQuantity": {"value": number(value), "unit": m["unit"]["display"], "system": SYS["ucum"], "code": m["unit"]["ucum"]},
    }
    if m["effective"] == "instantOrPeriod" and start == end:
        o["effectiveDateTime"] = hc_time(start, so, phone_tz)
    else:
        o["effectivePeriod"] = {"start": hc_time(start, so, phone_tz), "end": hc_time(end, eo, phone_tz)}
    if flags:
        o["meta"]["tag"] = [{"system": SYS["dataQualityFlag"], "code": code} for code in flags]
    if device_ref:
        o["device"] = {"reference": device_ref}
    return o


def sample_identity(record_id, time_ms, metric_id, canon):
    return sha("hc-sample", record_id, time_ms, metric_id, canon)


def nutrition_metrics():
    return [m for m in CONTRACT["metrics"] if m["kind"] == "intake" and m.get("healthConnect", {}).get("record") == "NutritionRecord"]


def content_key(record):
    meal = MEAL_BY_CODE.get(record.get("mealType", 0), "other" if record.get("mealType", 0) else "")
    fields = ["hc-content", record["origin"].strip(), meal, millis(utc(record["startTime"])), millis(utc(record["endTime"]))]
    for m in nutrition_metrics():
        field = m["healthConnect"]["field"]
        if record["nutrients"].get(field) is not None:
            fields.append("%s=%s" % (m["id"], canonical(record["nutrients"][field])))
    return sha(*fields)


def nutrition_group_values(records):
    """The group value of each live nutrition record, in input order (contract healthConnect.nutritionOrdinal)."""
    seen, out = {}, []
    for r in records:
        key = content_key(r)
        seen[key] = seen.get(key, 0) + 1
        out.append("%s#%d" % (key, seen[key]))
    return out


def hc_sleep_stage_id(stage_type):
    for stage, types in metric("sleepStage")["healthConnect"]["stages"].items():
        if stage_type in types:
            return stage
    return None


def hc_observations(case):
    """Observations for one delivery of one record (a list), or an {'error': name} for a refused one. nutrition_group is the
    group value of a nutrition record (it depends on the other live records, so the caller supplies it)."""
    r, issued, phone_tz, device_ref = case["record"], case["issued"], case["phoneTimeZone"], case.get("deviceReference")
    cls = r["class"]
    if not r.get("id", "").strip():
        return {"error": "emptyRecordId"}
    out = []
    if cls == "HeartRateRecord":
        m = metric("heartRate")
        for smp in r["samples"]:
            v = smp["beatsPerMinute"]
            if v <= 0:
                return {"error": "nonPositiveValue"}
            t = utc(smp["time"])
            flags = hc_flags(r, "heartRate", v, smp["time"], issued)
            out.append(hc_observation(m, sample_identity(r["id"], millis(t), "heartRate", canonical(v)), r["id"], smp["time"], smp["time"],
                                      (r["startZoneOffset"], r["startZoneOffset"]), phone_tz, issued, v, code_concept(m), None, flags, device_ref))
    elif cls in ("RestingHeartRateRecord", "HeartRateVariabilityRmssdRecord"):
        mid, field = ("restingHeartRate", "beatsPerMinute") if cls == "RestingHeartRateRecord" else ("hrvRmssd", "heartRateVariabilityMillis")
        m, v = metric(mid), r[field]
        if v <= 0:
            return {"error": "nonPositiveValue"}
        flags = hc_flags(r, mid, v, r["time"], issued)
        out.append(hc_observation(m, sample_identity(r["id"], millis(utc(r["time"])), mid, canonical(v)), r["id"], r["time"], r["time"],
                                  (r["zoneOffset"], r["zoneOffset"]), phone_tz, issued, v, code_concept(m), None, flags, device_ref))
    elif cls == "SleepSessionRecord":
        m = metric("sleepStage")
        for st in r["stages"]:
            stage = hc_sleep_stage_id(st["stageType"])
            if stage is None:
                continue
            start, end = utc(st["startTime"]), utc(st["endTime"])
            if end <= start:
                return {"error": "emptySleepInterval"}
            minutes = (Decimal(str((end - start).total_seconds())) / Decimal(60)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
            canon = "%s:%s" % (stage, millis(end))
            flags = hc_flags(r, "sleepStage", None, st["endTime"], issued)
            out.append(hc_observation(m, sample_identity(r["id"], millis(start), "sleepStage", canon), r["id"], st["startTime"], st["endTime"],
                                      (r["startZoneOffset"], r["endZoneOffset"]), phone_tz, issued, minutes, code_concept(m, m["stages"][stage]),
                                      None, flags, device_ref))
    elif cls == "HydrationRecord":
        m, v = metric("dietaryWater"), r["volume"]
        if v < 0:
            return {"error": "negativeValue"}
        flags = hc_flags(r, "dietaryWater", v, r["endTime"], issued)
        out.append(hc_observation(m, sample_identity(r["id"], millis(utc(r["startTime"])), "dietaryWater", canonical(v)), r["id"], r["startTime"],
                                  r["endTime"], (r["startZoneOffset"], r["endZoneOffset"]), phone_tz, issued, v, code_concept(m), None, flags, device_ref))
    elif cls == "NutritionRecord":
        group = case["nutritionGroup"]
        code = r.get("mealType", 0)
        meal = None
        if code:
            mt = MEAL_BY_CODE.get(code, "other")
            meal = {"code": mt, "label": CONTRACT["mealTypes"][mt]["display"]}
        for m in nutrition_metrics():
            v = r["nutrients"].get(m["healthConnect"]["field"])
            if v is None:
                continue
            if v < 0:
                return {"error": "negativeValue"}
            flags = hc_flags(r, m["id"], v, r["endTime"], issued)
            out.append(hc_observation(m, sha("hc-nutrient", group, m["id"]), group, r["startTime"], r["endTime"],
                                      (r["startZoneOffset"], r["endZoneOffset"]), phone_tz, issued, v, code_concept(m), meal, flags, device_ref))
    return out


def hc_case(name, note, record, issued="2026-01-15T16:31:00Z", phone_tz="America/Los_Angeles", device_ref="Device/example-hc-device", group=None):
    case = {"name": name, "note": note, "patientId": PATIENT, "phoneTimeZone": phone_tz, "issued": issued,
            "deviceReference": device_ref, "record": record}
    if record["class"] == "NutritionRecord":
        case["nutritionGroup"] = group if group is not None else nutrition_group_values([record])[0]
    result = hc_observations(case)
    if isinstance(result, dict):
        case["expectedError"] = result["error"]
    else:
        case["expected"] = result
    return case


def rec(cls, rid, origin="com.example.wearable", method=2, **fields):
    return {"class": cls, "id": rid, "origin": origin, "recordingMethod": method, **fields}


def hr_record(rid, samples, start="2026-01-15T16:30:00Z", end="2026-01-15T16:32:00Z", offset="-08:00", method=2, origin="com.example.wearable"):
    return rec("HeartRateRecord", rid, origin, method, startTime=start, endTime=end, startZoneOffset=offset, endZoneOffset=offset,
               samples=[{"time": t, "beatsPerMinute": v} for t, v in samples])


def nutrition_record(rid, nutrients, meal=2, start="2026-01-15T18:00:00Z", end="2026-01-16T06:00:00Z", offset="-08:00",
                     origin="com.example.nutritionapp", method=MANUAL_ENTRY):
    return rec("NutritionRecord", rid, origin, method, startTime=start, endTime=end, startZoneOffset=offset, endZoneOffset=offset,
               mealType=meal, nutrients=nutrients)


FOOD = {"energy": 450.0, "protein": 31.5, "totalCarbohydrate": 62.0, "totalFat": 14.2, "dietaryFiber": 7.5, "sugar": 22.0, "sodium": 620.0,
        "vitaminC": 12.0, "calcium": 120.0}  # the last two are not mapped: they must change nothing


def healthconnect_cases():
    t1, t2, t3 = "2026-01-15T16:30:05Z", "2026-01-15T16:30:35Z", "2026-01-15T16:31:05Z"
    sleep_stages = [("STAGE_TYPE_AWAKE", "2026-01-15T07:00:00Z", "2026-01-15T07:10:00Z"),
                    ("STAGE_TYPE_LIGHT", "2026-01-15T07:10:00Z", "2026-01-15T08:00:00Z"),
                    ("STAGE_TYPE_DEEP", "2026-01-15T08:00:00Z", "2026-01-15T08:45:00Z"),
                    ("STAGE_TYPE_REM", "2026-01-15T08:45:00Z", "2026-01-15T09:15:00Z"),
                    ("STAGE_TYPE_SLEEPING", "2026-01-15T09:15:00Z", "2026-01-15T09:30:00Z"),
                    ("STAGE_TYPE_AWAKE_IN_BED", "2026-01-15T09:30:00Z", "2026-01-15T09:40:00Z"),
                    ("STAGE_TYPE_OUT_OF_BED", "2026-01-15T09:40:00Z", "2026-01-15T09:50:00Z"),
                    ("STAGE_TYPE_UNKNOWN", "2026-01-15T09:50:00Z", "2026-01-15T09:55:00Z")]

    def sleep(rid, stages, **kw):
        return rec("SleepSessionRecord", rid, kw.pop("origin", "com.example.wearable"), kw.pop("method", 2),
                   startTime=stages[0][1], endTime=stages[-1][2], startZoneOffset=kw.pop("offset", "-08:00"), endZoneOffset=kw.pop("offset2", "-08:00"),
                   stages=[{"stageType": a, "startTime": b, "endTime": c} for a, b, c in stages])
    cases = [
        hc_case("hc-heart-rate-record-three-samples", "Pattern (a): a record of three samples gives three Observations; each carries its sample identity and the record id as the group.",
                hr_record("rec-hr-0001", [(t1, 72), (t2, 74), (t3, 71)])),
        hc_case("hc-heart-rate-decimal-double", "A value that is not exactly representable (72.1) is hashed through its shortest round-trip text (assumption A49).",
                hr_record("rec-hr-0002", [(t1, 72.1)])),
        hc_case("hc-heart-rate-null-offsets-use-the-phone-zone", "A record with no zone offsets: the phone's zone at that instant (here Asia/Kolkata, +05:30).",
                hr_record("rec-hr-0003", [(t1, 72)], offset=None), phone_tz="Asia/Kolkata"),
        hc_case("hc-heart-rate-recorded-offset-is-used-as-given", "The recorded offset wins over the phone's zone (a record written in Tokyo, read in Los Angeles).",
                hr_record("rec-hr-0004", [(t1, 72)], offset="+09:00")),
        hc_case("hc-heart-rate-utc-offset-z-is-plus-zero", "An offset of Z is written +00:00, never Z.", hr_record("rec-hr-0005", [(t1, 72)], offset="Z")),
        hc_case("hc-heart-rate-manual-entry-is-user-entered", "MANUAL_ENTRY carries the user-entered tag (assumption A46).",
                hr_record("rec-hr-0006", [(t1, 72)], method=MANUAL_ENTRY)),
        hc_case("hc-heart-rate-artifact-and-late", "An implausible value from a record delivered days later: both quality flags, in code order.",
                hr_record("rec-hr-0007", [(t1, 280)]), issued="2026-01-20T00:00:00Z"),
        hc_case("hc-heart-rate-no-device-reference", "Without a device reference there is no device element.",
                hr_record("rec-hr-0008", [(t1, 72)]), device_ref=None),
        hc_case("hc-resting-heart-rate-instant", "An instant record: effectiveDateTime at the record's own offset.",
                rec("RestingHeartRateRecord", "rec-rhr-0001", time="2026-01-15T16:30:05Z", zoneOffset="-08:00", beatsPerMinute=58)),
        hc_case("hc-hrv-rmssd-own-code", "RMSSD has no LOINC code: the project's metric system, code hrv-rmssd, display in code.text; never SDNN.",
                rec("HeartRateVariabilityRmssdRecord", "rec-hrv-0001", time="2026-01-15T16:30:05Z", zoneOffset="-08:00", heartRateVariabilityMillis=48.3)),
        hc_case("hc-sleep-session-stages", "Each mapped stage is one duration Observation; awake in bed maps to awake; out of bed and unknown give none (A43).",
                sleep("rec-sleep-0001", sleep_stages)),
        hc_case("hc-sleep-session-null-offsets", "Sleep with no offsets uses the phone's zone for each end.", sleep("rec-sleep-0002", sleep_stages[:2], offset=None, offset2=None)),
        hc_case("hc-hydration-record", "A hydration record is dietaryWater in mL, identified by its record id.",
                rec("HydrationRecord", "rec-hyd-0001", origin="com.example.nutritionapp", startTime="2026-01-15T19:00:00Z", endTime="2026-01-15T19:00:00Z",
                    startZoneOffset="-08:00", endZoneOffset="-08:00", volume=250.0)),
        hc_case("hc-nutrition-full-record-with-meal", "One record, seven mapped nutrients, one Observation each, all sharing one group value; the meal is a separate category entry; "
                "unmapped nutrients change nothing; the window is a period (A47).", nutrition_record("rec-nut-0001", dict(FOOD))),
        hc_case("hc-nutrition-no-meal", "Meal type 0 (unknown): no meal entry, never an invented one.", nutrition_record("rec-nut-0002", dict(FOOD), meal=0)),
        hc_case("hc-nutrition-unlisted-meal-code-is-other", "A meal code the contract does not know is other.", nutrition_record("rec-nut-0003", dict(FOOD), meal=9)),
        hc_case("hc-nutrition-missing-nutrient-is-absent-not-zero", "A nutrient the record does not carry gets no Observation (a missing nutrient is not zero).",
                nutrition_record("rec-nut-0004", {k: v for k, v in FOOD.items() if k != "energy"})),
        hc_case("hc-nutrition-zero-sodium-is-stored", "Zero is a valid intake: stored, and part of the content key.",
                nutrition_record("rec-nut-0005", {**FOOD, "sodium": 0.0})),
        hc_case("hc-nutrition-from-a-wearable-is-not-user-entered", "An automatically recorded nutrition record carries no user-entered tag.",
                nutrition_record("rec-nut-0006", dict(FOOD), method=2)),
    ]
    errors = [
        hc_case("hc-error-empty-record-id", "A record without an id cannot be identified: refused.", hr_record("  ", [(t1, 72)])),
        hc_case("hc-error-zero-heart-rate", "Zero is refused for a quantity (the control is any other case above).", hr_record("rec-err-0002", [(t1, 0)])),
        hc_case("hc-error-negative-nutrient", "A negative intake is always refused.", nutrition_record("rec-err-0003", {**FOOD, "protein": -1.0})),
        hc_case("hc-error-sleep-stage-ends-before-it-starts", "A stage whose end is not after its start is refused.",
                sleep("rec-err-0004", [("STAGE_TYPE_LIGHT", "2026-01-15T08:00:00Z", "2026-01-15T07:00:00Z")])),
    ]
    return cases, errors


def identity_cases():
    """Properties of the identities across deliveries (contract healthConnect.sampleIdentity, nutritionContentKey, nutritionOrdinal)."""
    t1, t2, t3 = "2026-01-15T16:30:05Z", "2026-01-15T16:30:35Z", "2026-01-15T16:31:05Z"
    base = {"issued": "2026-01-15T16:40:00Z", "phoneTimeZone": "America/Los_Angeles", "deviceReference": None}

    def ids(record, group=None):
        case = {**base, "record": record}
        if record["class"] == "NutritionRecord":
            case["nutritionGroup"] = group
        return [o["identifier"][0]["value"] for o in hc_observations(case)]

    def prop(name, note, a, b, group_a=None, group_b=None):
        ia, ib = ids(a, group_a), ids(b, group_b)
        return {"name": name, "note": note, "deliveryA": {"record": a, "nutritionGroup": group_a}, "deliveryB": {"record": b, "nutritionGroup": group_b},
                "identifiersA": ia, "identifiersB": ib,
                "shared": sorted(set(ia) & set(ib)), "onlyInA": sorted(set(ia) - set(ib)), "onlyInB": sorted(set(ib) - set(ia))}

    f1, f2 = nutrition_record("rec-nut-1000", dict(FOOD)), nutrition_record("rec-nut-2000", dict(FOOD))  # same food, new record id (a rewrite)
    edited = nutrition_record("rec-nut-2000", {**FOOD, "protein": 40.0})
    g1, g2 = nutrition_group_values([f1])[0], nutrition_group_values([f2])[0]
    ge = nutrition_group_values([edited])[0]
    twin_a, twin_b = nutrition_record("rec-nut-3001", dict(FOOD)), nutrition_record("rec-nut-3002", dict(FOOD))
    twin_groups = nutrition_group_values([twin_a, twin_b])
    props = [
        prop("identity-growing-record-keeps-old-sample-identities", "Pattern (b): the same record id delivered again with one more sample: the old samples keep their identifiers, only the new one is new.",
             hr_record("rec-hr-1000", [(t1, 72), (t2, 74)]), hr_record("rec-hr-1000", [(t1, 72), (t2, 74), (t3, 71)])),
        prop("identity-edited-sample-value-gets-a-new-identity", "The same record and time with another value: that sample's identifier changes (the old Observation is to be retracted), the others keep theirs.",
             hr_record("rec-hr-1001", [(t1, 72), (t2, 74)]), hr_record("rec-hr-1001", [(t1, 72), (t2, 75)])),
        prop("identity-another-record-id-is-another-sample", "Two records with the same time and value but different record ids are different samples (the record id is part of the identity).",
             hr_record("rec-hr-1002", [(t1, 72)]), hr_record("rec-hr-1003", [(t1, 72)])),
        prop("identity-the-same-value-in-two-metrics-differs", "The metric id is part of the identity: a resting reading and an RMSSD reading with the same record id, time and value differ.",
             rec("RestingHeartRateRecord", "rec-x-1", time=t1, zoneOffset="-08:00", beatsPerMinute=50),
             rec("HeartRateVariabilityRmssdRecord", "rec-x-1", time=t1, zoneOffset="-08:00", heartRateVariabilityMillis=50.0)),
        prop("identity-nutrition-rewritten-with-a-new-record-id-is-the-same", "MyFitnessPal re-creates a record with a new id on every sync: the content key and so every identifier is unchanged.",
             f1, f2, g1, g2),
        prop("identity-nutrition-edited-nutrient-is-a-new-item", "An edit that changes a mapped nutrient is a different content key: every identifier of the item changes (old Observations retracted, new created).",
             f2, edited, g2, ge),
        prop("identity-nutrition-unmapped-nutrient-changes-nothing", "A change to a nutrient the contract does not map leaves every identifier unchanged.",
             f2, nutrition_record("rec-nut-2001", {**FOOD, "vitaminC": 99.0}), g2, nutrition_group_values([nutrition_record("rec-nut-2001", {**FOOD, "vitaminC": 99.0})])[0]),
        prop("identity-nutrition-twin-entries-are-told-apart-by-ordinal", "The same food logged twice in one meal has one content key: the two records get ordinals #1 and #2, and deleting one leaves #1.",
             twin_a, twin_b, twin_groups[0], twin_groups[1]),
    ]
    canon = [{"value": v, "canonical": canonical(v)} for v in
             [72, 72.0, 72.5, 0, 0.1, 0.30000000000000004, 48.3, 1e21, 1e-7, 123456789.125, 31.5, 450, 0.5]]
    lookups = []
    for name, value in [("record-id", "rec-hr-1000"), ("nutrition-group", twin_groups[0])]:
        lookups.append({"name": "retraction-lookup-" + name, "note": "To find what a deleted or changed record produced, search Observation by this token (the client percent-encodes it).",
                        "groupValue": value, "searchToken": "%s|%s" % (SYS["identifier"]["healthConnectGroup"], value)})
    return {"properties": props, "canonicalValues": canon, "retractionLookups": lookups,
            "contentKeys": [{"record": f1, "contentKey": content_key(f1), "groupValue": g1}]}


def healthconnect_device_cases():
    def device_key(d):
        m, mo = (d.get("manufacturer") or "").strip(), (d.get("model") or "").strip()
        return sha(m, mo, DEVICE_TYPES[d.get("type", 0)])

    def usable(d):
        return bool(d) and bool((d.get("manufacturer") or "").strip() or (d.get("model") or "").strip())

    def device_resource(d):
        r = {"resourceType": "Device", "identifier": [{"system": SYS["identifier"]["deviceKey"], "value": device_key(d)}], "status": "active"}
        if (d.get("manufacturer") or "").strip():
            r["manufacturer"] = d["manufacturer"].strip()
        if (d.get("model") or "").strip():
            r["modelNumber"] = d["model"].strip()
        r["type"] = {"text": DEVICE_TYPES[d.get("type", 0)]}
        r["patient"] = {"reference": "Patient/" + PATIENT}
        return r

    def app_resource(package):
        key = sha("hc-app", package.strip())
        return {"resourceType": "Device", "identifier": [{"system": SYS["identifier"]["deviceKey"], "value": key},
                                                         {"system": SYS["identifier"]["appPackageName"], "value": package.strip()}],
                "status": "active", "patient": {"reference": "Patient/" + PATIENT}}

    def case(name, note, origin, device):
        d = {"name": name, "note": note, "patientId": PATIENT, "origin": origin, "device": device}
        if usable(device):
            d["expectedKey"], d["expected"] = device_key(device), device_resource(device)
        elif origin.strip():
            d["expectedKey"], d["expected"] = sha("hc-app", origin.strip()), app_resource(origin)
        else:
            d["expectedError"] = "blankPackageName"
        return d
    band = {"manufacturer": "Example Corp", "model": "Band 2", "type": 6}
    return [
        case("hc-device-full", "A record with a device: keyed by manufacturer, model and the type name.", "com.example.wearable", band),
        case("hc-device-trimmed", "Whitespace is trimmed: the same key as the untrimmed device.", "com.example.wearable",
             {"manufacturer": " Example Corp ", "model": "Band 2 ", "type": 6}),
        case("hc-device-model-only", "Manufacturer absent: an empty field in the key, no manufacturer in the resource.", "com.example.wearable", {"model": "Band 2", "type": 6}),
        case("hc-device-unknown-type", "Type 0 is the name unknown.", "com.example.wearable", {"manufacturer": "Example Corp", "type": 0}),
        case("hc-device-without-names-is-the-app-source", "A device with neither manufacturer nor model is not usable: the record is attributed to its data origin.",
             "com.example.nutritionapp", {"type": 2}),
        case("hc-no-device-is-the-app-source", "No device at all (MyFitnessPal's records, M24): the data origin's package name keys a Device.", "com.example.nutritionapp", None),
        case("hc-app-source-trimmed-package", "The package name is trimmed: the same key.", "  com.example.nutritionapp ", None),
        case("hc-app-source-blank-package-is-refused", "No device and no package name: refused.", "   ", None),
    ]

def healthconnect_files():
    cases, errors = healthconnect_cases()
    # the flags the Health Connect metrics can carry, for the metric iOS does not read (hrvRmssd)
    t = "2026-01-15T16:30:05Z"
    r = metric("hrvRmssd")["plausibleRange"]
    flags = [flag_case("hrvRmssd-inside", "Inside the range: no flag.", "hrvRmssd", (r["min"] + r["max"]) / 2, t),
             flag_case("hrvRmssd-at-min-not-flagged", "On the lower bound: not flagged.", "hrvRmssd", r["min"], t),
             flag_case("hrvRmssd-just-below-min", "Just below: artifact-suspected.", "hrvRmssd", r["min"] - 0.1, t),
             flag_case("hrvRmssd-at-max-not-flagged", "On the upper bound: not flagged.", "hrvRmssd", r["max"], t),
             flag_case("hrvRmssd-just-above-max", "Just above: artifact-suspected.", "hrvRmssd", r["max"] + 0.1, t)]
    v = CONTRACT["contractVersion"]
    return {"healthconnect-observations.json": {"contractVersion": v, "cases": cases},
            "healthconnect-errors.json": {"contractVersion": v, "cases": errors},
            "healthconnect-identity.json": {"contractVersion": v, **identity_cases()},
            "healthconnect-devices.json": {"contractVersion": v, "cases": healthconnect_device_cases()},
            "healthconnect-flags.json": {"contractVersion": v, "cases": flags}}


def build():
    la = "America/Los_Angeles"
    quantity = [
        quantity_case("heart-rate-instant", "The spec's sample (fhir-data-model.md), plus meta.source.", "heartRate", 72,
                      "2026-01-15T16:30:05Z", "2026-01-15T16:30:05Z"),
        quantity_case("heart-rate-period", "start != end gives effectivePeriod.", "heartRate", 72,
                      "2026-01-15T16:30:00Z", "2026-01-15T16:30:45Z"),
        quantity_case("heart-rate-fractional-seconds", "A non-zero sub-second part is kept to 3 digits.", "heartRate", 72,
                      "2026-01-15T16:30:05.250Z", "2026-01-15T16:30:05.250Z"),
        quantity_case("heart-rate-decimal-value", "A non-integer value is kept.", "heartRate", 72.5,
                      "2026-01-15T16:30:05Z", "2026-01-15T16:30:05Z"),
        quantity_case("heart-rate-no-device", "Without a device reference there is no device element.", "heartRate", 72,
                      "2026-01-15T16:30:05Z", "2026-01-15T16:30:05Z", device_ref=None),
        quantity_case("heart-rate-healthkit-uuid-lowercased", "HealthKit identity: healthkit-sample system, lowercase UUID, healthkit meta.source.",
                      "heartRate", 64, "2026-01-15T16:30:05Z", "2026-01-15T16:30:05Z", source="healthKit",
                      sid="3F2504E0-4F89-11D3-9A0C-0305E82C3301", device_ref="Device/example-watch"),
        quantity_case("heart-rate-healthkit-user-entered", "Typed in by hand in Apple Health: stored as given, tagged user-entered; "
                      "a hand entry has no device.", "heartRate", 80, "2026-01-15T16:30:00Z", "2026-01-15T16:30:00Z",
                      source="healthKit", sid="A1B2C3D4-0000-4000-8000-000000000001", device_ref=None, user_entered=True),
        quantity_case("heart-rate-artifact-above-range", "An implausible spike is stored as given and tagged artifact-suspected.", "heartRate", 280,
                      "2026-01-15T16:30:05Z", "2026-01-15T16:30:05Z", sid="syn-000003", flags=("artifactSuspected",)),
        quantity_case("heart-rate-late-arrival", "Received long after it was measured: tagged late-arrival.", "heartRate", 70,
                      "2026-01-15T16:30:05Z", "2026-01-15T16:30:05Z", issued="2026-01-18T00:00:00Z", sid="syn-000004", flags=("lateArrival",)),
        quantity_case("heart-rate-duplicate-resolved", "Two deliveries met in the queue before upload: one Observation, tagged duplicate-resolved.",
                      "heartRate", 70, "2026-01-15T16:30:05Z", "2026-01-15T16:30:05Z", sid="syn-000005", flags=("duplicateResolved",)),
        quantity_case("heart-rate-all-flags-sorted", "Every flag at once: tags in ascending code order, and the value untouched.", "heartRate", 281.5,
                      "2026-01-15T16:30:05Z", "2026-01-15T16:30:05Z", issued="2026-01-18T00:00:00Z", source="healthKit",
                      sid="A1B2C3D4-0000-4000-8000-000000000003", device_ref=None, user_entered=True,
                      flags=("lateArrival", "duplicateResolved", "artifactSuspected")),
        quantity_case("hrv-sdnn-artifact-below-range", "HRV below its range: tagged.", "hrvSdnn", 3,
                      "2026-01-15T16:30:05Z", "2026-01-15T16:30:05Z", sid="syn-hrv-0002", flags=("artifactSuspected",)),
        *intake_cases(),
        quantity_case("resting-heart-rate-day-period", "Resting HR over a local day: LOINC 40443-4 and a period.", "restingHeartRate", 58,
                      "2026-01-15T08:00:00Z", "2026-01-16T08:00:00Z", sid="syn-rest-0001"),
        quantity_case("hrv-sdnn-instant", "HRV SDNN: LOINC 112429-6, UCUM ms.", "hrvSdnn", 48.3,
                      "2026-01-15T16:30:05Z", "2026-01-15T16:30:05Z", sid="syn-hrv-0001"),
        quantity_case("heart-rate-utc-zone-is-plus-zero-not-Z", "A UTC sample carries +00:00, never Z.", "heartRate", 70,
                      "2026-01-15T16:30:05Z", "2026-01-15T16:30:05Z", tz="UTC"),
        quantity_case("heart-rate-half-hour-offset", "Asia/Kolkata is +05:30.", "heartRate", 70,
                      "2026-01-15T16:30:05Z", "2026-01-15T16:30:05Z", tz="Asia/Kolkata"),
        quantity_case("heart-rate-negative-half-hour-dst", "America/St_Johns in July is -02:30 (daylight time).", "heartRate", 70,
                      "2026-07-01T15:00:05Z", "2026-07-01T15:00:05Z", issued="2026-07-01T15:01:00Z", tz="America/St_Johns"),
        quantity_case("heart-rate-period-across-spring-forward", "Start in PST (-08:00), end in PDT (-07:00): each end has its own offset.",
                      "heartRate", 72, "2026-03-08T09:30:00Z", "2026-03-08T10:30:00Z", issued="2026-03-08T10:31:00Z"),
        quantity_case("heart-rate-fall-back-first-1:30", "01:30 local on 2026-11-01 occurs twice; this is the first (PDT, -07:00).",
                      "heartRate", 72, "2026-11-01T08:30:00Z", "2026-11-01T08:30:00Z", issued="2026-11-01T08:31:00Z"),
        quantity_case("heart-rate-fall-back-second-1:30", "...and this is the second (PST, -08:00): same wall clock, different instant.",
                      "heartRate", 72, "2026-11-01T09:30:00Z", "2026-11-01T09:30:00Z", issued="2026-11-01T09:31:00Z", sid="syn-000002"),
    ]
    sleep = [
        sleep_case("sleep-deep", "The spec's sample: 01:10 to 01:52 local, 42 min.", "asleepDeep", "2026-01-15T09:10:00Z", "2026-01-15T09:52:00Z"),
        sleep_case("sleep-core", "asleepCore maps to Light sleep duration (A4).", "asleepCore", "2026-01-15T09:10:00Z", "2026-01-15T09:52:00Z", sid="syn-sleep-0002"),
        sleep_case("sleep-rem", "asleepREM.", "asleepREM", "2026-01-15T09:10:00Z", "2026-01-15T09:52:00Z", sid="syn-sleep-0003"),
        sleep_case("sleep-unspecified", "asleepUnspecified.", "asleepUnspecified", "2026-01-15T09:10:00Z", "2026-01-15T09:52:00Z", sid="syn-sleep-0004"),
        sleep_case("sleep-awake", "awake maps to Awakening duration 103210-1 (A4).", "awake", "2026-01-15T09:10:00Z", "2026-01-15T09:52:00Z", sid="syn-sleep-0005"),
        sleep_case("sleep-user-entered", "A sleep interval entered by hand: the same tag, the same duration rule.", "asleepCore",
                   "2026-01-15T09:10:00Z", "2026-01-15T09:52:00Z", source="healthKit", sid="A1B2C3D4-0000-4000-8000-000000000002",
                   device_ref=None, user_entered=True),
        sleep_case("sleep-late-arrival", "A sleep interval can be late too.", "asleepDeep", "2026-01-15T09:10:00Z", "2026-01-15T09:52:00Z",
                   issued="2026-01-18T00:00:00Z", sid="syn-sleep-0011", flags=("lateArrival",)),
        sleep_case("sleep-in-bed-is-unmapped", "inBed has no verified code: no Observation, and not an error.", "inBed", "2026-01-15T09:10:00Z", "2026-01-15T09:52:00Z", sid="syn-sleep-0006"),
        sleep_case("sleep-half-minute", "30 s is 0.5 min.", "asleepCore", "2026-01-15T09:10:00Z", "2026-01-15T09:10:30Z", sid="syn-sleep-0007"),
        sleep_case("sleep-one-second-rounds-half-up", "1 s is 0.01666... min, rounded to 0.02.", "asleepCore", "2026-01-15T09:10:00Z", "2026-01-15T09:10:01Z", sid="syn-sleep-0008"),
        sleep_case("sleep-across-spring-forward", "01:30 PST to 03:30 PDT is ONE elapsed hour (the 02:00 hour does not exist): 60 min.",
                   "asleepCore", "2026-03-08T09:30:00Z", "2026-03-08T10:30:00Z", issued="2026-03-08T11:00:00Z", sid="syn-sleep-0009"),
        sleep_case("sleep-across-fall-back", "00:30 PDT to 02:30 PST is THREE elapsed hours (01:00 occurs twice): 180 min.",
                   "asleepCore", "2026-11-01T07:30:00Z", "2026-11-01T10:30:00Z", issued="2026-11-01T11:00:00Z", sid="syn-sleep-0010"),
    ]
    errors = [
        error_case("error-zero-value", "Zero is refused for every metric (A17).",
                   {"metric": "heartRate", "value": 0, "start": "2026-01-15T16:30:05Z", "end": "2026-01-15T16:30:05Z",
                    "issued": "2026-01-15T16:31:00Z", "timeZone": la, "source": "synthetic", "id": "syn-err-1"}, "nonPositiveValue"),
        error_case("error-negative-value", "Negative values are refused.",
                   {"metric": "hrvSdnn", "value": -5, "start": "2026-01-15T16:30:05Z", "end": "2026-01-15T16:30:05Z",
                    "issued": "2026-01-15T16:31:00Z", "timeZone": la, "source": "synthetic", "id": "syn-err-2"}, "nonPositiveValue"),
        error_case("error-negative-intake", "A negative intake is always refused, even though zero is allowed (the control: zero is stored).",
                   {"metric": "dietaryEnergy", "value": -1, "start": "2026-01-15T16:30:05Z", "end": "2026-01-15T16:30:05Z",
                    "issued": "2026-01-15T16:31:00Z", "timeZone": la, "source": "healthKit", "id": "syn-err-neg"}, "negativeValue"),
        error_case("error-end-before-start", "An interval that ends before it starts is refused.",
                   {"metric": "heartRate", "value": 72, "start": "2026-01-15T16:30:45Z", "end": "2026-01-15T16:30:00Z",
                    "issued": "2026-01-15T16:31:00Z", "timeZone": la, "source": "synthetic", "id": "syn-err-3"}, "endBeforeStart"),
        error_case("error-zero-length-sleep", "A sleep interval must have end strictly after start.",
                   {"metric": "sleepStage", "stage": "asleepDeep", "start": "2026-01-15T09:10:00Z", "end": "2026-01-15T09:10:00Z",
                    "issued": "2026-01-15T17:55:00Z", "timeZone": la, "source": "synthetic", "id": "syn-err-4"}, "emptySleepInterval"),
        error_case("error-empty-sample-id", "A sample without an identity cannot be deduplicated: refused.",
                   {"metric": "heartRate", "value": 72, "start": "2026-01-15T16:30:05Z", "end": "2026-01-15T16:30:05Z",
                    "issued": "2026-01-15T16:31:00Z", "timeZone": la, "source": "synthetic", "id": "  "}, "emptySampleID"),
    ]
    return {
        "observations-quantity.json": {"contractVersion": CONTRACT["contractVersion"], "cases": quantity},
        "observations-sleep.json": {"contractVersion": CONTRACT["contractVersion"], "cases": sleep},
        "errors.json": {"contractVersion": CONTRACT["contractVersion"], "cases": errors},
        "devices.json": {"contractVersion": CONTRACT["contractVersion"], "cases": device_cases()},
        "flags.json": {"contractVersion": CONTRACT["contractVersion"], "cases": flag_cases()},
        "meals.json": {"contractVersion": CONTRACT["contractVersion"], "cases": meal_cases()},
        **healthconnect_files(),
    }


def main():
    check = "--check" in sys.argv
    stale = []
    for name, content in build().items():
        text = json.dumps(content, indent=2, ensure_ascii=False) + "\n"
        path = os.path.join(HERE, name)
        if check:
            if not os.path.exists(path) or open(path).read() != text:
                stale.append(name)
        else:
            with open(path, "w") as f:
                f.write(text)
            print("wrote", name, "(%d cases)" % len(content.get("cases", content.get("properties", []))))
    if check:
        if stale:
            print("STALE golden fixtures (rerun generate.py):", ", ".join(stale))
            sys.exit(1)
        print("golden fixtures match the generator")


if __name__ == "__main__":
    main()
