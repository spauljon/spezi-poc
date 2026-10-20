# analytics/ — Analytics worker and API

Follow the root [CLAUDE.md](../CLAUDE.md) (data rules, milestone workflow, FHIR rules). The data rules apply here without exception: synthetic data only in fixtures, tests and logs.

- Stack: Node.js (the major pinned in the root `.nvmrc`; `scripts/check-node.sh` enforces it) and TypeScript (ESM, `strict`), `tsx` to run, Node's built-in test runner, `oracledb` in thin mode. Packages are pinned exactly and were approved for M9; adding any other needs approval.
- The worker reads HAPI only through the FHIR API (never `FHIRPDB`) and connects to `ANALYTICSPDB` as the `analytics` application user (DML only). Tables are created by `db-migrate.sh` as the no-login owner; the worker never gets DDL rights.
- Codes, units and categories come from `contract/metrics.json` (read at start-up), never hand-copied; `test/contract.test.ts` fails on a literal in `src/`.
- The rollup day is the UTC date of the instant (A6, decided in M9). Do not reintroduce a local-day or timezone key without a decision.
- Every write path is idempotent and every state change that must be atomic is one transaction. A negative test needs a positive control.
- Credentials are environment variables sourced from the git-ignored env files by `env.sh`; never print them, never put them on a command line, never include them in an error message.
- Search requests send `Cache-Control: no-cache` (HAPI's 60 s result reuse otherwise serves stale counts).
- Deployment (M13a): the worker (`loop`) and the API run as compose services started by `make stack-up`; the worker's loop must never end on an ordinary failure (`src/loop.ts`, tested). Containers get only the credentials they need (`make-env.sh`); the image is built from the repository-root allowlist `.dockerignore`.
- Tests: `make test-analytics` (no stack); `make test-analytics-live` (needs the stack, schema and seeded patient; leaves Observations in HAPI, cleans its own rollup rows).
- Sleep logic is pure (`src/sleep.ts`); a contract sleep stage that module does not classify must fail the test, not be miscounted.
- The API is loopback-only, TLS-only, GET-only and authenticates (signature, issuer, audience `poc-analytics`, role `clinician-reader`) before any routing. Widening the listener or the audience is a decision, not a convenience; document it in the root CLAUDE.md first.
- The API description `api/openapi.json` is a contract: `test/api.test.ts` checks every response against it and the route list. Change both together.
- Flag counts (M19) are read from the stored `meta.tag` only, using the contract's system and codes; never infer a flag from a value, and keep the bands inclusive of flagged samples (the counts say how many). A column added to the store goes in `sql/10-schema.sql` as an idempotent `ALTER`.
- Only `status = final` Observations are counted (M21): the capture app retracts a sample deleted in Apple Health by setting `entered-in-error`, and the touched-window scan (`_lastUpdated`) re-reads that day. Keep the local check; do not rely on a search parameter alone.
- Dietary intake totals (M22) use the **day as recorded** (the date in the entry's own timestamp), not the UTC day; never mix the two in one table or one rule, and keep `dayDefinition` honest. A day with no entries has no row (never a stored 0); a zero total needs entries. Sums go through `sumExact` (micro-units); the contract owns each nutrient's system, code and unit; the worker re-checks every returned entry. `analytics/verify-intake.py` is the independent check and prints counts only, so it is safe for real data; real amounts never go in output.
- When the contract gains a metric, run `make analytics-rescan`: the watermark scan never finds data older than itself.
- Milestones: M9-M11, M22
- Commit prefix: `analytics:`
