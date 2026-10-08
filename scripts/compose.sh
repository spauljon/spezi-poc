#!/bin/bash
# Deploys to the POC compose project explicitly: every docker compose call goes through here.
# Mirrors the governance project's bin/compose.sh (-p <project> -f <file>).
set -eo pipefail

run_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

exec docker compose -p spezi-poc -f "$run_dir/compose.yaml" "$@"
