# Nutrition metrics: planning brief

Extends [fhir-data-model.md](fhir-data-model.md) (which stays authoritative for everything already built). Written 2026-10-16 with the developer's decisions of that day. Planning only: no application code until the developer has reviewed this and the M20 to M23 entries in [../implementation-plan.md](../implementation-plan.md).

## Status

**M20 built and verified (2026-10-19):** the contract (1.5.0), the golden fixtures, the iOS mapping, the source-application Device and a synthetic meal generator, with the live searches below. Not built: the HealthKit collectors and retraction (M21), daily totals (M22), the web view (M23). Differences from the plan below: the domain coding carries a `display` ("Nutrition") from the contract; the three nutrient custom codes carry the display in `code.text`, not in the coding; the intake metrics are `kind: "intake"` in the contract so existing consumers (analytics, web) ignore them until M22 and M23; a negative intake is refused with its own error (`negativeValue`).

**M22 built and verified (2026-10-20):** daily totals per nutrient by day as recorded, overall and by meal (the Analytics section above, as built: table `nutrition_daily`, `GET /v1/nutrients`, `GET /v1/patients/{id}/nutrition`), checked against an independent sum on the synthetic and on the real data. Differences from the plan above: "revision" and "computed-at" are kept per row and the API reports the day's largest revision; the totals sum every source app's entries (a per-source split is possible later, from the stored source `Device`); first and last entry are UTC instants, so a local clock time is not served; and a new metric needs `make analytics-rescan` once to backfill data written before the worker knew its code.

**M23 built and verified (2026-10-20):** the Nutrition tab in the web app, as described under Web above: daily totals by day as recorded, gaps shown as gaps, split by meal, an energy and macronutrient table with estimated shares labelled as estimates, flags in words and on the chart, the data-set switch honoured. Differences from the plan above: time of day is not shown (the API serves UTC instants, not the recorded offset, so a local clock time cannot be shown honestly); averages are over days with entries only and labelled so; the range ends on today's date in UTC (a later recorded date east of UTC appears once UTC reaches it).

## Goal

Read dietary data that MyFitnessPal (MFP) writes to Apple Health, carry it through the same pipeline as the existing metrics (iOS ingest, HAPI FHIR, analytics, clinician web), and show **daily totals**. The data is the developer's own HealthKit data: the real-data rules of the root CLAUDE.md apply unchanged (own HAPI only, TLS and token, never in the repo, logs, fixtures or conversation).

## Decisions taken (2026-10-16)

| # | Decision | Consequence |
|---|---|---|
| D1 | All eight nutrients in the first version: energy, protein, carbohydrate, total fat, fiber, sugar, sodium, water | Four have a standard LOINC code; four need a custom code (below). More terminology assumptions to review. |
| D2 | MFP edits and deletions are handled by a **narrow HAPI rule**: the capture role may set `status` to `entered-in-error` on its own Observations, and nothing else | A deliberate relaxation of "capture-writer is create/read only" (milestone 4). It also lets the M17 recorded-but-unapplied deletions be applied (assumption A11 finally implementable). |
| D3 | A nutrition entry belongs to the **day as recorded** (the date part of its own timestamp, in its own offset) | Nutrition daily totals use a different day rule from the existing UTC-day rollups (A6); views must say so. |
| D4 | Milestones **M20 to M23, after M19** | M19 (data-quality surfacing and hardening) is finished first. |
| D5 | **Category and meal type (decided 2026-10-17):** nutrition Observations carry a `category` entry from a custom **domain** system (`nutrition`), plus a separate **meal-type** entry when MFP supplied a label. HL7 `activity` is **not** used for nutrition | One new domain system and one meal system (three custom systems with `nutrient`); adds a mealType field to the contract in M20, a filter in the API, a by-meal breakdown in the view. See "Category and meal type" below |
| D6 | **Source application (decided 2026-10-17):** a sample with no `HKDevice` gets a `Device` named by the source app's display name (name type `other`) and keyed by its **bundle identifier**, which is also stored as a second identifier | Contract change in M20 (new key rule for app-sourced Devices); new Devices on any server that holds old ones (accepted, no migration) |

## What HealthKit provides

