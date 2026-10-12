#!/usr/bin/env bash
# Creates the analytic store's tables in ANALYTICSPDB as the schema OWNER (a no-login account), then grants DML and
# creates synonyms for the application user. Idempotent; safe to run on every bootstrap (M9).
#
#   analytics/db-migrate.sh
#
# Connects as SYS inside the Oracle container (the connect line comes from stdin: no password in argv). The worker
# itself connects as the application user, which has no DDL rights.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
db_env="$root/db/.env.local"
oracle=spezi-poc-oracle
pdb=ANALYTICSPDB

fail() { echo "analytics/db-migrate: ERROR: $*" >&2; exit 1; }

[ -f "$db_env" ] || fail "credentials missing (run make stack-env)"
set -a; . "$db_env"; set +a
owner=${ANALYTICS_DB_OWNER:-analytics_owner}
app=${ANALYTICS_DB_USER:-analytics}
[ "$(docker inspect -f '{{.State.Health.Status}}' "$oracle" 2>/dev/null)" = "healthy" ] || fail "$oracle is not healthy (make stack-up)"

# The sql files take their arguments as &1/&2 (sqlplus positional); stdin has no argv, so substitute them here. The
# values are fixed account names, not input.
sub() { sed -e "s/&1/${owner}/g" -e "s/&2/${app}/g" "$1"; }

{
  echo "connect sys/${ORACLE_PWD}@localhost:1521/${pdb} as sysdba"
  sub "$root/analytics/sql/10-schema.sql" | grep -v '^exit;'
  sub "$root/db/sql/25-grants-and-synonyms.sql" | grep -v '^exit;'
  echo "exit"
} | docker exec -i "$oracle" sqlplus -S /nolog | grep -v '^$' | sed -e 's/^/analytics\/db-migrate: /'
echo "analytics/db-migrate: done"
