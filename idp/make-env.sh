#!/usr/bin/env bash
# Generates the gitignored idp/.env.local (Keycloak bootstrap admin). Never overwrites an existing file.
# Values are random and never printed. scripts/make-tls.sh later adds KC_HTTPS_KEY_STORE_PASSWORD,
# and M3b adds realm secrets, to the same file.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
env_file="${POC_IDP_ENV_FILE:-$root/idp/.env.local}"

if [ -e "$env_file" ]; then
  echo "idp/.env.local already exists; leaving it untouched."
  exit 0
fi

umask 077
cat > "$env_file" <<EOT
KC_BOOTSTRAP_ADMIN_USERNAME=kcadmin
KC_BOOTSTRAP_ADMIN_PASSWORD=P$(openssl rand -hex 16)
EOT
echo "created idp/.env.local (mode 600, gitignored; values not shown)"
