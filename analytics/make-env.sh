#!/usr/bin/env bash
# Generates the gitignored env files the analytics containers read (M13a). They hold ONLY the keys each service
# needs, copied from the credentials the other projects already generated, so a container never sees the Oracle SYS
# password or any other service's secrets:
#
#   analytics/.env.local       worker: ANALYTICS_DB_USER, ANALYTICS_DB_PASSWORD, POC_WORKER_CLIENT_SECRET
#   analytics/.env.api.local   API:    ANALYTICS_DB_USER, ANALYTICS_DB_PASSWORD
#
# Idempotent: rewritten from the sources on every run (values are never printed). Run after db/make-env.sh and
# idp/make-env.sh (make stack-env does).
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
db_env="$root/db/.env.local"
idp_env="$root/idp/.env.local"
[ -f "$db_env" ] && [ -f "$idp_env" ] || { echo "analytics/make-env: run db/make-env.sh and idp/make-env.sh first" >&2; exit 1; }

pick() { grep "^$2=" "$1" | cut -d= -f2- || true; } # pick <file> <key>
user="$(pick "$db_env" ANALYTICS_DB_USER)"; : "${user:=analytics}"
password="$(pick "$db_env" ANALYTICS_DB_PASSWORD)"
secret="$(pick "$idp_env" POC_WORKER_CLIENT_SECRET)"
[ -n "$password" ] && [ -n "$secret" ] || { echo "analytics/make-env: a source credential is missing" >&2; exit 1; }

umask 077
write() { # write <file> <KEY=value>...: replace the file atomically, mode 600
  local file="$1" tmp; shift
  tmp="$(mktemp "$file.XXXXXX")"
  printf '%s\n' "$@" > "$tmp"
  mv "$tmp" "$file"
}
write "$root/analytics/.env.local" "ANALYTICS_DB_USER=$user" "ANALYTICS_DB_PASSWORD=$password" "POC_WORKER_CLIENT_SECRET=$secret"
write "$root/analytics/.env.api.local" "ANALYTICS_DB_USER=$user" "ANALYTICS_DB_PASSWORD=$password"
echo "analytics/.env.local and analytics/.env.api.local written (values not shown; mode 600, gitignored)"
