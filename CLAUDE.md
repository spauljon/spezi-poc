# Working Rules

Learning project: spec-first, agent-driven app development with Stanford Spezi (SpeziVibe skills). The developer is an experienced engineer with deep EHR/FHIR background but is new to Spezi and agent workflows. Don't explain healthcare or FHIR basics; do explain Spezi concepts and what each skill is doing.

## Data
- Real health data is allowed only as the developer's own HealthKit data. It must never appear in the repo, fixtures, logs, screenshots, commit messages, or conversation, and must not go to analytics or any third party.
- Real data may be sent only to the developer's own HAPI FHIR service (R4, `https://macpro16.local:8443/fhir`), and only once that connection uses TLS and authentication. The loopback-only plain-HTTP dev endpoint (`http://127.0.0.1:8192/fhir`, M1 only) receives synthetic data only.
- Everything else is synthetic or sandbox only: tests, fixtures, docs, and example data. Never real patient identifiers or anyone else's data.
- Keep a synthetic data source behind the same ingest interface as HealthKit for development, tests, and the simulator.

## Isolation
- This project must never write to, reconfigure, restart, reset, or share volumes or ports with the governance project's stack (`~/repositories/pghd-governance-mapping-tool-service`). Copy and adapt its files; never mount or reference them. Reading them is fine.
- POC host ports: Oracle 1522 and HAPI 8192 (plain-HTTP dev, M1 only) are published on loopback only (`127.0.0.1`); network-reachable endpoints are TLS only: Keycloak 8444 (from M3) and HAPI 8443 (from M4, after token verification passes; loopback-bound before that). Never publish a plain-HTTP or unauthenticated service on all interfaces.

## Planning before code
- Planning briefs go in `docs/planning/`; the build plan goes in `docs/implementation-plan.md`.
- No application code until the implementation plan exists and the developer has reviewed it.

## Milestones
- Build one milestone at a time, then stop.
- At each stop, summarize what changed and give the verification steps so the developer can review the diff and run them before continuing. Do not start the next milestone until told.

## FHIR work
- State resource types, profiles, and code systems explicitly (e.g. `Observation`, profile URL, LOINC code + display) so they can be reviewed.
- Flag every assumption about terminology (value sets, code system versions, unit handling/UCUM) and cardinality (e.g. `Observation.value[x]` type, `effective[x]` variants, missing/optional elements).

## Skills
- When running a skill, briefly say what it does and why it's being run at this point in the workflow.

## Ask first
- Platform choices (React Native vs Apple-native), and anything that installs or connects external services (packages beyond the template, accounts, cloud, EHR sandboxes, MCP servers).

## Repository layout and conventions
- Monorepo: `docs/` (planning briefs, FHIR spec, implementation plan), `contract/` (`metrics.json`, the single machine-readable code table), `db/` (Oracle bootstrap SQL, created in M1), `hapi/`, `idp/` (Keycloak, created in M3), `ios/`, `analytics/`, `web/`. Each project directory has its own `CLAUDE.md`; these root rules apply everywhere.
- Commit prefixes: `docs:`, `contract:`, `db:`, `hapi:`, `idp:`, `ios:`, `analytics:`, `web:`, `repo:`. Tag each approved milestone `m00`, `m01`, ...
- Never hand-copy codes, units or categories into a project: read `contract/metrics.json` or test against it, and change it and all consumers in one commit.
- Run `make hooks` once per clone to enable the pre-commit data-leak guard. It is a backstop for obvious secret and export patterns, not proof that no real data is present.
- `make test` runs every project's tests; `make guard-all` scans the whole working tree.
