#!/usr/bin/env bash
# Live check of the web app's data path against the POC stack (M12 to M14): needs `make stack-up` and the CA. It
# reads, except that it ensures two synthetic status fixtures exist (a conditional create, as the capture user).
# The clinician's password is read from the git-ignored idp/.env.local into an environment variable; never printed.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
idp_env="$root/idp/.env.local"
[ -f "$idp_env" ] || { echo "web: idp/.env.local missing (make stack-env)" >&2; exit 1; }
pw=$(grep '^POC_CLINICIAN_USER_PASSWORD=' "$idp_env" | cut -d= -f2- || true)
[ -n "$pw" ] || { echo "web: POC_CLINICIAN_USER_PASSWORD missing from idp/.env.local" >&2; exit 1; }
cpw=$(grep '^POC_CAPTURE_USER_PASSWORD=' "$idp_env" | cut -d= -f2- || true)
[ -n "$cpw" ] || { echo "web: POC_CAPTURE_USER_PASSWORD missing from idp/.env.local" >&2; exit 1; }
ca="${POC_TLS_DIR:-$HOME/.poc-ca}/ca.crt"
[ -f "$ca" ] || { echo "web: CA certificate not found at $ca" >&2; exit 1; }
export POC_CLINICIAN_USER_PASSWORD="$pw" POC_CAPTURE_USER_PASSWORD="$cpw" NODE_EXTRA_CA_CERTS="$ca" POC_WEB_LIVE=1
unset pw cpw
"$root/scripts/check-node.sh"
cd "$root/web"
[ -d node_modules ] || npm ci --silent
exec npx vitest run test/live.test.ts
