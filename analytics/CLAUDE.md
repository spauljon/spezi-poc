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
- Milestones: M9-M11
- Commit prefix: `analytics:`