| Nutrient | HealthKit identifier | Unit read in (explicit, never locale) | UCUM |
|---|---|---|---|
| Energy | `HKQuantityTypeIdentifierDietaryEnergyConsumed` | kilocalorie | `kcal` |
| Protein | `...DietaryProtein` | gram | `g` |
| Carbohydrate | `...DietaryCarbohydrates` | gram | `g` |
| Total fat | `...DietaryFatTotal` | gram | `g` |
| Fiber | `...DietaryFiber` | gram | `g` |
| Sugar | `...DietarySugar` | gram | `g` |
| Sodium | `...DietarySodium` | milligram | `mg` |
| Water | `...DietaryWater` | milliliter | `mL` |

- One logged food is expected to produce **several samples** (one per nutrient) at the same instant **[UNVERIFIED]**. They are not linked by an id we know of. HealthKit's `food` correlation exists but is not needed to recover the meal (next bullet).
- **Observed 2026-10-17, on one calcium sample's detail page in Health (structure only; no value is recorded here):** the sample's metadata carries a **meal label, written under two keys that differ only in case (`meal` and `Meal`) with the same content**. So MFP does write the meal (breakfast, lunch and so on) as sample metadata; Apple Health's daily charts hide it, the samples keep it. The exact key names, the set of possible values and whether MFP lets a user rename meals are **[UNVERIFIED]** (see the M21 structure probe).
- **Observed on the same sample:** its date has zero seconds and "Date Added to Health" is a few seconds later, which is **consistent with the instant being when the entry was logged**, not a default time per meal. One sample is not proof (see N5).
- **MFP writes nutrients beyond our eight** (calcium was seen: the full label, presumably vitamins and minerals too). Those are outside D1: no collector is registered for them, and nothing in the mapper reads them.
- An MFP edit is, in HealthKit, a **delete of the old samples and a write of new ones** (new UUIDs). The app learns of the deletion from `handleDeletedObjects` (UUIDs only). This is why D2 exists: without it, an edited entry is counted twice.
- MFP writes only entries logged **after** Apple Health was connected (MFP's help page says it cannot push history), so there is no old data to backfill beyond that.

## FHIR representation

**Resource: `Observation`**, one per nutrient sample, exactly like the existing metrics (FHIR R4 has no food-intake resource; `NutritionIntake` exists only from R5, and `NutritionOrder` is an order, not a record). Shape follows the heart-rate Observation of fhir-data-model.md: `identifier` (HealthKit sample UUID, system `.../identifier/healthkit-sample`) for conditional-create dedup, `status` `final`, `subject` the `poc-real` Patient, `effectiveDateTime` (start = end) with offset, `issued`, `valueQuantity` (UCUM), `device`, `meta.source`.

**Profile:** none declared (base R4), as for the other metrics.

**Category:** a custom domain code (`nutrition`) and, when MFP supplied one, a meal-type code, each its own `category` entry (see "Category and meal type"). HL7's `observation-category` has no dietary code, so `activity` is deliberately not used for nutrition.

### Codes

| Nutrient | `code` | Status |
|---|---|---|
| Energy | LOINC `9052-2` "Calorie intake total" | **Verified to exist** (NLM LOINC tables, 2026-10-16). Property is *energy rate* (see N1). |
| Protein | LOINC `9079-5` "Protein intake Estimated" | Verified to exist (mass). *Estimated*, not *Measured* (`9080-3`): the figures come from a food database. |
| Carbohydrate | LOINC `9059-7` "Carbohydrate intake Estimated" | Verified to exist (mass). Measured variant is `9060-5`. |
| Total fat | LOINC `9066-2` "Fat intake Estimated" | Verified to exist (mass). Measured variant is `9067-0`. |
| Water | LOINC `8984-7` "Fluid intake Estimated" (volume) | Verified to exist. **Broader concept** than water (see N3). |
| Fiber | custom `fiber` | LOINC has only 24-hour rate codes (`81133-1`, `81057-2`); a single entry is not a 24-hour rate. |
| Sugar | custom `sugar` | No usable LOINC found (only a deprecated PhenX measure `62262-1`). |
| Sodium | custom `sodium` | LOINC sodium intake (`9086-0`, `9087-8`) measures *amount of substance* (mmol) and the other codes are 24-hour rates; converting HealthKit's mg to mmol would change the stored value, so the value is kept in mg under a custom code. |

**New custom code systems** (namespace as decided in A12; names are permanent once written): `http://aboutobjects.com/fhir/CodeSystem/nutrient` (codes `fiber`, `sugar`, `sodium`), `.../observation-domain` (`nutrition`) and `.../meal-type` (see "Category and meal type"). `code.text` carries the display. For LOINC-coded nutrients the Observation carries the LOINC coding only.

**UCUM:** `kcal`, `[Cal]`, `cal`, `g`, `mg` and `mL` are all valid UCUM strings (checked on the NLM UCUM service, 2026-10-16). `kcal` is chosen to match HealthKit's kilocalorie.

### Sample (synthetic)

```json
{
  "resourceType": "Observation",
  "identifier": [{ "system": "http://aboutobjects.com/fhir/identifier/healthkit-sample", "value": "00000000-0000-4000-8000-000000000001" }],
  "status": "final",
  "category": [
    { "coding": [{ "system": "http://aboutobjects.com/fhir/CodeSystem/observation-domain", "code": "nutrition" }] },
    { "coding": [{ "system": "http://aboutobjects.com/fhir/CodeSystem/meal-type", "code": "lunch" }], "text": "Lunch" }
  ],
  "code": { "coding": [{ "system": "http://loinc.org", "code": "9052-2", "display": "Calorie intake total" }] },
  "subject": { "reference": "Patient/example-real" },
  "effectiveDateTime": "2026-01-15T19:30:00-05:00",
  "issued": "2026-01-15T19:31:00.000-05:00",
  "valueQuantity": { "value": 450, "unit": "kcal", "system": "http://unitsofmeasure.org", "code": "kcal" },
  "device": { "reference": "Device/example-source-app" }
}
```

```json
{
  "resourceType": "Observation",
  "identifier": [{ "system": "http://aboutobjects.com/fhir/identifier/healthkit-sample", "value": "00000000-0000-4000-8000-000000000002" }],
  "status": "final",
  "category": [
    { "coding": [{ "system": "http://aboutobjects.com/fhir/CodeSystem/observation-domain", "code": "nutrition" }] }
  ],
  "code": { "coding": [{ "system": "http://aboutobjects.com/fhir/CodeSystem/nutrient", "code": "sodium" }], "text": "Dietary sodium" },
  "subject": { "reference": "Patient/example-real" },
  "effectiveDateTime": "2026-01-15T19:30:00-05:00",
  "issued": "2026-01-15T19:31:00.000-05:00",
  "valueQuantity": { "value": 620, "unit": "mg", "system": "http://unitsofmeasure.org", "code": "mg" },
  "device": { "reference": "Device/example-source-app" }
}
```

### Device (decision D6, 2026-10-17)

MFP samples carry **no `HKDevice`**; they come from a *source application*. This also settles the open M18 finding (a name taken from the source app was typed `model-name`). The source app is described by two fields HealthKit supplies, which correspond to the two a Validic-style source field carries (a brand name, or a reverse-DNS name):

| HealthKit | Meaning | Becomes |
|---|---|---|
| `HKSource.name` | the app's display name (for example the brand) | `Device.deviceName` with **type `other`** (no `DeviceNameType` code covers a software brand: `user-friendly-name` is the nearest, `other` is the strictly safe choice, and `other` matches the developer's existing mapping of source-app names) |
| `HKSource.bundleIdentifier` | the iOS app's **bundle identifier**: a unique, developer-assigned reverse-domain id (`com.<developer>.<product>`, `CFBundleIdentifier`), unchanged by renames and translations | a second `Device.identifier`, system `http://aboutobjects.com/fhir/identifier/app-bundle-id`, **and the basis of the device key** |

