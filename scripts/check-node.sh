#!/usr/bin/env bash
# Fails, with the fix, unless the Node on PATH is the major version the repo pins in .nvmrc (analytics/ and web/).
# Everything under analytics/ and web/ was verified on that major (see the milestone notes); an older or newer one can
# fail in confusing ways (for example Vitest crashes at startup on Node 21).
#
#   scripts/check-node.sh            exit 0 if the major matches, 1 otherwise
#   POC_NODE_ANY=1 scripts/check-node.sh   skip the check (your own risk; the message says so)
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
want="$(tr -d 'v \n\r' < "$root/.nvmrc")"
want_major="${want%%.*}"

if [ "${POC_NODE_ANY:-}" = "1" ]; then
  echo "node: version check skipped (POC_NODE_ANY=1); the repo is verified on Node ${want_major}" >&2
  exit 0
fi
command -v node > /dev/null 2>&1 || { echo "node: not found on PATH. Install Node ${want_major} (nvm install ${want_major})." >&2; exit 1; }

have="$(node -v | tr -d 'v \n')"
have_major="${have%%.*}"
if [ "$have_major" != "$want_major" ]; then
  echo "node: this repo is pinned to Node ${want_major} (.nvmrc) but 'node -v' is v${have}." >&2
  echo "      Fix:  nvm use          (run in the repo root; 'nvm install ${want_major}' first if needed)" >&2
  echo "      Or:   POC_NODE_ANY=1 make <target>   to override at your own risk." >&2
  exit 1
fi
