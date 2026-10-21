# Scale brief: from one patient to 100,000 to 500,000 patients with consumer wearables

Extends [fhir-data-model.md](fhir-data-model.md) and [nutrition-brief.md](nutrition-brief.md) (both stay authoritative for everything already built). Written 2026-10-20 on the developer's request and revised 2026-10-21 to focus on consumer wearables. **Planning only: no application code until the developer has reviewed this**, and nothing here that installs or connects an external service (a database, a queue, a time-series store) is started without approval (root CLAUDE.md).

Every figure is tagged **[MEASURED]** (seen on this POC stack, with where), **[ESTIMATE]** (my arithmetic from stated assumptions) or **[UNVERIFIED]** (believed, not checked). The POC is one Mac, one developer and one patient: it cannot prove population scale, only find where the design bends and say what would have to change.

## 1. The question

Large organizations have 100,000 to 500,000 patients, and a growing number of them will, over time, replace some clinical monitoring with data from consumer wearables. What does the pipeline (iOS capture app, HAPI FHIR on Oracle, analytics worker and API, clinician web app) do at that size, and what should the data model and architecture be?

**Focus (decided 2026-10-21): consumer wearables read through the phone's health platform** (Apple Health first), not continuous clinical streaming. The data that arrives is **batches and bursts**, not a constant stream:

- background samples through the day (heart rate every few minutes while worn, a few HRV readings, one resting heart rate, a sleep stage per interval overnight, and nutrition entries when someone logs food);
- bursts during workouts (heart rate every few seconds for the length of the workout);
- delivered to the phone in groups and uploaded when the app is woken or opened, so many patients sync at similar times (morning and evening).

**Out of scope, noted only:** continuous clinical streaming, where a worn sensor replaces bedside monitoring with a reading every second or faster all day (86,400 readings a day per patient). That is a different regime (clinical device integration, alarms, regulatory classification). As a stress case, 10,000 patients doing that would be about 860 million readings a day; it is not planned for here.

Two different things are hiding in "scale":

1. **Resource count.** The POC stores one FHIR `Observation` per HealthKit sample. That is correct and convenient at one patient; the count is what grows, and with it storage, index size and every scan.
2. **Rate and shape.** Many small values, mostly never read individually, written in bursts by many devices at similar times.

## 2. What the POC does today

- **One `Observation` per sample**, identified by the HealthKit sample UUID, written by conditional create (`If-None-Exist` on the identifier) so a re-delivery is a no-op. Retraction, data-quality flags and units are per Observation. (Contract 1.5.0.)
- **Upload:** the phone queues samples and sends transaction bundles of up to 100 entries (`SyncEngine` batch size) straight to HAPI, each request carrying a verified Keycloak token. After first choosing Apple Health it reads a 7-day window and then new samples.
- **HAPI 7.6.0 on Oracle** (`HapiFhirOracleDialect`; 54 tables and 96 indexes in the base schema), request validation on, token authorization per request.
- **Analytics** is not FHIR: a worker scans `Observation?_lastUpdated=ge<watermark>` across all patients, marks touched `(patient, metric, day)` windows and recomputes each from HAPI; rollups live in Oracle tables (`daily_rollup`, `sleep_session`, `nutrition_daily`); an API reads them over one connection per process.
- **Web** reads rollups from the analytic API and the flowsheet and intraday views from HAPI, per patient.

### Measured on this stack (one Mac, Docker, Oracle Free, one patient)

| What | Result | Source |
|---|---|---|
| Real data from the phone | 1,807 Observations in the first week, about 260 a day on average | the app's Uploaded count and `poc-real` count, 2026-10-20 **[MEASURED]** |
| Real nutrition | 21 Observations over 2 days | the same **[MEASURED]** |
| One synthetic dense day (heart rate every 4 s) | 19,878 Observations loaded in 31 s, 4 concurrent bundles of 250: about 640 Observations a second | `make web-seed-dense-day` **[MEASURED]** |
| A full worker rescan | 21,879 Observations scanned, 123 windows recomputed, about 15 s wall time | worker log, M22 **[MEASURED]** |
| Nutrition totals over 24 seeded days | correct against an independent sum; seeded in seconds | M23 **[MEASURED]** |

### Not measured (so nothing below is a measured ceiling)

- **Representative wearable cadence.** The developer's own Apple Watch data is not representative (worn irregularly, not for workouts, off at night), so it is **not** used to size anything; it served only as a functional test of the pipeline (about 260 Observations a day in the first week). The per-day figures in section 3 are assumptions, to be replaced by a published cadence for the devices in question, by pilot data from the organization, or by a stated synthetic profile with ranges.
- Bytes per Observation on disk **including all index rows** (the key input to every storage figure here).
- Anything above about 20,000 Observations a day sustained, or about 40,000 Observations in total on the synthetic patient.
- Search latency as the Observation table grows; the worker's scan time on a large table.
- More than one patient, or concurrent writers from many devices; Oracle CPU and memory under load; HAPI heap.
- The earlier plan's dense-load test was skipped by decision (M19).

## 3. Volume model

What a consumer wearable gives this pipeline, for the contract's metrics **[UNVERIFIED]**, to be replaced by one of the sources named in section 2:

- **Heart rate:** a background reading every 5 to 10 minutes while worn (about 150 to 300 a day) plus a burst per workout (an hour at one reading every 5 s is about 720).
- **HRV (SDNN):** a handful to a few dozen a day. **Resting heart rate:** one a day.
- **Sleep:** one Observation per stage interval, tens a night.
- **Nutrition:** per food item up to eight Observations (one per nutrient).

Two round figures follow: **300 a day for a typical wearer** and **1,000 a day for an active one** (workouts most days). Parameters are my assumptions; the point is the order of magnitude. "Wearing" is the share of patients who connect a wearable and share its data; 25% is a plausible early share, 100% the long-run ceiling the question points at.

