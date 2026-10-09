# Keycloak setup notes (research for M3)

Researched 2026-10-09. **Nothing was pulled or installed**: only Keycloak's documentation and Quay's public metadata API were read. "Verified" below means read in a primary source on that date; "Unverified" means from memory or secondary sources and must be tested before relying on it.

## Image

| Fact | Value | Source |
|---|---|---|
| Image | `quay.io/keycloak/keycloak` | [containers guide](https://www.keycloak.org/server/containers) |
| Newest release | **26.8.0**, tagged 2026-10-01 (downloads page agrees) | [Quay tags API](https://quay.io/api/v1/repository/keycloak/keycloak/tag/?limit=30&onlyActiveTags=true), [downloads](https://www.keycloak.org/downloads) |
| Previous line, latest patch | 26.7.5, tagged 2026-09-30 | Quay tags API |
| Tag forms | `26.8.0`, `26.8.0-0` (rebuild suffix), `26.8`, `latest`, `nightly` | Quay tags API |
| Index digest of `26.8.0` | `sha256:b0f60d489d51c5d113390bdf5461d4c06e6051be026c05549f2e1e10ec352bcc` | Quay tags API |
| Platforms | linux/**arm64**, linux/**amd64**, linux/ppc64le | Quay manifest API |
| arm64 download size | about **264 MB** compressed (3 content layers) | Quay manifest API |
| Base / user / entrypoint | UBI 9 micro, `USER 1000`, `ENTRYPOINT ["/opt/keycloak/bin/kc.sh"]` | Quay manifest API |
| Support model | No LTS line; only the newest line receives fixes | secondary ([Skycloak](https://skycloak.io/blog/keycloak-25-released-new-features-and-enhancements/)); unverified against keycloak.org |

## Running it (verified from the docs)

- **Production mode** `start` serves HTTPS only (container port 8443) and needs a hostname and a certificate. `start-dev` is "strictly avoid in production" (insecure defaults). A plain `start` runs the build step at startup (slower, mutable image); the recommended shape is `kc.sh build` in an image, then `start --optimized` ([containers](https://www.keycloak.org/server/containers)).
- **TLS** ([enabletls](https://www.keycloak.org/server/enabletls)): PEM via `--https-certificate-file` and `--https-certificate-key-file` (`KC_HTTPS_CERTIFICATE_FILE`, `KC_HTTPS_CERTIFICATE_KEY_FILE`), or a keystore via `--https-key-store-file`, `--https-key-store-password`, `--https-key-store-type`. PEM wins if both are set. `--https-protocols` defaults to `TLSv1.3,TLSv1.2`. `--http-enabled` defaults to `false` in production mode.
- **Hostname** ([hostname](https://www.keycloak.org/server/hostname); the page was served from the nightly 26.8.0 docs, which matches the newest release): `--hostname=https://macpro16.local:8444` (a full URL), optional `--hostname-admin`, `--hostname-strict` (default `true`), `--hostname-backchannel-dynamic`. These change generated URLs, not the ports Keycloak listens on.
- **Management interface** ([doc](https://www.keycloak.org/server/management-interface)): health and metrics move to a separate port, default **9000** (`--http-management-port`, `--http-management-host`, `--http-management-scheme` = `inherited` or `http`). Keep it unpublished.
- **First admin** (containers guide): `KC_BOOTSTRAP_ADMIN_USERNAME` and `KC_BOOTSTRAP_ADMIN_PASSWORD`.
- **Memory** (containers guide): heap defaults to 70% of the container memory limit (`MaxRAMPercentage=70`); always set a limit; at least 750 MB, 2 GB suggested for a small production deployment.
- **Realm as code** ([import/export](https://www.keycloak.org/server/importExport)): `--import-realm` reads `/opt/keycloak/data/import/<realm>-realm.json`; `${ENV_VAR}` placeholders are supported (any environment variable can be referenced, so keep secrets out of the container environment unless needed); **an existing realm is skipped** on later starts, so editing the file changes nothing until the realm is recreated or a partial import / config tool is used.
- **Database** ([db](https://www.keycloak.org/server/db)): default is `dev-file` (H2), documented as deprecated in production mode and "not suitable for production"; the page does not say whether production mode refuses to start with it. Oracle is supported, but **the Oracle JDBC driver is not bundled** (`ojdbc17` and `orai18n` jars must be added to a custom image).

## The admin console cannot be restricted by Keycloak itself

Per the [reverse proxy guide](https://www.keycloak.org/server/reverseproxy): expose only `/realms/` (but not `/realms/master/`), `/resources/` and `/.well-known/`; keep `/admin/`, `/realms/master/`, `/metrics`, `/health` and port 9000 internal. There is no built-in IP restriction and (per searches) no supported switch to turn the console off; `--hostname-admin` only changes URLs. Enforcement is at a proxy or network layer. A path-normalization bypass of `/admin` blocking existed (CVE-2025-10939, fixed in 26.4.4 per a secondary source), so proxy rules need testing, not assuming.

## Unverified (test or export before relying on it)

- Whether `start` with the default `dev-file` database starts cleanly (deprecation warning vs refusal).
- The realm-JSON shape for: a public client with PKCE (I believe `"publicClient": true` and a client attribute `pkce.code.challenge.method` = `S256`), a confidential client-credentials client, realm roles, the roles/audience protocol mappers, and test users. Plan: create once in the console and export, or test the import.
- How to health-check the container (the UBI micro image probably has no `curl`; a `bash` `/dev/tcp` probe against the management port is the likely approach).
- Whether `--http-management-host` can bind the management port to the container loopback.
- Brute-force protection defaults on the `master` realm.
