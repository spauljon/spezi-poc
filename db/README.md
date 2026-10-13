# POC Oracle (db/)

The POC's own Oracle Database Free container (`container-registry.oracle.com/database/free:23.26.0.0-arm64`), independent of the governance project's Oracle. One container database with three pluggable databases:

| PDB            | Schema owner (no login) | Application user | Purpose                                              |
|----------------|-------------------------|------------------|------------------------------------------------------|
| `FHIRPDB`      | `hapi_owner`            | `hapi`           | HAPI FHIR's JPA schema (system of record)            |
| `ANALYTICSPDB` | `analytics_owner`       | `analytics`      | Aggregation worker's rollups (M9 creates its tables) |
| `KEYCLOAKPDB` | `keycloak_owner`        | `keycloak`       | Keycloak's data (M3c); the schema is loaded by `idp/db-migrate.sh`, not by `db/init.sh` |

## Owner vs. application user

The usual enterprise split: a **schema owner** (`NO AUTHENTICATION`, so it cannot log in) holds every table, temporary table and sequence, and all DDL runs as SYS through `current_schema = owner`. The **application user** that HAPI connects as has `CREATE SESSION` only, `SELECT/INSERT/UPDATE/DELETE` on the owner's tables, `SELECT` on its sequences, and a private synonym for each object so HAPI's unqualified names resolve. It owns nothing, so it cannot `DROP`, `ALTER` or `TRUNCATE`, and needs no tablespace quota.

`db/sql/25-grants-and-synonyms.sql` is idempotent and runs on every init, which is every `oracle` container start. After a HAPI upgrade (or any change to the owner's objects), rerun the init with `docker exec spezi-poc-oracle bash /opt/poc/db/init.sh`; `docker restart spezi-poc-oracle` does the same through the startup hook. Regenerate `hapi/schema/oracle-temp-tables.sql` too, since Hibernate no longer creates the `HTE_*` tables at startup.

Planned in [docs/implementation-plan.md](../docs/implementation-plan.md), Milestone 1. Compose file: [compose.yaml](../compose.yaml) (project `spezi-poc`). Oracle is published on loopback only (`127.0.0.1:1522`); HAPI's 8443 is network-reachable since M4 (TLS, bearer token required).

## Bring-up order

```bash
make stack-up         # the same path every time; the database initializes itself
make stack-verify     # M1 checks
```

What `make stack-up` (`scripts/bootstrap.sh`) does, first run or not:

1. Generates credentials and TLS material if absent (never overwrites).
2. Starts `oracle` and waits until it is **healthy**. The image runs `db/init.sh` as a startup hook (`db/startup/10-poc-init.sh`) on every start: it creates the PDBs, users, the HAPI schema and the analytics schema if absent and refreshes grants. Healthy means the database answers *and* this start's init succeeded (`db/init-status.sh`). A first run takes several minutes; a failed init is reported immediately with the log.
3. Loads Keycloak's schema (`idp/db-migrate.sh`, idempotent). It cannot be part of the hook: Keycloak generates it by running the Keycloak image.
4. Starts everything else and waits for every service to be healthy.

Every service restarts itself (`unless-stopped`) after a daemon restart; `make stack-down` and `docker stop` stay stopped. There is no init service, profile or marker file. The container stays up if the init fails (the image ignores a hook's exit status), but it never reports healthy, so nothing that depends on it starts. For anything else, `scripts/compose.sh` is the project-scoped escape hatch.

The Docker daemon must be running. The Oracle image may already be present from the governance stack; if not, `make stack-up` pulls it (the registry can require accepting a license or logging in).

## Boundary rule

The analytics project reads HAPI **only through the FHIR API**, never by querying `FHIRPDB`. Credentials for each PDB are separate.

## Resetting synthetic data

Everything in this stack is synthetic, so resets are cheap:

- **Both PDBs and HAPI data:** `make stack-reset` (asks before deleting the volume), then `make stack-up`.
- **One PDB only** (container running), as SYSDBA in the container root:
  `alter pluggable database FHIRPDB close immediate; drop pluggable database FHIRPDB including datafiles;` then `docker exec spezi-poc-oracle bash /opt/poc/db/init.sh` (or `docker restart spezi-poc-oracle`); the init recreates it.

Never run these against the governance project (its compose project is `dgp`; this stack's is `spezi-poc`).

## Sizing and limits (Free edition)

CPU, memory, and user-data caps apply to the **whole instance across both PDBs** (as I recall: 2 CPU threads, 2 GB RAM, 12 GB user data; **unverified** for your image). The tablespace maximums in `db/sql/20-fhir-user.sql` (6 GB) and `30-analytics-user.sql` (3 GB) are budgets inside that cap. Record the measured limits here once the instance is up:

| Fact                    | Value                                                                                                                                          |
|-------------------------|------------------------------------------------------------------------------------------------------------------------------------------------|
| Edition / version       | Oracle AI Database 26ai Free Release 23.26.0.0.0 - Develop, Learn, and Run for Free, Version 23.26.0.0.0                                       |
| CPU threads             | 2 (`cpu_count`, measured 2026-10-08)                                                                                                           |
| SGA / PGA               | SGA max 1,536 MB (`sga_max_size`); PGA target 512 MB, hard limit 2 GB (`pga_aggregate_target`/`_limit`), so SGA + PGA target = 2 GB (measured) |
| User-data cap           | 12 GB per Oracle's Free documentation as I recall it; **not exposed as a parameter**, so unverified here                                       |
| User-data in use        | HAPI schema: 52 segments, about 4.4 MB after one Patient (tables allocate storage lazily); datafiles overall about 4.5 GB, mostly system/undo  |
| POC tablespace ceilings | `POC_FHIR_DATA` 6 GB, `POC_ANALYTICS_DATA` 3 GB, both autoextend (allocated 256 MB and 128 MB at creation)                                     |

## Files

| File | Role |
|---|---|
| `make-env.sh` | Generates random credentials into gitignored `.env.local` files |
| `init.sh` | Creates PDBs and users, loads the HAPI schema (runs inside the `oracle` container on every start) |
| `startup/10-poc-init.sh` | The image startup hook: sources into the image's startup, runs `init.sh`, records the outcome |
| `init-status.sh` | Prints `ok`, `failed` or `pending` for this container start (healthcheck and bootstrap) |
| `sql/10-create-pdb.sql` | Creates and opens a PDB (discovers the seed directory) |
| `sql/20-fhir-user.sql` | FHIR tablespace, `hapi_owner` and `hapi` users, HAPI schema and temp-table load |
| `sql/25-grants-and-synonyms.sql` | Grants and synonyms for an application user (idempotent, reusable) |
| `sql/30-analytics-user.sql` | Analytics tablespace, `analytics_owner` and `analytics` users |
| `verify.sh` | M1 checks against the running stack |

All SQL and shell here is **untested** until you run it; a failure in the first-run init is expected to need a fix or two (PDB datafile paths and tablespace creation are the likeliest).
