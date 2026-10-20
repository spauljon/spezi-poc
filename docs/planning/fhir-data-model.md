# FHIR Data Model: Clinical Longitudinal Monitoring POC

> Produced with `fhir-data-model-design`. Status: DRAFT for developer review.
> Terminology marked **[verified]** was checked on 2026-10-07 against NLM Clinical Tables (LOINC) or the published US Core v9.0.0 pages. Anything marked **[UNVERIFIED]** was not checked and must not be implemented without checking.
> All example data in this document is synthetic.

## Overview

| Field            | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
|------------------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| App              | Capture app (Spezi mobile) -> HAPI FHIR (system of record) -> clinician web app; server-side aggregation into an analytic store                                                                                                                                                                                                                                                                                                                                                                                                  |
| Use case         | Clinical remote monitoring and longitudinal review                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| FHIR version     | R4 (4.0.1)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Conformance      | Base FHIR R4 only. **No `meta.profile` is declared on any resource** in this phase. Raw heart rate is shaped to be compatible with the R4 core profile `http://hl7.org/fhir/StructureDefinition/heartrate` (draft status in R4) **[verified]**, so a claim could be added later. **US Core is not a target**: it is built for EHR-originated, clinician-attested data and constrains Patient and Observation (and, if used, Provenance) in ways a patient-device stream does not fit. See "Decision: not conforming to US Core". |
| Additional IGs   | None                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Server           | HAPI FHIR 7.6.0, R4. Target endpoint: `https://macpro16.local:8443/fhir` (TLS + authn planned as an early milestone). HTTPS only since M2 (loopback-bound until M4).                                                                                                                                                                                                                                                                                                                                                             |
| Interoperability | Self-contained POC. If EHR exchange is ever needed, a mapping layer to US Core would be added at the boundary (see decision section).                                                                                                                                                                                                                                                                                                                                                                                            |
| Data sources     | HealthKit (Apple Watch / iPhone) and a synthetic device, behind one ingest interface                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Aggregates       | NOT stored in FHIR. Computed server-side into a separate analytic store (Oracle). See "Analytic projection".                                                                                                                                                                                                                                                                                                                                                                                                                     |

> **Nutrition (M20, contract 1.5.0):** dietary intake is part of this model (below). The reasoning, alternatives (including R5 `NutritionIntake`) and open items are in [nutrition-brief.md](nutrition-brief.md); contract assumptions A34 to A41 hold the detail.

## Conformance summary (read this first)

| Concept | Resource | Profile | Notes |
|---|---|---|---|
| Patient (single, fixed) | `Patient` | Base R4 | n/a |
| Heart rate (raw samples) | `Observation` | None declared (shaped to match `http://hl7.org/fhir/StructureDefinition/heartrate`) | n/a |
| Resting heart rate | `Observation` | Base R4 `Observation` + category `vital-signs` | n/a. The core `heartrate` profile also fixes `code` to 8867-4, so 40443-4 does not claim it. |
| HRV (SDNN) | `Observation` | Base R4 `Observation` + category `vital-signs` | n/a. See assumption A3. |
| Sleep stage intervals | `Observation` | Base R4 `Observation` + category `activity` | n/a. See assumption A5. |
| Dietary intake (eight nutrients) | `Observation` | Base R4 `Observation`; categories from the project's own `observation-domain` and `meal-type` systems | n/a. One per nutrient per food entry. See "Observation: dietary intake" and the nutrition brief. |
| Source device | `Device` | Base R4 `Device` | n/a |

## Decision: not conforming to US Core

Rationale. Verified on the US Core v9.0.0 pages (2026-10-07): the Heart Rate profile fixes the code to 8867-4 and requires a `us-core-patient` subject; the Provenance profile requires a `recorded` time and author/transmitter agents, with an organization as author. **[UNVERIFIED, from memory]:** US Core Patient's mandatory elements, and the absence of US Core profiles for HRV and sleep (I did not search the IG for them). The practical point stands without those: a patient-generated device stream has no Organization and no clinician attestation, so conformance would mean either failing validation or bending the model.

