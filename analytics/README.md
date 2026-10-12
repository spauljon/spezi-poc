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
refuses any code or unit literal in `src/`. Sleep stages are not rolled up here (nightly summaries are M10).

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

`typescript` 7.0.2, `tsx` 4.23.15, `@types/node` 25.9.9 (dev) and `oracledb` 26.0.0 (runtime, thin). Tests use
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
- Not done: the analytic API (M10/M11), sleep nights (M10), flagging of artifacts (M16), a container for the worker
  (it runs on the host for the POC).
