# hapi/ — HAPI FHIR deployment

Follow the root [CLAUDE.md](../CLAUDE.md) (data rules, milestone workflow, FHIR rules). The data rules apply here without exception: synthetic data only in fixtures, tests and logs.

- Stack: HAPI FHIR 7.6.0 (R4) configuration, TLS and authentication. No data in this directory.
- Milestones: M1, M3
- Contract: codes, units and categories come from `contract/metrics.json` (added in M5), never hand-copied.
- Commit prefix: `hapi:`

Stack-specific rules (versions, test commands) are added when this project's first milestone runs.
