#!/usr/bin/env bash
# Loads Keycloak's schema into KEYCLOAKPDB as its schema OWNER, so the runtime account needs no DDL rights (M3c).
# Idempotent: does nothing if the schema is already loaded. Safe to run on every bootstrap.
#
#   idp/db-migrate.sh                 load the schema if absent; always refresh the app user's grants
#   idp/db-migrate.sh --reset-schema  DROP the owner's objects first (Keycloak data is lost; the realm is code)
#
# How it works, and why (found by running it against Keycloak 26.8.0 on Oracle Free 23.26; see idp/README.md):
#   1. Keycloak's "manual" migration strategy writes the schema SQL instead of applying it, BUT it still creates
#      Liquibase's DATABASECHANGELOG table in the connecting user's schema. So the generation runs as a
#      THROWAWAY account (CREATE SESSION/TABLE/SEQUENCE, random password, dropped immediately). The runtime
#      application user never has DDL rights, and the owner never has a login.
#   2. Every name in the exported SQL is qualified with the throwaway account; one prefix rewrite points it at
#      the owner (checked: that string occurs only as an identifier prefix and in one comment).
#   3. The SQL is applied as SYS into the owner. Four statements are expected to fail and are tolerated by an
#      exact allowlist (CREATE INDEX only; ORA-00955 name in use, ORA-01408 column list already indexed): the
#      export omits Liquibase preconditions, which a live run would use to skip duplicate index creation.
#      Anything else fails the migration.
#   4. DATABASECHANGELOGLOCK is created by a live run only, so it is created here (definition copied from the
#      throwaway account's, via DBMS_METADATA).
#   5. One index that Keycloak's own startup checker expects is absent from the export; it is created explicitly.
#   6. The application user gets DML and synonyms from db/sql/25-grants-and-synonyms.sql.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
db_env="$root/db/.env.local"
idp_env="$root/idp/.env.local"
oracle=spezi-poc-oracle
net=spezi-poc_default
image=spezi-poc-keycloak:26.8.0-oracle
pdb=KEYCLOAKPDB
reset=false
[ "${1:-}" = "--reset-schema" ] && reset=true

log()  { echo "idp/db-migrate: $*"; }
fail() { echo "idp/db-migrate: ERROR: $*" >&2; exit 1; }

[ -f "$db_env" ] && [ -f "$idp_env" ] || fail "credentials missing (run make stack-env)"
set -a; . "$db_env"; set +a
owner=$(echo "${KEYCLOAK_DB_OWNER:-keycloak_owner}" | tr '[:lower:]' '[:upper:]')
app=$(echo "${KEYCLOAK_DB_USER:-keycloak}" | tr '[:lower:]' '[:upper:]')
gen=KC_GEN
[ "$(docker inspect -f '{{.State.Health.Status}}' "$oracle" 2>/dev/null)" = "healthy" ] || fail "$oracle is not healthy"

sq() { docker exec -i "$oracle" sqlplus -S /nolog; }   # the connect line comes from stdin: no password in argv
scalar() { # scalar <sql>: run a one-value query as SYS in the PDB, print the trimmed result
  { echo "connect sys/${ORACLE_PWD}@localhost:1521/${pdb} as sysdba"; echo "set heading off feedback off pagesize 0 verify off"; echo "$1"; echo "exit"; } | sq | tr -d '[:space:]'
}
run_sys() { # run_sys <<< sql : run statements as SYS in the PDB, failing on any error
  { echo "connect sys/${ORACLE_PWD}@localhost:1521/${pdb} as sysdba"; echo "whenever sqlerror exit failure rollback"; cat; echo "exit"; } | sq
}

tables=$(scalar "select count(*) from dba_tables where owner='${owner}';")
rows=0
if [ "$tables" != "0" ] && [ "$(scalar "select count(*) from dba_tables where owner='${owner}' and table_name='DATABASECHANGELOG';")" = "1" ]; then
  rows=$(scalar "select count(*) from ${owner}.databasechangelog;")
fi

if [ "$reset" = true ] && [ "$tables" != "0" ]; then
  log "--reset-schema: dropping all objects of ${owner}"
  run_sys <<EOF
drop user ${owner} cascade;
create user ${owner} no authentication default tablespace poc_keycloak_data temporary tablespace temp quota unlimited on poc_keycloak_data;
EOF
  tables=0; rows=0
fi