```json
{
  "resourceType": "Device",
  "identifier": [
    { "system": "http://aboutobjects.com/fhir/identifier/device-key", "value": "<hash>" },
    { "system": "http://aboutobjects.com/fhir/identifier/app-bundle-id", "value": "com.example.nutritionapp" }
  ],
  "status": "active",
  "deviceName": [{ "name": "Example Nutrition App", "type": "other" }],
  "patient": { "reference": "Patient/example-real" }
}
```

- **Key rule.** For a Device with no `HKDevice`, the key is derived from the bundle identifier (a new, documented algorithm in the contract), so one app stays one Device across renames. The five-field key for Watch and iPhone Devices is unchanged.
- **Accepted consequence (developer, 2026-10-17).** A Device's identity is its key, so a new key algorithm produces new Devices: a server that already holds an app-sourced Device made by the old, name-based rule gets a second Device for the same app, and old Observations keep pointing at the old one. This is unavoidable and accepted. Devices are never merged or updated (the capture role is create-only), and no migration is built. It costs nothing on a rebuilt POC.
- **When there is no bundle identifier** (absent or blank), the old rule applies unchanged.
- **Samples that do have an `HKDevice`** (a Watch heart rate written by a third-party app) keep only the device: `Observation.device` names a single Device, so the source app is not recorded for them. **[OPEN]** whether that is acceptable (question to the developer).
- **Privacy.** A bundle id is an app id, not personal data, but the set of apps writing to someone's Health can say something about them (for example a condition-specific app). It is recorded only for the sample types this project reads, on the `poc-real` Patient's Devices, with the same protections as the rest of the real data.