Consequences:
- Model is base R4 plus the R4 core `heartrate` profile where it fits. We keep the good parts of US Core as conventions (LOINC codes, UCUM units, `category`, `identifier`-based dedup), without claiming conformance.
- If EHR exchange is ever needed, map at the boundary (export or FHIR facade). Not in scope now.
- Validation: no profile claims, so HAPI validates base R4 structure only. Value-level rules (codes, units, required fields per metric) are enforced by the capture app's metric registry. No US Core package to load.
- **Re-opening this decision would change:** adding `meta.profile` claims and the Patient shape.

## Resources

### Patient: the monitored person

| Field | Value |
|---|---|
| Resource | `Patient` |
| Profile | Base R4 |
| Clinical use | One fixed, synthetic-identity patient for the POC. Never real identifiers. |

| Field | Type | Notes |
|---|---|---|
| `identifier` | Identifier[] 1..* | `system` = `http://aboutobjects.com/fhir/identifier/poc-patient`. |
| `name` | HumanName[] 0..* | Synthetic, optional. |

Multi-patient is a future extension: every Observation search uses `subject=Patient/{id}`; nothing may assume a single patient.

### Observation: heart rate (raw samples)

| Field | Value |
|---|---|
| Resource | `Observation` |
| Profile | None declared; shaped to match R4 core `heartrate` (fixed LOINC `8867-4`, UCUM `/min`, `vital-signs`, `valueQuantity`) |
| HealthKit source | `HKQuantityTypeIdentifier.heartRate` (unit count/min) |

| Field | Type | Notes |
|---|---|---|
| `identifier` | Identifier 1..1 (our rule) | Stable per-sample id for dedup: HealthKit sample UUID or synthetic sample id. Used with conditional create. |
| `status` | code 1..1 | `final`; `entered-in-error` if the source sample is later deleted. |
| `category` | CodeableConcept 1..* | `vital-signs`. |
| `code` | CodeableConcept 1..1 | Fixed by profile: LOINC `8867-4` "Heart rate" **[verified]**. Additional codings are allowed by the profile. |
| `subject` | Reference 1..1 | `Patient/{id}`. |
| `effective[x]` | dateTime or Period 1..1 | `effectiveDateTime` when sample start = end, else `effectivePeriod`. Offset required (see A6). |
| `issued` | instant 0..1 | Time the capture app produced the resource (not server receipt; `meta.lastUpdated` is server time). See A7. |
| `valueQuantity` | Quantity 1..1 (ours) | `value` decimal, `unit` `/min`, `system` `http://unitsofmeasure.org`, `code` `/min` (profile-fixed). |
| `device` | Reference(Device) 0..1 | The emitting device. |
| `meta.tag` | Coding 0..* | Optional data-quality flags (A8). |
| `meta.source` | uri 0..1 | Writing system: `http://aboutobjects.com/fhir/capture-app/healthkit` or `...:synthetic` (A9). |

**Sample (synthetic):**

```json
{
  "resourceType": "Observation",
  "identifier": [{ "system": "http://aboutobjects.com/fhir/identifier/synthetic-sample", "value": "syn-000001" }],
  "status": "final",
  "category": [{ "coding": [{ "system": "http://terminology.hl7.org/CodeSystem/observation-category", "code": "vital-signs", "display": "Vital Signs" }] }],
  "code": { "coding": [{ "system": "http://loinc.org", "code": "8867-4", "display": "Heart rate" }] },
  "subject": { "reference": "Patient/example-patient" },
  "effectiveDateTime": "2026-01-15T08:30:05-08:00",
  "issued": "2026-01-15T08:31:00.000-08:00",
  "valueQuantity": { "value": 72, "unit": "/min", "system": "http://unitsofmeasure.org", "code": "/min" },
  "device": { "reference": "Device/example-synthetic-device" }
}
```

### Observation: resting heart rate

| Field | Value |
|---|---|
| Profile | Base R4 `Observation` (not the core `heartrate` profile; see Conformance summary) |
| HealthKit source | `HKQuantityTypeIdentifier.restingHeartRate` |
| `code` | LOINC `40443-4` "Heart rate --resting" **[verified]** |
| `category` | `vital-signs` (A3) |
| `valueQuantity` | UCUM `/min` |
| `effective[x]` | `effectivePeriod` when HealthKit supplies a span, else `effectiveDateTime`. One sample per day expected (A6: which "day"). |

