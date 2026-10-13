#!/usr/bin/env bash
# Prints the outcome of THIS container start's database init: ok | failed | pending.
# Runs inside the oracle container (healthcheck in compose.yaml; scripts/bootstrap.sh via docker exec).
# See db/startup/10-poc-init.sh for how the status file is written.
f=/dev/shm/poc-init.status
token=$(cut -d' ' -f22 /proc/1/stat)
if [ -r "$f" ]; then
  read -r t s < "$f" || true
  if [ "${t:-}" = "$token" ] && [ -n "${s:-}" ]; then echo "$s"; exit 0; fi
fi
echo pending
