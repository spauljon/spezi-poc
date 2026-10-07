# web/ — Clinician web app

Follow the root [CLAUDE.md](../CLAUDE.md) (data rules, milestone workflow, FHIR rules). The data rules apply here without exception: synthetic data only in fixtures, tests and logs.

- Stack: React and TypeScript.
- Milestones: M10-M14
- Contract: codes, units and categories come from `contract/metrics.json` (added in M4), never hand-copied.
- Commit prefix: `web:`

Stack-specific rules (versions, test commands) are added when this project's first milestone runs.
