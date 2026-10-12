# Analytics worker and API

Node.js and TypeScript. Aggregation worker and analytic API over Oracle 26ai. M9 built the worker and the store;
the API arrives in M10/M11. Planned in [docs/implementation-plan.md](../docs/implementation-plan.md).

## What M9 does

The worker reads Observations from HAPI **only through the FHIR API** (never `FHIRPDB`), as the service account
`analytics-worker` (role `worker-reader`, client-credentials grant), and keeps one row per patient, metric and UTC day
in `ANALYTICSPDB`: count, min, median, max.

```
 scan:      Observation?_lastUpdated=ge<watermark - overlap>&code=<contract quantity codes>&_sort=_lastUpdated
              -> touched windows (patient, metric, UTC day) + new watermark        ONE transaction
 recompute: for each touched window: Observation?subject&code&date=ge<day>&date=lt<next day>
              -> summarize -> upsert (or delete) the rollup, clear the touched mark ONE transaction per window
```

Every step is idempotent: a recompute reads the server's current data for the whole window, so running again, or
re-reading overlap, changes nothing (a row's `revision` increments only when its values change).

| Table (owner `analytics_owner`) | Purpose |
|---|---|
| `daily_rollup` | PK `(patient_id, metric_id, day)`; `unit`, `n`, `min_value`, `median_value`, `max_value`, `revision`, `updated_at` |
| `rollup_touched` | windows waiting to be recomputed; written in the same transaction as the watermark, so a crash loses nothing |
| `rollup_watermark` | per worker name: newest `meta.lastUpdated` seen (epoch ms) |

The metric list, LOINC codes and units come from `contract/metrics.json` at start-up (`src/contract.ts`); a test
refuses any code or unit literal in `src/`. Sleep stages are summarized per night (below), not rolled up per day.

## Sleep nights (M10)

Sleep-stage Observations (one duration Observation per stage interval, `effectivePeriod`) are summarized per sleep
session in `sleep_session` by the same worker, with the same scan, touched-window and idempotent-recompute
machinery. Pure logic is in `src/sleep.ts`.

**Windows.** A sleep window is (patient, `sleepStage`, night date). One interval can extend a session, bridge two
sessions into one (one row vanishes, another changes) or start a new one, so a touched interval marks every date
within 26 h either side; a recompute of a night reads 5 days of intervals, rebuilds the sessions, keeps those whose
final waking falls on that date, and replaces that night's rows **as a set** (insert, change, delete) in one
transaction.

**Rules** (decided for M10):

1. *Session*: a run of intervals with no gap over 2 h. A session with no asleep stage produces no row.
2. *Night date*: the UTC date of the final waking from sleep.
3. *Naps*: every session is stored; per date the one with the most time asleep is `is_main`, the rest are reported
   as non-main, never dropped.
4. *Overlaps*: every instant gets one stage; the interval that starts later wins, ties go to the more specific
   stage, then the lower id. The overlapped time is stored (`overlap_min`).
5. *Awakenings*: awake stretches strictly between onset and final waking of at least 5 minutes. Shorter ones add to
   `awake_min` only. Awake time before onset is `latency_min`; after the final waking `wake_after_end_min`.
6. *Gaps inside a session* are reported as `unscored_min`, never counted as sleep or wake.

Stored per session: session start/end, onset, last-asleep end (epoch ms); latency, wake-after-end, asleep, core,
deep, REM, unspecified, awake, unscored, overlap (minutes); awakenings, interval count, `is_main`, `revision`.

## Analytic API (M11)

A read-only HTTP API over what the worker computed (`src/api.ts`, `src/jwt.ts`, `src/server.ts`; described in
[api/openapi.json](api/openapi.json)). No new packages: Node's `https` and `crypto`.

| Request | Returns |
|---|---|
| `GET /v1/metrics` | the metrics a band exists for (id, display, UCUM unit) from the contract |
| `GET /v1/patients/{id}/bands?metric=&from=&to=` | per UTC day: n, min, median, max, revision |
| `GET /v1/patients/{id}/sleep?from=&to=` | sleep sessions whose final waking is on a date in the range, naps flagged |

Every response has a `completeness` block: `requestedDays`, `daysWithData`, `missingDays`, `pendingWindows` (changed
but not yet recomputed: the rows may be stale), `lastComputedAt`, `workerWatermark`, `generatedAt`. Absence of data
is never presented as a normal reading.

**Authentication** (same strictness as HAPI's, M4): a Keycloak access token, signature checked against the realm's
published keys (RS256 only; `none`, HMAC and other algorithms refused before any key is used), then issuer, audience
`poc-analytics`, expiry (30 s leeway), then the realm role `clinician-reader`. 401: no token or not accepted (a
token minted for HAPI, wrong signature, expired). 403: valid token, missing role. 503: the signing keys cannot be
fetched and none are cached. Authentication runs before routing and parameter checks, so an anonymous caller learns
nothing about the API. A forged `kid` cannot make the API fetch keys more than once per 30 s.

**Exposure.** TLS only, GET only, bound to **loopback `127.0.0.1:8445`** (decided at M11). The certificate is the
analytic API's own leaf from the POC CA (`~/.poc-ca/analytics/api.{key,crt}`, issued by `make tls`). Because the
name `macpro16.local` resolves to the LAN address and the listener is on loopback, callers on this Mac map the name
to loopback (curl `--resolve macpro16.local:8445:127.0.0.1`; the M12 dev server will need the same or a proxy).
CORS allows exactly one origin (default `https://macpro16.local:3000`, the clinician web app's registered origin;
`POC_API_CORS_ORIGIN` overrides), answers preflight without a token, and never uses credentials or wildcards.

```bash
make analytics-api          # foreground; Ctrl-C stops
```

**Decisions and assumptions (M11):**

- **A43 Audience `poc-analytics`** is minted only for `clinician-web` (and the dev-only `poc-devtest` client the
  scripts use). `ios-capture` and `analytics-worker` tokens carry only `hapi-fhir`. `idp/oidc.py check` asserts the
  clinician token has it, the worker token does not, and (statically, from the realm file) which clients have the
  mapper. A capture user's token obtained through `poc-devtest` does carry the audience; the role check refuses it
  (403), which the live test shows.
- **A44 Any clinician may read any patient.** No per-patient scoping: patient-clinician linking and consent are out
  of scope for the POC (UX brief section 12). The route shape (`/patients/{id}`) leaves room for it.
- **A45 One connection.** The API shares one Oracle connection per process (queries queue); fine for a POC, a pool
  is the first thing to change under load.
- **A46 Limits.** At most 366 days per request; patient ids `[A-Za-z0-9.-]{1,64}`; no request body is read.
- **A47 `missingDays` cannot distinguish** "no samples were taken" from "not delivered yet"; `pendingWindows` and
  `workerWatermark` are what let a reader judge freshness. Days are UTC (A6), so a clinic's local day is not a row.

## Run

```bash
make analytics-migrate      # create the tables (idempotent; SYS in the container, worker has no DDL rights)
make analytics-run          # one cycle on the host
analytics/run.sh status     # watermark, row count, pending windows (counts only)
analytics/run.sh loop       # every POC_WORKER_INTERVAL_SECONDS (default 30)
make test-analytics         # unit + contract tests (no stack needed)
make test-analytics-live    # end to end against HAPI, Keycloak and Oracle (synthetic data)
```

Credentials come from the git-ignored `db/.env.local` and `idp/.env.local` as environment variables
(`analytics/env.sh`); the POC CA is trusted through `NODE_EXTRA_CA_CERTS`. Nothing is printed or put on a command
line. Oracle is reached on loopback `127.0.0.1:1522` (thin mode: no Instant Client).

## Packages (approved for M9, pinned exactly)

`typescript` 7.0.2, `tsx` 4.23.15, `@types/node` 25.9.9 (dev) and `oracledb` 26.0.0 (runtime, thin). M11 added no packages. Tests use
Node's built-in runner. node-oracledb's types are declared locally (`src/oracledb.d.ts`) instead of adding
`@types/oracledb`. npm's install scripts are not needed (thin mode, no native build) and are not run.

## Decisions and assumptions (review these)

- **A6 (decided): the rollup day is the UTC calendar date of the sample's instant.** A patient crosses time zones
  and DST within a day, so a fixed reference keeps every sample's day stable. Consequence: a sample at 23:30 local in
  New York belongs to the *next* UTC day, and "a patient's day" in a clinic's sense is not what a row means. The plan's
  key `(patient, metric, local day, timezone)` therefore has no timezone column. Changing the rule later means
  recomputing every row.
- **A30 Median** of an even count is the mean of the two middle values. Values are stored as `BINARY_DOUBLE`.
- **A31 Day of a period-valued quantity** is the day of `effectivePeriod.start`. The server's `date` search matches any
  overlap, so the worker re-checks the day locally.
- **A32 Overlap window.** HAPI stamps `lastUpdated` when a transaction starts, so one that commits later can carry a
  time slightly before one already seen. The scan re-reads 60 s behind the watermark. A transaction that takes
  longer than that to commit, and touches a day nothing else touches, is missed until something touches that day:
  the limit is tested (and is a deliberate, documented trade-off, not a guarantee).
- **A33 One worker.** There is no lock; two workers with the same name would not corrupt data (every write is an
  idempotent upsert) but would duplicate work. The watermark moves forward only.
- **A34 Search caching.** HAPI reuses an identical search for 60 s by default; every worker request sends
  `Cache-Control: no-cache`, otherwise a recompute right after a write could read stale data (seen in M8).
- **A35 Units are enforced here, not by HAPI.** An Observation whose `valueQuantity` is not the contract's UCUM
  system and code is excluded and counted (`wrongUnit`).
- **A36 No deletes.** No role can delete Observations, so a rollup is never made smaller by a deletion; a window
  whose observations are all gone does delete its row (handled, tested with a fake only).
- **A37 Session gap** is 2 hours and **A38 minimum awakening** is 5 minutes: constants in `src/sleep.ts`, a clinical
  judgment, not standards. They could move into `contract/metrics.json` with the M16 thresholds.
- **A39 Night date** is the UTC date of the final waking, consistent with A6; a sleeper far from UTC can see a
  night dated one day away from their local date.
- **A40 Durations come from the period**, not from the Observation's `valueQuantity` (the contract derives that
  value from the period, so they agree for data the app produced).
- **A41 `inBed` never reaches the server** (contract v1: unmapped), so time in bed is not available; session span
  (start to end) is the closest proxy and is not labelled "in bed".
- **A42 Session length**: a recompute reads 5 days, so a session longer than about 30 hours would be cut. Not
  expected from real sleep.
- Not done: the analytic API (M11), flagging of artifacts (M16), a container for the worker (it runs on the host
  for the POC).
