# Identity provider (idp/)

Keycloak (pinned `26.8.0`) behind an nginx path-allowlist proxy, for the POC. Planned in [docs/implementation-plan.md](../docs/implementation-plan.md) (M3a, M3b, M3c); research and what is still unverified: [docs/planning/keycloak-notes.md](../docs/planning/keycloak-notes.md).

## Shape

| Piece | Role | Reachable from |
|---|---|---|
| `idp-edge` (nginx) | terminates TLS on `https://macpro16.local:8444`, allows only the public OIDC paths, re-encrypts to Keycloak | the network (TLS only) |
| `keycloak` | the identity provider; HTTPS with its own certificate | the compose network only. **Never published** |

Keycloak has no built-in way to restrict its admin console, so the proxy is the control: only `/realms/poc/`, `/resources/` and `/.well-known/` pass; `/admin/`, `/realms/master/`, `/metrics`, `/health` and everything else get 404, and any request with `..`, `;`, `//` or an encoded slash, dot or backslash gets 400. Admin tasks run inside the container with `kcadm.sh`; nothing is published for them.

## Files

| File | Role |
|---|---|
| `nginx/nginx.conf` | the allowlist proxy |
| `keycloak/Dockerfile` | Keycloak 26.8.0 (digest-pinned) plus the Oracle JDBC driver, `kc.sh build` (M3c); the two jars are checksum-verified at build time |
| `db-migrate.sh` | loads Keycloak's schema into `KEYCLOAKPDB` as its schema owner; idempotent; run by the bootstrap before Keycloak starts (M3c) |
| `make-env.sh` | generates the gitignored `.env.local` (bootstrap admin, realm secrets, Keycloak's database account) |
| `verify-allowlist.sh` | tests the proxy: blocked paths denied by the edge (marked `X-Edge-Denied`), allowed paths pass, encoding tricks blocked; fails if the proxy is not up |
| `realm/poc-realm.json` | the `poc` realm as code: 3 roles, 4 clients, 3 users; secrets are `${ENV}` placeholders |
| `oidc.py` | `token worker\|capture\|clinician` prints a decoded token (claims only; `--raw` for the token); `check` runs the realm's security checks |
| `test-config.sh` | `nginx -t` with the pinned image (never pulls; SKIPs loudly if it cannot run) |
| `.env.local` | gitignored: bootstrap admin password, `KC_DB_USERNAME`/`KC_DB_PASSWORD`, realm secrets, `KC_HTTPS_KEY_STORE_PASSWORD` (added by `scripts/make-tls.sh`) |

Certificates (own key for each service, all from the name-constrained CA) are made by `scripts/make-tls.sh` into `~/.poc-ca/idp/`, outside the repo.

## Running it

The IdP services are part of the normal stack: `make stack-up` starts them (the first run pulls the pinned Keycloak base image, about 264 MB compressed, 750 MB on disk, and builds the Oracle-enabled image on top) and `make stack-verify` checks them. The image is pinned by tag and digest in `compose.yaml`.

## Database (M3c): KEYCLOAKPDB on the POC Oracle

Keycloak keeps its data in its own pluggable database, with the same owner/app split as HAPI:

| Account | Can log in | Rights | Holds |
|---|---|---|---|
| `keycloak_owner` | no (`NO AUTHENTICATION`) | none | all 101 tables, 295 indexes |
| `keycloak` (what Keycloak connects as) | yes | `CREATE SESSION`; `SELECT/INSERT/UPDATE/DELETE` on the owner's tables; synonyms | nothing |

Keycloak runs with `--db-schema=KEYCLOAK_OWNER` (**upper case: see below**), `--db-pool-max-size=10`, and the manual migration strategy with `initialize-empty=false`, so it can never alter the schema. The image is built once (`idp/keycloak/Dockerfile`): the Oracle driver (`ojdbc17` and `orai18n` 23.26.2.0.0, the versions Keycloak's DB guide names, Oracle Free Use Terms) is fetched from Maven Central and verified against the SHA-256 checksums Maven Central publishes; `ADD --checksum` fails the build on any mismatch.

### How the schema gets there, and what was found by doing it

`idp/db-migrate.sh` (run by the bootstrap between Oracle and Keycloak; idempotent):

1. **A throwaway account is needed, because "manual" is not DDL-free.** In manual mode Keycloak writes the schema SQL instead of applying it, but Liquibase still creates its `DATABASECHANGELOG` table in the connecting user's schema, so a no-DDL user fails with ORA-01031 before anything is exported. The script therefore creates a random-password `KC_GEN` account for the export and drops it at once (an exit trap drops it even on failure). The runtime user never has DDL rights and the owner never has a login.
2. **One prefix rewrite.** Every name in the export is qualified with the generating account (`KC_GEN.`), so `current_schema` alone cannot redirect it; the script rewrites that one prefix to `KEYCLOAK_OWNER.` after checking it occurs in no other form.
3. **Applied as SYS into the owner; four statements fail, by design, and are tolerated by an exact allowlist** (`CREATE INDEX` only; ORA-00955 or ORA-01408). The export omits Liquibase preconditions, which a live run uses to skip duplicate index creation. Anything else fails the migration. Mutation-tested: not tolerating ORA-01408 makes the script refuse.
4. **The lock table is missing from the export** (only a live run creates it), so the script creates it from the throwaway account's definition. Without it Keycloak fails to start with ORA-01031 on `CREATE TABLE DATABASECHANGELOGLOCK`.
5. **One index is missing from the export:** `IDX_ORG_DOMAIN_REALM` (Organizations feature; performance only), found because Keycloak's own startup index checker reports it. The script creates it.
6. **`IDX_OFFLINE_CSS_BY_CLIENT` is a known duplicate** of `IDX_OFFLINE_CSS_PRELOAD` (same columns; Oracle refuses a second index, ORA-01408), so Keycloak's checker keeps warning about it by name. `make stack-verify` expects exactly that one warning.

**`--db-schema` must be upper case.** With `keycloak_owner` in lower case Keycloak worked but its index checker reported ~125 existing indexes as missing: Oracle's JDBC metadata calls are case-sensitive, while Liquibase and Hibernate quote names. Upper case brought it to the one known duplicate.

**Unverified / accepted:** the Oracle privileges Keycloak needs are not documented; these were found by trial and are exactly `CREATE SESSION` plus DML (no sequences are used, so none are granted). A Keycloak upgrade may add tables or indexes: rerun `idp/db-migrate.sh --reset-schema` to regenerate (the realm is code, so nothing is lost), then check that `make stack-verify` still passes. The HAPI→Oracle and Keycloak→Oracle hops are cleartext on the private Compose network (accepted POC gap, as for HAPI).

## Admin tasks (nothing is published, so no browser console)

`kcadm.sh` runs inside the container. The cluster's own name resolves to loopback there (`extra_hosts`), so the certificate name verifies, and the CA is trusted through the bundled keystore. The password comes from the container's environment and is never typed or printed:

```bash
docker exec spezi-poc-keycloak bash -c '/opt/keycloak/bin/kcadm.sh config credentials --config /tmp/kcadm.config \
  --server https://macpro16.local:8443 --realm master --user "$KC_BOOTSTRAP_ADMIN_USERNAME" --password "$KC_BOOTSTRAP_ADMIN_PASSWORD" \
  --truststore /opt/keycloak/tls/keycloak.p12 --trustpass "$KC_HTTPS_KEY_STORE_PASSWORD"'
docker exec spezi-poc-keycloak bash -c '/opt/keycloak/bin/kcadm.sh get realms --config /tmp/kcadm.config \
  --truststore /opt/keycloak/tls/keycloak.p12 --trustpass "$KC_HTTPS_KEY_STORE_PASSWORD" --fields realm,enabled'
```

(The truststore flags are needed on every command; the config file lives in the container's `/tmp`.)

## Trusting the CA on a phone (iPhone)

The CA certificate is `~/.poc-ca/ca.crt` (public; its key never leaves the Mac). It is name-constrained to `macpro16.local`. AirDrop it to the phone, open it and install the profile (Settings > Profile Downloaded), then enable full trust: Settings > General > About > Certificate Trust Settings > "Spezi POC Local CA". Test in a **new Private Browsing tab** (an old tab can hold a remembered exception): `https://macpro16.local:8444/ping` should show a large "IdP edge reachable" page with no warning.

Two gotchas learned the hard way (2026-10-09):
- Installing the profile is not enough. **Certificate Trust Settings must also be switched on** for "Spezi POC Local CA"; until then Safari shows "This Connection Is Not Private", and tapping through it only stores an exception.
- The server cannot see whether the client verified the certificate. To check from the Mac, set the proxy's `error_log` to `info` and look for `tlsv1 alert unknown ca` (alert 48): a rejection means the CA is not trusted. The log also records the User-Agent (Docker Desktop hides client addresses behind `172.18.0.1`), so an iPhone request is recognizable.

A phone may reach the Mac over IPv6 link-local (`fe80::`) and never use IPv4; the published port serves both. The macOS firewall was disabled here, so it was not a factor; if the page does not load at all, check it.

## The `poc` realm

Imported from `realm/poc-realm.json` at the first start on an empty database (`--import-realm`; an existing realm is skipped, so a changed file has no effect until the realm is recreated: `idp/db-migrate.sh --reset-schema` drops Keycloak's tables and reloads them empty, then restart Keycloak; `make stack-reset` erases all of Oracle).

| Client | Kind | Used by | Grant |
|---|---|---|---|
| `ios-capture` | public, PKCE S256 required | the iOS capture app (M5, M8) | authorization code; `offline_access` allowed. Redirect `com.blueysoft.spezipoc:/oauth2redirect` |
| `clinician-web` | public, PKCE S256 required | the web app (M12) | authorization code. Redirect `https://macpro16.local:3000/*` (placeholder origin, revisit in M12) |
| `analytics-worker` | confidential | the aggregation worker (M9) | client credentials only; its service account holds `worker-reader` |
| `poc-devtest` | public | scripts only (`oidc.py`), **never the apps** | password grant, so a user token can be fetched without a browser |

| User (synthetic) | Realm role |
|---|---|
| `capture-user` | `capture-writer` |
| `clinician-user` | `clinician-reader` |
| `service-account-analytics-worker` | `worker-reader` |

Every client's access token carries `aud` = `hapi-fhir` and a flat `roles` claim (the user's realm roles). HAPI checks both in M4.

| Setting | Value | Why |
|---|---|---|
| Access token lifetime | 10 minutes | HAPI checks `exp` on every call, so a stolen token expires quickly |
| SSO session idle / max | 14 days / 30 days | the phone can be offline for days and still refresh |
| Offline sessions | 30 days idle, `offline_access` for `ios-capture` only | the capture queue syncs in the background without the user signing in again |
| Authorization code | 60 seconds | |
| Brute force | on: 5 failures, then a wait up to 15 minutes | |
| `sslRequired` | `all` | no plain-HTTP token endpoint, even locally |

Secrets (`POC_WORKER_CLIENT_SECRET`, the two user passwords) are generated into the gitignored `.env.local` and substituted into the template at import; they appear in no log and no tracked file (checked). `python3 idp/oidc.py check` verifies the properties by behavior: issuer and endpoints use the public URL; the roles, audience and lifetime of each token; a wrong secret, an unknown user, the password grant and client credentials on the public clients are all refused; an authorization request without PKCE, or with `plain`, is refused; a foreign redirect URI is refused; and the master realm and admin console stay closed. The PKCE check was mutation-tested: with the attribute removed from `ios-capture`, exactly the two PKCE checks fail.
