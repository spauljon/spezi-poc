#!/usr/bin/env bash
# Prints an access token for the synthetic capture user (password grant, client poc-devtest) on stdout.
# Status goes to stderr, so `TOKEN=$(idp/capture-token.sh)` works. The password is read from the git-ignored
# idp/.env.local, never printed, and never put on a command line (it would show in `ps`).
#
# Overrides: POC_ISSUER_URL (default https://macpro16.local:8444/realms/poc), POC_TLS_DIR (default ~/.poc-ca).
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
env_file="$root/idp/.env.local"
issuer="${POC_ISSUER_URL:-https://macpro16.local:8444/realms/poc}"
ca="${POC_TLS_DIR:-$HOME/.poc-ca}/ca.crt"

[ -f "$env_file" ] || { echo "capture-token: $env_file not found (make stack-env)" >&2; exit 1; }
[ -f "$ca" ] || { echo "capture-token: CA certificate not found at $ca" >&2; exit 1; }
case "$issuer" in https://*) ;; *) echo "capture-token: the issuer must be an https URL" >&2; exit 1 ;; esac

password=$(grep '^POC_CAPTURE_USER_PASSWORD=' "$env_file" | head -n 1 | cut -d= -f2- | tr -d '\r' || true)
[ -n "$password" ] || { echo "capture-token: POC_CAPTURE_USER_PASSWORD is missing from $env_file" >&2; exit 1; }

umask 077
work=$(mktemp -d "${TMPDIR:-/tmp}/capture-token.XXXXXX")
trap 'rm -rf "$work"' EXIT
printf '%s' "$password" > "$work/password"
unset password

status=$(curl -sS --cacert "$ca" -o "$work/body.json" -w '%{http_code}' \
  -X POST "$issuer/protocol/openid-connect/token" \
  -d grant_type=password -d client_id=poc-devtest -d username=capture-user \
  --data-urlencode "password@$work/password") || {
  echo "capture-token: could not reach $issuer (certificate problem or stack down)" >&2
  exit 2
}

# One small Python call parses the JSON: no jq needed, and the token is not echoed anywhere but stdout.
python3 -I - "$status" "$work/body.json" <<'PY'
import json, sys
status, path = sys.argv[1], sys.argv[2]
try:
    body = json.load(open(path))
except Exception:
    print(f"capture-token: HTTP {status}, response was not JSON", file=sys.stderr)
    sys.exit(3)
if status != "200" or "access_token" not in body:
    print(f"capture-token: HTTP {status} {body.get('error', 'error')}: {body.get('error_description', '')}", file=sys.stderr)
    sys.exit(4)
print(f"capture-token: HTTP {status} ok", file=sys.stderr)
print(body["access_token"])
PY
