# ios/ — iOS capture app

Follow the root [CLAUDE.md](../CLAUDE.md) (data rules, milestone workflow, FHIR rules). The data rules apply here without exception: synthetic data only in fixtures, tests and logs.

- Stack: Swift, SwiftUI, Spezi (SpeziHealthKit, SpeziFHIR). Copied from the Spezi Template Application without its .git; upstream commit recorded here at M5.
- Milestones: M5-M8, M17, M18
- Contract: codes, units and categories come from `contract/metrics.json` (added in M6), never hand-copied.
- Commit prefix: `ios:`

Stack-specific rules (versions, test commands) are added when this project's first milestone runs.
