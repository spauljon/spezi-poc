# Sourced by run.sh and live-test.sh: exports the credentials the worker needs from the git-ignored env files and
# trusts the POC CA. Secrets are only ever environment variables; nothing is printed.
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
db_env="$root/db/.env.local"
idp_env="$root/idp/.env.local"
[ -f "$db_env" ] && [ -f "$idp_env" ] || { echo "analytics: credentials missing (make stack-env)" >&2; return 1; }

pick() { grep "^$2=" "$1" | cut -d= -f2- || true; } # pick <file> <key>
ANALYTICS_DB_USER=$(pick "$db_env" ANALYTICS_DB_USER); : "${ANALYTICS_DB_USER:=analytics}"
ANALYTICS_DB_PASSWORD=$(pick "$db_env" ANALYTICS_DB_PASSWORD)
POC_WORKER_CLIENT_SECRET=$(pick "$idp_env" POC_WORKER_CLIENT_SECRET)
[ -n "$ANALYTICS_DB_PASSWORD" ] && [ -n "$POC_WORKER_CLIENT_SECRET" ] || { echo "analytics: a credential is missing from the env files" >&2; return 1; }
export ANALYTICS_DB_USER ANALYTICS_DB_PASSWORD POC_WORKER_CLIENT_SECRET

ca="${POC_TLS_DIR:-$HOME/.poc-ca}/ca.crt"
[ -f "$ca" ] || { echo "analytics: CA certificate not found at $ca" >&2; return 1; }
export NODE_EXTRA_CA_CERTS="$ca"
"$root/scripts/check-node.sh" || return 1
[ -d "$root/analytics/node_modules" ] || { echo "analytics: run 'npm ci' in analytics/ first" >&2; return 1; }
