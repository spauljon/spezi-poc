# Implementation Plan: Clinical Longitudinal Monitoring POC

> Produced with `app-build-planner`. Status: DRAFT for developer review.
> Build one milestone at a time. Stop after each for diff review and verification (CLAUDE.md).

## Context

| Field | Value |
|---|---|
| App | Patient-side iOS capture app (HealthKit or synthetic source) -> HAPI FHIR -> analytic worker (Oracle) -> clinician web app |
| Need statement | Not available (`biodesign-needs-finding` not run; the POC's goal is architectural learning) |
| Platform | Capture app: Apple-native (Swift/SwiftUI + Spezi), iOS. Clinician app: React / TypeScript web. |
| Backend | HAPI FHIR 7.6.0 R4 (system of record) at `https://macpro16.local:8443/fhir` (target), on Oracle 26ai in its own FHIR PDB; a second analytics PDB in the same instance (you stand it up); Node/TypeScript aggregation worker and analytic API |
| Study context | No |

### Projects and repository layout (monorepo)

One repository (this one). Each project is a top-level directory with its own `CLAUDE.md`; root `CLAUDE.md` holds the data and workflow rules that apply everywhere.

```
spezi/
  CLAUDE.md          # data rules, workflow rules
  docs/              # planning briefs, fhir-data-model.md, this plan
  contract/          # versioned machine-readable code table (metrics.json)
  db/                # Oracle container, bootstrap SQL, FHIR and analytics PDBs (created in M1)
  hapi/              # HAPI 7.6.0 config, Oracle datasource, TLS, token verification, authorization
  idp/               # Keycloak realm and Docker Compose (created in M3)
  ios/               # Spezi-based capture app (Swift, SwiftUI, Spezi)
  analytics/         # Node/TypeScript aggregation worker + analytic API (Oracle)
  web/               # React/TypeScript clinician app
```

| Convention | Rule |
|---|---|
| Commit prefixes | `docs:`, `contract:`, `db:`, `hapi:`, `idp:`, `ios:`, `analytics:`, `web:`, `repo:` |
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
| 0b | Independent POC stack: Oracle Free with two PDBs (FHIR, analytics) and HAPI 7.6.0 on Oracle; reset procedure | Developer decision | Must | Oracle, HAPI datasource config (adapted from governance project) |
| 1 | HAPI over TLS at `macpro16.local`, trusted by Mac and iPhone | UX risk 1-2 | Must | HAPI config (custom) |
| 2 | Keycloak IdP (realm, roles, clients) + HAPI token verification and authorization rules (capture write, clinician read, worker read) | UX risk 1 | Must | Keycloak, HAPI interceptors (custom) |
| 2b | Sign-in flow in the capture app (authorization code + PKCE, Keychain) | UX capture journey 1 | Must | Custom (OIDC client library TBD) |
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

Ordering rationale: server trust first (it gates real data); the synthetic pipeline end-to-end next, so every later piece is testable without real data; analytics and web before HealthKit; HealthKit last because it only swaps in a source behind an interface already proven. Reorder if you'd rather see real data sooner (M17 can move earlier once M2-M4 and M8 are done).

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

### Milestone 1: POC Oracle and HAPI stack [db/, hapi/]

**Goal:** A self-contained POC stack runs: its own Oracle Free container with a FHIR PDB and an empty analytics PDB, and its own HAPI 7.6.0 container using the FHIR PDB. A synthetic `Patient` round-trips at a loopback-only dev endpoint, `http://127.0.0.1:8192/fhir`.

**Depends on:** Nothing. The Docker daemon must be running, and you approve any image pull.

**Independence rule:** the stack shares nothing with the governance project (`~/repositories/pghd-governance-mapping-tool-service`): its own compose project name, network, volume (`poc_oracle_data`), containers and ports. That project uses host ports 1521, 3001, 5500, 8091-8093, 8095, 8200, 8500, 8600, 9000, 9090 and 27017. POC ports: Oracle 1522 and the HAPI plain-HTTP dev port 8192 are published **on loopback only** (`127.0.0.1:...`), and the actuator is not published at all (the healthcheck runs inside the container). Network-reachable endpoints are TLS only: Keycloak 8444 from M3, and HAPI 8443 only from M4 (it is loopback-bound in M2 and M3 so an unauthenticated HAPI is never reachable from the network). Files are copied and adapted from the governance project, never referenced or mounted from it.

**Tasks:**
1. Create the `db/` skeleton (README, `CLAUDE.md`, `.gitignore`, `.env.example`), a `test-db` Makefile target, and the `db:` prefix in root `CLAUDE.md` (M0 predates this directory).
2. Oracle container: the Free image used by the governance stack (`container-registry.oracle.com/database/free:23.26.0.0-arm64`; reuse it locally if present, and confirm before any pull since the registry can require a license acceptance or login), host port 1522, named volume, healthcheck.
3. Bootstrap SQL adapted from the governance `init.sh` and `setup.sql`: create `FHIRPDB` and `ANALYTICSPDB`, a least-privilege user in each, tablespace quotas. Passwords come from a gitignored `.env.local`.
4. HAPI schema DDL: adapt the stock HAPI 7.6.0 Oracle DDL (`oracle.sql`) from the governance project into `hapi/`, excluding governance-specific objects (`chg-log.sql`, the trigger and flashback grants). Load it into the FHIR PDB user.
5. HAPI image and config: adapted `Dockerfile` (`hapiproject/hapi:v7.6.0` plus the additive `/app/extra-classes` mount point, empty until M4) and `application.yaml` (Oracle datasource by PDB service name, `HapiFhirOracleDialect`, UTC, Flyway off, credentials from the environment).
6. Compose wiring for both services: loopback-bound published ports, in-container healthchecks, `depends_on` Oracle healthy.
7. Docs: measured instance facts (edition, version, actual CPU, memory and user-data caps), the boundary rule (analytics reads HAPI only through the FHIR API, never the FHIR PDB), a PDB reset procedure, and provenance (the governance repo commit the files were adapted from).

**Platform notes:** HAPI's JPA schema is index-heavy, so measure growth with synthetic data early. Whether the copied DDL exactly matches HAPI 7.6.0 is checked by a one-time `hibernate.hbm2ddl.auto: validate` start (unverified until then).

**Verify:** both PDBs show open in `v$pdbs`; the HAPI container reports `healthy`; HAPI tables exist only in the FHIR PDB user; the schema `validate` start passes; a synthetic `Patient` can be `POST`ed and `GET`ed at `http://127.0.0.1:8192/fhir`; connecting to the Mac's LAN address on ports 8192 and 1522 is refused; the analytics PDB has no HAPI tables; the governance containers, volumes and ports are unchanged (compare `docker ps` and `docker volume ls` before and after); `make guard-all` passes and no passwords are in the repo.

---

### Milestone 2: HAPI over TLS [hapi/]

**Goal:** HAPI serves `https://macpro16.local:8443/fhir` over TLS with a certificate from a local CA, reachable from the Mac only (port published on loopback), with the plain-HTTP dev port gone.

**Depends on:** Milestone 1 (HAPI config captured, Oracle-backed).

**Tasks:**
1. Capture the current HAPI 7.6.0 setup as reproducible config in the repo (no data in the repo).
2. Create a local CA and a server certificate for `macpro16.local` (SAN set correctly). Keep the CA private key outside the repo; M3 reuses the CA for Keycloak.
3. Configure HAPI/its container or proxy to serve TLS on 8443 at `/fhir`, published as `127.0.0.1:8443` only.
4. Document installing and trusting the CA profile on the iPhone (the phone check happens in M3 and M4).
5. Once TLS is verified, remove the plain-HTTP dev port so HAPI is HTTPS-only. HAPI stays loopback-bound until M4, so an unauthenticated HAPI is never reachable from the network.

**Platform notes:** iOS App Transport Security requires valid TLS for non-local hosts; the CA must be trusted on the device (Settings -> General -> About -> Certificate Trust Settings).

**Verify:** `curl --cacert ca.pem --resolve macpro16.local:8443:127.0.0.1 https://macpro16.local:8443/fhir/metadata` succeeds (this also checks the certificate's name); the plain-HTTP port is no longer published; connecting to the Mac's LAN address on 8443 is refused.

---

### Milestone 3: Keycloak identity provider [idp/]

**Goal:** A local Keycloak over TLS issues signed JWTs with role claims for three principals; the discovery document and JWKS are reachable from the Mac and the iPhone with no trust warnings, and tokens can be obtained and inspected with `curl`.

**Depends on:** Milestone 2 (local CA and TLS approach).

**Tasks:**
1. Create the `idp/` skeleton (README, `CLAUDE.md`, `.gitignore` for generated secrets and data), add a `test-idp` target to the Makefile and the `idp:` prefix to root `CLAUDE.md` (M0 predates this directory).
2. Confirm with you before pulling the Keycloak image (needs Docker). Pin a version after checking current Keycloak docs: image name, tags and startup flags are unverified.
3. Docker Compose: Keycloak in dev mode with its embedded database (POC only), TLS from a certificate issued by the M2 CA for `macpro16.local`, port 8444 published on the network. Generate a strong admin password outside the repo, and restrict the admin console to loopback if the pinned Keycloak version supports it (unverified).
4. Realm `poc` as code: roles `capture-writer`, `clinician-reader`, `worker-reader`; clients `ios-capture` and `clinician-web` (public, authorization code + PKCE) and `analytics-worker` (confidential, client credentials); mappers for the roles claim and audience; synthetic test users only.
5. Commit the realm export in templated form with no secrets or passwords; a script generates local secrets and passwords outside the repo.
6. Document token lifetimes and refresh behavior (including the phone offline case).

**Platform notes:** Keycloak issues no FHIR-specific claims; HAPI evaluates the roles and audience in M4. A dev-only test client (direct access grant) lets `curl` obtain user tokens without a browser. It is for testing only and is never used by the apps.

**Verify:** discovery document and JWKS reachable by `curl` (with the CA) and in iPhone Safari with no trust warning (this is the phone's CA trust test; it also proves the certificate name works for `macpro16.local`); a worker client-credentials token decodes to the expected `iss`, `aud`, `exp` and roles; a test-user token carries the clinician role; a wrong client secret is rejected; `make guard-all` passes with the realm export staged.

---

### Milestone 4: HAPI token verification and authorization [hapi/]

**Goal:** HAPI rejects requests without a valid Keycloak token, and each principal has only the access its roles allow.

**Note:** HAPI does not authenticate. Keycloak (M3) authenticates and issues the JWT; HAPI verifies it, and `AuthorizationInterceptor` evaluates rules built from its claims.

**Depends on:** Milestones 2, 3.

**Tasks:**
1. Verify bearer JWTs on every `/fhir` request: signature via the realm's JWKS, plus `iss`, `aud` and `exp`; reject otherwise with 401. (Spring Security resource server or a custom interceptor: the approach adds a dependency, so I'll propose it and confirm with you first.)
2. `AuthorizationInterceptor` rules from roles: `capture-writer` = create/read `Observation`, `Device`, `Patient`; `clinician-reader` and `worker-reader` = read-only; unauthenticated `GET /fhir/metadata` only (the capability statement), to be confirmed with you.
3. Evaluate `SearchNarrowingInterceptor` for patient-compartment scoping via a claim (future multi-patient); decide at this milestone.
4. Seed one synthetic `Patient` via a script using a `capture-writer` token.
5. Document clock skew, JWKS rotation behavior, and that unverified claims are never trusted.
6. Only after the verify steps pass, re-bind HAPI's 8443 from loopback to the network.

**Verify:** no token -> 401 (except `/fhir/metadata`); expired or wrong-audience token -> 401; clinician token can `GET` but gets 403 on `POST Observation`; capture token can `POST`; worker token can `GET` and gets 403 on `POST`. iPhone Safari loads `https://macpro16.local:8443/fhir/metadata` with no trust warning and gets 401 on `/fhir/Patient`. **Real-data gate:** after this milestone, CLAUDE.md allows real data to `https://macpro16.local:8443/fhir` only.

---

### Milestone 5: Capture app scaffold [ios/]

**Goal:** A Spezi-based iOS app runs on the simulator with an orientation screen, a source choice (synthetic only for now), and the HAPI endpoint and credentials configurable outside the code.

**Depends on:** Milestone 4 (for endpoint and auth config).

**Tasks:**
1. Run `spezi-platform-selection` for the Apple-native path, but copy the Spezi Template Application into `ios/` without its `.git` and record the upstream commit in `ios/README.md`. Do not let the skill move `docs/` (they stay at the repo root).
2. Strip template features not in scope (account, scheduler, notifications, etc.); keep what's needed.
3. Orientation screen: what data, where it goes, synthetic vs real.
4. Source selection state (synthetic only enabled).
5. Config for endpoint and credentials; none committed.
6. Sign in with Keycloak (authorization code + PKCE) as the synthetic capture user; store tokens in the Keychain; show signed-in state. The OIDC client library (for example AppAuth) is a package beyond the template, so I'll propose it and confirm with you first.
7. Fill in `ios/CLAUDE.md` with stack-specific rules (Swift version, Spezi module versions, test commands).

**Platform notes:** `SpeziOnboarding` for the orientation screen. Verify the template's current structure before trimming.

**Verify:** builds and runs on the simulator; no account or consent screens; endpoint config read from outside source control.

---

### Milestone 6: Metric registry and FHIR mapping [ios/]

**Goal:** A pure, well-tested layer maps abstract samples to FHIR Observations exactly per `fhir-data-model.md`.

**Depends on:** Milestone 5.

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

### Milestone 7: Synthetic source and simulator controls [ios/]

**Goal:** A simulated device emits samples at a configurable cadence, with controls to inject gaps, jitter, late/batched delivery, duplicates and artifacts, via a simulator screen visible only when the source is synthetic.

**Depends on:** Milestone 6.

**Tasks:**
1. Ingest source protocol (HealthKit and synthetic will both implement it).
2. Synthetic generator for the four metrics (plausible waveforms, sleep nights).
3. Controls: cadence, jitter, gaps, late delivery, duplicates, outliers, presets.
4. Simulator screen (hidden for HealthKit source).
5. Deterministic seed option for tests.

**Verify:** unit tests on the generator's behaviors; simulator screen shows emitted samples live; presets produce the intended anomalies.

---

### Milestone 8: Local queue and upload [ios/]

**Goal:** Synthetic samples reach HAPI as FHIR Observations over TLS with authentication, surviving offline periods and resends without duplicates.

**Depends on:** Milestones 4, 7.

**Tasks:**
1. Persistent local queue.
2. Batched transaction Bundles with conditional create (`ifNoneExist` on `identifier`) and `Device` upsert.
3. Retry with backoff; offline tolerance.
4. Sync status UI: source, last sync, queued count, errors.
5. Integration test against HAPI with synthetic data.

**Platform notes:** Check whether `SpeziFHIR`'s `FHIRClient` fits conditional-create transaction Bundles; fall back to custom if not.

**Verify:** after a run, `GET Observation?subject=Patient/{id}&_summary=count` matches emitted count; resending the same batch changes nothing; toggling airplane mode then reconnecting delivers the backlog once.

---

### Milestone 9: Analytic store and daily rollups [analytics/]

**Goal:** A worker computes daily min/median/max (and counts) per metric from HAPI into Oracle, idempotently.

**Depends on:** Milestones 1 (analytics PDB), 4, 8.

**Tasks:**
1. Schema for daily rollups (key: patient, metric code, local day, timezone).
2. Node/TypeScript worker: obtain tokens with the client-credentials grant (refresh before expiry), then poll `Observation?_lastUpdated=gt{watermark}`, record touched windows.
3. Recompute touched windows with idempotent upsert; persist the watermark.
4. Day definition per A6 (patient-local day); DST-aware.
5. Tests with synthetic late, duplicate and out-of-order data.
6. Contract test: the worker's metric list and codes match `contract/metrics.json`.

**Verify:** run twice and rows are identical; a late Tuesday sample delivered Thursday changes only Tuesday's row.

---

### Milestone 10: Sleep night summaries [analytics/]

**Goal:** Per-night sleep summaries (stage durations, awakenings) are computed in Oracle from stage-interval Observations.

**Depends on:** Milestone 9.

**Tasks:**
1. Define "night" (session grouping, boundary rules); record as assumption.
2. Summary schema and computation from stage intervals.
3. Handle overlapping or conflicting intervals and missing stages.
4. Tests with synthetic nights.

**Verify:** known synthetic night yields the expected stage totals; reruns are stable.

---

### Milestone 11: Analytic API [analytics/]

**Goal:** An authenticated API serves trend bands and sleep summaries for a patient and time range.

**Depends on:** Milestones 9, 10.

**Tasks:**
1. Endpoints: daily bands (metric, range), sleep nights (range).
2. Validate Keycloak JWTs (audience, `clinician-reader` role) the same way HAPI does in M4.
3. Response includes data-completeness info (gaps, last computed, watermark).
4. Contract tests and API description.

**Verify:** `curl` with a clinician token returns bands; without a token returns 401; response matches Oracle contents.

---

### Milestone 12: Clinician web scaffold and patient banner [web/]

**Goal:** A React/TypeScript app signs in as the clinician, shows the patient banner with latest values, last-data-received, and a visible stale-data indicator.

**Depends on:** Milestones 4, 8.

**Tasks:**
1. Scaffold the repo and typed FHIR client.
2. Sign in with Keycloak (authorization code + PKCE) as the synthetic clinician; token handling and refresh.
3. Banner: `Observation/$lastn`, staleness, source kinds.
4. Error and empty states.

**Verify:** banner reflects latest synthetic data; stopping the synthetic source makes staleness appear.

---

### Milestone 13: Flowsheet [web/]

**Goal:** A filterable, sortable, paged table of Observations across metrics.

**Depends on:** Milestone 12.

**Tasks:** filters (metric, range, source, status), sort, paging via HAPI search, units always visible, keyboard-accessible table.

**Verify:** results match direct HAPI searches; sort/filter combos behave over thousands of rows.

---

### Milestone 14: Longitudinal trend view [web/]

**Goal:** Weeks-to-months daily min/median/max bands per metric, from the analytic API, with gaps clearly shown.

**Depends on:** Milestones 11, 12.

**Tasks:** contract test (metric list, codes and units match `contract/metrics.json`), choose charting library (Open Question 6), band chart, time-scale controls, gap rendering, text/table equivalent, drill link to intraday.

**Verify:** matches the analytic API; synthetic gaps appear as gaps, not interpolation; screen-reader summary present.

---

### Milestone 15: Intraday dense view [web/]

**Goal:** One day's raw samples with zoom/pan and gap markers.

**Depends on:** Milestones 13, 14.

**Tasks:** paged fetch of a day, client-side downsampling for rendering, zoom/pan, gap markers, flagged-artifact markers.

**Verify:** a 17k-sample day renders responsively; zoom reveals raw points; gaps marked.

---

### Milestone 16: Sleep view [web/]

**Goal:** A single-night hypnogram plus a multi-week nightly summary.

**Depends on:** Milestones 11, 14.

**Tasks:** hypnogram from stage intervals, nightly summary from the analytic API, accessible alternatives, timezone/DST labeling.

**Verify:** a known synthetic night renders the expected stage sequence; summary matches Oracle.

---

### Milestone 17: HealthKit source [ios/]

**Goal:** The capture app can read your own HealthKit data for the three metrics and upload it to the authenticated TLS endpoint.

**Depends on:** Milestones 2, 3, 4, 8 (real-data gate satisfied).

**Tasks:**
1. HealthKit entitlement and authorization for the specific types only.
2. Implement the ingest source protocol over HealthKit queries.
3. Map to the registry, including user-entered samples and deletions (`entered-in-error`, A11).
4. HealthKit selectable only when the endpoint is TLS + authenticated.
5. Verify no real data in logs or fixtures.

**Platform notes:** `SpeziHealthKit` for authorization and collection; verify its upload behavior against the spec before relying on it. Needs a real iPhone for meaningful data.

**Verify:** on device, a small sync appears in HAPI and the clinician web views; repo and logs contain no real values.

---

### Milestone 18: Background delivery and device mapping [ios/]

**Goal:** New HealthKit data arrives without opening the app; sources are modeled as `Device`s.

**Depends on:** Milestone 17.

**Tasks:** background delivery and observer queries, HKDevice -> `Device`, backfill windows, failure handling, battery/impact check.

**Verify:** new samples show up within an expected window with the app closed; duplicate-free after repeated syncs.

---

### Milestone 19: Data-quality surfacing and hardening [all]

**Goal:** Artifacts and late data are visible to clinicians; accessibility, errors and volume are exercised.

**Depends on:** Milestones 15-18.

**Tasks:** `meta.tag` flags (A8) displayed in views, accessibility audit, error states, volume test with dense data, runbooks per repo.

**Verify:** injected artifacts appear flagged; accessibility checks pass; dense load test completes.

## Data Model Integration

| Entity | FHIR Resource | Milestone | Notes |
|---|---|---|---|
| Patient | `Patient` | 4 (seed), 8 | One synthetic patient seeded; app only references it |
| Heart rate | `Observation` (8867-4) | 6, 8, 17 | Shaped like R4 `heartrate`, no profile claim |
| Resting heart rate | `Observation` (40443-4) | 6, 8, 17 | |
| HRV SDNN | `Observation` (112429-6) | 6, 8, 17 | `ms` unit unverified |
| Sleep stage intervals | `Observation` (93829-0/93830-8/93831-6/93832-4/103210-1) | 6, 8, 17 | `inBed` unmapped |
| Source device | `Device` | 8, 18 | Synthetic first, HKDevice in M18 |
| Daily rollups, sleep nights | Not FHIR (Oracle) | 9, 10 | Per decision, not written back |
| Data-quality flags | `meta.tag` | 19 | A8 |

## Compliance Integration

No compliance brief was produced. CLAUDE.md's data rules act as the controls:

| Control | Milestone | How |
|---|---|---|
| Real data only to own HAPI, only over TLS + auth | 2, 3, 4, 17 | Gate: HealthKit source selectable only when endpoint meets this |
| No real data in repo, fixtures, logs, screenshots, commits | 0, 17 | Pre-commit data-leak guard from M0 (backstop only); synthetic fixtures only; log review at M17 |
| Synthetic source behind same ingest interface | 7 | Source protocol shared with HealthKit |
| No third-party or analytics services | All | No SDKs beyond Spezi modules approved per milestone |
| No secrets in the repo (Oracle and Keycloak credentials, test-user passwords, CA keys) | 1, 2, 3, 4 | Realm export templated; generated secrets and CA key live outside the repo; guard blocks key/secret patterns |
| Ask before installing or connecting external services | All | Oracle, charting library, any new package approved at the milestone |

If this ever leaves local use, run `digital-health-compliance-planning` first.

## Open Questions

1. **Resolved:** Keycloak is the IdP (decided). Still open for M3: Docker availability and your approval to pull the image, the Keycloak version and port numbers, and whether to run it on the Mac Pro alongside HAPI and Oracle.
2. **Oracle Free edition limits and host memory** (M1, M9): the POC runs its own Oracle container alongside the governance stack's, so total RAM matters too. CPU, memory and user-data caps apply to the whole instance across PDBs, so HAPI's index-heavy schema and the rollups compete for the same budget. Unverified until M1 measures them.
3. **Paid Apple Developer account** (M17): whether HealthKit on a personal device needs one is unverified; it would be an account and a cost.
4. **SpeziHealthKit and SpeziFHIR behaviors** (M8, M17): the reference file's claims (background delivery, HAPI support, data store upload) need verifying against the modules before relying on them.
5. **Resolved:** monorepo layout (see Context). Still open: whether `.agents/`, `.claude/`, `agent/` and `skills-lock.json` are committed (M0).
6. **Charting library** for the web app (M14): not chosen; will be proposed with trade-offs when we reach it.
7. **Day and night definitions** (A6, M9-10): need your clinical judgment; I will propose defaults.
8. **Apple Watch**: not required until you buy it; M17-18 work with iPhone data first.
9. **HAPI request validation** (A13): enable it in M4 or later?
10. **Clinician web hosting**: dev server only, or served from the Mac Pro behind TLS?
11. **OIDC client library for iOS** (M5): AppAuth or a custom `ASWebAuthenticationSession` implementation; adds a package beyond the template, so it needs your approval.
12. **Token lifetime vs. offline capture** (M3, M8): how long the capture queue can wait before a refresh is required.

## Next Steps

Review this plan. When approved, start Milestone 0 (repo foundation), then stop for your review before Milestone 2. No application code until you approve (CLAUDE.md).
