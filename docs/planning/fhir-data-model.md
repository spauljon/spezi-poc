# FHIR Data Model: Clinical Longitudinal Monitoring POC

> Produced with `fhir-data-model-design`. Status: DRAFT for developer review.
> Terminology marked **[verified]** was checked on 2026-10-07 against NLM Clinical Tables (LOINC) or the published US Core v9.0.0 pages. Anything marked **[UNVERIFIED]** was not checked and must not be implemented without checking.
> All example data in this document is synthetic.

## Overview

| Field | Value |
|---|---|
| App | Capture app (Spezi mobile) -> HAPI FHIR (system of record) -> clinician web app; server-side aggregation into an analytic store |
| Use case | Clinical remote monitoring and longitudinal review |
| FHIR version | R4 (4.0.1) |
| Conformance | Base FHIR R4 only. **No `meta.profile` is declared on any resource** in this phase. Raw heart rate is shaped to be compatible with the R4 core profile `http://hl7.org/fhir/StructureDefinition/heartrate` (draft status in R4) **[verified]**, so a claim could be added later. **US Core is not a target**: it is built for EHR-originated, clinician-attested data and constrains Patient and Observation (and, if used, Provenance) in ways a patient-device stream does not fit. See "Decision: not conforming to US Core". |
| Additional IGs | None |
| Server | HAPI FHIR 7.6.0, R4. Target endpoint: `https://macpro16.local:8443/fhir` (TLS + authn planned as an early milestone). Current dev endpoint: `http://localhost:8092/fhir`. |
| Interoperability | Self-contained POC. If EHR exchange is ever needed, a mapping layer to US Core would be added at the boundary (see decision section). |
| Data sources | HealthKit (Apple Watch / iPhone) and a synthetic device, behind one ingest interface |
| Aggregates | NOT stored in FHIR. Computed server-side into a separate analytic store (Oracle). See "Analytic projection". |

## Conformance summary (read this first)

| Concept | Resource | Profile | Notes |
|---|---|---|---|
| Patient (single, fixed) | `Patient` | Base R4 | n/a |
| Heart rate (raw samples) | `Observation` | None declared (shaped to match `http://hl7.org/fhir/StructureDefinition/heartrate`) | n/a |
| Resting heart rate | `Observation` | Base R4 `Observation` + category `vital-signs` | n/a. The core `heartrate` profile also fixes `code` to 8867-4, so 40443-4 does not claim it. |
| HRV (SDNN) | `Observation` | Base R4 `Observation` + category `vital-signs` | n/a. See assumption A3. |
| Sleep stage intervals | `Observation` | Base R4 `Observation` + category `activity` | n/a. See assumption A5. |
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
| `identifier` | Identifier[] 1..* | `system` = `http://blueysoft.com/fhir/identifier/poc-patient`. |
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
| `meta.source` | uri 0..1 | Writing system: `http://blueysoft.com/fhir/capture-app/healthkit` or `...:synthetic` (A9). |

**Sample (synthetic):**

```json
{
  "resourceType": "Observation",
  "identifier": [{ "system": "http://blueysoft.com/fhir/identifier/synthetic-sample", "value": "syn-000001" }],
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
  "identifier": [{ "system": "http://blueysoft.com/fhir/identifier/synthetic-sample", "value": "syn-sleep-0001" }],
  "status": "final",
  "category": [{ "coding": [{ "system": "http://terminology.hl7.org/CodeSystem/observation-category", "code": "activity", "display": "Activity" }] }],
  "code": { "coding": [{ "system": "http://loinc.org", "code": "93831-6", "display": "Deep sleep duration" }] },
  "subject": { "reference": "Patient/example-patient" },
  "effectivePeriod": { "start": "2026-01-15T01:10:00-08:00", "end": "2026-01-15T01:52:00-08:00" },
  "valueQuantity": { "value": 42, "unit": "min", "system": "http://unitsofmeasure.org", "code": "min" },
  "device": { "reference": "Device/example-synthetic-device" }
}
```

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

### Provenance: not used

Decision: no `Provenance` resources. The ingest transaction and app version are not interesting enough to justify a second resource per batch. Lineage that matters is carried on the Observation itself:

| Question | Where it lives |
|---|---|
| Which device emitted it? | `Observation.device` -> `Device` |
| Which original sample? | `Observation.identifier` (HealthKit UUID or synthetic id) |
| When produced vs. received? | `Observation.issued` vs `meta.lastUpdated` |
| Which system wrote it (real vs. simulated)? | `Observation.meta.source` (URI), e.g. `http://blueysoft.com/fhir/capture-app/healthkit` or `http://blueysoft.com/fhir/capture-app/synthetic` (A9) |