if [ "$tables" != "0" ] && [ "$rows" = "0" ]; then
  fail "${owner} has $tables table(s) but an empty changelog: a previous run stopped half way. Rerun with --reset-schema"
fi

if [ "$rows" != "0" ]; then
  # "Loaded" means the changelog AND the steps after it completed; a run that stopped between them must not pass.
  [ "$(scalar "select count(*) from dba_tables where owner='${owner}' and table_name='DATABASECHANGELOGLOCK';")" = "1" ] \
    || fail "${owner} has a changelog but no lock table: a previous run stopped half way. Rerun with --reset-schema"
  [ "$(scalar "select count(*) from dba_indexes where owner='${owner}' and index_name='IDX_ORG_DOMAIN_REALM';")" = "1" ] \
    || fail "${owner} lacks IDX_ORG_DOMAIN_REALM: a previous run stopped half way. Rerun with --reset-schema"
  log "schema already loaded ($rows changelog rows); refreshing grants only"
else
  [ -n "$(docker image ls -q "$image")" ] || fail "image $image not found (build it: scripts/compose.sh build keycloak)"
  tmp="$(mktemp -d)"; chmod 777 "$tmp"
  cleanup() {
    rm -rf "$tmp"
    # always remove the throwaway account, even if a step failed
    { echo "connect sys/${ORACLE_PWD}@localhost:1521/${pdb} as sysdba"; echo "set feedback off"; echo "begin execute immediate 'drop user ${gen} cascade'; exception when others then null; end;"; echo "/"; echo "exit"; } | sq > /dev/null 2>&1 || true
  }
  trap cleanup EXIT
  genpwd="G$(openssl rand -hex 12)"

  log "1/6 creating the throwaway generator account ${gen}"
  run_sys > /dev/null <<EOF
create user ${gen} identified by "${genpwd}" default tablespace poc_keycloak_data temporary tablespace temp quota unlimited on poc_keycloak_data;
grant create session, create table, create sequence to ${gen};
EOF

  log "2/6 running Keycloak (manual migration strategy) to export its schema SQL"
  # The password reaches the container through the environment of this one docker run only (never written).
  docker run --rm --network "$net" --user 1000 -v "$tmp":/export \
    -e KC_DB_URL="jdbc:oracle:thin:@//oracle:1521/${pdb}" -e KC_DB_USERNAME="$gen" -e KC_DB_PASSWORD="$genpwd" \
    "$image" start --optimized --http-enabled=true --hostname-strict=false \
    --spi-connections-jpa--quarkus--migration-strategy=manual \
    --spi-connections-jpa--quarkus--initialize-empty=false \
    --spi-connections-jpa--quarkus--migration-export=/export/keycloak-schema.sql > "$tmp/kc.log" 2>&1 || true
  [ -s "$tmp/keycloak-schema.sql" ] || { tail -20 "$tmp/kc.log" >&2; fail "Keycloak did not write the schema SQL"; }
  grep -q "Database not initialized" "$tmp/kc.log" || { tail -20 "$tmp/kc.log" >&2; fail "unexpected Keycloak output (expected 'Database not initialized')"; }

  log "3/6 reading the lock table definition, then dropping ${gen}"
  { echo "connect sys/${ORACLE_PWD}@localhost:1521/${pdb} as sysdba"
    cat <<'EOF'
set heading off feedback off pagesize 0 verify off long 100000 linesize 4000 trimspool on
begin
  dbms_metadata.set_transform_param(dbms_metadata.session_transform, 'SEGMENT_ATTRIBUTES', false);
  dbms_metadata.set_transform_param(dbms_metadata.session_transform, 'STORAGE', false);
  dbms_metadata.set_transform_param(dbms_metadata.session_transform, 'TABLESPACE', false);
  dbms_metadata.set_transform_param(dbms_metadata.session_transform, 'SQLTERMINATOR', true);
end;
/
select dbms_metadata.get_ddl('TABLE', 'DATABASECHANGELOGLOCK', 'KC_GEN') from dual;
exit
EOF
  } | sq | sed -e 's/"KC_GEN"/"'"${owner}"'"/g' | grep -v '^[[:space:]]*$' > "$tmp/lock.sql"
  grep -q "DATABASECHANGELOGLOCK" "$tmp/lock.sql" && grep -q "${owner}" "$tmp/lock.sql" || fail "could not read the lock table definition"
  run_sys > /dev/null <<EOF