| Scenario | Patients wearing | Samples per patient per day | Resources a day | Resources a year | Storage a day at 5 KB each |
|---|---|---|---|---|---|
| POC today | 1 | about 260 | about 260 | about 95,000 | about 1 MB |
| 100,000 patients, 25% wearing, typical | 25,000 | 300 | 7.5 x 10^6 | 2.7 x 10^9 | about 38 GB |
| 100,000, 25% wearing, active | 25,000 | 1,000 | 2.5 x 10^7 | 9.1 x 10^9 | about 125 GB |
| 100,000, all wearing, typical | 100,000 | 300 | 3 x 10^7 | 1.1 x 10^10 | about 150 GB |
| 100,000, all wearing, active | 100,000 | 1,000 | 1 x 10^8 | 3.7 x 10^10 | about 500 GB |
| 500,000, 25% wearing, typical | 125,000 | 300 | 3.8 x 10^7 | 1.4 x 10^10 | about 190 GB |
| 500,000, 25% wearing, active | 125,000 | 1,000 | 1.25 x 10^8 | 4.6 x 10^10 | about 625 GB |
| 500,000, all wearing, typical | 500,000 | 300 | 1.5 x 10^8 | 5.5 x 10^10 | about 750 GB |
| 500,000, all wearing, active | 500,000 | 1,000 | 5 x 10^8 | 1.8 x 10^11 | about 2.5 TB |
| Nutrition alone: a fifth of 100,000 log, 15 items a day, 8 nutrients each | 20,000 | 120 | 2.4 x 10^6 | 8.8 x 10^8 | about 12 GB |

**[ESTIMATE]** throughout. The 5 KB per Observation is a guess: a resource row, a version row and the search-index rows (token, date, quantity, reference, string) each cost something. **Measuring it is the first job** (section 7).

Three readings of the table:

- **The near-term case is not an ingest-rate problem; it is a storage and retention problem.** 100,000 patients with a quarter wearing at a typical rate is 7.5 million Observations a day, about 87 a second on average. The dense seed on this Mac sustained about 640 a second, so average ingest fits one node, with room for peaks of a few times the average **[UNVERIFIED]**. What does not fit is the growth: 2.7 billion resources and on the order of 14 TB a year at 5 KB each, every one carrying index rows and every one a target for scans.
- **Rate becomes the problem at the all-wearing, active end:** 10^8 a day is about 1,160 a second on average, beyond one Mac and one HAPI node before any peak.
- **Nutrition is not negligible at population scale.** At one patient it is noise (about 120 a day for a heavy logger); at 100,000 patients with one in five logging it is about 900 million resources a year, a cost of the per-nutrient design of M20 that I understated when first asked about scalability. It is the clearest case for grouping (section 5, B3), though wearable samples remain the larger volume.

## 4. Where each part of the current design bends

| Part | At one patient | At 100,000 to 500,000 patients with wearables |
|---|---|---|
| Raw samples as `Observation`s in HAPI | fine | A FHIR server stores each Observation with many index rows and is built for clinical records, not for billions of small values per year. The storage and index growth is the first wall **[ESTIMATE]** (at the near-term figure in section 3, tens of terabytes a year); where exactly it hurts on Oracle is **[UNVERIFIED]**. |
| Conditional create per entry | gives free idempotency | Each entry runs a search before the insert (my reading of how conditional create works **[UNVERIFIED]** here); at 10^7 to 10^8 writes a day that adds index work to every one. |
| Phone to HAPI directly, one token per request | simple | There is no queue or backpressure: a slow server means a growing phone queue and retry storms. A real ingest path needs a gateway and a queue in front. |
| Worker scanning `_lastUpdated` across all Observations | about 15 s for 21,879 | Cannot sensibly scan a table that grows by 10^7 to 10^8 a day. It needs an event feed instead (FHIR Subscription, a message queue, or per-patient or partitioned scans); HAPI Subscriptions and Bulk Export are candidates, neither verified here. A single worker with one connection is a bottleneck by design. |
| Rollups `(patient, metric, day)` in Oracle | fine | About 2 billion rows a year at 500,000 patients with 10 metrics: partitioning by day, or a columnar or time-series store, and a pool, not one connection (assumption A45 in `analytics/README.md`). |
| Retraction, flags and per-sample units | each costs one resource | These are per-sample features; at this volume they are the cost that has to be reconsidered (section 5). |
| Web flowsheet and intraday | per patient, fine | A clinician cannot read a day of workout samples for 100,000 patients; the view has to be summaries and excursions. **The intraday drill-down (M15) and the flagged-sample review need raw per-sample data, so a retention window for raw data is a product decision, not just an engineering one.** |
| Auth (Keycloak token verification per request) | fine | Verification is local with a cached key set, so it scales; Keycloak itself holds the sign-ins and refresh traffic, not the data path **[UNVERIFIED]**. |
| Oracle Free in this stack | fine | Oracle Free's published limits are small (my recollection: 12 GB of user data, 2 CPU threads, 2 GB of RAM **[UNVERIFIED]**: check the licence for 23.26). At 5 KB each that is only about 2 million Observations, so **a load test beyond that cannot run on this database**. It would extrapolate, or need another database (a decision for the developer: HAPI supports others). |

## 5. Options

### A. Stay: one Observation per sample, scale HAPI

- **What it is:** the present design with HAPI and Oracle tuned and partitioned (patient-based partitioning, search-parameter trimming, a separate read path for analytics).
- **For:** no data-model change; keeps per-sample idempotency, retraction and flags that M18 to M21 depend on.
- **Against:** the yearly volume in section 3 (billions of resources); the ceiling is unknown and probably within the low hundreds of millions of resources for a well-tuned single server **[UNVERIFIED]**, not 10^10 a year.
- **Fits:** low-rate data and events (sleep, daily values, alerts, nutrition at modest volume) and the first stages of a rollout.
- **A2. A bounded raw window.** Keep per-sample Observations in HAPI for a window (say 30 to 90 days, enough for the intraday drill-down and flagged-sample review) and keep the rollups (`daily_rollup`, `sleep_session`, `nutrition_daily`, already outside FHIR) for the whole record. Older raw Observations are archived and expunged. This caps HAPI's size, keeps every M15 to M21 feature working inside the window, and needs no new store if the archive is simply object storage later. It is a retention-policy decision first (what must be kept, for how long, under which rules), and HAPI's expunge and delete-expunge operations are **[UNVERIFIED]** here: no role in this POC can delete today.