Other fields as heart rate. Same `identifier`, `status`, `subject`, `device` rules.

### Observation: heart rate variability (SDNN)

| Field | Value |
|---|---|
| Profile | Base R4 `Observation` |
| HealthKit source | `HKQuantityTypeIdentifier.heartRateVariabilitySDNN` |
| `code` | LOINC `112429-6` "Heart rate variability SDNN [Time]" **[verified]**. Alternative considered: `80404-7` "R-R interval.standard deviation (Heart rate variability)" **[verified]**, more generic. |
| `category` | `vital-signs` (A3) |
| `valueQuantity` | UCUM `ms` **[UNVERIFIED: LOINC `EXAMPLE_UCUM_UNITS` was empty in the lookup; `ms` is the unit HealthKit reports]** |

### Observation: sleep stage interval

One Observation per HealthKit sleep-analysis sample (an interval in a stage). This preserves the hypnogram; nightly summaries are computed in the analytic store, not stored in FHIR.

| Field | Value |
|---|---|
| Profile | Base R4 `Observation` |
| HealthKit source | `HKCategoryTypeIdentifier.sleepAnalysis` (`HKCategoryValueSleepAnalysis`) |
| `category` | `activity` (A5) |
| `effectivePeriod` | 1..1, the stage interval (start/end with offset) |
| `valueQuantity` | Duration of the interval, UCUM `min`, derived from the period |

Stage mapping (every row below is an assumption, A4 and A5):

| HealthKit value | LOINC code | Display **[verified]** | Note |
|---|---|---|---|
| `asleepCore` | `93830-8` | Light sleep duration | Apple "Core" mapped to "light": **assumption A4** |
| `asleepDeep` | `93831-6` | Deep sleep duration | |
| `asleepREM` | `93829-0` | REM sleep duration | |
| `asleepUnspecified` | `93832-4` | Sleep duration | Stage not known |
| `awake` | `103210-1` | Awakening duration | Alternative: `93828-2` "Nighttime awakening duration" **[verified]**; picked the more generic one: **A4** |
| `inBed` | none chosen | | **No verified code. Not stored as an Observation in v1; decision needed (A4).** |

**Sample (synthetic):**

```json
{
  "resourceType": "Observation",
  "identifier": [{ "system": "http://aboutobjects.com/fhir/identifier/synthetic-sample", "value": "syn-sleep-0001" }],
  "status": "final",
  "category": [{ "coding": [{ "system": "http://terminology.hl7.org/CodeSystem/observation-category", "code": "activity", "display": "Activity" }] }],
  "code": { "coding": [{ "system": "http://loinc.org", "code": "93831-6", "display": "Deep sleep duration" }] },
  "subject": { "reference": "Patient/example-patient" },
  "effectivePeriod": { "start": "2026-01-15T01:10:00-08:00", "end": "2026-01-15T01:52:00-08:00" },
  "issued": "2026-01-15T09:55:00.000-08:00",
  "valueQuantity": { "value": 42, "unit": "min", "system": "http://unitsofmeasure.org", "code": "min" },
  "device": { "reference": "Device/example-synthetic-device" }
}
```

### Observation: dietary intake (eight nutrients)

One `Observation` per nutrient per food entry (FHIR R4 has no food-intake resource; `NutritionIntake` exists only from R5, see the brief). Same shape as the heart-rate Observation (`identifier` for dedup, `status` `final`, `effectiveDateTime` with offset, `issued`, `valueQuantity`, `device`, `meta.source`), with these differences:

