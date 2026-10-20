# Analytics worker and API

Operating the stack (start, logs, updating a service, resets, failures): [docs/runbooks/operations.md](../docs/runbooks/operations.md).

Node.js (version pinned in the root `.nvmrc`; `nvm use`) and TypeScript. Aggregation worker and analytic API over Oracle 26ai. M9 built the worker and the store;
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

## Data-quality flag counts (M19)

A rollup row also carries `n_artifact` and `n_late`: how many of the day's samples hold the **stored** `artifact-suspected` and `late-arrival` tags (contract `systems.dataQualityFlag` and `dataQualityFlags`). The API returns them per band as `artifactSuspected` and `lateArrival`.

- **The bands still include every stored value**, flagged ones too: a flag is a suspicion, not a removal, and the counts say how many of the values are suspect.
- **Counted from the tag only**, never inferred from a value; a tag in another system, or a different code, is not counted (tests, with positive controls). A flag arriving with a late sample changes the row and its revision.
- **Schema:** added by `ALTER TABLE` in `sql/10-schema.sql` (ORA-01430 "column exists" is the only error tolerated), so an existing database gains the columns on the next init or `make analytics-migrate`. The running containers must be rebuilt to read them (see [docs/runbooks/operations.md](../docs/runbooks/operations.md)).
- The contract loader refuses a contract without the flag system and codes; the fixtures isolate each refusal's reason.
- Verified live: flagged Observations written to HAPI, worked through the worker and Oracle, and the API's counts equal an independent count of the tags.

## Daily dietary intake totals (M22)

Dietary intake (contract 1.5.0, `kind: "intake"`: energy, protein, carbohydrate, fat, fibre, sugar, sodium, water) is a **sum**, not a band: `GET /v1/nutrients` lists the nutrients and `GET /v1/patients/{id}/nutrition?nutrient=&from=&to=` returns, for each day that has entries, the total, the number of entries, the first and last entry, the flag counts and the day split by meal. It is stored in `nutrition_daily` (`sql/10-schema.sql`), one row per patient, nutrient and day as recorded for the whole day (`meal = 'all'`) and one per meal that has entries (a contract meal code, or `unlabelled`).

- **Day as recorded (D3).** An entry belongs to the calendar date written in its own `effectiveDateTime` (or `effectivePeriod.start`), in the offset it carries: `2026-10-19T23:30:00-07:00` is the 19th although it is the 20th in UTC. Bands and sleep keep the UTC day (A6); the API says which rule applies in `dayDefinition`, and the two never mix in one table. The worker's day search covers the widest possible UTC span for a recorded day (UTC-12 to UTC+14) and then checks each entry's own date.
- **No entries is not zero.** A day with no entries has no row and appears in `completeness.missingDays`; a day whose entries sum to zero has a row with `total: 0` and `entries > 0`. Tests, the live test and `verify-intake.py` all keep the two apart, each with a control.
- **Only `final` entries count.** A retracted entry (`entered-in-error`, M21) drops out on the next cycle; retracting a day's last entry removes the day (it becomes "no entries", never a stored zero). An edit in the source app arrives as a retraction plus a new entry and shows the new amount only.
- **Exact sums.** Each amount is taken to a millionth of a unit and added as an integer, so the order of entries and float rounding cannot change a total (`0.1 + 0.2` is `0.3`). Tests compare the sum with an independent decimal-string implementation.
- **Flags** are counted from the stored tags exactly as for bands; the total includes flagged entries (a 7,000 kcal entry is in the day and counted as suspect).
- **Only the contract is trusted for codes:** each nutrient's system, code and unit come from `contract/metrics.json` (five are LOINC, three are in the contract's own `nutrient` system); the worker re-checks the code, unit, patient, status and recorded day of every returned entry instead of trusting the search. An entry with a wrong unit is left out and counted (`wrongUnit`), a negative or non-numeric amount is left out and counted (`invalidValue`), and a date-time with no offset has no day (ignored).

Independent check on any patient, safe for real data because it prints counts and a verdict only:

```bash
python3 analytics/verify-intake.py            # the synthetic patient
python3 analytics/verify-intake.py poc-real   # your own data
```

It reads the Observations from HAPI itself (no shared code), sums them by the date written in each timestamp, and compares every day and nutrient with the API, including that the meals add up to the day.

**Backfill after a contract change.** The worker scans only what changed since its watermark, so Observations written *before* it knew a metric's code are never found. When a contract change adds a metric, run `make analytics-rescan` once: it forgets the watermark and the running worker re-reads everything on its next cycle (every step is idempotent). Found in M22, when 21 real nutrition Observations uploaded before the worker knew the codes were not summed until a rescan.

