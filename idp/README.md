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
| `make-env.sh` | generates the gitignored `.env.local` (bootstrap admin) |
| `verify-allowlist.sh` | tests the proxy: blocked paths denied by the edge (marked `X-Edge-Denied`), allowed paths pass, encoding tricks blocked; fails if the proxy is not up |
| `realm/poc-realm.json` | the `poc` realm as code: 3 roles, 4 clients, 3 users; secrets are `${ENV}` placeholders |
| `oidc.py` | `token worker\|capture\|clinician` prints a decoded token (claims only; `--raw` for the token); `check` runs the realm's security checks |
| `test-config.sh` | `nginx -t` with the pinned image (never pulls; SKIPs loudly if it cannot run) |
| `.env.local` | gitignored: bootstrap admin password, `KC_HTTPS_KEY_STORE_PASSWORD` (added by `scripts/make-tls.sh`) |

Certificates (own key for each service, all from the name-constrained CA) are made by `scripts/make-tls.sh` into `~/.poc-ca/idp/`, outside the repo.

## Running it

The IdP services are part of the normal stack: `make stack-up` starts them (the first run pulls the pinned Keycloak image, about 264 MB compressed, 750 MB on disk) and `make stack-verify` checks them. The image is pinned by tag and digest in `compose.yaml`.

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

Imported from `realm/poc-realm.json` at the first start with an empty Keycloak volume (`--import-realm`; an existing realm is skipped, so change the file and recreate the volume: `make stack-reset`, or remove only `spezi-poc_keycloak_data`).

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
