#!/usr/bin/env bash
# Runs the analytics worker on the host (M9): credentials from the git-ignored env files, the POC CA trusted.
#
#   analytics/run.sh [once|loop|status]     default: once
set -euo pipefail
# shellcheck source=env.sh
. "$(dirname "${BASH_SOURCE[0]}")/env.sh"
cd "$root/analytics"
exec node --import tsx src/main.ts "$@"
