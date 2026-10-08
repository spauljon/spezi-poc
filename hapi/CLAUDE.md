# hapi/ — HAPI FHIR deployment

Follow the root [CLAUDE.md](../CLAUDE.md) (data rules, milestone workflow, FHIR rules). The data rules apply here without exception: synthetic data only in fixtures, tests and logs.

- Stack: HAPI FHIR 7.6.0 (R4) in Docker (compose project `spezi-poc`): Oracle datasource (M1), TLS (M2), token verification and authorization (M4). No data in this directory.
- Published ports are loopback-only until M4. Never publish a plain-HTTP or unauthenticated service on all interfaces.
- Never touch the governance project's HAPI or its files; copy and adapt only (provenance is in README.md).
- Milestones: M1, M2, M4
- Contract: codes, units and categories come from `contract/metrics.json` (added in M6), never hand-copied.
- Commit prefix: `hapi:`

Stack-specific rules (versions, test commands) are added when this project's first milestone runs.
