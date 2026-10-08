# HAPI FHIR deployment

HAPI FHIR 7.6.0 (R4) for the POC: Oracle datasource now (M1), TLS (M2), token verification and authorization (M4). No data in this directory.

Planned in [docs/implementation-plan.md](../docs/implementation-plan.md) (M1, M2, M4). Planning briefs and the FHIR spec live in [docs/planning/](../docs/planning/).

## Files

| File | Role |
|---|---|
| `Dockerfile` | `hapiproject/hapi:v7.6.0` plus busybox (for the healthcheck); `/app/extra-classes` is the additive extension mount point used in M4 |
| `application.yaml` | Oracle datasource at `jdbc:oracle:thin:@oracle:1521/FHIRPDB` (connects as the application user `hapi`; objects belong to `hapi_owner`, reached through synonyms), `HapiFhirOracleDialect`, R4, request validation on |
| `schema/oracle.sql` | HAPI 7.6.0 Oracle base schema (54 tables, 96 indexes), loaded once by `db/init.sh` |
| `.env.example` | Names of the credentials in the gitignored `.env.local` |

Runs in the root [compose.yaml](../compose.yaml), project `spezi-poc`, published on loopback only (`127.0.0.1:8192`) for M1; bring-up order is in [db/README.md](../db/README.md).

## Provenance

Adapted from the governance project (`pghd-governance-mapping-tool-service`, commit `1d86695`, `docker/` directory). Copied and adapted, never mounted or referenced:

| Here | From | Change |
|---|---|---|
| `schema/oracle.sql` | `docker/oracle/oracle.sql` | None (sha256 `d8bcf0e4105f9fd2461038605d533a3c295930b32a2837045ad2287269158acb`). Checked: no governance-specific names. |
| `application.yaml` | `docker/hapi/application.yaml` | Reduced to the keys the source sets; datasource URL points at the POC; dropped the governance bean package, CORS allow-any-origin with credentials, and the external "global tester" |
| `Dockerfile` | `docker/hapi/Dockerfile` | Dropped the governance extension jar build; kept the busybox and extension-mount pattern |
| `db/init.sh`, `db/sql/*` | `docker/oracle/init.sh`, `setup.sql` | Rewritten for two PDBs and least-privilege users |

Deliberately not taken: `chg-log.sql`, `objects.sql` (governance change journal, triggers, flashback grant).
