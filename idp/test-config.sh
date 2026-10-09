#!/usr/bin/env bash
# Static check of the IdP proxy config: `nginx -t` with the PINNED nginx image, using the real
# certificates. Never pulls (--pull never): if the image or the certificates are missing it says so
# and SKIPs loudly instead of passing.
set -uo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tls="${POC_TLS_DIR:-$HOME/.poc-ca}"
img="nginx@sha256:4a73073bd557c65b759505da037898b61f1be6cbcc3c2c3aeac22d2a470c1752"

command -v docker >/dev/null 2>&1 || { echo "idp: SKIP nginx -t (docker not on PATH)"; exit 0; }
docker info >/dev/null 2>&1       || { echo "idp: SKIP nginx -t (Docker daemon is not running)"; exit 0; }
docker image inspect "$img" >/dev/null 2>&1 || { echo "idp: SKIP nginx -t (pinned nginx image is not local; this check never pulls)"; exit 0; }
for f in idp/edge.crt idp/edge.key ca.crt; do
  [ -f "$tls/$f" ] || { echo "idp: SKIP nginx -t ($tls/$f missing; run make tls)"; exit 0; }
done

out=$(docker run --rm --pull never \
  -v "$root/idp/nginx/nginx.conf":/etc/nginx/nginx.conf:ro \
  -v "$tls/idp/edge.crt":/etc/nginx/tls/edge.crt:ro \
  -v "$tls/idp/edge.key":/etc/nginx/tls/edge.key:ro \
  -v "$tls/ca.crt":/etc/nginx/tls/ca.crt:ro \
  "$img" nginx -t 2>&1)
if echo "$out" | grep -q "test is successful"; then echo "idp: nginx config ok (nginx -t)"; else echo "idp: nginx -t FAILED"; echo "$out" | grep -E "emerg|failed" | sed 's/^/    /'; exit 1; fi