Not tracked: which mapping-registry version produced the data. If a mapping later changes (e.g. the sleep-stage mapping, A4), add a `meta.tag` then. Re-adding Provenance would be additive.

## Terminology Bindings

| Resource | Field | System | Strength | Notes |
|---|---|---|---|---|
| `Observation` | `code` | LOINC `http://loinc.org` | required (heart rate, by profile); extensible elsewhere | All codes above **[verified]** except as noted |
| `Observation` | `category` | `http://terminology.hl7.org/CodeSystem/observation-category` | preferred | `vital-signs`, `activity` |
| `Observation` | `valueQuantity.system/code` | UCUM `http://unitsofmeasure.org` | required | `/min`, `ms`, `min` |
| `Observation` | `meta.tag` | Custom data-quality CodeSystem | n/a | A8 |
| `Device` | `type` | none in v1 | n/a | |

SNOMED CT is not used (no license or code lookup needed).

## Custom Code Systems

Namespace: `http://blueysoft.com/fhir` (decided). Form: `http://blueysoft.com/fhir/CodeSystem/<name>` and `http://blueysoft.com/fhir/identifier/<name>`. These are names, not endpoints, and need not resolve. FHIR compares `system` as an exact string, so the scheme (`http`, not `https`) and the case are permanent: never change them after the first write.

| Name | URI | Purpose |
|---|---|---|
| Data quality flag | `http://blueysoft.com/fhir/CodeSystem/data-quality-flag` | `artifact-suspected`, `duplicate-resolved`, `late-arrival` |
| Source kind | `http://blueysoft.com/fhir/CodeSystem/source-kind` | `healthkit`, `synthetic` |

| Identifier system | URI |
|---|---|
| HealthKit sample UUID | `http://blueysoft.com/fhir/identifier/healthkit-sample` |
| Synthetic sample id | `http://blueysoft.com/fhir/identifier/synthetic-sample` |
| Device key | `http://blueysoft.com/fhir/identifier/device-key` |

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

Base: `GET|POST {base}/...` where base is `http://localhost:8092/fhir` now, and the TLS host later.

### Capture app writes: transaction Bundle with conditional create

```
POST {base}   (Bundle type=transaction)
  entry[].request: { method: "POST", url: "Observation",
                     ifNoneExist: "identifier=http://blueysoft.com/fhir/identifier/healthkit-sample|<uuid>" }
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

Stored in Oracle (26ai, your instance; not installed by the agent). Grain and keys, for the build plan to refine:

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
| A7 | `Observation.issued` = capture-app production time; `meta.lastUpdated` = server time. | Late-arrival detection. |
| A8 | Data-quality flags as `meta.tag` with a custom CodeSystem. Alternatives: `Observation.interpretation`, `Observation.note`, `dataAbsentReason`. Flagged values are stored, not dropped. | How artifacts surface to clinicians. |
| A9 | No Provenance. Source system is recorded in `Observation.meta.source` as a placeholder URI scheme (`http://blueysoft.com/fhir/capture-app/{healthkit|synthetic}`), and mapping version is not tracked. | Can't tell which mapping version produced old data; can't group by ingest batch. |
| A10 | Cardinality: `Observation.value[x]` is always `valueQuantity` (1..1 in practice). No `component`, no `referenceRange`, no `interpretation` stored; reference bands are a UI concern. `performer` omitted (device-originated). | Search and UI don't depend on these. |
| A11 | Deleted HealthKit samples map to `status=entered-in-error` on the existing Observation (found by identifier), not hard delete. | Audit trail vs. clean data; HAPI delete semantics. |
| A12 | Namespace `http://blueysoft.com/fhir` is a domain the developer controls (not independently verified). It uses `http`, and string identity is permanent. | Changing it later means rewriting every stored `identifier.system` and `code.system`. |
| A13 | HAPI validates `meta.profile` claims only if request validation is enabled. Whether to enable it belongs to the HAPI TLS/auth project. **[UNVERIFIED]** for 7.6.0 configuration. | Profile claims are only as good as validation. |

## Implementation notes

- Volume: dense heart rate at ~1 sample / 5 s is ~17k Observations/day. Plan batching, HAPI paging, index strategy, and retention before the first real sync.
- `_total` and `_count` behavior in HAPI at that volume should be tested, not assumed.
- Terminology licensing: LOINC and UCUM are free; no SNOMED CT used.
- All fixtures and examples must be synthetic (CLAUDE.md data rules).