## Category and meal type (decision D5, 2026-10-17)

MFP organises a day into meals and snacks and writes that into each sample's metadata (see "What HealthKit provides"). FHIR R4 `Observation` has no meal field, so it is carried in `category`.

**Decided:**

| Entry in `category` | System | Codes | When |
|---|---|---|---|
| Domain | `http://aboutobjects.com/fhir/CodeSystem/observation-domain` | `nutrition` (the system is a domain taxonomy of the form `vital-signs`, `laboratory`, `daily-activity-summary`, `workout`, `nutrition`; only `nutrition` is used by this project for now) | always, for nutrition Observations |
| Meal | `http://aboutobjects.com/fhir/CodeSystem/meal-type` | `breakfast`, `lunch`, `dinner`, `snack`, `other`; `text` keeps the original label | only when MFP supplied a label |

- **Codes are lowercase and hyphenated** (FHIR codes are case-sensitive; HL7's own category codes use this style).
- **Absence is omitted, never invented.** No label means no meal entry (not `other`, not `unknown`). If the two metadata keys (`meal` and `Meal`) ever disagree, the entry is omitted and the case is counted internally.
- **Normalisation:** common names map to the fixed codes; anything else maps to `other` with the original label in `text`. **[UNVERIFIED]** how MFP names meals and snacks, and whether users can rename them (the M21 structure probe lists the labels' shape without values).
- **The domain and the meal are different concepts, so they are different systems**: breakfast and lunch are not domains and do not belong in a domain taxonomy.
- **Meal is not a food name.** It says when someone eats, not what; it carries the same protections as the rest of the nutrition data.
- **Flow-on:** the contract gains `systems.observationDomain` and `systems.mealType` with their code tables, and an optional `mealType` on the sample; the analytics store gains an optional meal dimension (daily totals overall and by meal); the web view can break a day down by meal.

**FHIR conformance check (R4, read 2026-10-17).** `Observation.category` is `0..*` `CodeableConcept`, bound at *preferred* strength, with no invariants, so several categories are allowed and a code outside HL7's set is permitted. The element's own **Comments** go further: besides the preferred value set it allows various categorization schemes *based on the owner's definition of the category*, and effectively several categories can be used at once (found in review, 2026-10-17). A domain scheme and a meal scheme are exactly that. Inside **one** `CodeableConcept`, multiple `coding` entries are *translations of the same concept*; therefore the domain and the meal are **separate `category` entries, each with a single coding**, never two codings in one concept. Array order carries no defined meaning: no consumer may depend on `category[0]` (the domain is listed first by convention only).

**Options not chosen:** an extension (`.../StructureDefinition/meal-type`; the FHIR-preferred way to add a field, but not searchable without a custom search parameter), `meta.tag` (labels about the record, not clinical context), ignoring the meal (loses what MFP records).

**R5 does not settle this.** Its `NutritionIntake` has no meal-type element either (see the forward mapping): the nearest standard pieces are a `Timing` on `consumedItem.schedule` with the `EventTiming` codes breakfast, lunch and dinner (no snack), a parent intake linked by `partOf`, or an extension. A later R5 projection needs a rule for meal type and loses "snack" unless an extension carries it.

**Search:** `category=<system>|nutrition` returns every nutrition Observation without listing nine codes; `category=<system>|lunch` selects a meal. **Verified on HAPI 7.6.0 on 2026-10-19** (`contract/verify-hapi.py`): a search on one of several `category` entries, on both together, on the custom nutrient code and on a Device's second identifier all answer correctly, each with a zero-result control.

## Alternatives considered: R5 `NutritionIntake`

Raised in review on 2026-10-17. R5's [`NutritionIntake`](https://hl7.org/fhir/R5/nutritionintake.html) (new in R5, **Maturity Level 1, Trial Use**) is the resource built for exactly this: a person consuming food or fluid, with food-tracking apps among its stated use cases. Its shape is per food item: `consumedItem` (type, a `NutritionProduct` reference, amount) and an `ingredientLabel` list of nutrients (each a `Substance` reference with an amount). Its own text says Observation-based intake has been done in practice but lacks that ingredient-level detail.

**Decision: keep `Observation` per nutrient sample for this POC, and record `NutritionIntake` as the intended R5 target.**

| Way to get `NutritionIntake` on an R4 server | Assessment |
|---|---|
| Extend R4 with R5 concepts as extensions on an existing resource | Works for elements; **[UNVERIFIED]** whether the cross-version extension work covers a whole new resource type |
| A custom resource type in HAPI | Not standard FHIR; other tools and validators would reject it. Rejected |
| A second HAPI server on R5 for nutrition only | Legitimate, but doubles the stack, the auth wiring and the stored data, and a `Patient` reference does not resolve across servers. Rejected for the POC |
| Move the whole server to R5 | Rewrites the contract, golden fixtures, iOS FHIR types and web app for one resource at maturity 1. Rejected |
| **Keep `Observation`, document the forward mapping** | **Chosen** |

**Why not now:**

1. **The source data is not shaped like it.** HealthKit supplies separate nutrient samples with no food identity. A `NutritionIntake` needs a food (`NutritionProduct`) and a `Substance` per nutrient; building those means reading the `food` correlation and food names, which this design excludes (N6), or inventing them.
2. **Maturity and ecosystem.** Level 1 trial use means the shape can change, and most FHIR servers and tools are on R4.
3. **The upgrade path stays open** (below).

### Forward mapping (so a later projection is mechanical)

| This design (`Observation`) | R5 `NutritionIntake` | Notes |
|---|---|---|
| `status` `final` / `entered-in-error` | `status` `completed` / `entered-in-error` | R5 `EventStatus` value set |
| `subject` | `subject` | |
| `effectiveDateTime` | `occurrenceDateTime` | The day-as-recorded rule (D3) carries over unchanged |
| patient-entered data | `reportedBoolean` `true` | MFP entries are self-reported |
| `identifier` (HealthKit sample UUID) | `identifier` | Kept so no re-ingest is needed |
| `code` (nutrient) + `valueQuantity` | one `ingredientLabel` (`nutrient` + `amount`) | The nutrient is a `Substance` reference, which needs a coded substance per nutrient. **[UNVERIFIED]** how energy (kcal) is represented there, since it is not a substance |
| *(nothing today)* | `consumedItem.nutritionProduct` (the food) | **Not available**: needs the food identity we do not ingest. A projection would have to use a placeholder ("unspecified food from Apple Health"), which is lossy by construction |
| *(nothing today)* | grouping of nutrients into one intake | Needs the HealthKit `food` correlation id, or a same-instant heuristic that N6 refuses to assume |
| meal type (the D5 `category` coding) | **no dedicated element** | Read in full on 2026-10-17: R5 has no meal-type field, and the page only uses "meal" for the *size* of an intake (`ingredientLabel`: "total nutrient amounts for the whole meal, product, serving"). Candidates: `consumedItem.schedule` (a `Timing`, described only as "scheduled frequency of consumption"), whose `repeat.when` can carry the `EventTiming` codes **CM** breakfast, **CD** lunch, **CV** dinner, **C** a meal (**no snack code**; a schedule is also a *planned* frequency, so using it for a recorded event is a stretch); a parent `NutritionIntake` for the meal linked by `partOf` (a `code` search parameter exists, the element itself was not confirmed); an `encounter` for the meal (heavy); or an extension. A projection would lose "snack" unless an extension is used |
| `device`, `meta.source` | no direct element seen | **[UNVERIFIED]**: only the first part of the resource page was read; probably a `Provenance` or an extension |

**What would make the projection cheap later:** keep every sample's UUID (done), and, **if per-meal views ever matter**, ingest the correlation's identifier (an id, not the food name) as a grouping key. That is a contract change and is not part of M20 to M23.

**Revisit this decision if:** the project moves to R5, `NutritionIntake` leaves Maturity Level 1, a consumer of the data requires it, or a per-meal view is wanted.

## Retraction (D2): how an edit or delete is applied

1. HealthKit reports deleted UUIDs; the app already records them (`pending_deletions`).
2. For each, the app sends a **conditional JSON Patch**: `PATCH Observation?identifier=<healthkit-sample system>|<uuid>` with exactly `[{"op":"replace","path":"/status","value":"entered-in-error"}]`.
3. **HAPI rule (new, in `hapi/ext`; built in M21 as `RetractionPolicy` + `RetractionRule`, see `hapi/README.md`):** the capture role may `PATCH` an `Observation` only if the patch is exactly that one operation, the target is found by the capture app's own sample-identifier system (**changed from `meta.source`**: an identifier can be required in the request, `meta.source` cannot), and nothing else is allowed (no `PUT`, no `DELETE`, no other path or resource type). Everything else stays refused.
4. A match count of 0 (never uploaded, or already retracted) is success. A sample deleted before it was uploaded is removed from the queue instead.
5. The analytics worker excludes `entered-in-error` Observations from totals and recomputes the touched days.

Tests need negative controls that fail for the stated reason (PUT, DELETE, a patch with another path or value, a patch on a Patient: each refused, 403) and a positive control (the exact retraction succeeds and the status changes).

## Analytics (D3): daily totals

- Different shape from the existing rollups: a **sum**, not min/median/max. New table (working name `NUTRITION_DAILY`): patient, nutrient, **day as recorded**, total, entries (n), first and last effective, revision, computed-at; same recompute-on-touched-window discipline and watermark as M9.
- **Day as recorded** = the date part of `effectiveDateTime` (or of `effectivePeriod.start`) in the offset the sample carries.
- **A day with no entries is "no data", never 0.** Not logging is not zero intake; the API and the views must say so.
- API: a daily-totals endpoint with the same completeness fields as the existing bands (days with data, missing days, pending windows, last computed).
- Derived values (for example percent of energy from macronutrients using 4, 4 and 9 kcal per gram) are **labelled estimates** in the views, never stored as measurements.

## Web (M23)

A Nutrition view (daily energy and macronutrients, a table twin, "No entries" days as gaps, a text summary, keyboard readout), honouring the existing data-set switch (real data only has nutrition). Day labels say "day as recorded", not UTC.

## Privacy and data minimisation

- **No food names and no photos.** The food correlation and its food-name metadata are not read (N6). The **meal label** (a category such as lunch) is read (D5), because it is structure rather than identity; the original label is kept in `text` as D5 describes.
- Only the eight sample types above are requested (a new authorization sheet appears once).
- Same rules as the other real data: separate `poc-real` Patient, TLS and token only, nothing in logs.

## Code survey: Validic nutrition types against LOINC (2026-10-23)

A comparison table requested by the developer: for each metric in Validic's `Nutrition` category, the LOINC per-entry code (the kind this project stores, one amount per logged item) and the LOINC 24-hour code (a daily total). Each cell shows **Estimated / Measured**, LOINC's two method variants of the same concept. Sources: the "Commonly Found" column of the [Validic metrics table](https://developer.validic.com/docs/metrics) (12 rows, all `Nutrition`), and NLM's [Clinical Tables LOINC lookup](https://clinicaltables.nlm.nih.gov/api/loinc_items/v3/search) (`loinc_items` v3), searched 2026-10-23 by nutrient name. The lookup results were read through a summarizing fetch, not raw, and cross-checked against the codes already verified for the contract (`verification.nutrientLoinc`: 9079-5, 9059-7, 9066-2, 8984-7, 9052-2), which agree. This does not change the contract; it records what exists.

| Validic `Nutrition` type (standard unit) | LOINC per-entry code (Estimated / Measured) | LOINC 24-hour code (Estimated / Measured) |
|---|---|---|
| `calcium` (mg) | 9045-6 / 9046-4 (property `Sub`) | 81137-2 / 80975-6 |
| `carbohydrate` (g) | 9059-7 / 9060-5 | 75296-4 / 81953-2 |
| `cholesterol` (mg) | none found | 81021-8 / 81022-6 |
| `dietary_fiber` (g) | none found (only a panel, 81926-8, and a deprecated PhenX code, 61548-4) | 81133-1 / 81057-2 |
| `energy_consumed` (kcal) | 9052-2 "Calorie intake total" (no method variant; property `EngRat`) | 75298-0 / 80494-8 |
| `fat` (g) | 9066-2 / 9067-0 | 75297-2 / 81952-4 |
| `protein` (g) | 9079-5 / 9080-3 | 75299-8 / 82156-1 |
| `saturated_fat` (g) | none found | 81033-3 / 81136-4 |
| `sodium` (mg) | 9086-0 / 9087-8 (property `Sub`) | 81011-9 / 81012-7 |
| `sugars` (g) | none found (only a deprecated PhenX code, 62262-1) | none found |
| `unsaturated_fat` (g) | none found (no generic code) | no generic code (monounsaturated 81897-1 / 81899-7 and polyunsaturated 81131-5 / 81036-6 exist at 24 hours only) |
| `water` (mL) | 8984-7 / 8985-4 ("Fluid intake", all fluids; also 9102-5 / 9103-3 "Fluid intake total", not compared with 8984-7) | 75301-2 / 81951-6 |

**Reading the table**

- **Estimated, not Measured, applies to every nutrient from a food-logging app, not only to the four codes that say so.** MyFitnessPal's amounts come from a food database, so even calories are estimates; the LOINC code for energy simply has no Estimated/Measured pair at the per-entry level, and our three custom nutrient codes (fibre, sugar, sodium) carry no method at all. The `Estimated` suffix in a code's display is therefore not a reliable signal that the others are measured. The contract has no `method` on any intake metric; R4's `Observation.method` is a candidate for stating it uniformly (an open design question, not decided).
- **Gaps.** No per-entry LOINC code exists for cholesterol, fibre, saturated fat, sugars or unsaturated fat. Sugars has no intake code in either form. Validic describes its `sugars` as added or packaged sugars (paraphrased), a narrower concept than total sugars, so the mapping would need a decision even if a code existed.
- **Units.** The per-entry calcium and sodium codes have LOINC property `Sub`, which I believe is an amount of substance (moles), not mass; Validic's unit is mg. This is why the contract uses its own code system and mg for sodium (assumption A37). I have not checked the property definition against LOINC's documentation.
- **Energy.** `9052-2` has the property `EngRat` (an energy rate) although it is used per entry here (assumption A35); its Estimated and Measured variants exist only as 24-hour codes.
- **24-hour codes are rates** (property such as `MRat`), a total over a day: they are not what this project stores per entry. Our daily totals (M22) are computed, not stored under these codes.
- **Count.** Validic lists 12 nutrition types; the contract ingests 8 (energy, protein, carbohydrates, fat, fibre, sugar, sodium, water; decision D1). Validic's four others are calcium, cholesterol, saturated fat and unsaturated fat. How many nutrients MyFitnessPal actually writes to Apple Health was recalled by the developer as 14 and is not verified here; the app asks HealthKit for the eight only, so any others are not uploaded.

## Assumptions to review (flagged per CLAUDE.md)

| # | Assumption | Why it matters |
|---|---|---|
| N1 | Energy uses LOINC `9052-2`, whose property is *energy rate*, while an entry is an amount of energy (kcal). No per-entry energy-amount intake code was found. The unit `kcal` is kept; the code is the nearest. **[UNVERIFIED]** whether a better code exists. | Terminology fidelity if exchanged outside this POC. |
| N2 | **Resolved by D5:** nutrition uses the custom `nutrition` domain code, so HL7 `activity` is no longer a stand-in. Heart rate and sleep keep their HL7 categories (changing them would make stored history inconsistent, since the create-only server cannot update old Observations); extending the domain system to them is a later, deliberate contract change. | Mixed category conventions across metrics until then. |
| N3 | Water maps to LOINC `8984-7` "Fluid intake Estimated", a broader concept (all fluids). | A coded value that is slightly wider than what was measured. |
| N4 | Fiber, sugar and sodium use a custom code system; sodium stays in mg (no mmol conversion). | Not interoperable without a mapping; chosen over changing a stored value. |
| N5 | **Time of day may be meaningful.** One observed sample is consistent with the logging time (zero seconds, a few seconds before "Date Added to Health"); I had assumed MFP stamps default times per meal. **[UNVERIFIED]** on more than one sample: the M21 probe counts distinct times per day. Until then the views treat time of day as indicative, not exact, and the meal label (D5) is the reliable structure. | Whether an intraday nutrition view is worth building. |
| N6 | The `food` correlation and food names are not ingested. **Meal type is available without them**, as sample metadata (two keys, `meal` and `Meal`; read case-insensitively; if they ever disagree the meal is recorded as unknown and counted). Entries sharing a meal and an instant are still not assumed to be one food. **[UNVERIFIED]** whether a per-entry id exists in the metadata (the probe lists key names). | Per-meal totals are possible; per-food ones are not. |
| N7 | Day as recorded can mix offsets for a person who travels: each entry takes the date of its own offset. **If MFP writes no time-zone metadata, the mapper falls back to the phone's current zone at ingest**, which is right when ingesting in the zone you logged in and wrong when travelling or syncing late. Apple Health's own daily totals use the local calendar day, so the two normally agree at home. **[UNVERIFIED]** whether MFP writes `HKMetadataKeyTimeZone`. | A day boundary can be one day off for travelled or late-synced entries. |
| N8 | UCUM `kcal` vs HealthKit's kilocalorie (thermochemical, 4184 J) **[UNVERIFIED]** whether UCUM `kcal` is defined identically; the conversion endpoint I tried did not answer. | Numeric agreement of energy. |
| N9 | Cardinality: `valueQuantity` is always present (1..1 in practice); no `component`, no `referenceRange`, no `interpretation`; `performer` omitted. A sample with a missing value or an unknown unit is ignored and counted, never guessed. | Same as A10. |
| N10 | MFP may write a nutrient as 0 for an item (a food with no sodium listed). Zeros are stored as given; a missing nutrient is simply absent. | Totals vs "not recorded". |
| N11 | HAPI 7.6.0 supports conditional JSON Patch by identifier search. **VERIFIED live in M21** (`hapi/auth.py check`): 200 and only the matched Observation changes, 200 again on repeat, 404 for no match. Its own `allow().patch()` rule does not match a typed patch, so the project has its own rule. | The whole retraction path depends on it. |
| N12 | `Observation` per nutrient is chosen over R5 `NutritionIntake` (see Alternatives considered). The resource page was read in full except its elements table and mappings (the search parameters were read): no meal-type element exists, and the `NutritionIntake.code` search parameter's element was not confirmed. The forward mapping's gaps (meal type, device, energy) are open. **[UNVERIFIED]** | The documented upgrade path may need adjusting; "snack" has no standard home in either version. |

## Environment prerequisite (read before M20)

The teardown has been done on this Mac (the CA directory, the git-ignored environment files and `Local.xcconfig` are gone; Docker is not running). Before any milestone here can be verified end to end:

1. Recreate secrets and the CA (`make stack-env`, `make tls`), then trust the **new** CA on the Mac (System keychain, `sudo`) and on the phone (remove the old profile first; Certificate Trust Settings must be switched on again). The simulator needs `scripts/ios-sim-trust.sh install`.
2. If the Oracle volume still exists it holds the **old** passwords: run `make stack-reset` and answer `y`, then `make stack-up`. Real data from earlier is then gone from the server.
3. **Delete the app from the phone and reinstall.** Its queue says everything was already sent and its HealthKit bookmarks say it is up to date, so against an empty server it would upload nothing. (Deleting the app removes the queue, bookmarks and preferences.)
4. `ios/Config/Local.xcconfig` (team id) must be recreated, and the 7-day free-profile limit applies again.

## Out of scope

Food names, photos and per-food modelling (meal *type* is in scope, D5), micronutrients beyond the eight, comparing intake against targets, exporting to an EHR, writing anything back to HealthKit.
