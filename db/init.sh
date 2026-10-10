#!/usr/bin/env bash
# Creates the FHIR, analytics and Keycloak PDBs, their users, and (once) the HAPI schema.
# Runs inside the oracle-init service (see compose.yaml). Idempotent: existing PDBs and
# users are skipped. (Ran cleanly on 2026-10-08; the owner/app split, grants and synonyms are newer and unverified on a fresh DB.)
set -euo pipefail

: "${ORACLE_PWD:?ORACLE_PWD is not set (run make stack-env)}"
: "${PDB_ADMIN_PASSWORD:?}" "${FHIR_DB_USER:?}" "${FHIR_DB_PASSWORD:?}"
: "${ANALYTICS_DB_USER:?}" "${ANALYTICS_DB_PASSWORD:?}"
: "${KEYCLOAK_DB_USER:?}" "${KEYCLOAK_DB_PASSWORD:?}"

host=oracle
sql_dir=/opt/poc/db/sql
schema_ddl=/opt/poc/hapi-schema/oracle.sql
temp_ddl=/opt/poc/hapi-schema/oracle-temp-tables.sql
fhir_pdb=FHIRPDB
analytics_pdb=ANALYTICSPDB
keycloak_pdb=KEYCLOAKPDB
# Schema owners (no login) hold the objects; FHIR_DB_USER/ANALYTICS_DB_USER are the application users.
fhir_owner=${FHIR_DB_OWNER:-hapi_owner}
analytics_owner=${ANALYTICS_DB_OWNER:-analytics_owner}
keycloak_owner=${KEYCLOAK_DB_OWNER:-keycloak_owner}

cdb_conn="sys/${ORACLE_PWD}@${host}:1521/FREE as sysdba"
pdb_conn() { echo "sys/${ORACLE_PWD}@${host}:1521/$1 as sysdba"; }

scalar() { # scalar <conn> <sql>: run a one-value query, print the trimmed result
  sqlplus -S "$1" <<EOF | tr -d '[:space:]'
set heading off feedback off pagesize 0 verify off
$2
exit;
EOF
}

ensure_pdb() {
  local name=$1
  if [ "$(scalar "$cdb_conn" "select count(*) from v\$pdbs where name = '${name}';")" = "1" ]; then
    echo "PDB ${name} already exists, skipping."
  else
    echo "Creating PDB ${name} ..."
    sqlplus -S "$cdb_conn" @"${sql_dir}/10-create-pdb.sql" "${name}" "${PDB_ADMIN_PASSWORD}"
  fi
}

user_exists() { # user_exists <pdb> <user>
  local u; u=$(echo "$2" | tr '[:lower:]' '[:upper:]')
  [ "$(scalar "$(pdb_conn "$1")" "select count(*) from dba_users where username = '${u}';")" = "1" ]
}

ensure_pdb "$fhir_pdb"
ensure_pdb "$analytics_pdb"
ensure_pdb "$keycloak_pdb"

if user_exists "$fhir_pdb" "$fhir_owner"; then
  echo "Owner ${fhir_owner} already exists in ${fhir_pdb}, skipping users and HAPI schema."
else
  echo "Creating owner ${fhir_owner} and application user ${FHIR_DB_USER} in ${fhir_pdb}, loading the HAPI schema ..."
  sqlplus -S "$(pdb_conn "$fhir_pdb")" @"${sql_dir}/20-fhir-user.sql" "${fhir_owner}" "${FHIR_DB_USER}" "${FHIR_DB_PASSWORD}" "${schema_ddl}" "${temp_ddl}"
fi
# Idempotent: refreshes grants and synonyms every time (cheap), e.g. after a HAPI upgrade adds objects.
sqlplus -S "$(pdb_conn "$fhir_pdb")" @"${sql_dir}/25-grants-and-synonyms.sql" "${fhir_owner}" "${FHIR_DB_USER}"

if user_exists "$analytics_pdb" "$analytics_owner"; then
  echo "Owner ${analytics_owner} already exists in ${analytics_pdb}, skipping users."
else
  echo "Creating owner ${analytics_owner} and application user ${ANALYTICS_DB_USER} in ${analytics_pdb} ..."
  sqlplus -S "$(pdb_conn "$analytics_pdb")" @"${sql_dir}/30-analytics-user.sql" "${analytics_owner}" "${ANALYTICS_DB_USER}" "${ANALYTICS_DB_PASSWORD}"
fi
sqlplus -S "$(pdb_conn "$analytics_pdb")" @"${sql_dir}/25-grants-and-synonyms.sql" "${analytics_owner}" "${ANALYTICS_DB_USER}"

if user_exists "$keycloak_pdb" "$keycloak_owner"; then
  echo "Owner ${keycloak_owner} already exists in ${keycloak_pdb}, skipping users."
else
  echo "Creating owner ${keycloak_owner} and application user ${KEYCLOAK_DB_USER} in ${keycloak_pdb} ..."
  sqlplus -S "$(pdb_conn "$keycloak_pdb")" @"${sql_dir}/40-keycloak-user.sql" "${keycloak_owner}" "${KEYCLOAK_DB_USER}" "${KEYCLOAK_DB_PASSWORD}"
fi
# The owner has no objects until idp/db-migrate.sh loads Keycloak's schema; rerun this script's grants then
# (it is idempotent) with: scripts/compose.sh --profile initialize run --rm oracle-init (see idp/db-migrate.sh).
sqlplus -S "$(pdb_conn "$keycloak_pdb")" @"${sql_dir}/25-grants-and-synonyms.sql" "${keycloak_owner}" "${KEYCLOAK_DB_USER}"

echo "Initialization complete."
