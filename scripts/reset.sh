#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# reset.sh -- clears the POC project's containers and (after confirmation) its Oracle volume (which also holds Keycloak's data since M3c).
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

# Keycloak keeps its data in KEYCLOAKPDB inside the Oracle volume (M3c), so erasing Oracle erases it too. A leftover
# volume from before M3c (the H2 file) is removed here so it cannot be mistaken for live data.
if docker volume inspect spezi-poc_keycloak_data > /dev/null 2>&1; then
  docker volume rm spezi-poc_keycloak_data > /dev/null && echo "✅ Removed the obsolete Keycloak H2 volume spezi-poc_keycloak_data."
fi

echo "✅ Done."
