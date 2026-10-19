# Implementation Plan: Clinical Longitudinal Monitoring POC

> Produced with `app-build-planner`. Status: DRAFT for developer review.
> Build one milestone at a time. Stop after each for diff review and verification (CLAUDE.md).

## Context

| Field | Value |
|---|---|
| App | Patient-side iOS capture app (HealthKit or synthetic source) -> HAPI FHIR -> analytic worker (Oracle) -> clinician web app |
| Need statement | Not available (`biodesign-needs-finding` not run; the POC's goal is architectural learning) |
| Platform | Capture app: Apple-native (Swift/SwiftUI + Spezi), iOS. Clinician app: React / TypeScript web. |
| Backend | HAPI FHIR 7.6.0 R4 (system of record) at `https://macpro16.local:8443/fhir` (target), on Oracle 26ai in its own FHIR PDB; a second analytics PDB in the same instance (you stand it up); Node/TypeScript aggregation worker and analytic API |
| Study context | No |

### Projects and repository layout (monorepo)

One repository (this one). Each project is a top-level directory with its own `CLAUDE.md`; root `CLAUDE.md` holds the data and workflow rules that apply everywhere.

```
spezi/
  CLAUDE.md          # data rules, workflow rules
  docs/              # planning briefs, fhir-data-model.md, this plan
  contract/          # versioned machine-readable code table (metrics.json)
  compose.yaml       # POC stack (project spezi-poc); grows with idp/ in M3
  db/                # Oracle container, bootstrap SQL, FHIR and analytics PDBs (created in M1)
  hapi/              # HAPI 7.6.0 config, Oracle datasource, TLS, token verification, authorization
  idp/               # Keycloak realm template and the nginx allowlist proxy config (created in M3a)
  ios/               # Spezi-based capture app (Swift, SwiftUI, Spezi)
  analytics/         # Node/TypeScript aggregation worker + analytic API (Oracle)
  web/               # React/TypeScript clinician app
```

| Convention | Rule |
|---|---|
| Commit prefixes | `docs:`, `contract:`, `db:`, `hapi:`, `idp:`, `ios:`, `analytics:`, `web:`, `repo:` |
| Milestone tags | `m00`, `m01`, ... tagged after you approve each milestone |
| Contract | `contract/metrics.json` is the only machine-readable code table; `ios/`, `analytics/` and `web/` read it or test against it. A mapping change updates it and every consumer in one commit. |
| Data-leak guard | One pre-commit check at the root (set up in M0) |
| Template | `SpeziTemplateApplication` is copied into `ios/` without its `.git`; the upstream commit is recorded in `ios/README.md` |

## Planning Inputs

- **`docs/planning/ux-brief.md` (approved):** capture-app and clinician journeys, three initial metrics (resting heart rate, heart rate/HRV, sleep), three views (longitudinal trend + flowsheet, sleep, intraday), synthetic-source controls on a simulator screen, risks.
- **`docs/planning/fhir-data-model.md` (approved, assumptions A1-A13):** base R4, no `meta.profile`, LOINC/UCUM mappings, sleep as per-stage interval Observations, `Device`, no Provenance, namespace `http://blueysoft.com/fhir`, search patterns, analytic projection.
- **Not run (gaps):** `digital-health-compliance-planning` (see Compliance Integration: CLAUDE.md data rules stand in), `health-data-model-planning`, `biodesign-needs-finding`, `digital-health-study-planning`. `fasten-ehr-integration` is intentionally excluded (external service).

## Feature List

| # | Feature | Source | Priority | Packages / Modules |
|---|---|---|---|---|
| 0 | Monorepo foundation: skeleton, `.gitignore`s, root test script, data-leak guard | Repo decision | Must | Custom |
| 0b | Independent POC stack: Oracle Free with two PDBs (FHIR, analytics) and HAPI 7.6.0 on Oracle; reset procedure | Developer decision | Must | Oracle, HAPI datasource config (adapted from governance project) |
| 1 | HAPI over TLS at `macpro16.local`, trusted by Mac and iPhone | UX risk 1-2 | Must | HAPI config (custom) |
| 2 | Keycloak IdP (realm, roles, clients) + HAPI token verification and authorization rules (capture write, clinician read, worker read) | UX risk 1 | Must | Keycloak, HAPI interceptors (custom) |
| 2b | Sign-in flow in the capture app (authorization code + PKCE, Keychain) | UX capture journey 1 | Must | Custom (OIDC client library TBD) |
| 3 | Capture app shell, orientation screen, source choice | UX capture journey 1 | Must | Spezi template, SpeziOnboarding (orientation only) |
| 4 | Shared contract file + metric registry + HealthKit/synthetic -> FHIR mapping | FHIR spec | Must | Custom (Swift), `contract/metrics.json` |
| 5 | Synthetic source + simulator controls (cadence, jitter, gaps, late, duplicates, artifacts, presets) | UX capture journey 3 | Must | Custom (Swift/SwiftUI) |
| 6 | Local queue + upload (transaction Bundles, conditional create, retry, offline) + sync status UI | UX capture journey 2/4 | Must | SpeziFHIR (to verify), custom |
| 7 | Analytic store schema + aggregation worker (daily rollups, sleep nights, late-arrival recompute) | UX risk 5, FHIR flow 3 | Must | Node/TS, Oracle (custom) |
| 8 | Analytic API for trend and sleep summaries | FHIR spec | Must | Node/TS (custom) |
| 9 | Clinician web: patient banner, staleness, quality indicators | UX clinician journey 1 | Must | React/TS (custom) |
| 10 | Clinician web: flowsheet (filter, sort, paging) | UX clinician journey 2 | Must | React/TS |
| 11 | Clinician web: longitudinal trend with bands | UX clinician journey 2 | Must | React/TS + charting lib (to choose) |
| 12 | Clinician web: intraday dense view | UX clinician journey 3 | Must | React/TS |
| 13 | Clinician web: sleep (hypnogram + nightly summary) | UX clinician journey 4 | Must | React/TS |
| 14 | HealthKit source (authorization, read, map, user-entered flag, deletions) | UX capture journey 1 | Must | SpeziHealthKit |
| 15 | Background delivery, HKDevice -> Device, sync reliability | FHIR spec | Should | SpeziHealthKit |
| 16 | Data-quality flags surfaced in views (A8) | UX clinician journey 5 | Should | Custom |
| 17 | Accessibility pass, error states, volume test, runbook | UX accessibility | Should | Custom |
| 18 | Distribution and daily-overlay views | UX candidates | Nice | Custom |

Not used from the Spezi catalog: SpeziAccount / SpeziFirebaseAccount / SpeziFirestore (no accounts, HAPI is the store), SpeziScheduler, SpeziNotifications, SpeziChat, SpeziQuestionnaire (no tasks, alerts, chat or surveys in scope).

## Milestones

Ordering rationale: server trust first (it gates real data); the synthetic pipeline end-to-end next, so every later piece is testable without real data; analytics and web before HealthKit; HealthKit last because it only swaps in a source behind an interface already proven. Reorder if you'd rather see real data sooner (M17 can move earlier once M2-M4 and M8 are done).

### Milestone 0: Monorepo foundation [repo]

**Goal:** The repository has the agreed layout, a one-command way to run each project's tests, and a guard that blocks commits containing real-data patterns.

**Depends on:** Nothing.

**Tasks:**
1. Create the directory skeleton (`hapi/`, `ios/`, `analytics/`, `web/`, `contract/`) with a README and a short `CLAUDE.md` in each project directory pointing to the root rules.
2. Per-directory `.gitignore` files (Xcode, Node, HAPI config secrets and certificates).
3. Root test script with one target per project (initially placeholders).
4. Data-leak guard as a pre-commit check: blocks files and patterns that look like real HealthKit exports, credentials, or private keys. Document its limits (it's a backstop, not proof).
5. Extend root `CLAUDE.md` with the layout, commit prefixes and milestone-tag convention.
6. First commit of the planning docs, `CLAUDE.md` and the installed skills (you decide whether `.agents/`, `.claude/` and `agent/` are committed).

**Verify:** `git status` clean after commit; each test target runs and reports "no tests yet"; the guard rejects a dummy staged file containing a fake private key header and a fake credential string.

---

### Milestone 1: POC Oracle and HAPI stack [db/, hapi/]

**Goal:** A self-contained POC stack runs: its own Oracle Free container with a FHIR PDB and an empty analytics PDB, and its own HAPI 7.6.0 container using the FHIR PDB. A synthetic `Patient` round-trips at a loopback-only dev endpoint, `http://127.0.0.1:8192/fhir`.

**Depends on:** Nothing. The Docker daemon must be running, and you approve any image pull.

**Independence rule:** the stack shares nothing with the governance project (`~/repositories/pghd-governance-mapping-tool-service`): its own compose project name, network, volume (`spezi-poc_oracle_data`), containers and ports. That project uses host ports 1521, 3001, 5500, 8091-8093, 8095, 8200, 8500, 8600, 9000, 9090 and 27017. POC ports: Oracle 1522 and the HAPI plain-HTTP dev port 8192 are published **on loopback only** (`127.0.0.1:...`), and the actuator is not published at all (the healthcheck runs inside the container). Network-reachable endpoints are TLS only: the IdP edge proxy on 8444 from M3a (only the public OIDC paths; Keycloak itself is never published), and HAPI 8443 only from M4 (it is loopback-bound in M2 and M3 so an unauthenticated HAPI is never reachable from the network). Files are copied and adapted from the governance project, never referenced or mounted from it.

**Tasks:**
1. Create the `db/` skeleton (README, `CLAUDE.md`, `.gitignore`, `.env.example`), a `test-db` Makefile target, and the `db:` prefix in root `CLAUDE.md` (M0 predates this directory).
2. Oracle container: the Free image used by the governance stack (`container-registry.oracle.com/database/free:23.26.0.0-arm64`; reuse it locally if present, and confirm before any pull since the registry can require a license acceptance or login), host port 1522, named volume, healthcheck.
3. Bootstrap SQL adapted from the governance `init.sh` and `setup.sql`: create `FHIRPDB` and `ANALYTICSPDB`; in each, a schema-only **owner** (no login, holds the objects) and a separate **application user** (`CREATE SESSION`, DML grants and synonyms, owns nothing). Passwords come from a gitignored `.env.local`.
4. HAPI schema DDL: adapt the stock HAPI 7.6.0 Oracle DDL (`oracle.sql`) from the governance project into `hapi/`, excluding governance-specific objects (`chg-log.sql`, the trigger and flashback grants). Load it, plus the pre-created Hibernate `HTE_*` temporary tables (`oracle-temp-tables.sql`), into the FHIR PDB **owner** schema as SYS; HAPI connects as the application user, which never needs `CREATE TABLE`.
5. HAPI image and config: adapted `Dockerfile` (`hapiproject/hapi:v7.6.0` plus the additive `/app/extra-classes` mount point, empty until M4) and `application.yaml` (Oracle datasource by PDB service name, `HapiFhirOracleDialect`, UTC, Flyway off, credentials from the environment).
6. Root `compose.yaml` (project `spezi-poc`) wiring both services: loopback-bound published ports, in-container healthchecks, a one-time `initialize` profile (Oracle healthy -> `oracle-init` completed -> HAPI) activated only while `db/.initialized` is absent, with the exited init container removed afterward (replaced after M13a: see the change note under Milestone 13a), plus `scripts/compose.sh` (explicit project), `scripts/bootstrap.sh`, `scripts/reset.sh`, `make stack-*` targets, a credential generator (`db/make-env.sh`), `db/verify.sh` and `scripts/isolation.sh` (adapted from the governance project's `bin/` scripts).
7. Docs: measured instance facts (edition, version, actual CPU, memory and user-data caps), the boundary rule (analytics reads HAPI only through the FHIR API, never the FHIR PDB), a PDB reset procedure, and provenance (the governance repo commit the files were adapted from).

**Platform notes:** HAPI's JPA schema is index-heavy, so measure growth with synthetic data early. Whether the copied DDL exactly matches HAPI 7.6.0 is checked by a one-time `hibernate.hbm2ddl.auto: validate` start (unverified until then).

**Verify:** both PDBs show open in `v$pdbs`; the HAPI container reports `healthy`; HAPI tables exist only in the FHIR PDB's owner schema; the owner cannot log in, and the application user has `CREATE SESSION` only, owns no tables, and has one synonym per table and sequence; the schema `validate` start passes; a synthetic `Patient` can be `POST`ed and `GET`ed at `http://127.0.0.1:8192/fhir`; connecting to the Mac's LAN address on ports 8192 and 1522 is refused; the analytics PDB has no HAPI tables; the governance containers, volumes and ports are unchanged (compare `docker ps` and `docker volume ls` before and after); `make guard-all` passes and no passwords are in the repo.

---

### Milestone 2: HAPI over TLS [hapi/]

**Goal:** HAPI serves `https://macpro16.local:8443/fhir` over TLS with a certificate from a local CA, reachable from the Mac only (port published on loopback), with the plain-HTTP dev port gone.

**Depends on:** Milestone 1 (HAPI config captured, Oracle-backed).

**Tasks:**
1. Capture the current HAPI 7.6.0 setup as reproducible config in the repo (no data in the repo).
2. Create a local CA and a server certificate for `macpro16.local` (SAN set correctly). Keep the CA private key outside the repo; M3 reuses the CA for Keycloak.
3. Configure HAPI/its container or proxy to serve TLS on 8443 at `/fhir`, published as `127.0.0.1:8443` only.
4. Document installing and trusting the CA profile on the iPhone (the phone check happens in M3 and M4).
5. Once TLS is verified, remove the plain-HTTP dev port so HAPI is HTTPS-only. HAPI stays loopback-bound until M4, so an unauthenticated HAPI is never reachable from the network.

**Platform notes:** iOS App Transport Security requires valid TLS for non-local hosts; the CA must be trusted on the device (Settings -> General -> About -> Certificate Trust Settings).

**Verify:** `curl --cacert ca.pem --resolve macpro16.local:8443:127.0.0.1 https://macpro16.local:8443/fhir/metadata` succeeds (this also checks the certificate's name); the plain-HTTP port is no longer published; connecting to the Mac's LAN address on 8443 is refused.

---

### Milestone 3a: Keycloak behind a path-allowlist proxy [idp/]

**Goal:** Keycloak 26.8.0 runs with nothing published, behind an nginx proxy that terminates TLS for `https://macpro16.local:8444` and exposes only the public OIDC paths. The admin console, the `master` realm, health and metrics are not reachable from the network. The iPhone trusts our CA and loads the proxy's `/ping` with no warning.

**Depends on:** Milestone 2 (local CA and TLS approach).

**Decisions (2026-10-09):** Keycloak **26.8.0**, pinned by tag and digest (`quay.io/keycloak/keycloak:26.8.0@sha256:b0f60d489d51c5d113390bdf5461d4c06e6051be026c05549f2e1e10ec352bcc`; multi-arch, about 264 MB for arm64). Admin exposure **option B**: Keycloak's docs say it has no built-in way to restrict the admin console, so a proxy exposes only `/realms/` (not `/realms/master/`), `/resources/` and `/.well-known/`. Research, sources and what is still unverified: [docs/planning/keycloak-notes.md](planning/keycloak-notes.md). **Database: H2** (the default `dev-file`, on a named volume) in this milestone; Oracle-backed Keycloak is Milestone 3c. The proxy is `nginx:alpine`, **already on this machine** (nginx 1.31.3, arm64, digest `sha256:4a73073bd557c65b759505da037898b61f1be6cbcc3c2c3aeac22d2a470c1752`), so only the Keycloak image needs a pull, and I ask you before it.

**Status (2026-10-09):** built and verified on the Mac **and on an iPhone** (CA installed and trust enabled; fresh private tab loads `/ping` with no warning; the proxy log shows the iPhone request and no rejection), **committed as `m03a`**. Tasks 1 to 7 are done: the Keycloak image was pulled (approved) and runs in production mode on H2; the healthcheck, the container-loopback management port and `kcadm.sh` were verified by running them (see [docs/planning/keycloak-notes.md](planning/keycloak-notes.md)); the proxy allowlist passes 26 checks via loopback and via the Wi-Fi address and was mutation-tested; TLS 1.2/1.3 accepted and TLS 1.1 refused on 8444 (shown on Linux, since this Mac's LibreSSL cannot try them). The temporary `idp` compose profile (it only guarded the image pull) is removed, so the IdP is part of `make stack-up`.

**Prerequisite already done (2026-10-09):** the POC CA is name-constrained (critical, `macpro16.local` only), so the first device trust is against the final CA. Commit: `hapi: constrain the local CA to macpro16.local`.

**Tasks:**
1. Create the `idp/` skeleton (README, `CLAUDE.md`, `.gitignore`), a `test-idp` Makefile target, and the `idp:` prefix in root `CLAUDE.md` (M0 predates this directory).
2. TLS: issue two more leaf certificates from the same constrained CA, each with its own key (none shared with HAPI): `edge` (the proxy, public-facing) and `keycloak` (internal), both SAN `macpro16.local`, as PEM files. The script is shared now, so it moved from `hapi/tls/` to `scripts/make-tls.sh` (done; `make tls` kept; HAPI's key material verified unchanged by fingerprint).
3. Compose: `keycloak` in production-mode `start` (HTTPS from the PEM files, `--hostname=https://macpro16.local:8444`, `--proxy-headers=xforwarded`, no published ports, management port 9000 unpublished, memory limit about 1.5 GB, named volume for its database, bootstrap admin from a gitignored env file with a generated password) and `idp-edge` (nginx) publishing 8444.
4. nginx config: TLS 1.2/1.3 only; allow `/realms/`, `/resources/`, `/.well-known/`; return 404 for `/realms/master/` and for everything else (`/admin/`, `/metrics`, `/health`, `/`); re-encrypt to Keycloak and verify its certificate against our CA (`proxy_ssl_verify on`); a static `/ping` so the phone trust test works before any realm exists.
5. Admin access: nothing is published. Admin tasks use `kcadm.sh` inside the container (documented); an optional loopback-only admin listener can come later.
6. Container healthcheck on the management port (approach unverified: the image likely has no `curl`, so try a `bash` `/dev/tcp` probe; confirm whether the management port can bind to the container loopback).
7. Database: try production mode with the default `dev-file` (H2) on a named volume. The docs call it deprecated and unsuitable for production but do not say it refuses to start. If it refuses, fall back to `start-dev` and record it. Either way it is an accepted POC gap, closed by Milestone 3c.

**Platform notes:** the Keycloak container is never published; a compromised or misconfigured proxy rule is the exposure. A path-normalization bypass of `/admin` blocking has happened before (CVE-2025-10939, fixed in 26.4.4 per a secondary source), so the allowlist must be tested with encoded and dot-segment paths, not only the plain ones. Docker Desktop's VM (about 7.75 GiB) is shared with Oracle and HAPI; raising it to 12 GB or more is your setting.

**Verify:** the Keycloak image is pulled by digest (after your approval) and `docker ps` shows no published Keycloak ports; `https://macpro16.local:8444/ping` returns 200 from the Mac (with the CA) and from iPhone Safari with no trust warning (the phone's first CA trust test; it also proves the name works); the proxy returns 404 (never 200 or an admin redirect) for `/admin/`, `//admin/`, `/%61dmin/`, `/realms/master/`, `/realms/%6dmaster/`, `/realms/poc/../master/`, `/metrics`, `/health` and `/`; the TLS checks used for HAPI (CA trust, wrong host rejected, TLS 1.2/1.3 up, TLS 1.1 refused) pass against 8444; both containers healthy and Keycloak stays under its memory limit; `make guard-all` passes.

---

### Milestone 3b: `poc` realm as code and tokens [idp/]

**Goal:** The `poc` realm exists from a committed template and issues signed JWTs with role claims for three principals; the discovery document and JWKS are reachable through the proxy from the Mac and the iPhone, and tokens can be obtained and inspected with a script.

**Status (2026-10-09):** built and verified, **waiting on your review**. The realm imports from code on an empty Keycloak volume; `python3 idp/oidc.py check` runs 36 behavior checks (tokens, roles, audience, lifetime, refusals, PKCE, redirect URI, closed admin side), mutation-tested on the PKCE attribute; no secret appears in any log or tracked file. Defaults chosen, to revisit: iOS redirect `com.blueysoft.spezipoc:/oauth2redirect`, web origin `https://macpro16.local:3000`, 10-minute access tokens, 14-day SSO idle.

**Depends on:** Milestone 3a.

**Tasks:**
1. Realm template `idp/realm/poc-realm.json`: roles `capture-writer`, `clinician-reader`, `worker-reader`; clients `ios-capture` and `clinician-web` (public, authorization code + PKCE S256) and `analytics-worker` (confidential, client credentials, service account with `worker-reader`); mappers for the roles claim and for an audience the HAPI check will expect; synthetic test users only. Secrets and passwords come from `${ENV}` placeholders filled from gitignored env files.
2. Import at first start with `--import-realm` (it is skipped when the realm exists, so changing the template means recreating the realm).
3. Confirm the unverified JSON shapes by exporting a realm configured once in the console (or by testing the import): the PKCE client attribute, the client-credentials client, the mappers.
4. A dev-only test client (direct access grant) lets a script obtain user tokens without a browser. It is for testing only and the apps never use it.
5. Token lifetimes and refresh behavior documented, including the phone offline case.
6. A token script (client credentials for the worker; the test client for a user) that decodes the claims for verification.

**Platform notes:** Keycloak issues no FHIR-specific claims; HAPI evaluates the roles and audience in M4.

**Verify:** the discovery document and JWKS are reachable through the proxy by `curl` (with the CA) and in iPhone Safari with no warning; the worker client-credentials token decodes to `iss` = `https://macpro16.local:8444/realms/poc`, the expected `aud`, `exp` and `worker-reader`; a test-user token carries the clinician role; a wrong client secret is rejected; `/realms/master/` is still 404 at the proxy; `make guard-all` passes with the realm template staged and no secrets in the repo.

---

### Milestone 3c: Keycloak on Oracle (KEYCLOAKPDB) [db/, idp/]

**Goal:** Keycloak keeps its data in its own PDB on the POC Oracle, with the same owner/app split as HAPI, replacing the H2 file.

**Depends on:** Milestone 3b.

**Status (2026-10-10):** built and verified, **waiting on your review**. The two Oracle jars (`ojdbc17`, `orai18n` 23.26.2.0.0) are downloaded at image build from Maven Central and checksum-verified (you approved the download). Keycloak runs on `KEYCLOAKPDB` as the `keycloak` application user (`CREATE SESSION` + DML only; the owner `keycloak_owner` cannot log in and holds 101 tables and 295 indexes). `make stack-verify` runs 16 new checks (owner/app split, no DDL for the app user with a positive control, no leftover generator account, no ORA- errors, index checker) and the realm still passes its 37 behavior checks. A full destroy and recreate (reset Oracle, `make stack-up`) took 39 s with no manual steps, and the capture user's id survives recreating the Keycloak container. Findings that changed the plan (details: [idp/README.md](../idp/README.md)): (a) manual migration still needs CREATE TABLE, so the export runs as a throwaway account; (b) the exported SQL has 4 failing duplicate-index statements, no lock table and one missing index; (c) `--db-schema` must be upper case; (d) the schema step runs from the bootstrap (`idp/db-migrate.sh`), not from `db/init.sh`, because only Keycloak can generate it. Also fixed in `make stack-verify`: the HAPI log check matched HAPI's access-log lines for deliberately refused requests, and the 8443 per-address check wrongly required every host address (a VPN interface appeared) to serve it.

**Why separate:** Keycloak does not bundle the Oracle JDBC driver (a custom image with the `ojdbc17` and `orai18n` jars is required), and its schema migration normally needs DDL rights, which clashes with the owner/app split. The realm is code, so moving the database later loses nothing, and keeping this apart means a proxy problem is not tangled with a driver problem. Facts from Keycloak's DB guide: [docs/planning/keycloak-notes.md](planning/keycloak-notes.md).

**Tasks:**
1. `KEYCLOAKPDB`, a schema-only `keycloak_owner` (no login) and an application user `keycloak`, through the existing idempotent init (remove `db/.initialized`, rerun `make stack-up`; the other PDBs are untouched). The instance allows 18 PDBs; a new PDB costs about 0.9 to 1 GB of datafiles before data.
2. Custom Keycloak image: base pinned to the 26.8.0 digest, the two Oracle jars (version 23.26.2.0.0) in `providers`, `KC_DB=oracle`, `kc.sh build`. **Needs your approval for the jar downloads** (Maven Central or Oracle); record their checksums.
3. Schema migration with `--spi-connections-jpa--quarkus--migration-strategy=manual` (plus `migration-export` and `initialize-empty`): Keycloak writes the SQL, we apply it as the owner, and the runtime user gets DML only. Untested; the Oracle privileges Keycloak needs are not documented, so find them by trial.
4. Names: use `--db-schema` or synonyms (the docs do not say whether `db-schema` can point at another user's schema; test it).
5. Cap the connection pool (the default maximum is 100; the instance allows 200 processes and HAPI already holds 10).
6. Recreate the realm from the template on the new database.
7. Extend `db/verify.sh` for the new PDB (owner cannot log in, application user has `CREATE SESSION` only, Keycloak connected as the application user).

**Verify:** Keycloak starts on Oracle; the realm imports; the M3b token checks still pass; data survives recreating the Keycloak container; `KEYCLOAKPDB` shows the expected owner/app privileges; `make guard-all` passes.

---

### Milestone 4: HAPI token verification and authorization [hapi/]

**Goal:** HAPI rejects requests without a valid Keycloak token, and each principal has only the access its roles allow.

**Note:** HAPI does not authenticate. Keycloak (M3) authenticates and issues the JWT; HAPI verifies it, and `AuthorizationInterceptor` evaluates rules built from its claims.

**Depends on:** Milestones 2, 3.

**Status (2026-10-09):** built and verified, **waiting on your review** (the iPhone check is yours). Decisions taken: a single custom `AuthorizationInterceptor` subclass (hooked ahead of the request validator, the pattern from the VA smart-pgd-fhir-service) using `nimbus-jose-jwt 9.37.3`, which the HAPI war already ships (no new runtime dependency); the extension jar is built by a multi-stage Dockerfile on a digest-pinned `maven:3.9.9-eclipse-temurin-17` (the one new build-only image you approved; it runs 19 unit tests in the build); anonymous `GET /fhir/metadata` only. Deviations from the tasks below: (a) authorization is hooked at `POST_PROCESSED` with `order = -1`, before the request validator, because at the stock `PRE_HANDLED` hook an anonymous single-resource POST gets 422 and validator findings instead of 401 (reproduced, see hapi/README.md); (b) probing found that HAPI's `/control/jobs` (list and cancel batch jobs), the tester page, `/v3/api-docs` and the Swagger UI answered with no token; nothing uses them, so the first two are removed at startup (a Spring bean-definition post-processor) and the last two switched off by configuration; (c) `SearchNarrowingInterceptor` is not used (single patient; revisit with a second). `python3 hapi/auth.py check` runs 79 live checks; mutation tests (interceptor unregistered; hook order moved behind the validator; endpoint remover disabled) each made the relevant checks fail. HAPI 8443 is now network-reachable. Process notes: the mutation test wrote stray synthetic data (no role can delete), so the Oracle volume was reset with your approval; `application.yaml`-only changes are not picked up by `make stack-up`. Details: [hapi/README.md](../hapi/README.md).

**Tasks:**
1. Verify bearer JWTs on every `/fhir` request: signature via the realm's JWKS, plus `iss`, `aud` and `exp`; reject otherwise with 401. (Spring Security resource server or a custom interceptor: the approach adds a dependency, so I'll propose it and confirm with you first.)
2. `AuthorizationInterceptor` rules from roles: `capture-writer` = create/read `Observation`, `Device`, `Patient`; `clinician-reader` and `worker-reader` = read-only; unauthenticated `GET /fhir/metadata` only (the capability statement), to be confirmed with you.
3. Evaluate `SearchNarrowingInterceptor` for patient-compartment scoping via a claim (future multi-patient); decide at this milestone.
4. Seed one synthetic `Patient` via a script using a `capture-writer` token.
5. Document clock skew, JWKS rotation behavior, and that unverified claims are never trusted.
6. Only after the verify steps pass, re-bind HAPI's 8443 from loopback to the network.

**Verify:** no token -> 401 (except `/fhir/metadata`); expired or wrong-audience token -> 401; clinician token can `GET` but gets 403 on `POST Observation`; capture token can `POST`; worker token can `GET` and gets 403 on `POST`. iPhone Safari loads `https://macpro16.local:8443/fhir/metadata` with no trust warning and gets 401 on `/fhir/Patient`. **Real-data gate:** after this milestone, CLAUDE.md allows real data to `https://macpro16.local:8443/fhir` only.

---

### Milestone 5: Capture app scaffold [ios/]

**Goal:** A Spezi-based iOS app runs on the simulator with an orientation screen, a source choice (synthetic only for now), and the HAPI endpoint and credentials configurable outside the code.

**Depends on:** Milestone 4 (for endpoint and auth config).

**Status (2026-10-10):** tasks 1 to 5 and 7 are built, verified and **committed as `m05`**; task 6 (sign in) moved to Milestone 5b below. Template copied from `d52014a` without its `.git` (you approved the download); trimmed from 20 Swift packages to 5; bundle id `com.blueysoft.spezipoc` (matches the realm's redirect URI). Orientation and source-selection screens, a Home that shows the synthetic source, the endpoint and the sign-in URL from configuration, and "Not signed in". 8 unit tests and 1 UI test pass (`make test-ios-ui`). Findings: the template's onboarding presentation rendered **blank** on Xcode 27 / iOS 27 (SpeziViews `ManagedNavigationStack`: "Accessing State<Path>'s value without being installed on a View"), so the flow is a plain state switch; the template's `setup.sh` installs system-wide tooling and was not run. Details: [ios/README.md](../ios/README.md).

**Tasks:**
1. Run `spezi-platform-selection` for the Apple-native path, but copy the Spezi Template Application into `ios/` without its `.git` and record the upstream commit in `ios/README.md`. Do not let the skill move `docs/` (they stay at the repo root).
2. Strip template features not in scope (account, scheduler, notifications, etc.); keep what's needed.
3. Orientation screen: what data, where it goes, synthetic vs real.
4. Source selection state (synthetic only enabled).
5. Config for endpoint and credentials; none committed.
6. *Moved to Milestone 5b (sign in with Keycloak).*
7. Fill in `ios/CLAUDE.md` with stack-specific rules (Swift version, Spezi module versions, test commands).

**Platform notes:** `SpeziOnboarding` for the orientation screen. Verify the template's current structure before trimming.

**Verify:** builds and runs on the simulator; no account or consent screens; endpoint config read from outside source control.

---

### Milestone 5b: Sign in with Keycloak [ios/]

**Goal:** The app signs in as the synthetic capture user through Keycloak (authorization code + PKCE in the system browser session), keeps the tokens in the Keychain, and shows the signed-in state; HAPI accepts the token.

**Depends on:** Milestone 5 (scaffold), Milestone 3b (realm and `ios-capture` client), Milestone 4 (HAPI verification).

**Why separate:** the OIDC library is the one package beyond the template, and sign-in is security-sensitive, so it gets its own review (same reasoning as M3a/3b/3c).

**Status (2026-10-10):** built, verified and **committed as `m05b`**. AppAuth-iOS is pinned to exactly 3.0.0 (commit `a972daac`, confirmed against the approved tag). Tasks 1 to 7 are done; the CA step (approved) is `scripts/ios-sim-trust.sh`. Verified end to end against the running stack: Keycloak login page over the trusted CA, PKCE code exchange, signed in as `capture-user` with `capture-writer`, HAPI metadata 200, anonymous Patient search 401, authenticated Patient search 200, sign out. 27 unit tests and 2 UI tests (`make test-ios-ui`, 87 s); a mutation (token not sent) fails the end-to-end test; 186,000 simulator log lines, every xcodebuild log and the repo contain no token or password. **Not verified live:** the refresh grant against Keycloak (fake-client unit tests only; 10-minute tokens). **Known gap:** sign-out clears the device only; the refresh token stays valid server-side until the 14-day session idle timeout (RFC 7009 revocation not implemented). Details: [ios/README.md](../ios/README.md).

**Decision (2026-10-10):** **AppAuth-iOS 3.0.0** (`github.com/openid/AppAuth-iOS`, Apache-2.0, no dependencies; released 2026-08-24, pushed 2026-10-07, not archived) is approved. Confirm the exact version resolves and the license before adding.

**Tasks:**
1. Add AppAuth as a Swift package dependency (project-file edit, validated as in M5); record version and license in `ios/README.md`.
2. Discovery from `POC_ISSUER_URL`; authorization code + PKCE (S256) in `ASWebAuthenticationSession`, redirect `com.blueysoft.spezipoc:/oauth2redirect`; `state` and `nonce` checked.
3. Token storage in the Keychain via `SpeziKeychainStorage` (access token, refresh token, expiry); never in `UserDefaults`, logs or the UI.
4. Refresh before expiry; sign-out clears the Keychain.
5. Home shows signed-in state (user name, roles claim, expiry) without showing the token.
6. A call to HAPI `GET /fhir/metadata` and an authenticated `GET /fhir/Patient` (200 for the capture role) to prove the token works end to end.
7. Tests: token-handling logic (expiry, refresh decision, storage) as unit tests with synthetic tokens; one UI test of the sign-in screen up to the browser handoff.

**Verify:** sign in as the capture user on the simulator against the running stack; signed-in state shown; HAPI returns 200 with the token and 401 without it; sign out clears state; the token never appears in logs or screenshots; the iPhone simulator trusts the POC CA (the CA must be installed in the simulator, documented).

**Open point to settle first:** the simulator must trust the POC CA (`~/.poc-ca/ca.crt`) for TLS to `macpro16.local`; installing a CA into a simulator's trust store is a system-trust change, so it needs your approval and a documented, reversible procedure.

---

### Milestone 6: Metric registry and FHIR mapping [ios/]

**Goal:** A pure, well-tested layer maps abstract samples to FHIR Observations exactly per `fhir-data-model.md`.

**Depends on:** Milestone 5.

**Status (2026-10-10):** built, verified and **committed as `m06`**. Contract `1.0.0` with every code and unit re-verified against NLM Clinical Tables, the NLM UCUM service and terminology.hl7.org (evidence recorded in the file; the spec's `[UNVERIFIED]` HRV unit `ms` is now verified). Mapper for heart rate, resting HR, HRV and sleep stages (`inBed` produces nothing), device mapping and key, per-metric validation. 34 golden fixtures written by an **independent Python implementation** (own tz database, decimals, hash) and checked by the Swift mapper; the two samples printed in the spec are reproduced exactly. 45 iOS unit tests and 36 offline contract checks pass; two mutations (contract edited alone; offset taken at "now") both fail the suite (10 of 14 quantity goldens). **HAPI 7.6.0 with request validation on accepted all 23 Observations and the Devices**; a re-sent equivalent Device was matched, not duplicated. Findings: the spec's sleep sample lacked `issued` (corrected, A7); LOINC's example-unit field is empty for all these codes, so UCUM alone confirms units. New assumptions A14 to A17 are in [contract/README.md](../contract/README.md). `verify-hapi.py` left `golden-` synthetic resources in HAPI.

**Tasks:**
1. Create `contract/metrics.json` (metric -> LOINC, UCUM unit, category, `effective[x]` rule, sleep stage mapping) with a version field; this is the single source of truth.
2. Load it in the app's registry (bundled copy, with a test that fails if it differs from `contract/metrics.json`).
3. Implement mapping for heart rate, resting HR, HRV, and sleep stages (A4 mapping, `inBed` unmapped).
4. Per-metric validation (code, unit, required fields, offsets).
5. Deterministic `identifier`, `meta.source`, and `Device` key.
6. Golden-JSON unit tests with synthetic samples, including edge cases (period vs instant, DST offsets).

**Platform notes:** No network, no HealthKit yet. Maps from an internal sample type that both sources will produce.

**Verify:** unit tests pass; produced JSON matches the spec samples; the contract test fails if the bundled copy is edited.

---

### Milestone 7: Synthetic source and simulator controls [ios/]

**Goal:** A simulated device emits samples at a configurable cadence, with controls to inject gaps, jitter, late/batched delivery, duplicates and artifacts, via a simulator screen visible only when the source is synthetic.

**Depends on:** Milestone 6.

**Status (2026-10-10):** built, verified and **committed as `m07`**. A pure, seeded generator (heart rate, HRV, resting HR, sleep nights) behind the new `IngestSource` protocol; controls for cadence, jitter, gaps, late and batched delivery, duplicates and artifacts; seven presets; a live runner with a time-scale and start-in-the-past; the simulator screen (shown only for the synthetic source) with live counters by metric and by injected anomaly. 83 unit tests and 3 UI tests pass (`make test-ios-ui`). Verified by measurement, not by "output exists": cadence and jitter bounds, gap windows empty and near the configured rate, late delay within bounds and near its fraction, batch alignment, duplicates identical and later, DST day lengths of 23 and 25 hours, and that every sample maps with the M6 mapper. Two mutations (look-back too short; batches rounded the wrong way) are caught by several tests, and a test that was too weak to catch the first was strengthened. Seen on the simulator: Late 75, Batched 241, Duplicates 24, Artifacts 7 after a few seconds of "Everything at once". New assumptions A18 to A23 in [ios/README.md](../ios/README.md). Not done: flagging artifacts and their thresholds (M16), persistence and upload (M8).

**Tasks:**
1. Ingest source protocol (HealthKit and synthetic will both implement it).
2. Synthetic generator for the four metrics (plausible waveforms, sleep nights).
3. Controls: cadence, jitter, gaps, late delivery, duplicates, outliers, presets.
4. Simulator screen (hidden for HealthKit source).
5. Deterministic seed option for tests.

**Verify:** unit tests on the generator's behaviors; simulator screen shows emitted samples live; presets produce the intended anomalies.

---

### Milestone 8: Local queue and upload [ios/]

**Goal:** Synthetic samples reach HAPI as FHIR Observations over TLS with authentication, surviving offline periods and resends without duplicates.

**Status (2026-10-11):** built and verified; **awaiting your review** (not committed). SQLite queue, transaction Bundles of conditional creates (Device + Observations), Patient resolution, retry with backoff, bisect-and-quarantine for refused samples, sync status section on Home, and the HAPI capture-role `transaction` rule (matrix and mutation checks in `hapi/auth.py`). Contract 1.1.0 adds the patient identifier system. 106 unit tests and 3 UI tests pass; `make test-ios-integration` uploads 64 synthetic samples to the live stack and checks the server's own count, a byte-for-byte resend (0 created, 64 already present), and a 3-request outage whose backlog arrives once. Mutation: breaking `ifNoneExist` failed the integration test (and exposed that the unit test was too weak, now strengthened). Assumptions A24 to A29 in [ios/README.md](../ios/README.md). Stray data: the mutation run left synthetic Observations in 2001-2015 windows (no role can delete; `make stack-reset` clears).

**Depends on:** Milestones 4, 7.

**Tasks:**
1. Persistent local queue.
2. Batched transaction Bundles with conditional create (`ifNoneExist` on `identifier`) and `Device` upsert.
3. Retry with backoff; offline tolerance.
4. Sync status UI: source, last sync, queued count, errors.
5. Integration test against HAPI with synthetic data.

**Platform notes:** Check whether `SpeziFHIR`'s `FHIRClient` fits conditional-create transaction Bundles; fall back to custom if not.

**Verify:** after a run, `GET Observation?subject=Patient/{id}&_summary=count` matches emitted count; resending the same batch changes nothing; toggling airplane mode then reconnecting delivers the backlog once.

---

### Milestone 9: Analytic store and daily rollups [analytics/]

**Goal:** A worker computes daily min/median/max (and counts) per metric from HAPI into Oracle, idempotently.

**Depends on:** Milestones 1 (analytics PDB), 4, 8.

**Tasks:**
1. Schema for daily rollups (key: patient, metric, UTC day; the timezone column was dropped when A6 was decided as UTC).
2. Node/TypeScript worker: obtain tokens with the client-credentials grant (refresh before expiry), then poll `Observation?_lastUpdated=gt{watermark}`, record touched windows.
3. Recompute touched windows with idempotent upsert; persist the watermark.
4. Day definition per A6: **UTC calendar day of the instant** (decided at M9 start; DST-independent).
5. Tests with synthetic late, duplicate and out-of-order data.
6. Contract test: the worker's metric list and codes match `contract/metrics.json`.

**Verify:** run twice and rows are identical; a late Tuesday sample delivered Thursday changes only Tuesday's row.

**Status (2026-10-12):** built and verified; **awaiting your review** (not committed). Schema (`daily_rollup`, `rollup_touched`, `rollup_watermark`) applied as the owner by `analytics/db-migrate.sh`; worker, Oracle and in-memory stores, client-credentials auth with renewal, paging with same-server link check; run on the host (`make analytics-run`). 31 unit/contract tests pass; `make test-analytics-live` passes end to end (3 samples across a UTC midnight, rerun identical with revisions unchanged, late sample changes only its own day, duplicate resend is a no-op, worker token refused for writes). Three mutations (day from written offset, revision bumped on no change, no `Cache-Control`) each fail tests. The real worker against the stack: first cycle 12 windows changed, second 0. Decisions A6 (UTC) and A30 to A36 in [analytics/README.md](../analytics/README.md). Packages installed with your approval: typescript, tsx, @types/node (dev), oracledb.

---

### Milestone 10: Sleep night summaries [analytics/]

**Goal:** Per-night sleep summaries (stage durations, awakenings) are computed in Oracle from stage-interval Observations.

**Depends on:** Milestone 9.

**Tasks:**
1. Define "night" (session grouping, boundary rules); record as assumption.
2. Summary schema and computation from stage intervals.
3. Handle overlapping or conflicting intervals and missing stages.
4. Tests with synthetic nights.

**Verify:** known synthetic night yields the expected stage totals; reruns are stable.

**Status (2026-10-12):** built and verified; **awaiting your review** (not committed). Decisions taken with you: session gaps (2 h) for grouping, night dated by the UTC date of the final waking, main sleep plus separately reported naps, awakenings at least 5 minutes. Pure logic in `analytics/src/sleep.ts`, a `sleep_session` table, and sleep windows in the existing worker. 53 tests (51 run, 2 live skipped without the stack) cover a known night with exact totals, the threshold edges, session-gap edges, overlap resolution, order independence, a late interval that bridges two sessions (one row removed), and rerun stability; `make test-analytics-live` adds a night across UTC midnight on the real stack (stable on rerun, a late stage changes only that night). Four mutations (gap boundary, overlap precedence, stale rows not deleted, awakening threshold ignored) each fail tests. Assumptions A37 to A42 in [analytics/README.md](../analytics/README.md). No contract change.

---

### Milestone 11: Analytic API [analytics/]

**Goal:** An authenticated API serves trend bands and sleep summaries for a patient and time range.

**Depends on:** Milestones 9, 10.

**Tasks:**
1. Endpoints: daily bands (metric, range), sleep nights (range).
2. Validate Keycloak JWTs (audience, `clinician-reader` role) the same way HAPI does in M4.
3. Response includes data-completeness info (gaps, last computed, watermark).
4. Contract tests and API description.

**Verify:** `curl` with a clinician token returns bands; without a token returns 401; response matches Oracle contents.

**Status (2026-10-12):** built and verified; **awaiting your review** (not committed). Decisions taken with you: separate audience `poc-analytics` (realm change; Keycloak realm re-imported) and a loopback-only TLS listener at `127.0.0.1:8445`. No new packages. Three endpoints (`/v1/metrics`, bands, sleep) with a `completeness` block, JWT verification in Node's `crypto` mirroring HAPI's checks, its own leaf certificate (`make tls`), and an API description (`analytics/api/openapi.json`) that responses are tested against. 77 unit/contract tests plus 4 live tests pass; `idp/oidc.py check` passes with the new audience checks. Against the real process on the host: no token 401, clinician 200, capture user 403, worker token 401, oversized range 400, listener on 127.0.0.1 only. Five mutations (audience check, role check, algorithm allowlist, auth-before-routing, range limit) each fail tests. Decisions A43 to A47 in [analytics/README.md](../analytics/README.md). Contract unchanged.

---

### Milestone 12: Clinician web scaffold and patient banner [web/]

**Goal:** A React/TypeScript app signs in as the clinician, shows the patient banner with latest values, last-data-received, and a visible stale-data indicator.

**Depends on:** Milestones 4, 8.

**Tasks:**
1. Scaffold the repo and typed FHIR client.
2. Sign in with Keycloak (authorization code + PKCE) as the synthetic clinician; token handling and refresh.
3. Banner: latest value per metric, last data received, staleness, source kinds (`Observation/$lastn` was found unusable on this HAPI, see the status).
4. Error and empty states.

**Verify:** banner reflects latest synthetic data; stopping the synthetic source makes staleness appear.

**Status (2026-10-12):** built and verified except an interactive sign-in; **awaiting your review** (not committed). Decisions taken with you: the standard package set (react, react-dom, oidc-client-ts; typescript, vite, @vitejs/plugin-react, vitest, jsdom, @testing-library/react and the type packages) and a web dev server on all interfaces :3000 with TLS (no hosts entry). The dev server serves `web/` and `contract/` only and relays `/fhir` and `/analytics`. 51 tests pass (banner model with the staleness boundary, client error mapping, loader, auth settings and callback flow, component states, contract tests); `make test-web-live` checks the banner against the live HAPI independently (every Observation of each metric read and the newest taken in the test; last-received compared to the newest receipt) and that staleness follows the clock. Checked with curl against the running server: TLS verified by the POC CA, `/fhir` 401 without a token and 200 with one, POST 405, `/analytics` 401/200/400 through the relay, `/@fs` of `idp/.env.local` and `db/.env.local` refused (403) with `contract/metrics.json` served as the control, Keycloak's preflight and discovery send the registered origin. **Finding:** `$lastn` returns unrelated, unordered Observations on this HAPI (ignores `code` and `max`), so the banner uses sorted searches. Not verified: the interactive Keycloak login (a person types the password; the built-in browser pane also refused the origin). Assumptions W1 to W7 in [web/README.md](../web/README.md).

---

### Milestone 13: Flowsheet [web/]

**Goal:** A filterable, sortable, paged table of Observations across metrics.

**Depends on:** Milestone 12.

**Tasks:** filters (metric, range, source, status), sort, paging via HAPI search, units always visible, keyboard-accessible table.

**Verify:** results match direct HAPI searches; sort/filter combos behave over thousands of rows.

**Status (2026-10-13):** built and verified; **awaiting your review** (not committed). No new packages. A filterable (metrics, UTC date range, source, status), sortable (five columns), server-paged table with the server's total, units beside values, flagged statuses, empty/error/stale-response handling and keyboard-operable headers. 82 unit and component tests pass. `make test-web-live` compares 31 filter and sort combinations over all 4,187 of the patient's Observations (3,000 of them seeded synthetic data for this check, left in HAPI) with an independent read: totals equal, every page walked with no duplicate or missing row, the set equal and the order monotonic. Three mutations (off-by-one offset, exclusive end day, ignored status) each fail the live test for the stated reason; a fourth (no stale-response guard) fails the component test. **Findings:** (1) HAPI stores `meta.source` as `<uri>#<request id>`, so M12's exact-match source detection showed every live resource as "Unknown source" (the M12 unit tests used bare URIs); fixed here. (2) HAPI sorts correctly by date, code, value, status and `_lastUpdated` but not by `_source`, and ignores `_source:not`. Assumptions F1 to F8 in [web/README.md](../web/README.md).

---

### Milestone 13a: Deployment and scheduled scans [repo/analytics/web]

*(Added after M13 at the developer's request; not in the original sequence.)*

**Goal:** Nothing is started by hand: the analytics worker, the analytic API and the web app are deployed by `make stack-up`, supervised, and the worker scans HAPI on a schedule.

**Decisions (with the developer):** containers in the existing compose project; the web app as a production build behind the pinned nginx (Vite's dev server stays for development); scans every 30 seconds; `node:24-slim` pinned by digest as the one new external image.

**Tasks:** 1. Image and compose service for the worker (loop that survives failures, heartbeat, healthcheck). 2. Service for the API (loopback publish, TLS key kept 0600). 3. Web image and nginx with verified upstream TLS and a CSP. 4. Least-privilege credentials per container. 5. Bootstrap runs the analytics migration and waits for every service to be healthy. 6. Extend `make stack-verify`.

**Verify:** after `make stack-up`, a sample written to HAPI becomes a rollup with nobody invoking the worker; stopping HAPI does not kill the worker, and it recovers; a crashed worker is restarted; `make stack-verify` passes.

**Status (2026-10-13):** built and verified; **awaiting your review** (not committed). Measured on the running stack: a new sample appeared as a rollup via the deployed API 19 s after the write with nobody invoking anything; with HAPI stopped the worker logged `fetch failed` with 30 s then 60 s backoff, stayed running and healthy, and resumed by itself when HAPI returned; a crashed worker process was restarted by Docker (restarts=1). `make stack-verify` gained 20 checks (health, API 401/200, web relay 401/200/405 with positive controls, CSP, no SYS password in the worker, no worker secret in the API, read-only filesystem, scans on schedule). 84 analytics unit tests (7 new for the loop) and 82 web tests pass. **Findings:** (1) `docker kill` counts as a manual stop for `unless-stopped`, so a crash had to be simulated inside the container; (2) with the POC CA trusted in the macOS keychain, curl, LibreSSL and Python all accepted the server with no CA given, which broke two existing "untrusted" checks in `db/verify.sh`; they now use Node's TLS with an unrelated CA (and skip loudly without Node). Decisions and assumptions in [analytics/README.md](../analytics/README.md) and [web/README.md](../web/README.md).

---

**Change after M13a (2026-10-13), bootstrap simplified:** the `oracle-init` service, the `initialize` profile and the `db/.initialized` marker are gone. `db/init.sh` now runs inside the `oracle` container on every start as an Oracle image startup hook (`db/startup/10-poc-init.sh`, mounted at `/opt/oracle/scripts/startup`), and the `oracle` healthcheck reports healthy only when the CDB answers and that start's init succeeded (`db/init-status.sh`). Everything that depends on `oracle: service_healthy` therefore depends on an initialized database, and `scripts/bootstrap.sh` has one path. Facts found in the image: hooks are **sourced** (a wrapper must not `exit`), the directory's `*.sql` files run as SYS, a hook's exit status is ignored (so the outcome is recorded in `/dev/shm`), and `/dev/shm` survives `docker restart` (so the status is keyed to PID 1's start time). Verified: fresh database in a throwaway container (three PDBs, 72 HAPI tables, users); idempotent rerun on restart; stale-status control; forced failure reports `failed` for the stated reason; live stack on the existing volume; `make stack-verify` passes. **Not exercised end to end:** `make stack-reset && make stack-up` (erases your Oracle volume).

**Change after M13a (2026-10-13), restart and dependency fixes:** every service is now `restart: unless-stopped` (oracle, hapi, keycloak and idp-edge were `no`, so a daemon restart left a database-less worker, API and web behind). The daemon ignores `depends_on`, so services that start early retry until their dependencies are up; `docker stop` and `make stack-down` stay stopped. `idp-edge` is healthy only when the realm's discovery document answers through the proxy (it was a port check that passed with Keycloak down), and waits for Keycloak healthy, so the worker's and API's existing dependency on it is now truthful. `web` also waits for `hapi`. The analytics schema moved into the oracle startup hook (`analytics/db-migrate.sh` is removed; `make analytics-migrate` reruns the init), so only Keycloak's schema remains a bootstrap step: it needs `docker run`/`cp`/`exec`, and a service for it would need the Docker socket. `db/verify.sh` scopes its HAPI and Keycloak log scans to each container's latest start. Verified: each service exits and is restarted healthy (SIGTERM to PID 1 from inside); all seven stopped and started simultaneously converge healthy in 27 s (`analytics-api` needed 5 restarts) and `make stack-verify` passes; a fresh database creates the four analytics tables, synonyms and grants through the hook. A real Docker Desktop restart (2026-10-13, no governance containers present): the daemon was back in 10 s and all seven services were healthy 30 s later with no `make` command; `analytics-api` took 6 restarts waiting for Oracle (an in-process wait would quiet it; optional).

### Milestone 14: Longitudinal trend view [web/]

**Goal:** Weeks-to-months daily min/median/max bands per metric, from the analytic API, with gaps clearly shown.

**Depends on:** Milestones 11, 12.

**Tasks:** contract test (metric list, codes and units match `contract/metrics.json`), choose charting library (Open Question 6), band chart, time-scale controls, gap rendering, text/table equivalent, drill link to intraday.

**Verify:** matches the analytic API; synthetic gaps appear as gaps, not interpolation; screen-reader summary present.

**Status (2026-10-13):** built and verified; **awaiting your review** (not committed). Decisions taken with you: uPlot for charts (chosen over hand-rolled SVG because M15 needs a dense-data library anyway), three stacked charts, the six defaults (7/14/30/90 days plus custom, resting heart rate as points, gaps as gaps with the API's completeness, a stub for the intraday drill, UTC days in words). One new package, `uplot` 1.6.32 (MIT, no dependencies; CSP-checked); loaded on demand as its own 51 kB chunk. `dataviz` skill run: slots 1 to 3 pass all-pairs in both modes, with aqua below 3:1 on light, relieved by the table and summary. Tests: 54 new unit and component tests; four mutations are caught (a gap filled with 0, lines spanning gaps, no isolated-day markers, points-only too eager). Live: every band equals an independent recomputation from raw HAPI Observations, the gaps are exactly the days with none, and a request without a token is refused (with a positive control). Rendered once in a real browser under the app's CSP, dark and light (not automated). **Found on the way:** (1) the flowsheet's date filter includes a period that overlaps the day (a resting-heart-rate day straddling UTC midnight appears under both days), so README F6 was wrong for periods and now says so; the live test model was corrected to match; (2) the M12 banner live test only worked while the stack held no period-valued Observations; (3) a fresh stack has no non-final Observations for the status controls, so the live test now creates two synthetic fixtures. **Not exercised:** a screen reader pass.

---

### Milestone 15: Intraday dense view [web/]

**Goal:** One day's raw samples with zoom/pan and gap markers.

**Depends on:** Milestones 13, 14.

**Tasks:** paged fetch of a day, client-side downsampling for rendering, zoom/pan, gap markers, flagged-artifact markers.

**Verify:** a 17k-sample day renders responsively; zoom reveals raw points; gaps marked.

**Status (2026-10-14):** built and verified; **awaiting your review** (not committed). Decisions taken with you: the defaults (one UTC day, heart rate and HRV on a shared zoomable axis, buttons plus drag plus keyboard, an hourly table as the text equivalent, previous/next day, back to trends keeps the range, a seeded dense day) and **option (a) for artifact markers: only stored flags are marked, nothing is inferred**. Because the flag codes must live in the contract, `contract/metrics.json` went to **1.2.0** (additive: the flag system and codes, assumption A30); the iOS bundled copy and golden fixtures were regenerated and iOS (109 tests), analytics and web re-run. `make web-seed-dense-day` seeds one idempotent synthetic day (19,830 heart-rate samples with three gaps, a 4-minute pause that must not be a gap, six stored flags, two unflagged implausible values). Tests: about 60 new (model, plot and overlay painting, paging, routing, the page); mutations caught: flags inferred from a value, lines across gaps, retracted data included, other units accepted, no cadence scaling, and a reload on any sign-in state change. Live: the loaded day equals an independent read of the raw Observations, gaps/flags/oddities are as seeded. Measured: 19.8k samples fetched and modelled in about 2.7 s over the LAN; in a real browser a first draw costs about 9 ms and a zoom about 3 ms of CPU. **Found in a real browser:** the first version ignored every zoom (a uPlot `range` array, or a function ignoring its inputs, is applied to every zoom request); fixed and documented. **Also found:** the load depended on the whole auth context object and would re-download a dense day on any sign-in state change (fixed, with a test); the old flowsheet live test hit its own 20k-row cap and now sizes its page loop from the expected total. **Not exercised:** a screen reader, touch gestures, a day above 20k samples.

---

### Milestone 16: Sleep view [web/]

**Goal:** A single-night hypnogram plus a multi-week nightly summary.

**Depends on:** Milestones 11, 14.

**Tasks:** hypnogram from stage intervals, nightly summary from the analytic API, accessible alternatives, timezone/DST labeling.

**Verify:** a known synthetic night renders the expected stage sequence; summary matches Oracle.

**Status (2026-10-14):** built and verified; **awaiting your review** (not committed). Decisions taken with you: the defaults (option A: the web resolves the timeline from the stage Observations and is cross-checked against the API; stage-lane hypnogram in SVG; last 14/30/90 nights as stacked bars with a table twin; times as recorded with the clock change stated; a third tab; known fixture nights; no new package, no contract change, no API change). `make web-seed-sleep-nights` seeds three known nights (an overlap, an unscored gap, a 3-minute awake and a 10-minute awakening; a night plus a nap; the 2026-03-08 DST night). **The analytic API's summaries equal an independent per-minute reading on all 12 fields for all four sessions**, and the web's timeline equals the API's for every one of the 16 sessions on the stack. Tests: about 60 new (model, loading, parsing, routing, the page); mutations caught: later start no longer winning, the awakening threshold, the tie-break, an invented clock time inside a clock change, unscored time dropped, adjacent awake pieces not joined, and (after a first miss, fixed) a neighbouring session included. Real browser: dark and light, the DST night's "10:00 UTC" tick and the hatched unscored stretch checked by eye. **Along the way:** a blue stage ramp failed the dark-mode lightness band (replaced by slots 4 to 7); my fixture reader first treated a nap as one session (fixed); an unspecified-stage overlap shows as two adjacent stretches because the overlap count changes. **Not exercised:** a screen reader, touch, a very large session.

---

### Milestone 17: HealthKit source [ios/]

**Goal:** The capture app can read your own HealthKit data for the three metrics and upload it to the authenticated TLS endpoint.

**Depends on:** Milestones 2, 3, 4, 8 (real-data gate satisfied).

**Tasks:**
1. HealthKit entitlement and authorization for the specific types only.
2. Implement the ingest source protocol over HealthKit queries.
3. Map to the registry, including user-entered samples and deletions (`entered-in-error`, A11).
4. HealthKit selectable only when the endpoint is TLS + authenticated.
5. Verify no real data in logs or fixtures.

**Platform notes:** `SpeziHealthKit` for authorization and collection; verify its upload behavior against the spec before relying on it. Needs a real iPhone for meaningful data.

**Verify:** on device, a small sync appears in HAPI and the clinician web views; repo and logs contain no real values.

**Status (2026-10-13):** built and verified in code and on the simulator; **awaiting your review and your on-device run** (not committed). Decisions taken with you: the defaults (SpeziHealthKit 1.4.2 pinned; deletions recorded, not applied; a separate `poc-real` Patient with a data-set switch in the web app; a `user-entered` flag, contract **1.3.0**; first backfill 7 days; signing steps are yours). Tests: 145 iOS unit and 3 UI tests, 253 web, 84 analytics, contract checks; all pass, and `make guard-all` is clean. New tests cover the mapper (units, sleep stages, user-entered, unknown values refused), the bridge (drops and counts while HealthKit is not the selected source), the gate (each refusal reason), per-source patients (two patients, one patient per bundle, and **no fallback**: with no real-data patient the real items stay on the device and the synthetic ones still upload), deletions (idempotent, queue untouched), queue file protection, and a scan proving no real-data file can log or print (with a positive control). **Not verified here:** anything with real data, the HealthKit authorization sheet, the free-provisioning limits (7-day expiry; background delivery for M18). Assumptions in [ios/README.md](../ios/README.md#healthkit-source-m17).

---

### Milestone 18: Background delivery and device mapping [ios/]

**Goal:** New HealthKit data arrives without opening the app; sources are modeled as `Device`s; and no sample can be lost between HealthKit and the local queue.

**Depends on:** Milestone 17.

**Background (what M17 found, by reading SpeziHealthKit 1.4.2).** Collection is an anchored object query per sample type that HealthKit pushes to while the app is alive (`continueInBackground` is off). The library saves the new anchor as soon as `handleNewSamples` returns. Two consequences are M18's first tasks:
- *Kill-time loss window:* our Standard hands a sample to the bridge's stream and returns; the SQLite write happens later in another task. A kill in between leaves the anchor advanced and the sample nowhere.
- *Drop-while-closed loss:* when the gate closes (sign-out, token gone) the bridge drops and counts arrivals, but the collector keeps running and the anchor keeps advancing, so those samples never return.

**Tasks (in this order):**
1. **Entitlement check first (decision gate).** Establish whether background delivery (`com.apple.developer.healthkit.background-delivery`) can be signed with a free provisioning profile on the target device. Record the evidence. If it cannot, stop and bring you the choice: a paid Apple Developer account (an account and a cost), or foreground-only for the POC. Do not build the rest until decided.
2. **Durable handoff.** `handleNewSamples` awaits the queue write (map, enqueue, commit) before it returns, so the anchor never advances past a sample that is not in the queue. Test: a failing/slow queue write must delay the return; a crash-style test proves a sample is either queued or redelivered.
3. **Pause, do not drop.** When the gate closes, stop the collectors (the anchor stays), and resume them when it opens. The bridge's drop-and-count stays only as a backstop. Test with a positive control: samples that arrive while paused are delivered after resuming, none lost, none duplicated.
4. **Background delivery.** `continueInBackground: true` for the four types: observer query plus `enableBackgroundDelivery`, with the completion handler called only after the durable handoff. A background wake-up must be able to upload what it queued within its time budget, or leave it safely queued.
5. **Token and TLS in the background.** A wake-up with an expired access token refreshes once or leaves the items queued with a stated reason; it never uploads unauthenticated and never falls back to the synthetic patient. The data-file protection class chosen in M17 (`completeUntilFirstUserAuthentication`) is what lets this run with the phone locked; verify it on the device, not the simulator.
6. **Device mapping.** Check the Watch's real `HKDevice` fields against the `Device` resource (name, manufacturer, model, hardware and software version) and the stable device key, so one Watch is one `Device` across software updates. Flag every assumption (cardinality of missing fields, what counts as "same device").
7. **Backfill policy.** Replace the fixed 7-day window with a stated policy: first run, resume after a long gap, and a way to widen it deliberately. Re-delivery must stay harmless (conditional create on the sample's identifier).
8. **Surface it.** Show "Received since app start" and a lifetime figure side by side with last background delivery time, so the screen cannot be misread (found in M17).
9. **Battery and impact.** Measure wake-ups per day and upload cost over a day of wear; record the numbers.

**Assumptions to flag in the README (to be reviewed):** the background-delivery frequency per type is set by iOS, not by the app; "within an expected window" is a measured range, not a guarantee; deletions stay recorded-not-applied (the writer role cannot update or delete, A11); real data still goes only to `poc-real`.

**Risks and open decisions:**
- Free provisioning may refuse the background entitlement (task 1); the answer may need your decision on a paid account.
- Free-profile builds expire after 7 days; a lapsed build stops background delivery until reinstalled.
- Background behaviour cannot be verified in the simulator.

**Verify (counts and structure only; no real values in the repo, logs or this conversation):**
- With the app closed and the phone locked, new Watch samples appear under `poc-real` within a measured window; record the observed range.
- Repeating the sync (relaunch, forced re-delivery, anchor reset on a test build) leaves the server count unchanged.
- Tests prove: no sample is lost at kill time, none is lost while the gate is closed, and a wake-up without a usable token uploads nothing.
- Server counts per metric match the app's lifetime sent figure, and nothing real appears under `poc-0001`.

**Status (2026-10-14):** code built and unit-tested; **device measurement and your review outstanding** (not committed). Task 1 passed: the signed build and its embedded profile both carry the background-delivery entitlement on the free profile (expires 2026-10-21). Built: durable acknowledged handoff (task 2), hold-not-drop while signed out (task 3), background delivery with launch-time registration and sign-in restore (tasks 4 and 5), a fixed backfill window (task 7) and counters that survive relaunch (task 8). 157 iOS unit and 3 UI tests pass. **Deviations from the brief:** (a) task 3 is "hold", not "stop collectors": SpeziHealthKit has no pause that keeps its anchor, only a reset that clears it; (b) the bridge also buffers records that arrive before it is wired. **Findings (counts and field presence only):** the three real devices map by the contract's rules; one has no `HKDevice`, so its name comes from the source app yet is typed `model-name` (a contract decision for you); the device key includes the software version, so an update makes a new `Device`. **Measured on your phone (2026-10-14, counts and times only):** with the app in the background and the phone locked, batches were stored at about 41 to 42 minute intervals (12:27, 13:09, 13:50); a measurement reached the server a median of 20 minutes and at most 42 minutes after it was taken; app uploaded total equalled the server total (750) with nothing queued. One batch received at 13:42 was stored at 13:50, which pointed at the upload not finishing inside the wake-up; fixed by holding a background-task assertion until the drain ends, and a persisted "last upload attempt" line added to diagnose it. Not yet re-measured after that fix. **Not verified:** battery and impact (a day of wear); the kill-time and signed-out loss windows on the device; sleep samples arriving by background after waking. Assumptions in [ios/README.md](../ios/README.md#background-delivery-and-durable-handoff-m18).

---

### Milestone 19: Data-quality surfacing and hardening [all]

**Goal:** Artifacts and late data are visible to clinicians; accessibility, errors and operations are exercised.

**Depends on:** Milestones 15-18.

**Finding that shaped it:** nothing wrote the flags. Only a web seeding tool planted them; contract A30 said "written by nothing yet (M19)". So "injected artifacts appear flagged" first needed a flag *writer*.

**Decisions taken with you (2026-10-17):** the **iOS app writes the flags at ingest** (thresholds in the contract; works with the create-only server role; the synthetic source's injected faults are exact ground truth); **no new packages** for accessibility; **late arrival means more than 24 hours**; and the **dense-load test is skipped** (see Verify).

**Tasks:**
1. Contract 1.4.0 (additive): `plausibleRange` per quantity metric, `qualityThresholds.lateArrivalHours`, the rules `artifactSuspected`, `lateArrival`, `duplicateResolved`, `tagOrder`, assumptions A31 to A33; the independent generator and `golden/flags.json` (boundaries on both sides).
2. iOS: `QualityFlagger` (applied to every sample entering the queue), duplicate flagging in the queue, tag emission, simulator label stating the threshold and a 72 h late range.
3. Analytics: flag counts per day (`n_artifact`, `n_late`) read from the stored tags, in the store, the API and `openapi.json`; idempotent `ALTER` for existing databases.
4. Web: a Flags column in the flowsheet, flag counts and a visible notice in the trends view (the range includes the flagged values), one shared helper.
5. Accessibility: Xcode's audit as a ratchet on iOS (fixing the accent colour, the secondary text colour and the disabled-choice row); a dependency-free DOM audit on the web with positive controls.
6. Error states: reviewed against the existing tests (offline, 5xx, 401, 403, signed out, refused samples, malformed analytic answers, empty results, retry), which already cover them; nothing added.
7. Runbooks: [docs/runbooks/operations.md](runbooks/operations.md) and [docs/runbooks/ios-device.md](runbooks/ios-device.md), beside the TLS runbook.

**Verify:** injected artifacts, late deliveries and duplicates appear flagged **on the server**, exactly as ground truth says (live); accessibility checks do not regress and never fail on contrast. ~~Dense load test~~ **skipped by decision.**

**Status (2026-10-17):** built and verified; **awaiting your review** (not committed). Tests: 178 iOS unit and 4 UI (the accessibility ratchet among them), 95 analytics, 282 web, contract checks, `make guard-all`; **live:** analytics 5 of 5, iOS integration (the new end-to-end flag test among them) passing, web 6 of 8. Mutations caught: both boundary comparisons in the flagger (seven golden cases fail), a lowered secondary-text contrast (the ratchet fails), and the audit's own rules (each has a defect it must find). **Findings:** (1) the first accessibility audit reported 30 issues; 5 contrast failures were real defects of ours, fixed, and borderline contrast plus five Dynamic Type results remain, most without an element named by the audit, so their causes are inferred; (2) `up -d --build` rebuilt the web image but did not replace the running container, so the runbook now checks image ids; (3) a vacuous test I wrote (`|| true`) was removed, and a wrong path in a scan was caught by its own "did it read the files" guard; (4) my own test data tripped the new web validation (more flagged than samples), which is the validation working; (5) **`scripts/ios-test.sh` was silently cutting off a UI test**: its watchdog took Swift Testing's summary as the end of the run, but the UI tests run after it, so "3 UI tests passed" meant 3 of 4 ran (also true of earlier milestones' runs). Fixed: with UI tests it waits for xcodebuild's own verdict; all four now run and pass; (6) the accessibility ratchet failed deterministically after I added an explanatory text near the screen edge (the audit measures clipped text as failed contrast); the text became the stepper's label. **Not verified:** a **real-browser** pass of the new web views and screen readers (needs an interactive sign-in); VoiceOver and Dynamic Type at the largest sizes; two web live checks that need weeks of synthetic history this rebuilt stack lacks (daily resting heart rate, more than five nights); **the dense-load test, so volume limits remain unknown** (the data model's sizing note stands). Assumptions in [ios/README.md](../ios/README.md#data-quality-flags-m19), contract A31 to A33.

---

### Milestone 20: Nutrition contract and mapping [contract/, ios/]

**Goal:** The eight nutrition metrics exist in the contract and map to FHIR correctly, proven on synthetic data, before any real source is touched. Design in [docs/planning/nutrition-brief.md](planning/nutrition-brief.md).

**Depends on:** Milestone 19. **Environment:** the stack rebuilt (see the brief's prerequisite section).

**Tasks:**
1. `contract/metrics.json` 1.5.0 (additive; M19 took 1.4.0 for the data-quality flag rules): eight quantity metrics (energy `kcal`; protein, carbohydrate, fat, fiber, sugar `g`; sodium `mg`; water `mL`), the LOINC codes the brief lists, the new `nutrient` code system with `fiber`, `sugar`, `sodium`, category `activity`, their HealthKit identifiers; assumptions N1 to N11 added to `assumptions`; the terminology checks (LOINC existence, UCUM validity) recorded in `verification` with their date and source. Each nutrient also gets a `plausibleRange` (a clinical judgment, flagged like A32) so the M19 flagging applies to nutrition; for example an energy value above a stated per-entry ceiling is `artifact-suspected`, never dropped.
2. **Source application as a `Device` (decision D6):** `HealthKitRecord` gains the source's bundle identifier; for a sample with no `HKDevice` the Device is named by the source app's display name (name type `other`, replacing `model-name`), carries the bundle identifier as a second identifier (`.../identifier/app-bundle-id`), and is keyed by it (a new key algorithm in the contract; the five-field key for Watch and iPhone Devices is unchanged; a blank bundle identifier falls back to the old rule). In the contract, the independent generator, the golden fixtures and the iOS mapper in one commit; a test shows two display names with one bundle id give one key.
   **Category and meal type (decision D5, decided):** `systems.observationDomain` (`nutrition`) and `systems.mealType` with their code tables, an optional `mealType` on the sample mapped to a second `category` entry (omitted when absent), nutrition Observations carry no HL7 `activity`; the generator and goldens cover present, absent and disagreeing labels. Verify that HAPI 7.6.0 answers `category=<system>|nutrition` and `|lunch` searches (assumption in the brief).
3. `contract/golden/generate.py` (independent implementation) and golden fixtures for every nutrient, including zero values, a custom-coded one and an edit (a retraction).
4. iOS: registry and mapper read the new metrics; `HealthKitRecord.unit` gains the units; the synthetic source gains a meal generator (entries, edits, deletions, a day with none) with a measured test and a mutation for each fault. No HealthKit collector yet.

**Verify:** `make test-contract` and the iOS unit tests pass; a mapper change that needs a different golden means one of the two implementations is wrong; the generator output uploads to the rebuilt stack under the synthetic patient and reads back identical.

**Status (2026-10-19):** built and verified; **awaiting your review** (not committed). Contract **1.5.0**: eight `intake` metrics, the domain and meal-type systems, zero allowed for intakes, per-entry plausible ranges, the source-application Device (D6), and the checker with a control for every refusal. Independent generator: 34 observation cases (the eight nutrients with and without meals, zeros, a flagged one), 12 devices (a renamed app keeps its key), 6 refusals (a negative intake), 55 flag evaluations (nutrient boundaries) and 11 meal-label cases. iOS: 197 unit tests (new: intake units converted from kJ, mg, oz and L; meal-label resolution including two disagreeing keys; the source-application key; ten measured tests of the new **meal generator** (eight nutrients at one instant, fixed meal roles with contract labels, skipped days, zeros, edits, deletions, artifacts, determinism)); the accessibility ratchet and the simulator UI test pass; a live test uploads generated meals through the real path and reads them back. **Mutations caught:** zero allowed, the bundle-identifier key and case-insensitive meal matching; six generator faults (seven tests). **Live on HAPI 7.6.0:** `contract/verify-hapi.py` accepts all 45 golden Observations and the Devices, and the searches the design relies on all answer, each with a zero-result control. Analytics (91) and web (282) tests still pass: both ignore `kind: intake`. **Findings:** (1) a literal `|` in a query string is rejected by the servlet container (HTTP 400), so searches must percent-encode it; (2) the brief's multi-entry category search assumption is now verified; (3) my first mutation run was misread because my `grep` anchored on a character some failure lines do not start with; all six mutations were in fact caught; (4) **my M19 docs commit had deleted the M20 to M23 sections from this plan** (its replacement ran from the M19 heading to the next section, and they sat between): restored from the commit that added them, with the later edits re-applied. (5) **found on your phone after the build:** signing in did not resume an upload that was blocked on "Sign in required" (1,677 samples sat queued with a stale state, because nothing woke the engine except a new sample, "Sync now", un-pausing or the network returning); fixed with `SyncModel.userSignedIn()` called when the auth state becomes signed in, with two tests (one with a control that a token merely appearing wakes nothing) and a mutation caught. Earlier runbook text implied this already worked. **Not built:** the HealthKit collectors and the structure probe (M21), retraction (M21), daily totals (M22), the web view (M23).

---

### Milestone 21: Nutrition ingest and retraction [ios/, hapi/]

**Goal:** MFP's entries reach HAPI under `poc-real`, and an edited or deleted entry is retracted instead of double counted.

**Depends on:** Milestone 20.

**Tasks:**
0. **Structure probe (read-only, on the device, your own data):** report **counts and key names only, never values or food names**: how many samples share an instant, distinct times per day, which metadata key names are present (are `meal` and `Meal` always both there, is there a per-entry id, is a time zone written), and whether samples belong to a `food` correlation. It settles N5, N6 and N7 and the meal-type labels' shape before M22 and M23 build on them. Remove or keep it behind a debug switch afterwards.
1. **First, verify** that HAPI 7.6.0 accepts conditional JSON Patch by identifier in this configuration (assumption N11); record the result before building on it.
2. `hapi/ext`: the narrow rule of the brief (the capture role may `PATCH` an Observation's `status` to `entered-in-error`, only that, only its own source), with negative controls for `PUT`, `DELETE`, another path or value, another resource type, and a positive control for the exact retraction.
3. iOS: collectors for the eight types behind the existing acknowledged handoff, the authorization request, the fixed window; the data-source screen shows nutrition counts.
4. iOS: apply the recorded deletions as retractions (all metrics, not only nutrition), with the queue handling a sample deleted before upload and a retry for a failed retraction; the "deleted, not applied" line becomes "retracted" and "pending".

**Verify (counts and structure only; no real values anywhere):** on the device, a new MFP entry appears under `poc-real` with the right codes and units; editing it leaves one `entered-in-error` and one `final`; the HAPI tests show each refusal for its stated reason.

---

### Milestone 22: Nutrition daily totals [analytics/]

**Goal:** Daily totals per nutrient, correct under edits, with "no entries" distinct from zero.

**Depends on:** Milestone 21.

**Tasks:** the daily-totals store and worker (day as recorded, `entered-in-error` excluded, touched-window recompute with a revision; an optional meal dimension (D5)), the API endpoint with completeness, and tests against an independent computation including an evening entry, a retraction, a zero value and a day with no data.

**Verify:** the API's totals equal an independent sum read straight from the FHIR Observations on the live stack (synthetic first, then your real data by totals only).

---

### Milestone 23: Nutrition view [web/]

**Goal:** A clinician can see daily energy and macronutrients, with gaps shown as gaps.

**Depends on:** Milestone 22.

**Tasks:** the Nutrition view (chart, table twin, text summary, arrow-key readout, a by-meal breakdown (D5)), "day as recorded" labelling, estimates labelled as estimates, the data-set switch honoured; verified on a real canvas.

**Verify:** the view agrees with the API and the FHIR data; a retracted entry disappears from the totals; checked in a real browser.

## Data Model Integration

| Entity | FHIR Resource | Milestone | Notes |
|---|---|---|---|
| Patient | `Patient` | 4 (seed), 8 | One synthetic patient seeded; app only references it |
| Heart rate | `Observation` (8867-4) | 6, 8, 17 | Shaped like R4 `heartrate`, no profile claim |
| Resting heart rate | `Observation` (40443-4) | 6, 8, 17 | |
| HRV SDNN | `Observation` (112429-6) | 6, 8, 17 | `ms` unit unverified |
| Sleep stage intervals | `Observation` (93829-0/93830-8/93831-6/93832-4/103210-1) | 6, 8, 17 | `inBed` unmapped |
| Source device | `Device` | 8, 18 | Synthetic first, HKDevice in M18 |
| Daily rollups, sleep nights | Not FHIR (Oracle) | 9, 10 | Per decision, not written back |
| Data-quality flags | `meta.tag` | 19 | A8 |

## Compliance Integration

No compliance brief was produced. CLAUDE.md's data rules act as the controls:

| Control | Milestone | How |
|---|---|---|
| Real data only to own HAPI, only over TLS + auth | 2, 3, 4, 17 | Gate: HealthKit source selectable only when endpoint meets this |
| No real data in repo, fixtures, logs, screenshots, commits | 0, 17 | Pre-commit data-leak guard from M0 (backstop only); synthetic fixtures only; log review at M17 |
| Synthetic source behind same ingest interface | 7 | Source protocol shared with HealthKit |
| No third-party or analytics services | All | No SDKs beyond Spezi modules approved per milestone |
| No secrets in the repo (Oracle and Keycloak credentials, test-user passwords, CA keys) | 1, 2, 3, 4 | Realm export templated; generated secrets and CA key live outside the repo; guard blocks key/secret patterns |
| Ask before installing or connecting external services | All | Oracle, charting library, any new package approved at the milestone |

If this ever leaves local use, run `digital-health-compliance-planning` first.

## Open Questions

1. **Resolved:** Keycloak **26.8.0**, digest-pinned, behind an nginx path-allowlist proxy on 8444, with H2 in M3a and Oracle in M3c (decided 2026-10-09); the Keycloak container and its admin console are never published. Still open: your approval to pull the Keycloak image for M3a (about 264 MB) and, later, to download the Oracle driver jars for M3c; the memory cap (about 1.5 GB); (the Docker Desktop VM memory is now 11.67 GiB, confirmed 2026-10-09).
2. **Oracle Free edition limits and host memory** (M1, M9): the POC runs its own Oracle container alongside the governance stack's, so total RAM matters too. CPU, memory and user-data caps apply to the whole instance across PDBs, so HAPI's index-heavy schema and the rollups compete for the same budget. Unverified until M1 measures them.
3. **Paid Apple Developer account** (M17): whether HealthKit on a personal device needs one is unverified; it would be an account and a cost.
4. **SpeziHealthKit and SpeziFHIR behaviors** (M8, M17): the reference file's claims (background delivery, HAPI support, data store upload) need verifying against the modules before relying on them.
5. **Resolved:** monorepo layout (see Context). Still open: whether `.agents/`, `.claude/`, `agent/` and `skills-lock.json` are committed (M0).
6. **Charting library** for the web app (M14): not chosen; will be proposed with trade-offs when we reach it.
7. **Day and night definitions** (A6, M9-10): need your clinical judgment; I will propose defaults.
8. **Apple Watch**: not required until you buy it; M17-18 work with iPhone data first.
9. **HAPI request validation** (A13): enable it in M4 or later?
10. **Clinician web hosting**: dev server only, or served from the Mac Pro behind TLS?
11. **OIDC client library for iOS** (M5): AppAuth or a custom `ASWebAuthenticationSession` implementation; adds a package beyond the template, so it needs your approval.
12. **Token lifetime vs. offline capture** (M3, M8): how long the capture queue can wait before a refresh is required.

## Parked (not part of this plan)

[docs/future-journeys.md](future-journeys.md) records ideas deliberately set aside, starting with FJ-1: a local Kubernetes cluster with mesh mTLS between pods and cleartext services inside.

## Next Steps

Review this plan. When approved, start Milestone 0 (repo foundation), then stop for your review before Milestone 2. No application code until you approve (CLAUDE.md).
