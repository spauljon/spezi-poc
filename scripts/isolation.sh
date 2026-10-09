#!/bin/bash
# Proves the POC stack did not touch anything outside its own compose project.
#   scripts/isolation.sh before   snapshot containers, volumes and networks NOT in the project
#   scripts/isolation.sh after    snapshot again and diff against the "before" snapshot
# Membership is decided by the compose project label, not by names. Read-only: only runs
# docker list commands.
# Only identity is compared (container name + image, volume names, network names), never run state
# or ports: those change whenever Docker Desktop restarts and would raise false alarms.
set -euo pipefail

snap="${TMPDIR:-/tmp}/spezi-poc-isolation.snapshot"
project=spezi-poc
label="com.docker.compose.project=${project}"

# Names in `all` that are not in `ours`, sorted.
minus() { comm -23 <(sort) <(sort "$1"); }

take() {
  local mine
  mine=$(mktemp); trap 'rm -f "$mine"' RETURN

  echo "## containers (name image)"
  docker ps -a --filter "label=${label}" --format '{{.Names}}' | sort > "$mine"
  docker ps -a --format '{{.Names}}	{{.Image}}' | sort \
    | awk -F'\t' 'NR==FNR{m[$1]=1;next} !($1 in m)' "$mine" - || true

  echo "## volumes"
  docker volume ls -q --filter "label=${label}" | sort > "$mine"
  docker volume ls -q | minus "$mine" || true

  echo "## networks"
  docker network ls --filter "label=${label}" --format '{{.Name}}' | sort > "$mine"
  docker network ls --format '{{.Name}}' | minus "$mine" || true
}

case "${1:-}" in
  before) take > "$snap"; echo "snapshot saved: $snap" ;;
  after)
    [ -f "$snap" ] || { echo "no snapshot; run '$0 before' first" >&2; exit 2; }
    if diff "$snap" <(take); then echo "ok - nothing outside the ${project} project changed"; else echo "FAIL - differences above"; exit 1; fi ;;
  *) echo "usage: $0 before|after" >&2; exit 2 ;;
esac
