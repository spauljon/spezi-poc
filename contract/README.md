# Contract

`metrics.json` (added in M4) is the single machine-readable table of metrics: LOINC code, UCUM unit, category, `effective[x]` rule, and sleep stage mapping. It carries a version field. `ios/`, `analytics/` and `web/` read it or test against it; a mapping change updates it and every consumer in one commit.

Human-readable rationale and assumptions: [docs/planning/fhir-data-model.md](../docs/planning/fhir-data-model.md).
