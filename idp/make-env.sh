#!/usr/bin/env bash
# Generates the gitignored idp/.env.local. Idempotent: adds only the keys that are MISSING and never
# changes or prints an existing value, so it is safe to run on a file made by an earlier milestone.
# scripts/make-tls.sh adds KC_HTTPS_KEY_STORE_PASSWORD to the same file.
#
#   KC_BOOTSTRAP_ADMIN_*          Keycloak's first admin (the console is never published; admin work uses kcadm)
#   POC_WORKER_CLIENT_SECRET      secret of the analytics-worker client (client credentials)
#   POC_CAPTURE_USER_PASSWORD     password of the synthetic capture-user
#   POC_CLINICIAN_USER_PASSWORD   password of the synthetic clinician-user
#   KC_DB_USERNAME, KC_DB_PASSWORD  Keycloak's Oracle application account (value shared with db/.env.local)
# The POC_* values are read by Keycloak's realm import as ${ENV} placeholders (idp/realm/poc-realm.json).
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
env_file="${POC_IDP_ENV_FILE:-$root/idp/.env.local}"

umask 077
[ -e "$env_file" ] || : > "$env_file"
added=()
add() { # add <KEY> <value>: append only if KEY is absent
  if ! grep -q "^$1=" "$env_file"; then echo "$1=$2" >> "$env_file"; added+=("$1"); fi
}
gen() { printf 'P%s' "$(openssl rand -hex 16)"; }

add KC_BOOTSTRAP_ADMIN_USERNAME kcadmin
add KC_BOOTSTRAP_ADMIN_PASSWORD "$(gen)"
add POC_WORKER_CLIENT_SECRET "$(gen)"
add POC_CAPTURE_USER_PASSWORD "$(gen)"
add POC_CLINICIAN_USER_PASSWORD "$(gen)"

# Keycloak's database account (M3c). The password is the one db/make-env.sh generated for the Oracle user, so the
# account the init script creates and the one Keycloak logs in with are the same by construction.
db_env="$root/db/.env.local"
if [ -e "$db_env" ] && grep -q '^KEYCLOAK_DB_PASSWORD=' "$db_env"; then
  add KC_DB_USERNAME "$(grep '^KEYCLOAK_DB_USER=' "$db_env" | cut -d= -f2-)"
  add KC_DB_PASSWORD "$(grep '^KEYCLOAK_DB_PASSWORD=' "$db_env" | cut -d= -f2-)"
else
  echo "note: db/.env.local has no KEYCLOAK_DB_PASSWORD yet (run db/make-env.sh first); KC_DB_* not added" >&2
fi

if [ "${#added[@]}" -eq 0 ]; then
  echo "idp/.env.local is complete; nothing added."
else
  echo "idp/.env.local: added ${added[*]} (values not shown; mode 600, gitignored)"
fi
