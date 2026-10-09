#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# bootstrap.sh -- starts the POC stack (compose project spezi-poc).
# Adapted from the governance project's bin/bootstrap.sh.
#
# First time (db/.initialized absent):
#   1. Ensures credentials exist (db/make-env.sh, never overwrites)
#   2. Brings the stack up with the "initialize" profile: oracle (healthy) ->
#      oracle-init (must complete successfully) -> hapi
#   3. Fails fast if the init did not exit 0
#   4. Removes the exited init container so no inactive service lingers
#   5. Writes the db/.initialized marker
#
# Later runs (marker present): plain `up -d`; the init service is not even in play.
#
# To reinitialize without losing data: remove db/.initialized and rerun (the init is
# idempotent). To start from nothing: scripts/reset.sh.
# UNTESTED until you run it.
# ---------------------------------------------------------------------------
set -euo pipefail

RUN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MARKER_FILE="${RUN_DIR}/db/.initialized"
COMPOSE_CMD="${RUN_DIR}/scripts/compose.sh"
INIT_CONTAINER=spezi-poc-oracle-init

log()  { echo "✅ $*"; }
fail() { echo "❌ ERROR: $*" >&2; exit 1; }

assert_docker_running() {
  if ! docker info > /dev/null 2>&1; then
    if [[ "$OSTYPE" == "darwin"* ]]; then
      echo "Starting Docker Desktop..."
      open -a Docker
      until docker info > /dev/null 2>&1; do sleep 2; done
      echo "Docker Desktop ready."
    else
      fail "Docker daemon is not running"
    fi
  fi
}

run_initialize() {
  log "Project spezi-poc is not initialized. Running with the *initialize* profile ..."

  # `up -d` blocks on hapi's dependency on oracle-init and exits non-zero if the init fails.
  if ! ${COMPOSE_CMD} --profile initialize up -d --build; then
    echo "---- last lines of the init container log:" >&2
    docker logs --tail 40 "${INIT_CONTAINER}" >&2 || true
    fail "startup failed; fix the cause, then rerun (the init is idempotent)."
  fi

  local exit_code
  exit_code=$(docker inspect -f '{{.State.ExitCode}}' "${INIT_CONTAINER}")
  [ "${exit_code}" = "0" ] || fail "Init container '${INIT_CONTAINER}' exited with code ${exit_code}."
  log "${INIT_CONTAINER} completed successfully."

  # Remove the exited init container; the rest of the stack keeps running.
  ${COMPOSE_CMD} --profile initialize rm -f oracle-init > /dev/null

  touch "${MARKER_FILE}"
  log "Initialization complete. Marker file written: ${MARKER_FILE}"
}

run_initialized() {
  log "Project spezi-poc is initialized. Starting services ..."
  ${COMPOSE_CMD} up -d --build
}

assert_docker_running

# create gitignored credentials where absent (never overwrites)
"${RUN_DIR}/db/make-env.sh"

# create the local CA, server certificate and HAPI keystore where absent (idempotent; keys live outside the repo)
"${RUN_DIR}/hapi/tls/make-tls.sh"

if [ -f "${MARKER_FILE}" ]; then
  run_initialized
else
  run_initialize
fi

log "spezi-poc is up. Verify with: make stack-verify"
