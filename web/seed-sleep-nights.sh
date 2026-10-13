#!/usr/bin/env bash
# Seeds a few known synthetic sleep nights for the sleep view: `make web-seed-sleep-nights`.
# Synthetic only; idempotent. The capture user's password is read from the git-ignored idp/.env.local into an
# environment variable and never printed.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
idp_env="$root/idp/.env.local"
[ -f "$idp_env" ] || { echo "web: idp/.env.local missing (make stack-env)" >&2; exit 1; }
cpw=$(grep '^POC_CAPTURE_USER_PASSWORD=' "$idp_env" | cut -d= -f2- || true)
[ -n "$cpw" ] || { echo "web: POC_CAPTURE_USER_PASSWORD missing from idp/.env.local" >&2; exit 1; }
ca="${POC_TLS_DIR:-$HOME/.poc-ca}/ca.crt"
[ -f "$ca" ] || { echo "web: CA certificate not found at $ca" >&2; exit 1; }
export POC_CAPTURE_USER_PASSWORD="$cpw" NODE_EXTRA_CA_CERTS="$ca"
unset cpw
"$root/scripts/check-node.sh"
exec node "$root/web/tools/seed-sleep-nights.mjs"
