#!/usr/bin/env python3
"""Generates the golden fixtures for the FHIR mapping (contract/golden/*.json).

This is a SECOND, INDEPENDENT implementation of the rules in contract/metrics.json: Python's own time-zone
database (zoneinfo), its own decimal arithmetic and its own SHA-256, nothing shared with the Swift mapper. The Swift
tests (ios/TemplateApplicationTests/Metrics) check the mapper against these files, so a bug has to be made twice,
identically, to slip through. All data is synthetic.

  python3 contract/golden/generate.py            rewrite the fixtures
  python3 contract/golden/generate.py --check    fail if the committed fixtures differ from what this would write

Requires Python 3.9+ (zoneinfo). The fixtures are committed; running this is only needed when the contract changes.
"""
import hashlib
import json
import os
import sys
from datetime import datetime, timezone
from decimal import ROUND_HALF_UP, Decimal
from zoneinfo import ZoneInfo

HERE = os.path.dirname(os.path.abspath(__file__))
CONTRACT = json.load(open(os.path.join(HERE, "..", "metrics.json")))
SYS = CONTRACT["systems"]
PATIENT = "example-patient"
SYN_DEVICE_REF = "Device/example-synthetic-device"


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


def observation(m, sample, code, display, value, unit, patient, device_ref):
    category = CONTRACT["categories"][m["category"]]
    start, end = utc(sample["start"]), utc(sample["end"])
    tz = sample["timeZone"]
    o = {
        "resourceType": "Observation",
        "meta": {"source": SYS["metaSource"][sample["source"]]},
        "identifier": [{"system": SYS["identifier"][sample["source"]],
                        "value": sample["id"].lower() if sample["source"] == "healthKit" else sample["id"]}],
        "status": CONTRACT["rules"]["status"],
        "category": [{"coding": [{"system": SYS["observationCategory"], "code": category["code"], "display": category["display"]}]}],
        "code": {"coding": [{"system": SYS["loinc"], "code": code, "display": display}]},
        "subject": {"reference": "Patient/" + patient},
        "issued": fmt(utc(sample["issued"]), tz, always_millis=True),
        "valueQuantity": {"value": value, "unit": unit["display"], "system": SYS["ucum"], "code": unit["ucum"]},
    }
    if m["effective"] == "instantOrPeriod" and start == end:
        o["effectiveDateTime"] = fmt(start, tz)
    else:
        o["effectivePeriod"] = {"start": fmt(start, tz), "end": fmt(end, tz)}
    if device_ref:
        o["device"] = {"reference": device_ref}
    return o


def quantity_case(name, note, metric_id, value, start, end, issued="2026-01-15T16:31:00Z", tz="America/Los_Angeles",
                  source="synthetic", sid="syn-000001", device_ref=SYN_DEVICE_REF):
    m = metric(metric_id)
    sample = {"metric": metric_id, "value": value, "start": start, "end": end, "issued": issued, "timeZone": tz,
              "source": source, "id": sid}
    return {"name": name, "note": note, "patientId": PATIENT, "deviceReference": device_ref, "sample": sample,
            "expected": observation(m, sample, m["loinc"]["code"], m["loinc"]["display"], number(value), m["unit"], PATIENT, device_ref)}


def sleep_case(name, note, stage, start, end, issued="2026-01-15T17:55:00Z", tz="America/Los_Angeles",
               source="synthetic", sid="syn-sleep-0001", device_ref=SYN_DEVICE_REF):
    m = metric("sleepStage")
    sample = {"metric": "sleepStage", "stage": stage, "start": start, "end": end, "issued": issued, "timeZone": tz,
              "source": source, "id": sid}
    case = {"name": name, "note": note, "patientId": PATIENT, "deviceReference": device_ref, "sample": sample}
    if stage in m["unmapped"]:
        case["expectedOutcome"] = "unmapped"
        return case
    stage_code = m["stages"][stage]
    seconds = (utc(end) - utc(start)).total_seconds()
    minutes = (Decimal(str(seconds)) / Decimal(60)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    case["expected"] = observation(m, sample, stage_code["code"], stage_code["display"], number(minutes), m["unit"], PATIENT, device_ref)
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
    ]


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
            print("wrote", name, "(%d cases)" % len(content["cases"]))
    if check:
        if stale:
            print("STALE golden fixtures (rerun generate.py):", ", ".join(stale))
            sys.exit(1)
        print("golden fixtures match the generator")


if __name__ == "__main__":
    main()