| Field | Notes |
|---|---|
| `category` | **Separate entries, not one concept with several codings** (a `CodeableConcept`'s codings are translations of one concept): first the domain, `{observation-domain, nutrition}`; then, **only when the source supplied a meal**, `{meal-type, breakfast / lunch / dinner / snack / other}` with `text` holding the label as written. HL7's `observation-category` is not used (it has no dietary code). Never depend on an entry's position. |
| `code` | LOINC where a code exists; otherwise the project's `nutrient` system with the display in `text` (table below) |
| `valueQuantity` | UCUM; **zero is a valid value** (a food can contain none of a nutrient); negative is refused; a missing nutrient is simply absent |
| `device` | the **source application** (no `HKDevice`): see Device below |
| `meta.tag` | the data-quality flags as for every metric; a value outside its per-entry `plausibleRange` is `artifact-suspected`, stored as given |

| Nutrient | `code` | Unit (UCUM) | Notes |
|---|---|---|---|
| Energy | LOINC `9052-2` Calorie intake total | `kcal` | LOINC's property is an energy rate, not an amount (A35) |
| Protein | LOINC `9079-5` Protein intake Estimated | `g` | *Estimated* because the figures come from a food database |
| Carbohydrate | LOINC `9059-7` Carbohydrate intake Estimated | `g` | |
| Total fat | LOINC `9066-2` Fat intake Estimated | `g` | |
| Water | LOINC `8984-7` Fluid intake Estimated | `mL` | wider than water (A36) |
| Fiber | `nutrient|fiber` | `g` | no per-entry LOINC code (A37) |
| Sugar | `nutrient|sugar` | `g` | no usable LOINC code (A37) |
| Sodium | `nutrient|sodium` | `mg` | LOINC's sodium intake is in mmol; not converted (A37) |

**Sample (synthetic):**

```json
{
  "resourceType": "Observation",
  "identifier": [{ "system": "http://aboutobjects.com/fhir/identifier/healthkit-sample", "value": "b0000000-0000-4000-8000-000000000008" }],
  "status": "final",
  "category": [
    { "coding": [{ "system": "http://aboutobjects.com/fhir/CodeSystem/observation-domain", "code": "nutrition", "display": "Nutrition" }] },
    { "coding": [{ "system": "http://aboutobjects.com/fhir/CodeSystem/meal-type", "code": "lunch" }], "text": "Lunch" }
  ],
  "code": { "coding": [{ "system": "http://aboutobjects.com/fhir/CodeSystem/nutrient", "code": "sodium" }], "text": "Dietary sodium" },
  "subject": { "reference": "Patient/example-patient" },
  "effectiveDateTime": "2026-01-15T11:30:00-08:00",
  "issued": "2026-01-15T11:31:00.000-08:00",
  "valueQuantity": { "value": 620, "unit": "mg", "system": "http://unitsofmeasure.org", "code": "mg" },
  "device": { "reference": "Device/example-app" }
}
```

**Searches verified on HAPI 7.6.0** (M20, `contract/verify-hapi.py`, each with a zero-result control): `category=<domain>|nutrition`, `category=<meal-type>|lunch`, both `category` parameters together, `code=<nutrient>|fiber`, `code=http://loinc.org|9052-2`, and `Device?identifier=<app-bundle-id>|<id>`. A literal `|` in a query string must be percent-encoded (the servlet container answers 400 otherwise).

**Not yet built:** retraction of an edited or deleted entry (M21), daily totals by day as recorded (M22), the clinician view (M23).

### Device: the source

| Field | Value |
|---|---|
| Resource | `Device` |
| Profile | Base R4 |
| Use | One Device per distinct source (Apple Watch model, iPhone, synthetic simulator), deduplicated by identifier. |

| Field | Type | Notes |
|---|---|---|
| `identifier` | Identifier 1..1 (ours) | Derived key: hash of HealthKit `HKDevice` fields (name, manufacturer, model, hardware/software version), or fixed id for the synthetic device. |
| `status` | code | `active` |
| `manufacturer` | string | From `HKDevice.manufacturer` |
| `deviceName` | BackboneElement | `name`, `type` = `model-name` |
| `modelNumber` | string | From `HKDevice.model` |
| `version` | BackboneElement | Software/hardware versions, if present |
| `patient` | Reference | `Patient/{id}` |
| `type` | CodeableConcept | **[UNVERIFIED]** no SNOMED code chosen for device type; leave out in v1 and mark source kind in a custom code (see Custom Code Systems). |

**Source application (D6, M20).** A sample with **no `HKDevice`** (all MyFitnessPal data) comes from an application, and its Device is described by that application: `deviceName` = the display name with type **`other`** (no `DeviceNameType` code covers a software brand; `user-friendly-name` is the nearest); `identifier` = the device key **and** a second identifier, `app-bundle-id`, holding the app's reverse-DNS bundle identifier; no manufacturer, model or version. The key is **derived from the bundle identifier** (SHA-256 over `app`, U+001F and the identifier), so one app is one Device under any display name; without a bundle identifier the earlier name-only key rule applies. A Device made by the earlier rule is not merged with the new one (accepted: a Device's identity is its key, and the capture role cannot update).

