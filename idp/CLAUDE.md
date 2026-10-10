# idp/ — identity provider

Follow the root [CLAUDE.md](../CLAUDE.md) (data rules, isolation, portability and test honesty, milestone workflow).

- Stack: Keycloak 26.8.0 pinned by digest in `keycloak/Dockerfile` (plus the checksum-verified Oracle JDBC jars), behind an nginx allowlist proxy (`nginx:alpine` pinned by digest, already local). Data lives in `KEYCLOAKPDB` on the POC Oracle (M3c).
- The Keycloak container, its admin console, `/realms/master/`, `/metrics`, `/health` and its management port are never published. Only the proxy publishes (8444, TLS only).
- Any change to `nginx/nginx.conf` must be re-tested with the encoded and dot-segment path cases (see the plan's M3a verify); a path-normalization bypass of admin blocking has happened before.
- Credentials and keystore passwords live only in the gitignored `.env.local`; never in committed files, logs, or conversation.
- The realm is code: `realm/poc-realm.json`, with `${ENV}` placeholders for every secret (generated into `.env.local` by `make-env.sh`). Keycloak silently ignores attributes it does not recognize, so every security property in the realm is verified by behavior in `oidc.py check`, never by the import succeeding. Keycloak skips the import if the realm already exists: change the template, then `idp/db-migrate.sh --reset-schema` and restart Keycloak.
- Database: Keycloak connects as the app user `keycloak` (`CREATE SESSION` + DML) and never runs DDL; the schema is loaded as `keycloak_owner` by `db-migrate.sh`. Keep `--db-schema` in UPPER case. Do not give the app user DDL rights to make a startup error go away: fix the migration instead.
- Commit prefix: `idp:`. Milestones: M3a, M3b, M3c (plus `db:` for the PDB and init changes).
