# contract/

Follow the root [CLAUDE.md](../CLAUDE.md). Commit prefix: `contract:`.

- `metrics.json` is the only place a LOINC code, UCUM unit, category or time rule is written. Every one is **verified against a terminology source** (NLM Clinical Tables, NLM UCUM service, terminology.hl7.org), never from memory; record the evidence in `verification` and the unverified in `assumptions`.
- A change to `metrics.json` is one commit with: the iOS bundled copy (`contract/sync.sh`), the regenerated fixtures (`golden/generate.py`), and passing `make test-contract` and `make test-ios`. Consumers elsewhere (analytics, web) change in the same commit.
- Golden fixtures are written by `golden/generate.py`, an independent implementation: never produce them by running the Swift mapper, and never hand-edit them.
- Fixtures and `verify-hapi.py` use synthetic data only. `verify-hapi.py` leaves `golden-` resources in HAPI (no role can delete).
- A new refusal rule needs a fixture in `golden/errors.json` (HealthKit-shaped samples) or `golden/healthconnect-errors.json` (Health Connect records) and a control that the same input without the defect is accepted.
- Health Connect (contract 1.6.0): identifiers and keys are SHA-256 over fields joined by U+001F, written in `metrics.json` under `healthConnect`; the generator and `check.py` implement them independently. A nutrition record's id is **not** an identity (MyFitnessPal re-creates records on every sync): its content key and ordinal are. The Android copy of the contract is `android/app/src/main/assets/metrics.json` (`sync.sh`). An iOS bundle identifier and an Android package name that are the same text must never be one Device: `hc-app` and `app` prefixes keep them apart, and `check.py` pins it.
