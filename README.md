# Spezi POC: clinical longitudinal monitoring

A learning project exercising a realistic remote-monitoring system: an iOS capture app (HealthKit or a synthetic device), a HAPI FHIR server on Oracle as the system of record, server-side aggregation into an analytic store, and a clinician web app. Planning and decisions live in [docs/](docs/): start with [docs/implementation-plan.md](docs/implementation-plan.md).

Real health data is allowed only as the developer's own HealthKit data and never in this repository. See [CLAUDE.md](CLAUDE.md) for the data, isolation and workflow rules.

## Supported platforms

| Platform | Status |
|---|---|
| **macOS** (Apple Silicon) | Supported; the primary development machine |
| **Linux** | Supported in intent: the scripts avoid BSD-only and GNU-only flags. Not yet exercised end to end on a Linux host (see below) |
| **Windows** | **Not supported.** Native Windows has no bash or `make`. WSL2 with Docker Desktop's WSL backend should behave like Linux but is untested |

Known platform limits:
- The Oracle Free image is pinned to `linux/arm64` (`compose.yaml`). On an x86 host the tag and `platform:` need to be changed; it will not run as-is.
- `scripts/bootstrap.sh` starts Docker Desktop only on macOS; elsewhere it stops with a clear message if the daemon is down.
- `.gitattributes` forces LF line endings for scripts, SQL, YAML and the Makefile; CRLF would break shebangs and scripts mounted into containers.

## Prerequisites

`bash`, GNU or BSD `make`, `docker` with Compose v2, `openssl`, `python3`, `curl`, `git`.

## Quick start

```bash
make hooks        # once per clone: enable the pre-commit data-leak guard
make stack-up     # credentials, local CA and certificates, Oracle, HAPI, Keycloak + its proxy (first run initializes and pulls the pinned Keycloak image)
make stack-verify # checks; any FAIL exits non-zero, SKIP lines mean a check did not run
```

Endpoints: HAPI `https://macpro16.local:8443/fhir` (loopback-only until M4); the IdP proxy `https://macpro16.local:8444` (the one network-reachable endpoint; only the public OIDC paths). Details: [hapi/README.md](hapi/README.md), [db/README.md](db/README.md), [idp/README.md](idp/README.md). To use a phone, install and trust the CA first (see idp/README.md).
