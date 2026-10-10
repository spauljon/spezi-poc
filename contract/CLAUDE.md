# contract/

Follow the root [CLAUDE.md](../CLAUDE.md). Commit prefix: `contract:`.

- `metrics.json` is the only place a LOINC code, UCUM unit, category or time rule is written. Every one is **verified against a terminology source** (NLM Clinical Tables, NLM UCUM service, terminology.hl7.org), never from memory; record the evidence in `verification` and the unverified in `assumptions`.
- A change to `metrics.json` is one commit with: the iOS bundled copy (`contract/sync.sh`), the regenerated fixtures (`golden/generate.py`), and passing `make test-contract` and `make test-ios`. Consumers elsewhere (analytics, web) change in the same commit.
- Golden fixtures are written by `golden/generate.py`, an independent implementation: never produce them by running the Swift mapper, and never hand-edit them.
- Fixtures and `verify-hapi.py` use synthetic data only. `verify-hapi.py` leaves `golden-` resources in HAPI (no role can delete).
- A new refusal rule needs a fixture in `golden/errors.json` and a control that the same input without the defect is accepted.
