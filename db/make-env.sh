#!/usr/bin/env bash
# Generates gitignored local credentials for the POC stack. Never overwrites existing files.
# Values are random and never printed. Writes db/.env.local and hapi/.env.local.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
db_env="$root/db/.env.local"
hapi_env="$root/hapi/.env.local"

# A letter first, then hex: satisfies Oracle's password rules without special characters.
gen() { printf 'P%s' "$(openssl rand -hex 12)"; }

if [ -e "$db_env" ] || [ -e "$hapi_env" ]; then
  echo "env files already exist; existing values are left untouched:"
  [ -e "$db_env" ] && echo "  db/.env.local"
  [ -e "$hapi_env" ] && echo "  hapi/.env.local"
  # M3c added Keycloak's database account: append only the keys that are MISSING (never change or print a value).
  if [ -e "$db_env" ]; then
    added=()
    add() { if ! grep -q "^$1=" "$db_env"; then echo "$1=$2" >> "$db_env"; added+=("$1"); fi; }
    add KEYCLOAK_DB_OWNER keycloak_owner
    add KEYCLOAK_DB_USER keycloak
    add KEYCLOAK_DB_PASSWORD "$(gen)"
    [ "${#added[@]}" -eq 0 ] || echo "db/.env.local: added ${added[*]} (values not shown)"
  fi
  exit 0
fi

fhir_user=hapi
fhir_pwd=$(gen)

umask 077
cat > "$db_env" <<EOF
ORACLE_PWD=$(gen)
PDB_ADMIN_PASSWORD=$(gen)
FHIR_DB_OWNER=hapi_owner
FHIR_DB_USER=$fhir_user
FHIR_DB_PASSWORD=$fhir_pwd
ANALYTICS_DB_OWNER=analytics_owner
ANALYTICS_DB_USER=analytics
ANALYTICS_DB_PASSWORD=$(gen)
KEYCLOAK_DB_OWNER=keycloak_owner
KEYCLOAK_DB_USER=keycloak
KEYCLOAK_DB_PASSWORD=$(gen)
EOF

cat > "$hapi_env" <<EOF
DB_USER=$fhir_user
DB_PASSWORD=$fhir_pwd
EOF

echo "created db/.env.local and hapi/.env.local (mode 600, gitignored; values not shown)"