### Provenance: not used

Decision: no `Provenance` resources. The ingest transaction and app version are not interesting enough to justify a second resource per batch. Lineage that matters is carried on the Observation itself:

| Question | Where it lives |
|---|---|
| Which device emitted it? | `Observation.device` -> `Device` |
| Which original sample? | `Observation.identifier` (HealthKit UUID or synthetic id) |
| When produced vs. received? | `Observation.issued` vs `meta.lastUpdated` |
| Which system wrote it (real vs. simulated)? | `Observation.meta.source` (URI), e.g. `http://aboutobjects.com/fhir/capture-app/healthkit` or `http://aboutobjects.com/fhir/capture-app/synthetic` (A9) |

Not tracked: which mapping-registry version produced the data. If a mapping later changes (e.g. the sleep-stage mapping, A4), add a `meta.tag` then. Re-adding Provenance would be additive.

## Terminology Bindings

| Resource | Field | System | Strength | Notes |
|---|---|---|---|---|
| `Observation` | `code` | LOINC `http://loinc.org` | required (heart rate, by profile); extensible elsewhere | All codes above **[verified]** except as noted |
| `Observation` | `category` | `http://terminology.hl7.org/CodeSystem/observation-category` | preferred | `vital-signs`, `activity` |
| `Observation` | `valueQuantity.system/code` | UCUM `http://unitsofmeasure.org` | required | `/min`, `ms`, `min`, `kcal`, `g`, `mg`, `mL` |
| `Observation` | `category` (dietary intake) | Custom `observation-domain` and `meal-type` systems | n/a | separate entries; HL7's set has no dietary category |
| `Observation` | `code` (fiber, sugar, sodium) | Custom `nutrient` system | n/a | no per-entry LOINC code |
| `Observation` | `meta.tag` | Custom data-quality CodeSystem | n/a | A8 |
| `Device` | `type` | none in v1 | n/a | |

SNOMED CT is not used (no license or code lookup needed).

## Custom Code Systems

Namespace: `http://aboutobjects.com/fhir` (decided). Form: `http://aboutobjects.com/fhir/CodeSystem/<name>` and `http://aboutobjects.com/fhir/identifier/<name>`. These are names, not endpoints, and need not resolve. FHIR compares `system` as an exact string, so the scheme (`http`, not `https`) and the case are permanent: never change them after the first write.

| Name | URI | Purpose |
|---|---|---|
| Data quality flag | `http://aboutobjects.com/fhir/CodeSystem/data-quality-flag` | `artifact-suspected`, `duplicate-resolved`, `late-arrival` |
| Source kind | `http://aboutobjects.com/fhir/CodeSystem/source-kind` | `healthkit`, `synthetic` |
| Observation domain | `http://aboutobjects.com/fhir/CodeSystem/observation-domain` | what kind of data: a taxonomy of the form `vital-signs`, `laboratory`, `daily-activity-summary`, `workout`, `nutrition`; only `nutrition` is used so far |
| Meal type | `http://aboutobjects.com/fhir/CodeSystem/meal-type` | `breakfast`, `lunch`, `dinner`, `snack`, `other` |
| Nutrient | `http://aboutobjects.com/fhir/CodeSystem/nutrient` | `fiber`, `sugar`, `sodium` (the nutrients with no per-entry LOINC code) |

| Identifier system | URI |
|---|---|
| HealthKit sample UUID | `http://aboutobjects.com/fhir/identifier/healthkit-sample` |
| Synthetic sample id | `http://aboutobjects.com/fhir/identifier/synthetic-sample` |
| Device key | `http://aboutobjects.com/fhir/identifier/device-key` |
| App bundle identifier | `http://aboutobjects.com/fhir/identifier/app-bundle-id` |

