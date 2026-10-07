# Implementation Plan: Clinical Longitudinal Monitoring POC

> Produced with `app-build-planner`. Status: DRAFT for developer review.
> Build one milestone at a time. Stop after each for diff review and verification (CLAUDE.md).

## Context

| Field | Value |
|---|---|
| App | Patient-side iOS capture app (HealthKit or synthetic source) -> HAPI FHIR -> analytic worker (Oracle) -> clinician web app |
| Need statement | Not available (`biodesign-needs-finding` not run; the POC's goal is architectural learning) |
| Platform | Capture app: Apple-native (Swift/SwiftUI + Spezi), iOS. Clinician app: React / TypeScript web. |
| Backend | HAPI FHIR 7.6.0 R4 (system of record) at `https://macpro16.local:8443/fhir` (target); Oracle 26ai for analytics (you stand it up); Node/TypeScript aggregation worker and analytic API |
| Study context | No |

### Projects and repository layout (monorepo)

One repository (this one). Each project is a top-level directory with its own `CLAUDE.md`; root `CLAUDE.md` holds the data and workflow rules that apply everywhere.

```
spezi/
  CLAUDE.md          # data rules, workflow rules
  docs/              # planning briefs, fhir-data-model.md, this plan
  contract/          # versioned machine-readable code table (metrics.json)
  hapi/              # HAPI 7.6.0 config, TLS, authentication
  ios/               # Spezi-based capture app (Swift, SwiftUI, Spezi)
  analytics/         # Node/TypeScript aggregation worker + analytic API (Oracle)
  web/               # React/TypeScript clinician app
```

| Convention | Rule |
|---|---|
| Commit prefixes | `docs:`, `contract:`, `hapi:`, `ios:`, `analytics:`, `web:`, `repo:` |
| Milestone tags | `m00`, `m01`, ... tagged after you approve each milestone |
| Contract | `contract/metrics.json` is the only machine-readable code table; `ios/`, `analytics/` and `web/` read it or test against it. A mapping change updates it and every consumer in one commit. |
| Data-leak guard | One pre-commit check at the root (set up in M0) |
| Template | `SpeziTemplateApplication` is copied into `ios/` without its `.git`; the upstream commit is recorded in `ios/README.md` |

## Planning Inputs

- **`docs/planning/ux-brief.md` (approved):** capture-app and clinician journeys, three initial metrics (resting heart rate, heart rate/HRV, sleep), three views (longitudinal trend + flowsheet, sleep, intraday), synthetic-source controls on a simulator screen, risks.
- **`docs/planning/fhir-data-model.md` (approved, assumptions A1-A13):** base R4, no `meta.profile`, LOINC/UCUM mappings, sleep as per-stage interval Observations, `Device`, no Provenance, namespace `http://blueysoft.com/fhir`, search patterns, analytic projection.
- **Not run (gaps):** `digital-health-compliance-planning` (see Compliance Integration: CLAUDE.md data rules stand in), `health-data-model-planning`, `biodesign-needs-finding`, `digital-health-study-planning`. `fasten-ehr-integration` is intentionally excluded (external service).

## Feature List

| # | Feature | Source | Priority | Packages / Modules |
|---|---|---|---|---|
| 0 | Monorepo foundation: skeleton, `.gitignore`s, root test script, data-leak guard | Repo decision | Must | Custom |
| 1 | HAPI over TLS at `macpro16.local`, trusted by Mac and iPhone | UX risk 1-2 | Must | HAPI config (custom) |
| 2 | HAPI authentication + minimal authorization (capture write, clinician read, worker read) | UX risk 1 | Must | HAPI config (custom) |
| 3 | Capture app shell, orientation screen, source choice | UX capture journey 1 | Must | Spezi template, SpeziOnboarding (orientation only) |
| 4 | Shared contract file + metric registry + HealthKit/synthetic -> FHIR mapping | FHIR spec | Must | Custom (Swift), `contract/metrics.json` |
| 5 | Synthetic source + simulator controls (cadence, jitter, gaps, late, duplicates, artifacts, presets) | UX capture journey 3 | Must | Custom (Swift/SwiftUI) |
| 6 | Local queue + upload (transaction Bundles, conditional create, retry, offline) + sync status UI | UX capture journey 2/4 | Must | SpeziFHIR (to verify), custom |
| 7 | Analytic store schema + aggregation worker (daily rollups, sleep nights, late-arrival recompute) | UX risk 5, FHIR flow 3 | Must | Node/TS, Oracle (custom) |
| 8 | Analytic API for trend and sleep summaries | FHIR spec | Must | Node/TS (custom) |
| 9 | Clinician web: patient banner, staleness, quality indicators | UX clinician journey 1 | Must | React/TS (custom) |
| 10 | Clinician web: flowsheet (filter, sort, paging) | UX clinician journey 2 | Must | React/TS |
| 11 | Clinician web: longitudinal trend with bands | UX clinician journey 2 | Must | React/TS + charting lib (to choose) |
| 12 | Clinician web: intraday dense view | UX clinician journey 3 | Must | React/TS |
| 13 | Clinician web: sleep (hypnogram + nightly summary) | UX clinician journey 4 | Must | React/TS |
| 14 | HealthKit source (authorization, read, map, user-entered flag, deletions) | UX capture journey 1 | Must | SpeziHealthKit |
| 15 | Background delivery, HKDevice -> Device, sync reliability | FHIR spec | Should | SpeziHealthKit |
| 16 | Data-quality flags surfaced in views (A8) | UX clinician journey 5 | Should | Custom |
| 17 | Accessibility pass, error states, volume test, runbook | UX accessibility | Should | Custom |
| 18 | Distribution and daily-overlay views | UX candidates | Nice | Custom |

Not used from the Spezi catalog: SpeziAccount / SpeziFirebaseAccount / SpeziFirestore (no accounts, HAPI is the store), SpeziScheduler, SpeziNotifications, SpeziChat, SpeziQuestionnaire (no tasks, alerts, chat or surveys in scope).

## Milestones

Ordering rationale: server trust first (it gates real data); the synthetic pipeline end-to-end next, so every later piece is testable without real data; analytics and web before HealthKit; HealthKit last because it only swaps in a source behind an interface already proven. Reorder if you'd rather see real data sooner (M15 can move earlier once M1, M2 and M6 are done).

### Milestone 0: Monorepo foundation [repo]

**Goal:** The repository has the agreed layout, a one-command way to run each project's tests, and a guard that blocks commits containing real-data patterns.

**Depends on:** Nothing.

**Tasks:**
1. Create the directory skeleton (`hapi/`, `ios/`, `analytics/`, `web/`, `contract/`) with a README and a short `CLAUDE.md` in each project directory pointing to the root rules.
2. Per-directory `.gitignore` files (Xcode, Node, HAPI config secrets and certificates).
3. Root test script with one target per project (initially placeholders).
4. Data-leak guard as a pre-commit check: blocks files and patterns that look like real HealthKit exports, credentials, or private keys. Document its limits (it's a backstop, not proof).
5. Extend root `CLAUDE.md` with the layout, commit prefixes and milestone-tag convention.
6. First commit of the planning docs, `CLAUDE.md` and the installed skills (you decide whether `.agents/`, `.claude/` and `agent/` are committed).

**Verify:** `git status` clean after commit; each test target runs and reports "no tests yet"; the guard rejects a dummy staged file containing a fake private key header and a fake credential string.

---

### Milestone 1: HAPI over TLS [hapi/]

**Goal:** `https://macpro16.local:8443/fhir/metadata` returns the CapabilityStatement from the Mac and from the iPhone with no trust warnings.

**Depends on:** Nothing.

**Tasks:**
1. Capture the current HAPI 7.6.0 setup as reproducible config in the repo (no data in the repo).
2. Create a local CA and a server certificate for `macpro16.local` (SAN set correctly).
3. Configure HAPI/its container or proxy to serve TLS on 8443 at `/fhir`.
4. Document installing and trusting the CA profile on the iPhone.
5. Keep the existing `localhost:8092` endpoint for dev until M2 is done.

**Platform notes:** iOS App Transport Security requires valid TLS for non-local hosts; the CA must be trusted on the device (Settings -> General -> About -> Certificate Trust Settings).

**Verify:** `curl --cacert ca.pem https://macpro16.local:8443/fhir/metadata`; Safari on the iPhone loads the same URL with no warning.

---

### Milestone 2: HAPI authentication and authorization [hapi/]

**Goal:** Unauthenticated requests are rejected; three principals (capture writer, clinician reader, worker reader) have only the access they need.

**Depends on:** Milestone 1.

**Tasks:**
1. Decide the mechanism (Open Question 1).
2. Implement authentication and enforce on every `/fhir` request.
3. Implement minimal authorization: capture = create/read `Observation`, `Device`, `Patient`; clinician and worker = read-only.
4. Seed one synthetic `Patient` via a script (no real identifiers).
5. Document credential handling; no secrets in the repo.

**Verify:** unauthenticated `GET` returns 401; each principal succeeds and fails as expected with `curl`. **Real-data gate:** after this milestone, CLAUDE.md allows real data to this endpoint only.

---

### Milestone 3: Capture app scaffold [ios/]

**Goal:** A Spezi-based iOS app runs on the simulator with an orientation screen, a source choice (synthetic only for now), and the HAPI endpoint and credentials configurable outside the code.

**Depends on:** Milestone 2 (for endpoint and auth config).

**Tasks:**
1. Run `spezi-platform-selection` for the Apple-native path, but copy the Spezi Template Application into `ios/` without its `.git` and record the upstream commit in `ios/README.md`. Do not let the skill move `docs/` (they stay at the repo root).
2. Strip template features not in scope (account, scheduler, notifications, etc.); keep what's needed.
3. Orientation screen: what data, where it goes, synthetic vs real.
4. Source selection state (synthetic only enabled).
5. Config for endpoint and credentials; none committed.
6. Fill in `ios/CLAUDE.md` with stack-specific rules (Swift version, Spezi module versions, test commands).

**Platform notes:** `SpeziOnboarding` for the orientation screen. Verify the template's current structure before trimming.

**Verify:** builds and runs on the simulator; no account or consent screens; endpoint config read from outside source control.

---

### Milestone 4: Metric registry and FHIR mapping [ios/]

**Goal:** A pure, well-tested layer maps abstract samples to FHIR Observations exactly per `fhir-data-model.md`.

**Depends on:** Milestone 3.

**Tasks:**
1. Create `contract/metrics.json` (metric -> LOINC, UCUM unit, category, `effective[x]` rule, sleep stage mapping) with a version field; this is the single source of truth.
2. Load it in the app's registry (bundled copy, with a test that fails if it differs from `contract/metrics.json`).
3. Implement mapping for heart rate, resting HR, HRV, and sleep stages (A4 mapping, `inBed` unmapped).
4. Per-metric validation (code, unit, required fields, offsets).
5. Deterministic `identifier`, `meta.source`, and `Device` key.
6. Golden-JSON unit tests with synthetic samples, including edge cases (period vs instant, DST offsets).

**Platform notes:** No network, no HealthKit yet. Maps from an internal sample type that both sources will produce.

**Verify:** unit tests pass; produced JSON matches the spec samples; the contract test fails if the bundled copy is edited.

---

### Milestone 5: Synthetic source and simulator controls [ios/]

**Goal:** A simulated device emits samples at a configurable cadence, with controls to inject gaps, jitter, late/batched delivery, duplicates and artifacts, via a simulator screen visible only when the source is synthetic.

**Depends on:** Milestone 4.

**Tasks:**
1. Ingest source protocol (HealthKit and synthetic will both implement it).
2. Synthetic generator for the four metrics (plausible waveforms, sleep nights).
3. Controls: cadence, jitter, gaps, late delivery, duplicates, outliers, presets.
4. Simulator screen (hidden for HealthKit source).
5. Deterministic seed option for tests.

**Verify:** unit tests on the generator's behaviors; simulator screen shows emitted samples live; presets produce the intended anomalies.

---

### Milestone 6: Local queue and upload [ios/]

**Goal:** Synthetic samples reach HAPI as FHIR Observations over TLS with authentication, surviving offline periods and resends without duplicates.

**Depends on:** Milestones 2, 5.

**Tasks:**
1. Persistent local queue.
2. Batched transaction Bundles with conditional create (`ifNoneExist` on `identifier`) and `Device` upsert.
3. Retry with backoff; offline tolerance.
4. Sync status UI: source, last sync, queued count, errors.
5. Integration test against HAPI with synthetic data.

**Platform notes:** Check whether `SpeziFHIR`'s `FHIRClient` fits conditional-create transaction Bundles; fall back to custom if not.

**Verify:** after a run, `GET Observation?subject=Patient/{id}&_summary=count` matches emitted count; resending the same batch changes nothing; toggling airplane mode then reconnecting delivers the backlog once.

---

### Milestone 7: Analytic store and daily rollups [analytics/]

**Goal:** A worker computes daily min/median/max (and counts) per metric from HAPI into Oracle, idempotently.

**Depends on:** Milestones 2, 6. You stand up Oracle 26ai (I won't install anything).

**Tasks:**
1. Schema for daily rollups (key: patient, metric code, local day, timezone).
2. Node/TypeScript worker: poll `Observation?_lastUpdated=gt{watermark}`, record touched windows.
3. Recompute touched windows with idempotent upsert; persist the watermark.
4. Day definition per A6 (patient-local day); DST-aware.
5. Tests with synthetic late, duplicate and out-of-order data.
6. Contract test: the worker's metric list and codes match `contract/metrics.json`.

**Verify:** run twice and rows are identical; a late Tuesday sample delivered Thursday changes only Tuesday's row.

---

### Milestone 8: Sleep night summaries [analytics/]

**Goal:** Per-night sleep summaries (stage durations, awakenings) are computed in Oracle from stage-interval Observations.

**Depends on:** Milestone 7.

**Tasks:**
1. Define "night" (session grouping, boundary rules); record as assumption.
2. Summary schema and computation from stage intervals.
3. Handle overlapping or conflicting intervals and missing stages.
4. Tests with synthetic nights.

**Verify:** known synthetic night yields the expected stage totals; reruns are stable.

---

### Milestone 9: Analytic API [analytics/]

**Goal:** An authenticated API serves trend bands and sleep summaries for a patient and time range.

**Depends on:** Milestones 7, 8.

**Tasks:**
1. Endpoints: daily bands (metric, range), sleep nights (range).
2. Auth consistent with M2 (clinician principal).
3. Response includes data-completeness info (gaps, last computed, watermark).
4. Contract tests and API description.

**Verify:** `curl` with a clinician token returns bands; without a token returns 401; response matches Oracle contents.

---

### Milestone 10: Clinician web scaffold and patient banner [web/]

**Goal:** A React/TypeScript app signs in as the clinician, shows the patient banner with latest values, last-data-received, and a visible stale-data indicator.

**Depends on:** Milestones 2, 6.

**Tasks:**
1. Scaffold the repo and typed FHIR client.
2. Auth wiring.
3. Banner: `Observation/$lastn`, staleness, source kinds.
4. Error and empty states.

**Verify:** banner reflects latest synthetic data; stopping the synthetic source makes staleness appear.

---

### Milestone 11: Flowsheet [web/]

**Goal:** A filterable, sortable, paged table of Observations across metrics.

**Depends on:** Milestone 10.

**Tasks:** filters (metric, range, source, status), sort, paging via HAPI search, units always visible, keyboard-accessible table.

**Verify:** results match direct HAPI searches; sort/filter combos behave over thousands of rows.

---

### Milestone 12: Longitudinal trend view [web/]

**Goal:** Weeks-to-months daily min/median/max bands per metric, from the analytic API, with gaps clearly shown.

**Depends on:** Milestones 9, 10.

**Tasks:** contract test (metric list, codes and units match `contract/metrics.json`), choose charting library (Open Question 6), band chart, time-scale controls, gap rendering, text/table equivalent, drill link to intraday.

**Verify:** matches the analytic API; synthetic gaps appear as gaps, not interpolation; screen-reader summary present.

---

### Milestone 13: Intraday dense view [web/]

**Goal:** One day's raw samples with zoom/pan and gap markers.

**Depends on:** Milestones 11, 12.

**Tasks:** paged fetch of a day, client-side downsampling for rendering, zoom/pan, gap markers, flagged-artifact markers.

**Verify:** a 17k-sample day renders responsively; zoom reveals raw points; gaps marked.

---

### Milestone 14: Sleep view [web/]

**Goal:** A single-night hypnogram plus a multi-week nightly summary.

**Depends on:** Milestones 9, 12.

**Tasks:** hypnogram from stage intervals, nightly summary from the analytic API, accessible alternatives, timezone/DST labeling.

**Verify:** a known synthetic night renders the expected stage sequence; summary matches Oracle.

---

### Milestone 15: HealthKit source [ios/]

**Goal:** The capture app can read your own HealthKit data for the three metrics and upload it to the authenticated TLS endpoint.

**Depends on:** Milestones 1, 2, 6 (real-data gate satisfied).

**Tasks:**
1. HealthKit entitlement and authorization for the specific types only.
2. Implement the ingest source protocol over HealthKit queries.
3. Map to the registry, including user-entered samples and deletions (`entered-in-error`, A11).
4. HealthKit selectable only when the endpoint is TLS + authenticated.
5. Verify no real data in logs or fixtures.

**Platform notes:** `SpeziHealthKit` for authorization and collection; verify its upload behavior against the spec before relying on it. Needs a real iPhone for meaningful data.

**Verify:** on device, a small sync appears in HAPI and the clinician web views; repo and logs contain no real values.

---

### Milestone 16: Background delivery and device mapping [ios/]

**Goal:** New HealthKit data arrives without opening the app; sources are modeled as `Device`s.

**Depends on:** Milestone 15.

**Tasks:** background delivery and observer queries, HKDevice -> `Device`, backfill windows, failure handling, battery/impact check.

**Verify:** new samples show up within an expected window with the app closed; duplicate-free after repeated syncs.

---

### Milestone 17: Data-quality surfacing and hardening [all]

**Goal:** Artifacts and late data are visible to clinicians; accessibility, errors and volume are exercised.

**Depends on:** Milestones 13-16.

**Tasks:** `meta.tag` flags (A8) displayed in views, accessibility audit, error states, volume test with dense data, runbooks per repo.

**Verify:** injected artifacts appear flagged; accessibility checks pass; dense load test completes.

## Data Model Integration

| Entity | FHIR Resource | Milestone | Notes |
|---|---|---|---|
| Patient | `Patient` | 2 (seed), 6 | One synthetic patient seeded; app only references it |
| Heart rate | `Observation` (8867-4) | 4, 6, 15 | Shaped like R4 `heartrate`, no profile claim |
| Resting heart rate | `Observation` (40443-4) | 4, 6, 15 | |
| HRV SDNN | `Observation` (112429-6) | 4, 6, 15 | `ms` unit unverified |
| Sleep stage intervals | `Observation` (93829-0/93830-8/93831-6/93832-4/103210-1) | 4, 6, 15 | `inBed` unmapped |
| Source device | `Device` | 6, 16 | Synthetic first, HKDevice in M16 |
| Daily rollups, sleep nights | Not FHIR (Oracle) | 7, 8 | Per decision, not written back |
| Data-quality flags | `meta.tag` | 17 | A8 |

## Compliance Integration

No compliance brief was produced. CLAUDE.md's data rules act as the controls:

| Control | Milestone | How |
|---|---|---|
| Real data only to own HAPI, only over TLS + auth | 1, 2, 15 | Gate: HealthKit source selectable only when endpoint meets this |
| No real data in repo, fixtures, logs, screenshots, commits | 0, 15 | Pre-commit data-leak guard from M0 (backstop only); synthetic fixtures only; log review at M15 |
| Synthetic source behind same ingest interface | 5 | Source protocol shared with HealthKit |
| No third-party or analytics services | All | No SDKs beyond Spezi modules approved per milestone |
| Ask before installing or connecting external services | All | Oracle, charting library, any new package approved at the milestone |

If this ever leaves local use, run `digital-health-compliance-planning` first.

## Open Questions

1. **Authentication mechanism for HAPI** (M2): OAuth2/OIDC bearer tokens (needs an identity provider), static API tokens, or mutual TLS? This is an external-service decision I will not make for you.
2. **Oracle 26ai edition limits** (M7): CPU, memory and storage for dense heart rate over months. Unverified.
3. **Paid Apple Developer account** (M15): whether HealthKit on a personal device needs one is unverified; it would be an account and a cost.
4. **SpeziHealthKit and SpeziFHIR behaviors** (M6, M15): the reference file's claims (background delivery, HAPI support, data store upload) need verifying against the modules before relying on them.
5. **Resolved:** monorepo layout (see Context). Still open: whether `.agents/`, `.claude/`, `agent/` and `skills-lock.json` are committed (M0).
6. **Charting library** for the web app (M12): not chosen; will be proposed with trade-offs when we reach it.
7. **Day and night definitions** (A6, M7-8): need your clinical judgment; I will propose defaults.
8. **Apple Watch**: not required until you buy it; M15-16 work with iPhone data first.
9. **HAPI request validation** (A13): enable it in M1/M2 or later?
10. **Clinician web hosting**: dev server only, or served from the Mac Pro behind TLS?

## Next Steps

Review this plan. When approved, start Milestone 0 (repo foundation), then stop for your review before Milestone 1. No application code until you approve (CLAUDE.md).
