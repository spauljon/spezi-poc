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
