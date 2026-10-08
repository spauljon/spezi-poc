# POC Oracle (db/)

The POC's own Oracle Database Free container (`container-registry.oracle.com/database/free:23.26.0.0-arm64`), independent of the governance project's Oracle. One container database with two pluggable databases:

| PDB            | Schema owner (no login) | Application user | Purpose                                              |
|----------------|-------------------------|------------------|------------------------------------------------------|
| `FHIRPDB`      | `hapi_owner`            | `hapi`           | HAPI FHIR's JPA schema (system of record)            |
| `ANALYTICSPDB` | `analytics_owner`       | `analytics`      | Aggregation worker's rollups (M9 creates its tables) |

## Owner vs. application user

The usual enterprise split: a **schema owner** (`NO AUTHENTICATION`, so it cannot log in) holds every table, temporary table and sequence, and all DDL runs as SYS through `current_schema = owner`. The **application user** that HAPI connects as has `CREATE SESSION` only, `SELECT/INSERT/UPDATE/DELETE` on the owner's tables, `SELECT` on its sequences, and a private synonym for each object so HAPI's unqualified names resolve. It owns nothing, so it cannot `DROP`, `ALTER` or `TRUNCATE`, and needs no tablespace quota.

`db/sql/25-grants-and-synonyms.sql` is idempotent and runs on every init. After a HAPI upgrade (or any change to the owner's objects), rerun the init: remove `db/.initialized` and `make stack-up`. Regenerate `hapi/schema/oracle-temp-tables.sql` too, since Hibernate no longer creates the `HTE_*` tables at startup.

Planned in [docs/implementation-plan.md](../docs/implementation-plan.md), Milestone 1. Compose file: [compose.yaml](../compose.yaml) (project `spezi-poc`). Published ports are loopback only: Oracle on `127.0.0.1:1522`.

## Bring-up order

```bash
make stack-up         # first run: the *initialize* profile is active once, then never again
make stack-verify     # M1 checks
```

What `make stack-up` (`scripts/bootstrap.sh`) does:

| Run                          | Behavior                                                                                                                                                                                                                                 |
|------------------------------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| First (no `db/.initialized`) | Generates credentials if absent, brings the stack up with `--profile initialize` (oracle healthy -> `oracle-init` completes -> hapi), fails fast if the init exits non-zero, removes the exited init container, writes `db/.initialized` |
| Later                        | Plain `up -d`; the init service is not in play, so no inactive container shows up                                                                                                                                                        |

To repeat the init without losing data (it is idempotent), delete `db/.initialized` and rerun. For anything else, `scripts/compose.sh` is the project-scoped escape hatch, e.g. `scripts/compose.sh --profile initialize run --rm oracle-init`.

```bash
```

The Docker daemon must be running. The Oracle image may already be present from the governance stack; if not, `make stack-up` pulls it (the registry can require accepting a license or logging in).

## Boundary rule

The analytics project reads HAPI **only through the FHIR API**, never by querying `FHIRPDB`. Credentials for each PDB are separate.

## Resetting synthetic data

Everything in this stack is synthetic, so resets are cheap:

- **Both PDBs and HAPI data:** `make stack-reset` (asks before deleting the volume), then `make stack-up`.
- **One PDB only** (container running), as SYSDBA in the container root:
  `alter pluggable database FHIRPDB close immediate; drop pluggable database FHIRPDB including datafiles;` then remove `db/.initialized` and run `make stack-up`; the init recreates it.

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
| `init.sh` | Creates PDBs and users, loads the HAPI schema (runs in the init container) |
| `sql/10-create-pdb.sql` | Creates and opens a PDB (discovers the seed directory) |
| `sql/20-fhir-user.sql` | FHIR tablespace, `hapi_owner` and `hapi` users, HAPI schema and temp-table load |
| `sql/25-grants-and-synonyms.sql` | Grants and synonyms for an application user (idempotent, reusable) |
| `sql/30-analytics-user.sql` | Analytics tablespace, `analytics_owner` and `analytics` users |
| `verify.sh` | M1 checks against the running stack |

All SQL and shell here is **untested** until you run it; a failure in the first-run init is expected to need a fix or two (PDB datafile paths and tablespace creation are the likeliest).
