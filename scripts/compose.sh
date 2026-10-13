#!/usr/bin/env bash
# Deploys to the POC compose project explicitly: every docker compose call goes through here.
# Mirrors the governance project's bin/compose.sh (-p <project> -f <file>).
set -eo pipefail

run_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# The analytics and web containers run as the invoking user so 0600 TLS keys on bind mounts are readable without
# loosening their mode (the same on macOS and Linux).
export POC_UID="${POC_UID:-$(id -u)}" POC_GID="${POC_GID:-$(id -g)}"

exec docker compose -p spezi-poc -f "$run_dir/compose.yaml" "$@"