## Resource Relationships

```
Patient
  ^ subject
Observation (HR | resting HR | HRV | sleep interval)
  | device --> Device (Watch | iPhone | synthetic)
```

| Reference | From | To | Cardinality |
|---|---|---|---|
| `subject` | `Observation` | `Patient` | 1..1 |
| `device` | `Observation` | `Device` | 0..1 |
| `patient` | `Device` | `Patient` | 0..1 |

## FHIR REST API Patterns

Base: `GET|POST {base}/...` where base is `https://macpro16.local:8443/fhir` (loopback-bound until M4), and the TLS host later.

### Capture app writes: transaction Bundle with conditional create

```
POST {base}   (Bundle type=transaction)
  entry[].request: { method: "POST", url: "Observation",
                     ifNoneExist: "identifier=http://aboutobjects.com/fhir/identifier/healthkit-sample|<uuid>" }
```
Re-sending the same sample is then a no-op. Include Device (conditional create by `device-key`) in the same Bundle.

### Clinician web app reads

```
# Intraday dense view (one day, paged)
GET Observation?subject=Patient/{id}&code=http://loinc.org|8867-4
    &date=ge2026-01-15T00:00:00-08:00&date=lt2026-01-16T00:00:00-08:00&_sort=date&_count=1000

# Flowsheet (filter + sort, any metric)
GET Observation?subject=Patient/{id}&category=vital-signs&date=ge...&_sort=-date&_count=100

# Latest value per metric (patient banner)
GET Observation/$lastn?subject=Patient/{id}&category=vital-signs

# Sleep intervals for one night
GET Observation?subject=Patient/{id}&code=http://loinc.org|93829-0,http://loinc.org|93830-8,http://loinc.org|93831-6,http://loinc.org|93832-4,http://loinc.org|103210-1&date=ge...&date=lt...&_sort=date
```

Trend bands (daily min/median/max) and nightly sleep summaries are **not** FHIR queries; they come from the analytic store through its own API.

## Data Flows

1. **Capture and ingest:** source (HealthKit or synthetic) -> metric registry (type -> LOINC, UCUM unit, category, effective rule) -> validation/normalization -> local queue -> transaction Bundle with conditional create -> HAPI. The local queue gives offline tolerance and retry.
2. **Late and duplicate data:** a late sample arrives with its true `effective[x]` and a later `issued` and `meta.lastUpdated`. Duplicates are absorbed by conditional create on `identifier`.
3. **Analytic feed:** a worker polls HAPI by `Observation?_lastUpdated=gt{watermark}`, records which (patient, metric, local day) windows were touched, and recomputes those windows idempotently in the analytic store. `_lastUpdated` is server ingest time, so late-arriving samples are picked up naturally. HAPI subscriptions are an alternative trigger, **[UNVERIFIED]** for 7.6.0.
4. **Clinician review:** web app reads patient/latest/raw from FHIR, and aggregates from the analytic API.

## Analytic projection (non-FHIR)

Stored in Oracle (26ai, your instance; not installed by the agent) in an `ANALYTICS` PDB separate from HAPI's `FHIR` PDB; the worker reads HAPI only through the FHIR API. Grain and keys, for the build plan to refine:

| Concept | Notes |
|---|---|
| Daily rollup | Key: (patient, metric code, local day, timezone). Columns: n, min, median, max, first/last effective, computed_at, source watermark. |
| Sleep night summary | Key: (patient, night). Duration per stage, awakenings, in-bed vs asleep. |
| Recompute | Triggered by touched windows (flow 3). Idempotent upsert; recompute is the same code path as first computation. |
| Day definition | Patient-local day at the time of the sample. A6. |

Edition limits for CPU, RAM and data size should be checked for your specific Oracle edition **[UNVERIFIED]**, since dense heart rate across months is the main sizing driver.

## Assumptions to review (CLAUDE.md: flag terminology and cardinality)

