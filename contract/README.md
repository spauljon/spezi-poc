# contract/

The single machine-readable source of truth for how abstract capture samples become FHIR R4 `Observation`s and `Device`s.
Built in M6 from [docs/planning/fhir-data-model.md](../docs/planning/fhir-data-model.md). Nothing else in the repository
may hand-copy a LOINC code, UCUM unit or category: it reads `metrics.json` (or is tested against it).

| File | Role |
|---|---|
| `metrics.json` | The contract (`contractVersion` 1.0.0): metrics -> LOINC, UCUM unit, category, `effective[x]` rule, sleep-stage mapping, identifier and `meta.source` systems, device-key rule, and the terminology verification evidence |
| `golden/generate.py` | An **independent** Python implementation of the rules (own time-zone database, decimals, SHA-256). Writes the fixtures; `--check` fails if they are stale |
| `golden/*.json` | 34 fixtures: expected JSON for 14 quantity cases, 10 sleep cases, 5 refusals and 5 devices, including DST and half-hour offsets |
| `check.py` | Offline checks (`make test-contract`): structure, LOINC check digits, bundled copy identical, fixtures current |
| `sync.sh` | Copies `metrics.json` into the iOS app's resources |
| `verify-hapi.py` | Posts the fixture shapes to the running HAPI (request validation on) and reports acceptance. Needs the stack; leaves synthetic resources behind (`golden-` identifiers) |

## Changing the contract

```bash
$EDITOR contract/metrics.json
contract/sync.sh                        # the app's bundled copy must stay byte-identical
python3 contract/golden/generate.py     # regenerate the fixtures (review the diff)
make test-contract && make test-ios     # both must pass
```

Change `metrics.json` and every consumer in one commit (repo rule). A contract edit without the sync fails
`make test-contract` and the app's `bundled copy is byte-identical` test.

## What was verified, and against what (2026-10-10; recorded in `metrics.json`)

| Item | Source | Result |
|---|---|---|
| LOINC `8867-4`, `40443-4`, `112429-6`, `93829-0`, `93830-8`, `93831-6`, `93832-4`, `103210-1` | NLM Clinical Tables `loinc_items` v3 | exact match; `display` is the LOINC long common name |
| UCUM `/min`, `ms`, `min` | NLM UCUM service `isValidUCUM` | valid (`beats/min` is not, and is not used). Closes the spec's `[UNVERIFIED]` for HRV `ms`. LOINC's own example-unit field is empty for all these codes |
| Categories `vital-signs`, `activity` | `observation-category` v2.0.0, terminology.hl7.org | present, displays `Vital Signs` and `Activity` |
| Device name type `model-name` | `http://hl7.org/fhir/device-nametype` R4 | present |
| `heartrate` profile shape | hl7.org R4 (status **draft**) | fixes category, `valueQuantity.system`/`code`; requires `subject` and `effective[x]`. No `meta.profile` is claimed |
| Real HAPI 7.6.0, request validation on | `verify-hapi.py` | accepted all 23 Observations and 4 Devices |

## Assumptions made in M6 (review these)

Added to the spec's A1-A13 (full text in `metrics.json` `assumptions`):

| # | Assumption | Why it matters |
|---|---|---|
| A14 | Time fraction: omitted when zero, else exactly 3 digits; `issued` always 3 digits. Sleep minutes rounded half-up to 2 decimals | Byte-for-byte determinism; a source with microsecond times loses sub-millisecond precision |
| A15 | `Device.version[]` carries `value` and `type.text` (`hardware`/`software`) only: no code system invented | Can't be queried by a version-type code |
| A16 | HealthKit UUIDs are lowercased in `identifier.value` | Identity must not depend on which API formatted the UUID; changing this later duplicates data |
| A17 | A value of zero is refused for all three metrics; no plausibility ranges in v1 | A genuine 0 would be dropped; artifact flagging is M7 |
| (A7 clarified) | `issued` is on **every** Observation, including sleep. The spec's sleep sample omitted it; that sample was corrected | Late-arrival detection for sleep intervals |
| (A6) | The offset is the offset of the sample's own zone **at that instant**; a source with no zone supplies the device's zone | Wrong across travel; the mapper refuses a zone whose offset is not whole minutes |

## Not covered by the contract yet

`meta.tag` data-quality flags (A8), the `entered-in-error` path for deleted HealthKit samples (A11), batching into a
transaction Bundle (M8), and any claim of `meta.profile`.
