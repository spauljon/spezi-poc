# idp/ — identity provider

Follow the root [CLAUDE.md](../CLAUDE.md) (data rules, isolation, portability and test honesty, milestone workflow).

- Stack: Keycloak pinned by tag and digest, behind an nginx allowlist proxy (`nginx:alpine` pinned by digest, already local).
- The Keycloak container, its admin console, `/realms/master/`, `/metrics`, `/health` and its management port are never published. Only the proxy publishes (8444, TLS only).
- Any change to `nginx/nginx.conf` must be re-tested with the encoded and dot-segment path cases (see the plan's M3a verify); a path-normalization bypass of admin blocking has happened before.
- Credentials and keystore passwords live only in the gitignored `.env.local`; never in committed files, logs, or conversation.
- The realm is code: `realm/poc-realm.json`, with `${ENV}` placeholders for every secret (generated into `.env.local` by `make-env.sh`). Keycloak silently ignores attributes it does not recognize, so every security property in the realm is verified by behavior in `oidc.py check`, never by the import succeeding. Keycloak skips the import if the realm already exists: change the template, then recreate the Keycloak volume.
- Commit prefix: `idp:`. Milestones: M3a, M3b, M3c.