### B. Fewer resources per sample

Three ways to put several values in one resource, with very different fits:

1. **`Observation.component` (R4).** Meant for values that only make sense together (the two numbers of a blood pressure). For one food's nutrients it saves up to about 8 resources per item, but:
   - the food grouping is not safe to recover from HealthKit without the `food` correlation id (nutrition brief N6, and whether MFP writes one is unverified: the M21 structure probe was meant to say);
   - the capture role cannot update an Observation, so a late nutrient means retract and recreate;
   - `meta.tag` flags are per resource, not per component;
   - the analytics searches change from `code` to `component-code` or `combo-code` and every component needs its own range, zero and flag handling.
   - Verdict: only worth it if the correlation id exists and the nutrition volume is the concern.
2. **`Observation.valueSampledData` (R4 `SampledData`).** One Observation holds a regular series: `origin`, `period` in milliseconds, `factor`, limits, `dimensions` and a `data` string, with markers for error, below-range and above-range. It is the FHIR-native answer for waveforms and dense series and cuts resource counts by the block length (one workout of heart rate at a reading every 5 s is about 720 values in one resource; a day of background readings is 150 to 300).
   - **For:** 100 to 700 times fewer resources for bursts; keeps FHIR as the store.
   - **The block length is a latency dial, and `Observation` is not built for streaming.** A block cannot be closed before its window has elapsed, so it needs **buffering** (extra latency) or **serial updating** (the resource is rewritten as readings arrive; each update is a new stored version of a growing resource **[UNVERIFIED]** for HAPI, and the capture role cannot update at all). A block of L seconds means 86,400 / L resources a day and up to L seconds of added delay: 288 a day and up to 5 minutes at 5-minute blocks, 24 a day and up to an hour at 1-hour blocks, one a day and a day's delay at 24 hours. This is acceptable for consumer wearables, because HealthKit already delivers samples in batches hours stale (M18), so **one block per delivered batch** adds no buffering and needs no update; it is not acceptable for live monitoring. Even the Personal Health Device IG buffers into sample-array Observations at a gateway: continuous streaming itself lives outside FHIR (a queue, a series store, a protocol such as MQTT) **[UNVERIFIED]**.
   - **Against:** the values are opaque to search (a block is found by time, not by value); spacing must be regular (HealthKit heart-rate samples are irregular, so they need resampling or gaps marked, which changes the data); the background readings every 5 to 10 minutes are too sparse and uneven to gain much; a block cannot be amended or have one value retracted, so blocks must be **closed and immutable** (the capture role cannot update anyway); flags are per block; analytics must unpack.
3. **A group key** (a shared second identifier on per-nutrient Observations, for example `.../nutrition-group|<hash>`, from the correlation id if it exists). No resource-count saving; groups without merging, keeps retraction and flags per nutrient. It solves "which nutrients belong to one food", not scale.

### C. Tier: raw samples outside FHIR, summaries and events inside

- **What it is:** the raw samples go to a time-series or columnar store (object storage with a columnar format, or a time-series database) through an ingest gateway and a queue. FHIR holds what a clinician acts on: hourly or daily summaries, excursions and alerts, events (as `Observation`, and `Flag` or `Communication` where they fit), plus **references to the raw segments** (a `DocumentReference` or `Binary` for a patient-day segment, with `Provenance`).
- **For:** the only option here that clearly scales to the all-wearing, active end of section 3, and the natural home for the archive of A2; matches how the POC already treats rollups (not FHIR, in Oracle) and how clinicians read data (trends and exceptions, not raw values).
- **Against:** new infrastructure (a store, a queue, a gateway), so approval first; two places to look; summaries are derived, so the derivation (and its clinical validity) becomes the thing to govern; raw access needs its own view and its own access control.
- **Fits:** the large scenarios and any use where raw samples are kept for review rather than read routinely.

### D. Summarise on the device

- **What it is:** the phone computes hourly or daily summaries and event detection and uploads only those; raw samples stay in Apple Health.
- **For:** upload volume collapses (24 summaries a day per metric instead of hundreds of samples); good for privacy; **a natural fit for consumer wearables, where Apple Health already keeps the raw samples on the phone**.
- **Against:** raw data is not available server-side for review, for the intraday view or for recomputation; clinical trust in on-device derivation (a summary rule is code that ships with the app and must be versioned and validated); a device that does not keep samples on the phone cannot do it.
- **Fits:** trend monitoring where trends and excursions are enough. It can combine with A2 or C (summaries always uploaded, raw only for flagged intervals or a bounded window).

### E. FHIR as a view over a series store

- **What it is:** the points live in a series store; the FHIR API (search, `$stats`, `$lastn`, conditional create, retraction, a change feed) is a projection of it. The contract is written out in section 5b.
- **For:** does not dictate persistence (the store can change under a stable API); cuts the per-point cost from a stored resource to a few tens of bytes **[ESTIMATE]**; keeps per-point retraction, flags and idempotent ingest; aggregates are native; works with option A2 (retention) and C (tiering) as the implementation underneath.
- **Against:** it declares what it does not offer (history, all-or-nothing transactions, the search long tail); a guard against read amplification; a new service and store; a custom operation for windowed series that standard clients do not know.
- **Fits:** the large scenarios of section 3, as the interface to option C.

### Not an option: more of the same

Making the POC's worker or HAPI faster by tuning alone does not change the arithmetic of section 3: storage and scans still grow by billions of resources a year.

## 5a. FHIR and streaming: what exists (searched 2026-10-21)

I found **no HL7 implementation guide dedicated to streaming wearable time series**. What exists is a set of pieces around the Observation, and none of them replaces storing raw samples as individual resources at this volume:

