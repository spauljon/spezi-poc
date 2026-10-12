#!/usr/bin/env bash
# The worker's end-to-end test against the live POC stack (M9). Needs `make stack-up`, the analytics schema
# (`make analytics-migrate`) and the seeded patient (`python3 hapi/auth.py seed`).
set -euo pipefail
# shellcheck source=env.sh
. "$(dirname "${BASH_SOURCE[0]}")/env.sh"
cap=$(pick "$idp_env" POC_CAPTURE_USER_PASSWORD)
[ -n "$cap" ] || { echo "analytics: POC_CAPTURE_USER_PASSWORD missing from idp/.env.local" >&2; exit 1; }
clin=$(pick "$idp_env" POC_CLINICIAN_USER_PASSWORD)
[ -n "$clin" ] || { echo "analytics: POC_CLINICIAN_USER_PASSWORD missing from idp/.env.local" >&2; exit 1; }
export POC_CAPTURE_USER_PASSWORD="$cap" POC_CLINICIAN_USER_PASSWORD="$clin" POC_ANALYTICS_LIVE=1
unset cap clin
cd "$root/analytics"
exec node --import tsx --test test/live.test.ts
