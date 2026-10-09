# HAPI FHIR deployment

HAPI FHIR 7.6.0 (R4) for the POC: Oracle datasource now (M1), TLS (M2), token verification and authorization (M4). No data in this directory.

Planned in [docs/implementation-plan.md](../docs/implementation-plan.md) (M1, M2, M4). Planning briefs and the FHIR spec live in [docs/planning/](../docs/planning/).

## Files

| File | Role |
|---|---|
| `Dockerfile` | `hapiproject/hapi:v7.6.0` plus busybox (for the healthcheck); `/app/extra-classes` is the additive extension mount point used in M4 |
| `application.yaml` | Oracle datasource at `jdbc:oracle:thin:@oracle:1521/FHIRPDB` (connects as the application user `hapi`; objects belong to `hapi_owner`, reached through synonyms), `HapiFhirOracleDialect`, R4, request validation on |
| `schema/oracle.sql` | HAPI 7.6.0 Oracle base schema (54 tables, 96 indexes), loaded once by `db/init.sh` |
| `tls/make-tls.sh` | Creates the local CA (once), the `macpro16.local` server certificate, and the PKCS12 keystore HAPI serves TLS from. Keys live in `~/.poc-ca/` (outside the repo); run via `make tls` or `make stack-up` |
| `.env.example` | Names of the credentials in the gitignored `.env.local` |

Runs in the root [compose.yaml](../compose.yaml), project `spezi-poc`, serving **HTTPS only** at `https://macpro16.local:8443/fhir`, published on loopback only (`127.0.0.1:8443`) until M4; bring-up order is in [db/README.md](../db/README.md).

## TLS

The CA certificate to trust on a device is `~/.poc-ca/ca.crt` (public, safe to share); its key `ca.key` never leaves `~/.poc-ca/` and is never mounted. Talking to HAPI from this machine before the name resolves publicly:

```bash
curl --cacert ~/.poc-ca/ca.crt --resolve macpro16.local:8443:127.0.0.1 https://macpro16.local:8443/fhir/metadata
```

The server certificate is valid 365 days; `make tls` regenerates it when under 30 days remain (then restart HAPI).

### The CA is name-constrained

`ca.crt` carries a **critical Name Constraints** extension: it may vouch only for `macpro16.local` (and its subdomains) and for no IP address. So even if `ca.key` leaked, a certificate it signed for any other name (a bank, a mail server) would fail validation on a device that trusts this CA. `make tls` ends with a self-test that issues a throwaway `evil.example` certificate and requires it to be rejected with *permitted subtree violation*, and `make stack-verify` checks the extension is present.

Constraints are part of the CA certificate and cannot be amended. `make tls` therefore **retires** a CA that lacks them (moves it, with its leaf and keystore, to `~/.poc-ca/retired-<timestamp>/`, never deleting it) and creates a constrained one; any device that trusted the retired CA must be re-pointed at the new `ca.crt`. Do this before installing the CA on a phone or browser.

### Design note: why HAPI terminates TLS itself

Common enterprise alternatives are edge termination (an ingress or reverse proxy terminates TLS and the service speaks cleartext on an internal network) and mesh mTLS (a sidecar terminates and encrypts every hop). For this POC HAPI terminates TLS itself: fewest moving parts, one process to reason about, and no cleartext FHIR listener anywhere. A reverse proxy was considered and deliberately not adopted (decision 2026-10-09); the certificates here would carry over to one if that changes. Whatever the TLS placement, token verification and authorization stay inside HAPI (M4): "trusted because it is inside the network" is not an assumption this design relies on.

Known cleartext hop (accepted for a single-host POC): HAPI to Oracle over the private Compose network. A real deployment would encrypt it.

## Provenance

Adapted from the governance project (`pghd-governance-mapping-tool-service`, commit `1d86695`, `docker/` directory). Copied and adapted, never mounted or referenced:

| Here | From | Change |
|---|---|---|
| `schema/oracle.sql` | `docker/oracle/oracle.sql` | None (sha256 `d8bcf0e4105f9fd2461038605d533a3c295930b32a2837045ad2287269158acb`). Checked: no governance-specific names. |
| `application.yaml` | `docker/hapi/application.yaml` | Reduced to the keys the source sets; datasource URL points at the POC; dropped the governance bean package, CORS allow-any-origin with credentials, and the external "global tester" |
| `Dockerfile` | `docker/hapi/Dockerfile` | Dropped the governance extension jar build; kept the busybox and extension-mount pattern |
| `db/init.sh`, `db/sql/*` | `docker/oracle/init.sh`, `setup.sql` | Rewritten for two PDBs and least-privilege users |

Deliberately not taken: `chg-log.sql`, `objects.sql` (governance change journal, triggers, flashback grant).