| Piece | What it is | Relevance here |
|---|---|---|
| `Observation.valueSampledData` (core R4) | one Observation holds a regular series. Community guidance (an HL7 chat thread, 2021, not a standard) is: wearable metrics are mostly Observations, and regularly sampled intervals can use SampledData | option B2 in section 5 |
| [Personal Health Device IG (PHD)](https://hl7.org/fhir/uv/phd/2024Sep/toc.html) | maps IEEE 11073-20601 device data to FHIR for gateway implementers, including sample-array Observations; 1.1.0 is the official version and 2.x builds are trial-use | aimed at medical-grade personal health devices, not consumer wearables; a pattern for a device gateway |
| [Point-of-Care Device IG](https://build.fhir.org/ig/HL7/uv-pocd/en/index.html) | the same idea for clinical devices; excludes home-use devices | out of scope here (clinical streaming) |
| [Subscriptions R5 Backport IG](https://hl7.org/fhir/uv/subscriptions-backport/2024Jan/components.html) (1.1.0, for R4 / 4.3.0) | topic-based subscriptions on an R4 server: notification bundles, heartbeats, and WebSocket delivery; custom topics are optional for servers | a candidate to replace the worker's `_lastUpdated` scan with an event feed (section 4); HAPI's support is **[UNVERIFIED]** here |
| [Bulk Data Access IG](https://build.fhir.org/ig/HL7/bulk-data/en/export.html) | asynchronous `$export` as NDJSON at system, patient and group level, with `_since` | a way to feed a warehouse or lake for analytics; not an ingest path |
| Implementation patterns (not standards) | for example Health Samurai describes keeping Observations as time series in TimescaleDB hypertables with other FHIR data as JSONB; a 2025 case study maps Garmin data to FHIR through a third-party API | the same shape as option C: FHIR at the interface, a time-series store underneath |

Reading: FHIR's answer to volume is to keep **FHIR as the record and interface** and put the bulk series behind it (SampledData blocks, a gateway, an event feed, a bulk export), which is option C and its variants. I did not find a current HL7 guide that compares SampledData with alternatives for streaming, and I did not confirm a Patient Generated Health Data guide in this search; neither claim should be read as "none exists".

## 5b. FHIR as a view: the view contract

Raised by the developer on 2026-10-21: a FHIR API that is a **projection** of a series store does not dictate the persistence structure. This section writes down what such a view would have to promise, so the idea can be judged on specifics. Planning only; nothing here is built, and a prototype is a new service and needs approval.

### Principle

The series store owns the points. The FHIR layer **synthesizes** `Observation` resources from them on request and accepts the same writes the capture app sends today. **Acceptance test:** for the interactions the view declares, a client cannot tell it from the HAPI-backed store, and the existing suites (`contract/verify-hapi.py`, `make test-analytics-live`, `make test-web-live`, `analytics/verify-intake.py`) pass unchanged when pointed at it. Anything the view does not support is declared, not approximated.

### What goes where (hybrid, not a replacement)

| Kept in HAPI (ordinary FHIR store) | Owned by the view (series store) |
|---|---|
| `Patient`, `Device`, and anything clinical or low-rate (events, summaries, documents, `Provenance`) | the numeric points of the contract's series metrics (heart rate, HRV, intake amounts and so on, per a new contract flag such as `storage: "series"`) |
| references the view resolves at ingest (does `Patient/42` exist; the device key) | per-point values, times, quality, status, ingest sequence |

Which side serves a request is decided by the contract: a metric marked as series belongs to the view, everything else to HAPI. How that decision is made is the hard part, and each shape has a real cost. The three shapes, each to be judged after measuring:

**V1. A router in front of HAPI** (decides by `code` on search, by id on read, by body on create). **It is not the cheap option** (developer's experience, 2026-10-21: it was tried, and it gets really complicated): search responses can mix resource types, so the router must split a request, send each part to the right back end and **merge the answers**. The cases: `_include` and `_revinclude` (an `Observation` search that includes its `Patient` or `Device`, a `Patient` search that reverse-includes `Observation`s), chained and reverse-chained search (`Observation?subject.name=…`, `Patient?_has:Observation:subject:code=…`), `Patient/$everything` and the compartment, `_total` and paging across two sources, and **transaction bundles that mix types**. Our own upload is one: `BundleBuilder` sends the `Device` entries first and then each `Observation`, all in one transaction with references between them, so a router must split the bundle, create the devices in HAPI first, then rewrite the observations' device references for the view, and keep the whole thing idempotent on retry. A router that only handles the simple cases is a half-built FHIR server.

**V2. Replacing HAPI JPA's `Observation` provider at bootstrap** with one backed by the series store. The developer reports (from experience, 2026-10-21) that HAPI JPA allows replacing the `Observation` provider during bootstrap, but that **the replacement has to implement everything itself**: nothing of the JPA provider carries over unless it is subclassed, and a subclassing strategy looks dubious (HAPI providers are annotation-driven, so an override has to re-declare the `@Search` and operation signatures). A near-complete replacement was started and not finished for lack of time, with considerable progress, so V2 is feasible but **expensive**. **It has not been tried in this repo.** The view contract's declared subset is the mitigation: the replacement implements only what the contract declares and refuses the rest.

**A composition variant (my idea, untested):** a replacement provider that routes by the contract, serving series metrics from the view and **delegating every other `Observation` request to the JPA DAO** (`IFhirResourceDao<Observation>`), so one endpoint serves both kinds. That still means writing every declared interaction against both back ends, and a request mixing series and non-series codes in one search (`code=a,b`) needs a defined behaviour (refuse, or merge two result streams with a stable cursor). HAPI's plain server is the documented facade (one provider per resource type). This repo already loads project code into HAPI (`hapi/ext`: `custom-bean-packages` and `custom-interceptor-classes` in `hapi/application.yaml`), which is where a replacement provider would hook in; how the replacement is registered with the starter's provider list is to be checked.

**What a provider swap does and does not cover [UNVERIFIED, to check before choosing V2].** Replacing the provider changes the REST surface for `Observation`. Things that go through HAPI's data-access layer instead of the provider may still see only the JPA store, which would then hold no series points: referential-integrity checks, `Patient/$everything` and the Patient compartment, `_include` and `_revinclude` from other resources, Group-based `$export`, resource-change `Subscription`s, and the search-parameter index. The existing authorization interceptor and `RetractionPolicy` act on the request, so they should apply regardless of which provider answers. V1 keeps HAPI untouched, but it has to answer the mixed-response questions itself (above).

**V3. A separate FHIR base for series data only, as a deliberate stance** (developer's framing, 2026-10-21: V3 is partly a concession to the value of adopting simplifying assumptions, accepting the trade-offs because the streaming benefit outweighs the features given up; for example `/series/fhir`, serving only the series `Observation`s, an honest `CapabilityStatement`, no `_include`, no chaining, no mixed bundles). Nothing is split or merged on the server: a client chooses the base per metric from the contract (`storage: "series"`). That is the cheapest shape because the view never has to answer a mixed request. The price is that it is **not drop-in**: the app, the worker and the web each learn two bases, and a standard client sees series data only if it is pointed at the second base. In the app the mixed bundle would be split on the client, which knows what it built: devices to HAPI first (they are conditional creates and idempotent), then observations to the view with the device referenced by identifier. A partial failure between the two is safe to retry for the same reason. The acceptance test of the principle (existing suites pass unchanged) then holds for each base separately, with the suites configured per metric.

**Summary:** V1 and V2 are drop-in and expensive in different places (merging answers; implementing a whole provider). V3 is cheap and not drop-in. The choice depends on whether "indistinguishable from the HAPI-backed store" is a requirement or a preference. **Under V3 the acceptance test changes:** not "the existing suites pass unchanged" but "everything inside the declared subset behaves as FHIR says, and each exclusion is refused for its stated reason, with a positive control that the supported neighbour works".

### The trade V3 makes: simplifying assumptions

V3 is not a lesser V1; it is a different stance, a purpose-built narrow server whose `CapabilityStatement` says what it is. FHIR permits a server to declare partial support, so this is within the standard's mechanism, even though a generic client cannot assume it. Each assumption buys something and gives something up:

| Simplifying assumption | What it buys | What is forgone | Mitigation |
|---|---|---|---|
| **Series Observations are append-only facts.** Retraction by status only; no update, no delete | no versions or history; immutable segments; simple storage | `update`, `delete`, `_history`, `vread`, conditional update | tombstone plus a revision counter (retraction stays per point) |
| **One resource type on the base:** `Observation` only | no mixed responses, no merge, no split | `_include`, `_revinclude`, chaining, `_has`, `$everything`, the compartment, mixed transactions | references stay references (`subject`, `device`) and the client fetches `Patient` and `Device` from the main base; the app splits its bundle |
| **Reads are patient-scoped and time-bounded:** a search needs a subject and a window (or a cursor) | the store is laid out by (patient, time); no accidental scans | population queries on the base (`Observation?code=…` across patients) | a change feed, a subscription and a bulk export for population work |
| **Contract-defined, numeric scalar points only** (`valueQuantity` in the contract's unit) | typed columnar storage; strict ingest validation | arbitrary Observations (components, ranges, text, ratio, panels) | those stay in HAPI, on the main base |
| **Aggregate-first reads:** per-point search is capped; `$stats`, `$lastn` and `$series` for the rest | cost is bounded; the expensive question is answered by the cheap operation | unbounded "give me everything" searches and deep paging | the cap says what to call instead |
| **Declared consistency:** an acknowledged write is durable, reads follow the ack point; a transaction is a batch (idempotent, not all-or-nothing) | no distributed transaction | atomic multi-entry transactions | idempotent retry converges |
| **Identity is the source id:** logical id equals the source UUID | point lookup, deterministic dedupe | server-assigned ids | none needed |
| **References are checked at ingest only** | no referential machinery in the store | integrity after a later patient delete or merge | a reconciliation job, or a rule that patients are never deleted while series exist |

**What must not be forgone** (the part of FHIR this project already depends on): per-point source (`meta.source`) and the recorded offset (times and days as recorded); stored quality flags and per-point retraction; idempotent ingest by identifier; the token rules of the root CLAUDE.md (TLS only, a verified token on every request); and honest errors (an unsupported parameter is a `400` with an `OperationOutcome`, never ignored).

**What our own clients actually send** bounds the subset, so it is not a guess (from the code as of 2026-10-21): the worker uses `_lastUpdated` with `code`, `_sort=_lastUpdated`, `_count` and `_elements`, and per-patient `date` windows; the banner uses `_sort=-date&_count=1` per metric and `_sort=-_lastUpdated&_count=1&_elements=meta` for the newest Observation **of any kind**; the flowsheet uses `status`, `_source`, `date`, `_sort` on several columns plus `_id`, `_count`, **`_offset`** and `_total=accurate`. Concretely, under V3: the newest-of-any-kind banner query becomes one request per base; the flowsheet's `_offset` paging and its sorts by `code`, `value-quantity` and `status` need either support in the view or a change in the flowsheet for series metrics (a time-ordered, cursor-paged list is what a stream suits); and the worker's change feed needs the view's feed endpoint.

### Point model (what one stored point must carry to be projected exactly)

| Column | Becomes | Note |
|---|---|---|
| stream key: patient id, metric id, source kind | `subject`, `code`, `meta.source` | metric id resolves to system, code, unit and category through `contract/metrics.json`, never copied |
| `uuid` (unique per source kind) | `identifier` (the healthkit-sample or synthetic-sample system) and the logical `id` | the dedupe key; the logical id is deterministic (for example the lower-cased UUID), so a read by id is a point lookup |
| `effective_start_ms`, `effective_end_ms` and **`offset_minutes`** | `effectiveDateTime` or `effectivePeriod` with the recorded offset | the offset is stored per point (2 bytes) so "day as recorded" and "times as recorded" (M16, M22) survive; without it the projection loses the zone |
| `value` (double, in the contract unit) | `valueQuantity` (unit, system, code from the contract) | |
| `status` (final or entered-in-error) and a revision counter | `status`, `meta.versionId` | retraction sets status and bumps the revision (a tombstone, not a delete) |
| `flags` (bitmask: artifact-suspected, late-arrival, duplicate-resolved, user-entered) | `meta.tag` in the data-quality-flag system | per point, as today |
| `issued_ms` | `issued` | |
| `ingest_ts_ms` and a monotonically increasing `ingest_seq` | `meta.lastUpdated` | the change feed; ordering inside the same millisecond is by sequence |
| `device_key` | `device` reference (a `Device` in HAPI, found by the device-key identifier) | |

A point is a few tens of bytes in a columnar or time-series store against the **5 KB** assumed for a stored Observation **[ESTIMATE]**: that ratio, about two orders of magnitude, is the whole motivation, and it is to be measured (section 7), not assumed.

### Interactions the view declares

All requests carry a verified bearer token exactly as for HAPI today; the view adds no credentials. Examples are synthetic and use this project's own systems.

**1. Search**: `GET /Observation?subject=Patient/42&code=http://loinc.org|8867-4&date=ge2026-10-20T00:00:00-07:00&date=lt2026-10-20T01:00:00-07:00&_count=500`

A range query on the stream, returned as an ordinary `searchset` of synthesized Observations:

```json
{
  "resourceType": "Bundle", "type": "searchset", "total": 361,
  "link": [{ "relation": "next", "url": "…/Observation?…&_cursor=eyJ0IjoxNzkyNTE0OTAwMDAwLCJzIjo0MDAxMjN9" }],
  "entry": [{
    "fullUrl": "…/Observation/b0000000-0000-4000-8000-0000000000a1",
    "resource": {
      "resourceType": "Observation",
      "id": "b0000000-0000-4000-8000-0000000000a1",
      "meta": { "versionId": "1", "lastUpdated": "2026-10-20T08:01:02.311Z",
                "source": "http://aboutobjects.com/fhir/capture-app/healthkit" },
      "identifier": [{ "system": "http://aboutobjects.com/fhir/identifier/healthkit-sample",
                       "value": "b0000000-0000-4000-8000-0000000000a1" }],
      "status": "final",
      "category": [{ "coding": [{ "system": "http://terminology.hl7.org/CodeSystem/observation-category", "code": "vital-signs" }] }],
      "code": { "coding": [{ "system": "http://loinc.org", "code": "8867-4", "display": "Heart rate" }] },
      "subject": { "reference": "Patient/42" },
      "effectiveDateTime": "2026-10-20T00:05:00-07:00",
      "issued": "2026-10-20T08:00:59.000Z",
      "valueQuantity": { "value": 72, "unit": "beats/minute", "system": "http://unitsofmeasure.org", "code": "/min" }
    }
  }]
}
```

- Supported parameters: `subject` (or `patient`), `code`, `date` (`ge`, `lt`), `status`, `identifier`, `_lastUpdated`, `_count`, `_sort` on `date` and `_lastUpdated` only, `_summary=count`, `_total=accurate`. **Anything else is refused with `400` and an `OperationOutcome` (`not-supported`)**, never ignored.
- **Paging** is by an opaque cursor on `(sort key, ingest_seq)`, so a point inserted into the past while a client pages neither duplicates nor skips; the `next` link carries it.
- **Cost guard:** `_count` is capped (say 1,000), and a per-point search with an unbounded range or a window larger than a stated limit is refused with an `OperationOutcome` of issue type `too-costly` and a message that names the aggregate alternative **[the HTTP status is a decision; the code must be checked against the spec]**.

**2. Aggregates**: `POST /Observation/$stats` (R4 core operation; a `period` is a complex type, so POST with `Parameters`):

```json
{ "resourceType": "Parameters", "parameter": [
  { "name": "subject", "valueUri": "Patient/42" },
  { "name": "coding", "valueCoding": { "system": "http://loinc.org", "code": "8867-4" } },
  { "name": "period", "valuePeriod": { "start": "2026-10-20T00:00:00-07:00", "end": "2026-10-21T00:00:00-07:00" } },
  { "name": "statistic", "valueCode": "minimum" }, { "name": "statistic", "valueCode": "median" },
  { "name": "statistic", "valueCode": "maximum" }, { "name": "statistic", "valueCode": "count" }
] }
```

returns, per the operation definition, one `final` Observation per code with a component per requested statistic (a `GROUP BY` in the store); entered-in-error points are excluded by the operation's own rule. **[UNVERIFIED]**: the code system of the statistic components (I believe `http://hl7.org/fhir/observation-statistics`), and whether the median is supported by this view. This is the interaction that replaces most of today's reads of raw Observations.

**3. Latest**: `GET /Observation/$lastn?patient=42&code=http://loinc.org|8867-4&max=1`: the newest point per code; natural in a series store (the web notes call it unusable on this HAPI, a view implements it directly).

**4. Windowed series (a project-defined operation, outside the standard)**: `POST /Observation/$series` with `subject`, `code`, `period` and `resolution` (a duration such as `PT5M`), returning one Observation with `valueSampledData` on a regular grid, each cell the mean of the points in that bucket:

```json
{ "resourceType": "Observation", "status": "final",
  "code": { "coding": [{ "system": "http://loinc.org", "code": "8867-4" }] },
  "subject": { "reference": "Patient/42" },
  "effectivePeriod": { "start": "2026-10-20T00:00:00-07:00", "end": "2026-10-20T01:00:00-07:00" },
  "valueSampledData": {
    "origin": { "value": 0, "unit": "beats/minute", "system": "http://unitsofmeasure.org", "code": "/min" },
    "period": 300000, "dimensions": 1, "data": "68 71 70 E 74 76 75 72 70 69 68 67" } }
```

A bucket with no points is `E` (error); **FHIR has no marker for "no data" as distinct from an error, so a gap and an error are indistinguishable in `SampledData`** (a limit to carry into any use of it). This is a derived, read-only view with a resolution chosen by the client, so the irregular spacing and the block-length latency of stored `SampledData` (section 5, B2) do not arise. It is also the one part a standard client cannot call without knowing the operation, so it should be optional: the web's intraday view could use it where present and fall back to a bounded search.

**5. Write (the capture app's upload, unchanged)**: `POST /` with a `transaction` Bundle of conditional creates:

```json
{ "resourceType": "Bundle", "type": "transaction", "entry": [{
    "fullUrl": "urn:uuid:7d2e9b3a-5c1f-4a6e-8b0d-3f9a1c5e7b21",
    "resource": { "resourceType": "Observation", "…": "as in the search example, subject Patient/42" },
    "request": { "method": "POST", "url": "Observation",
                 "ifNoneExist": "identifier=http%3A%2F%2Faboutobjects.com%2Ffhir%2Fidentifier%2Fhealthkit-sample%7Cb0000000-0000-4000-8000-0000000000a1" } }] }
```

Each entry is validated at ingest (the contract's rules: unit, code, range flags are the app's), the `Patient` reference is checked against HAPI (cached), and the point is appended with `ingest_seq`; a repeated identifier answers `200` and appends nothing, a new one `201`, exactly as HAPI does. **Atomicity is weakened and must be declared:** a transaction is idempotent per entry and a retry converges, but it is not all-or-nothing across entries.

**6. Retraction (unchanged)**: `PATCH /Observation?identifier=<healthkit-sample system>|<uuid>` with `[{"op":"replace","path":"/status","value":"entered-in-error"}]` sets the point's status, bumps its revision (`meta.versionId`) and its `ingest_seq` (so the change reaches the feed), answers `200` for a found point and again on repeat, and `404` for none: the behaviours `hapi/auth.py` checks today.

**7. Change feed**: `GET /Observation?_lastUpdated=ge<watermark>&_sort=_lastUpdated&_count=200` returns points by ingest sequence. It keeps today's worker working unchanged, and is cheaper than a table scan (an ordered range on one column). Its successor is a topic-based `Subscription` fed from the ingest path (not from the store), the Subscriptions R5 Backport IG in section 5a.

### Declared, not offered

`_history` and `vread` per point; `update` and `delete` (retraction only, by status); transactions with all-or-nothing semantics; search parameters beyond the list above; `Observation` types the contract does not mark as series (these go to HAPI). The `CapabilityStatement` states exactly this, and the view refuses the rest.

### Consistency semantics to state

- **Read-your-writes** after a `2xx` response: yes if the append is acknowledged durable before the response; the ack point is a design choice (a queue before the store makes it eventual).
- **Order:** per stream by event time on reads; per ingest by `ingest_seq` on the change feed.
- **Late and out-of-order points** are accepted and appear in the right place in a read; they also appear again in the change feed.
- **Retention:** a window of raw points may be moved to an archive tier; reads inside the window are unchanged, reads outside it answer from the archive or with a stated `OperationOutcome`, and aggregates always remain available (A2 in section 5).

### What this changes elsewhere

| Part | Effect |
|---|---|
| iOS app | none under V1 or V2 (same Bundles, same conditional creates and PATCH); under V3 the upload is split client-side (devices to HAPI, observations to the view). The contract gains a storage flag per metric in every case |
| Analytics worker | unchanged first (the change feed above); later replaced by a subscription or a query on the store; the per-day window reads become `$stats` or direct store reads |
| Web | the intraday view may use `$series` or `$stats`; the flowsheet needs a bounded range per stream |
| `contract/metrics.json` | a `storage` field per metric (`"fhir"` or `"series"`), checked by `contract/check.py` with the usual controls |
| HAPI | still the store for everything not marked series, and the reference authority for `Patient` and `Device` |

### Risks (the honest list)

1. **FHIR is record-oriented:** the semantics above that a view cannot give (history, all-or-nothing transactions) are declared, but a client written for a full server may assume them.
2. **Read amplification:** a client asking for a day of per-point Observations gets tens of thousands unless the guard refuses it; the guard is a policy that has to be chosen and tested.
3. **Search long tail:** the conformance surface is "only what is declared", which needs its own tests (a refused parameter must be refused for the right reason, with a control that a supported one works).
4. **Two stores:** references and the `Patient` they point to live elsewhere; ingest must check them, and a patient merge or delete does not propagate by itself.
5. **The custom operation** (`$series`) is not interoperable until proposed and adopted; it is an extension, flagged as such.
6. **Mixed responses and bundles:** whichever shape is chosen, any request that spans series and non-series resources (`_include`, chaining, mixed transactions, the compartment) is either unsupported and refused (V3) or has to be merged and split (V1, V2); the declared-subset rule is what keeps that list finite.
7. **Operating cost:** a new service and a new store to run, back up and secure with the same token rules as HAPI (root CLAUDE.md: TLS only, token required; a router or facade is a new network-reachable endpoint, so it must be decided before it is built).

### How to test the idea cheaply (proposed, needs approval)

A thin slice serving **synthetic** series (the existing dense-day and meal generators) through search, `$stats`, `$lastn`, the change feed and the conditional create, backed first by a plain table in the existing Oracle analytics schema and then by a second store behind the same interface, to show that the API does not move when the persistence does. Pass the existing live suites against it unchanged. Measure bytes per point, write throughput, and the latency of a day-window `$stats` against the same day read as 20,000 stored Observations (section 7).

### Questions this section raises

1. Which reads must stay per-point (a flowsheet, a flagged-sample review), and which can be aggregate or windowed (`$stats`, `$series`)?
2. Is a project-defined `$series` acceptable, or must the view stay inside the standard operations?
3. Where is the durable-ack point, and is eventual consistency after a write acceptable to clinicians?
4. Is the view one deployment per organization or shared, and who owns the series store?

## 6. Recommendation

1. **Do not change the data model yet.** M20 to M23 (per-nutrient Observations) are right at the volumes the POC handles and for the clinical features built on them (retraction, flags, totals).
2. **Measure what can be measured here:** the measurements in section 7 (bytes per Observation, write throughput, read latency as the table grows). Volumes stay assumptions until pilot data or a published device cadence replaces them, and the answer should be shown across a range, not at one point.
3. **Decide the raw-data policy on the product questions** (section 8), not on the technology: does a clinician need raw samples at all, for how long, and for which patients? This choice picks between A2 (a bounded raw window), D (summarise on the device) and C (a separate raw store).
4. **Option E is the idea to specify further** (section 5b): it moves the decision about persistence behind a stable FHIR interface. Its cost is in how requests reach it: a drop-in router (V1) or provider replacement (V2) is expensive, as the developer found when building both; a separate base (V3) is cheap and not drop-in. A synthetic-data slice would test the cheapest shape first (one service, approval needed).
5. **My expectation, to be tested:** for consumer wearables the likely shape is **summaries always (rollups, plus on-device summaries as an option) and raw samples for a bounded window (A2)**, with a separate raw store (C) only if raw must be kept long. That needs the fewest new parts and keeps M15 to M21 working. Design it as a note after the measurements; prototype only after approval of any new service.
6. **Treat nutrition separately:** keep per-nutrient Observations; add the group key (B3) if the correlation id turns out to exist and per-food views are wanted; reconsider components only if the nutrition volume at population scale becomes the problem.

## 7. A measurement plan (proposed milestone, not yet in the implementation plan)

Synthetic data only, on this stack, in its own synthetic patients, never touching the governance stack. 

| Measure | How | Why |
|---|---|---|
| Bytes per Observation including indexes | load N Observations (10^4, 10^5, 10^6 as far as Oracle Free allows) and read the FHIR schema's segment sizes before and after | the input to section 3 |
| Write throughput | the seed tools with 1, 4, 8 concurrent bundles and bundle sizes 50, 100, 250, 500; conditional create versus plain create | where one HAPI node saturates; what idempotency costs |
| Search latency against table size | patient + code + date, `_lastUpdated`, and the flowsheet queries at each N | whether reads stay usable |
| Worker | scan time and recompute time per cycle at each N; rescan time | where the global scan breaks |
| Analytics store and API | rollup row counts, API latency over 90 days at each N | the analytic path |
| Resources | HAPI heap and Oracle CPU and memory during each run | the ceiling for this hardware |
| `SampledData` | one synthetic workout (an hour of heart rate at one reading every 5 s, 720 values) as one block and as 720 per-sample Observations: size, load time, search, and the cost to unpack in the worker; and a day of 5-minute background readings the same way | whether B2 is as good as it looks for wearable data |
| A bounded raw window (A2) | load a year of synthetic samples for a few patients, then expunge everything older than 30 or 90 days and check that rollups, the intraday view and the analytics stay correct | whether A2 works end to end, and what expunge costs **[UNVERIFIED]** |

**Limits stated up front:** Oracle Free's size cap may stop the larger runs (section 4); a single Mac measures a single node, so the results say where it bends, not what a cluster does; the numbers carry the Mac's own performance. If the cap blocks the interesting range, the choice is to extrapolate with stated error or to approve a different database for the measurement.

## 8. Questions for the developer

1. **Signals and share:** beyond heart rate, resting heart rate, HRV, sleep and nutrition, which wearable signals matter (steps, oxygen saturation, respiratory rate, ECG summaries), and what share of patients do you expect to connect a wearable, now and in a few years?
2. **Readers of raw data:** does any clinician or algorithm need the raw samples (the intraday view, reviewing a flagged value), or are rollups and excursions enough? For how long: 30 days, 90 days, the whole record?
3. **Latency:** is daily or hourly review enough, or does any wearable signal need to raise an alert within minutes?
4. **Retention and deletion:** how long is raw data kept, and what happens on a patient's withdrawal of consent? (Per-sample storage makes this easy; blocks and tiers make it a design job.)
5. **Population:** is the 100,000 to 500,000 one deployment or many, and one jurisdiction or several?
6. **Infrastructure:** are you willing to approve, for a prototype, a second store, a queue, or a different database for the measurement? (Required before any code.)
7. **Source:** is Apple Health the only path? Wearables also reach a health system through vendor clouds and other phone platforms, which changes who writes to the server and whether a phone is in the loop.

## 9. Assumptions and unknowns (flagged per the working rules)

| # | Assumption or unknown | Matters because |
|---|---|---|
| S1 | The wearable cadence (heart rate every 5 to 10 minutes plus workout bursts), the 300 and 1,000 a day, and the 25% adoption figure in section 3 are mine; pilot data or a published device cadence replaces them (the developer's own watch data is not representative). | Every volume figure. |
| S2 | 5 KB per Observation, indexes included, is a guess. | Every storage figure; measure it. |
| S3 | A well-tuned HAPI on Oracle's ceiling is somewhere in the low hundreds of millions of resources. | Whether option A covers the lower scenarios. |
| S4 | Conditional create costs an index search per entry. | Write amplification. |
| S5 | Oracle Free's limits are about 12 GB of user data, 2 CPU threads, 2 GB of RAM. | Whether the measurement can run here. |
| S6 | A peak-to-average ingest ratio of a few times. | Sizing the gateway and queue. |
| S7 | HAPI Subscriptions or Bulk Export can replace the `_lastUpdated` scan. | The worker's future. |
| S8 | `SampledData` blocks cannot be amended in this pipeline (the capture role cannot update). | Whether blocks must be closed and immutable. |
| S9 | Keycloak and token verification are not the bottleneck on the data path. | The auth design at scale. |
| S10 | V1 (a router) is expensive because responses and bundles mix resource types (developer's experience; our own upload bundle mixes `Device` and `Observation`). HAPI JPA lets the `Observation` resource provider be replaced at bootstrap, and the replacement must implement the whole interaction surface itself (developer's experience: a near-complete attempt took considerable effort and was not finished; not tried here). The DAO-level features listed in section 5b may be left behind. | Whether a drop-in view (V1 or V2) is worth its cost, or a separate base (V3) is enough. |

## 10. What this does not decide

Alert thresholds and their clinical validity, regulatory classification of monitoring, consent and retention policy, clinical workflow, and the choice of any specific vendor or product. Those are inputs to section 8, not outputs of this brief.
