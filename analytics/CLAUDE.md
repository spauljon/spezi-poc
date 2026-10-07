# analytics/ — Analytics worker and API

Follow the root [CLAUDE.md](../CLAUDE.md) (data rules, milestone workflow, FHIR rules). The data rules apply here without exception: synthetic data only in fixtures, tests and logs.

- Stack: Node.js (latest) and TypeScript. Aggregation worker and analytic API over Oracle 26ai.
- Milestones: M7-M9
- Contract: codes, units and categories come from `contract/metrics.json` (added in M4), never hand-copied.
- Commit prefix: `analytics:`

Stack-specific rules (versions, test commands) are added when this project's first milestone runs.
