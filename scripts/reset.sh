#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# reset.sh -- clears the POC project's containers and (after separate confirmations) its Oracle and Keycloak volumes.
# Adapted from the governance project's bin/reset.sh. Touches ONLY compose project spezi-poc.
# ---------------------------------------------------------------------------
set -euo pipefail

run_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

"${run_dir}/scripts/compose.sh" --profile initialize down
echo "✅ Docker project 'spezi-poc' containers removed."

read -rp "This will erase the POC Oracle database (FHIR and analytics PDBs). Continue? [y/N]: " confirm
confirm_lc=$(echo "$confirm" | tr '[:upper:]' '[:lower:]')

if [[ ${confirm_lc} == "y" ]]; then
  set +e
  if docker volume rm spezi-poc_oracle_data 2>/dev/null; then
    echo "✅ Docker volume spezi-poc_oracle_data removed."
  else
    echo "✅ Docker volume is not present."
  fi
  set -e
  rm -vf "${run_dir}/db/.initialized"
else
  echo "Oracle volume kept; the .initialized marker is unchanged."
fi

read -rp "This will erase Keycloak's data (the H2 file volume). Continue? [y/N]: " confirm_kc
confirm_kc_lc=$(echo "$confirm_kc" | tr '[:upper:]' '[:lower:]')
if [[ ${confirm_kc_lc} == "y" ]]; then
  set +e
  if docker volume rm spezi-poc_keycloak_data 2>/dev/null; then
    echo "✅ Docker volume spezi-poc_keycloak_data removed."
  else
    echo "✅ Docker volume is not present."
  fi
  set -e
else
  echo "Keycloak volume kept."
fi

echo "✅ Done."
