# hapi/ — HAPI FHIR deployment

Follow the root [CLAUDE.md](../CLAUDE.md) (data rules, milestone workflow, FHIR rules). The data rules apply here without exception: synthetic data only in fixtures, tests and logs.

- Stack: HAPI FHIR 7.6.0 (R4) in Docker (compose project `spezi-poc`): Oracle datasource (M1), TLS (M2), token verification and authorization (M4). No data in this directory.
- HAPI's 8443 is network-reachable since M4 because every `/fhir` request needs a verified token and nothing outside `/fhir` is served. Never publish a plain-HTTP or unauthenticated service on all interfaces.
- The extension (`ext/`) is a thin jar: every dependency is `provided` by the HAPI war (check `WEB-INF/lib` of `main.war` before adding one). Token verification and rules live in one interceptor, `PocAuthorizationInterceptor`, hooked at `POST_PROCESSED` with `order = -1` so it runs before the request validator (stock `PRE_HANDLED` runs after it, so an anonymous caller would get 422 and validator output instead of 401; reproduced, see README). Keep that order. There is deliberately no servlet filter. `UnusedEndpointRemover` deletes the stock image's `/control/jobs` and tester controllers; do not re-enable them without protecting them.
- Changing only `application.yaml` was observed NOT to be picked up by `make stack-up` (the container was left as it was; a mutation test passed vacuously because of it). Run `scripts/compose.sh up -d --force-recreate --no-deps hapi`, then confirm the change inside the container.
- Do not run write-capable checks against a build with authorization weakened: no role can delete, so stray data needs an Oracle volume reset.
- Tests: `make test-hapi` (extension unit tests, run in the image build); `python3 hapi/auth.py check` (live matrix, needs the stack); `make test` runs the first and `make stack-verify` runs the second.
- Never touch the governance project's HAPI or its files; copy and adapt only (provenance is in README.md).
- Milestones: M1, M2, M4
- Contract: codes, units and categories come from `contract/metrics.json` (added in M6), never hand-copied.
- Commit prefix: `hapi:`