drop user ${gen} cascade;
EOF

  log "4/6 applying the schema as ${owner} (expected: a few duplicate-index statements fail)"
  # Rewrite the throwaway account's identifier prefix to the owner's; refuse if it occurs in any other form.
  total=$(grep -o -i 'kc_gen' "$tmp/keycloak-schema.sql" | wc -l | tr -d ' ')
  prefixed=$(grep -o 'KC_GEN\.' "$tmp/keycloak-schema.sql" | wc -l | tr -d ' ')
  [ "$((total - prefixed))" -le 1 ] || fail "KC_GEN appears in other forms than 'KC_GEN.' ($total vs $prefixed); refusing to rewrite"
  sed 's/KC_GEN\./'"${owner}"'./g' "$tmp/keycloak-schema.sql" > "$tmp/schema.owner.sql"
  docker cp "$tmp/schema.owner.sql" "$oracle":/tmp/kc-schema.sql > /dev/null
  docker cp "$tmp/lock.sql" "$oracle":/tmp/kc-lock.sql > /dev/null
  { echo "connect sys/${ORACLE_PWD}@localhost:1521/${pdb} as sysdba"
    echo "set define off sqlblanklines on feedback off echo off termout off"
    echo "whenever sqlerror continue"
    echo "spool /tmp/kc-apply.log"
    echo "@/tmp/kc-schema.sql"
    echo "spool off"
    echo "exit"; } | sq > /dev/null 2>&1 || true
  docker cp "$oracle":/tmp/kc-apply.log "$tmp/apply.log" > /dev/null
  docker exec -u root "$oracle" rm -f /tmp/kc-schema.sql /tmp/kc-apply.log > /dev/null

  # Strict allowlist: every error must be ORA-00955 or ORA-01408 on a CREATE INDEX statement.
  bad=$(awk '
    { l4=l3; l3=l2; l2=l1; l1=$0 }
    # sqlplus prints: <statement> / <marker line "   *"> / "ERROR at line N:" / "ORA-nnnnn: ..."
    /^ORA-[0-9]+/ {
      split($1, c, ":"); code=c[1]
      stmt=l4
      if (!((code == "ORA-00955" || code == "ORA-01408") && stmt ~ /^CREATE INDEX /)) print code ": " substr(stmt, 1, 100)
    }
    /^SP2-[0-9]+/ { print $0 }' "$tmp/apply.log")
  [ -z "$bad" ] || { echo "$bad" >&2; fail "unexpected errors applying the schema (listed above); rerun with --reset-schema after fixing"; }
  tolerated=$(grep -c '^ORA-' "$tmp/apply.log" || true)
  log "     applied; tolerated $tolerated duplicate-index error(s)"
  rows=$(scalar "select count(*) from ${owner}.databasechangelog;")
  [ "$rows" -gt 0 ] || fail "changelog is empty after applying the schema"

  log "5/6 creating the lock table and the index the export omits"
  { echo "connect sys/${ORACLE_PWD}@localhost:1521/${pdb} as sysdba"
    echo "set define off feedback off"
    echo "whenever sqlerror exit failure rollback"
    echo "@/tmp/kc-lock.sql"
    echo "whenever sqlerror continue"
    echo "CREATE INDEX ${owner}.IDX_ORG_DOMAIN_REALM ON ${owner}.ORG_DOMAIN(REALM_ID);"
    echo "exit"; } | sq > /dev/null
  docker exec -u root "$oracle" rm -f /tmp/kc-lock.sql > /dev/null
  [ "$(scalar "select count(*) from dba_tables where owner='${owner}' and table_name='DATABASECHANGELOGLOCK';")" = "1" ] || fail "lock table was not created"
fi

log "6/6 grants and synonyms for ${app}"
docker cp "$root/db/sql/25-grants-and-synonyms.sql" "$oracle":/tmp/kc-25.sql > /dev/null
{ echo "connect sys/${ORACLE_PWD}@localhost:1521/${pdb} as sysdba"; echo "@/tmp/kc-25.sql ${owner} ${app}"; } | sq
docker exec -u root "$oracle" rm -f /tmp/kc-25.sql > /dev/null

log "done: ${owner} holds $(scalar "select count(*) from dba_tables where owner='${owner}';") tables, $(scalar "select count(*) from ${owner}.databasechangelog;") changelog rows"