## Deployment and schedule (M13a)

`make stack-up` deploys and supervises the worker and the API; nothing is started by hand.

| Compose service | Command | Ports | Schedule / supervision |
|---|---|---|---|
| `analytics-worker` | `main.ts loop` | none | a scan every `POC_WORKER_INTERVAL_SECONDS` (30); `restart: unless-stopped`; healthcheck on its heartbeat |
| `analytics-api` | `main.ts api` | `127.0.0.1:8445` (loopback publish) | `restart: unless-stopped`; healthcheck expects a 401 from `/v1/metrics` over verified TLS |

- **The loop never dies of an ordinary failure.** A failed cycle (HAPI or Oracle down, a token error) is logged
  (`{"level":"error",...}`), retried after 30 s, 60 s, 120 s ... capped at 5 minutes, and resets on success. The
  database connection is re-opened after any failure. SIGTERM finishes the current cycle and exits.
- **Backlog on first start:** the first cycle reads from the beginning (an empty watermark) and may take a while
  over a large history; later cycles are a handful of searches.
- **Heartbeat:** written after every attempt, successful or not, so the container is "healthy" while the loop is
  alive; whether scans succeed is in the logs (`docker logs spezi-poc-analytics-worker`) and in `status`.
- **Credentials:** `analytics/make-env.sh` writes `analytics/.env.local` (database account + worker client secret)
  and `analytics/.env.api.local` (database account only) from the other projects' generated files, so a container
  never sees the Oracle SYS password or another service's secret.
- **Image:** `analytics/Dockerfile` on `node:24-slim` pinned by digest, `npm ci` of the locked packages, no
  credential or key copied in (the repository root's `.dockerignore` is an allowlist). Containers run as the
  invoking user's uid so the 0600 TLS key on its bind mount stays 0600.
- **Schema:** `db/init.sh` applies `analytics/sql/10-schema.sql` as the owner whenever the `oracle` container starts (idempotent), so `oracle` healthy implies the tables exist.
- **Reaching HAPI and the IdP:** `macpro16.local` is mapped to the host gateway in these two containers, so
  tokens' issuer name and the certificates' name both match and TLS is verified end to end.
- **Dev on the host** still works (`make analytics-run`, `analytics/run.sh loop`); `make analytics-api` refuses
  while the deployed API owns port 8445.

## Run

```bash
make analytics-migrate      # reapply the schema (reruns db/init.sh in the oracle container; the worker has no DDL rights)
make analytics-run          # one cycle on the host
make analytics-rescan       # re-read everything on the next cycle (after the contract gains a metric)
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
- **A36 No deletes.** No role can delete Observations. Since M21 the capture app retracts a deleted sample by setting
  `status` to `entered-in-error`; only `final` Observations are counted, so a rollup does get smaller, and a window
  with nothing left deletes its row (tested with a fake and, for intake totals, live).
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
- **A48 Day as recorded** is the date in the entry's own timestamp and offset (D3). A date-time with no offset has no day and is ignored: it is never filed under a guessed one. A traveller's entries each take their own offset's date, so one date can hold entries from two zones.
- **A49 Sums are exact to a millionth.** Amounts are rounded to 1e-6 of a unit before adding. A value converted from another unit (kJ to kcal, oz to g) can have more digits, so a total can differ from the full-precision sum by up to 5e-7 per entry; on the developer's real data the largest difference was 7e-7. `verify-intake.py` allows exactly that and nothing more.
- **A50 Meal buckets.** A contract meal code, `unlabelled` for entries with no meal (never invented as `other`), and a meal code the contract does not know counts as `other`. The meals add up to the day. Moving an entry between meals is a retraction plus a new entry.
- **A51 First and last entry are UTC instants**; the recorded offset is not kept, so the web cannot show the local clock time of a meal. Time of day is indicative anyway (nutrition brief N5).
- **A52 A day's `revision`** is the largest revision among its rows. A meal row that disappears without any other change (the day's last entry of that meal retracted) also changes the day's total or entry count, so the revision moves in practice; a pure re-labelling that leaves every count unchanged would not.
- **A53 The total sums every entry, from every source.** The API does not filter by source app, so two apps logging the same meal into Apple Health would count it twice. The source-application `Device` (D6) is stored on the Observation, so a per-source split is possible later; it is not built.
- **A54 Entries are never deduplicated here.** Two entries with identical amount and time but different identifiers are two entries; a re-delivery of the same sample is one Observation already (conditional create), so it cannot be counted twice.
- Not done: the analytic API (M11), flagging of artifacts (M16), a container for the worker (it runs on the host
  for the POC).