| # | Assumption | Why it matters |
|---|---|---|
| A1 | Base R4 (4.0.1) only; the R4 core `heartrate` profile is draft status and may change. US Core is deliberately not a target (see decision). | Profile stability, future EHR exchange. |
| A2 | Resting HR uses LOINC `40443-4` and does not claim the core `heartrate` profile (fixed code `8867-4`). | Profile validation would reject the claim. |
| A3 | HRV and resting HR use category `vital-signs`. FHIR's vital-signs set does not include HRV, so this is a pragmatic choice. `exam` or `activity` are alternatives. | Affects search by category. |
| A4 | Sleep stage mapping: Apple "Core" = LOINC "Light sleep"; `awake` = `103210-1`; `inBed` has no verified code. The "Core vs light" equivalence is a clinical judgment, not a standard mapping. | Mislabeling stages in a clinical view. |
| A5 | Sleep uses category `activity`, each stage as a duration-valued Observation over `effectivePeriod`. Alternatives: a single nightly Observation with components, or a `Procedure`-like model. **[UNVERIFIED]** whether a better-fitting standard modeling exists. | Determines hypnogram queries and size. |
| A6 | `effective[x]` carries a timezone offset. HealthKit samples carry absolute times and sometimes a timezone in metadata; where absent, the offset used is the device's at ingest, which can be wrong across travel or DST. "Day" for aggregation uses patient-local time. | Daily boundaries, DST edge cases. |
| A7 | `Observation.issued` = capture-app production time; `meta.lastUpdated` = server time. **On every Observation, including sleep intervals** (the sleep sample printed above omitted it until M6 found the disagreement while testing the mapper against the spec). | Late-arrival detection. |
| A8 | Data-quality flags as `meta.tag` with a custom CodeSystem. **Written by the capture app at ingest (M19, contract 1.4.0)**: artifact-suspected (a value outside the metric's plausible range), late-arrival (issued more than 24 h after the sample ended), duplicate-resolved (two deliveries met in the queue before upload), user-entered. Absence of a flag means none stored, never "verified". See contract A30 to A33. Alternatives: `Observation.interpretation`, `Observation.note`, `dataAbsentReason`. Flagged values are stored, not dropped. | How artifacts surface to clinicians. |
| A9 | No Provenance. Source system is recorded in `Observation.meta.source` as a placeholder URI scheme (`http://aboutobjects.com/fhir/capture-app/{healthkit|synthetic}`), and mapping version is not tracked. | Can't tell which mapping version produced old data; can't group by ingest batch. |
| A10 | Cardinality: `Observation.value[x]` is always `valueQuantity` (1..1 in practice). No `component`, no `referenceRange`, no `interpretation` stored; reference bands are a UI concern. `performer` omitted (device-originated). | Search and UI don't depend on these. |
| A11 | Deleted HealthKit samples map to `status=entered-in-error` on the existing Observation (found by identifier), not hard delete. | Audit trail vs. clean data; HAPI delete semantics. |
| A12 | Namespace `http://aboutobjects.com/fhir` is a domain the developer controls (not independently verified). It replaced the developer's earlier placeholder domain on 2026-10-20, together with a full stack reset (stored data was not migrated). It uses `http`, and string identity is permanent. | Changing it later means rewriting every stored `identifier.system` and `code.system`. |
| A13 | HAPI validates `meta.profile` claims only if request validation is enabled. Whether to enable it belongs to the HAPI TLS/auth project. **[UNVERIFIED]** for 7.6.0 configuration. | Profile claims are only as good as validation. |
| A14 | **Dietary intake** (M20): the decisions and the unverified points are in the nutrition brief (N1 to N12) and the contract's assumptions A34 to A41: energy's LOINC property is a rate; water maps to fluid intake; fiber, sugar and sodium use custom codes; the meal-label normalization is a guess at how sources name meals; zero is valid; a source application is a Device keyed by bundle identifier. | Terminology fidelity and interoperability of nutrition data. |

## Implementation notes

- Volume: dense heart rate at ~1 sample / 5 s is ~17k Observations/day. Plan batching, HAPI paging, index strategy, and retention before the first real sync.
- `_total` and `_count` behavior in HAPI at that volume should be tested, not assumed.
- Terminology licensing: LOINC and UCUM are free; no SNOMED CT used.
- All fixtures and examples must be synthetic (CLAUDE.md data rules).
