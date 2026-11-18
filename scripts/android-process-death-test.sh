#!/usr/bin/env bash
# The process-death test (M28): the app is KILLED at a named failpoint in the read-and-upload path, restarted, and must lose nothing.
#
#   ANDROID_SERIAL=emulator-5554 scripts/android-process-death-test.sh collector
#       emulator only: kills during the read (after the 4th commit of a 5,000-sample record), then checks the queue holds a PART of the
#       record and no token was stored, runs again, and checks the queue holds exactly 5,000 samples and the token is stored.
#   ANDROID_SERIAL=<phone> scripts/android-process-death-test.sh engine
#       the signed-in phone: kills right after the server accepted an upload (before the queue was told), restarts, and checks the
#       server still holds exactly the same number of samples (a repeat is a no-op) and the queue is empty. Needs the stack up.
#
# Debug builds only (the receivers and failpoints do not exist in release builds). Synthetic records from the :writer test tool. Everything
# printed is a count or a word. The `collector` test clears the app's data, so it refuses to run on anything but an emulator.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
adb="${ANDROID_HOME:-$HOME/Library/Android/sdk}/platform-tools/adb"
serial="${ANDROID_SERIAL:-}"
[ -n "$serial" ] || { echo "process-death: set ANDROID_SERIAL (adb devices lists the choices)" >&2; exit 2; }
a() { "$adb" -s "$serial" "$@"; }
app=com.aboutobjects.healthgate
writer=com.aboutobjects.healthgate.writer
mode="${1:-}"
fails=0

ok()   { echo "ok   - $1"; }
fail() { echo "FAIL - $1"; fails=$((fails + 1)); }

hg()  { a shell am broadcast -f 0x20 -n "$app/.debug.DebugControlReceiver" -a "com.aboutobjects.healthgate.debug.$1" "${@:2}" >/dev/null; }
wr()  { a shell am broadcast -f 0x20 -n "$writer/.ControlReceiver" -a "com.aboutobjects.healthgate.writer.$1" >/dev/null; }

# wait until logcat (tag, cleared before the call) shows a line matching the pattern; print that line
wait_for() {
  local tag="$1" pattern="$2" limit="${3:-120}" i=0 line
  while [ "$i" -lt "$limit" ]; do
    line="$(a logcat -d -s "$tag:I" | grep -E "$pattern" | tail -n 1 || true)"
    if [ -n "$line" ]; then echo "$line"; return 0; fi
    sleep 1; i=$((i + 1))
  done
  return 1
}
status() {  # prints the STATUS line's numbers: pending sent deleted token
  a logcat -c; hg STATUS
  wait_for HGDebug "queue pending" 30
}
num() { sed -E "s/.*$1 ([0-9]+).*/\1/" <<<"$2"; }

grant_all() {
  for p in READ_HEART_RATE READ_RESTING_HEART_RATE READ_HEART_RATE_VARIABILITY READ_SLEEP READ_NUTRITION READ_HYDRATION READ_HEALTH_DATA_IN_BACKGROUND; do
    a shell pm grant "$app" "android.permission.health.$p" >/dev/null 2>&1 || echo "note: could not grant $p (grant it in the app)"
  done
  for p in WRITE_HEART_RATE WRITE_RESTING_HEART_RATE WRITE_HEART_RATE_VARIABILITY WRITE_SLEEP WRITE_NUTRITION WRITE_HYDRATION; do
    a shell pm grant "$writer" "android.permission.health.$p" >/dev/null 2>&1 || echo "note: could not grant $p (grant it in the writer)"
  done
}

died() { # the process is gone and the failpoint said so
  local i=0
  while [ "$i" -lt 60 ]; do
    if ! a shell pidof "$app" >/dev/null 2>&1 && a logcat -d -s HGDebug:I | grep -q "failpoint .*killing"; then return 0; fi
    sleep 1; i=$((i + 1))
  done
  return 1
}

case "$mode" in
collector)
  case "$serial" in emulator-*) ;; *) echo "process-death: the collector test clears app data; it runs on an emulator only (ANDROID_SERIAL=emulator-...)" >&2; exit 2;; esac
  a shell pm clear "$app" >/dev/null; a shell pm clear "$writer" >/dev/null
  a shell pm clear com.google.android.healthconnect.controller >/dev/null 2>&1 || true
  grant_all
  a logcat -c; wr HR_LARGE
  wait_for HGWriter "Wrote one heart-rate record with 5000" 90 >/dev/null && ok "the writer wrote one record of 5,000 synthetic samples" || { fail "the writer did not write (is Health Connect allowed for it?)"; exit 1; }

  a logcat -c; hg ARM --es name collector.afterCommit --ei skip 3
  wait_for HGDebug "armed" 20 >/dev/null || { fail "could not arm the failpoint (is this a debug build?)"; exit 1; }
  a logcat -c; hg RUN
  if died; then ok "the process was killed after the 4th commit of the record"; else fail "the process was not killed (the control: it should have been)"; fi

  s="$(status)" || { fail "no status after the restart"; exit 1; }
  pending="$(num pending "$s")"
  echo "     after the kill: $s"
  if [ "$pending" -ge 1 ] && [ "$pending" -lt 5000 ] && grep -q "token none" <<<"$s"; then ok "part of the record is queued ($pending of 5000) and no token was stored"; else fail "unexpected state after the kill"; fi

  a logcat -c; hg RUN
  wait_for HGDebug "run done" 180 >/dev/null || { fail "the retry did not finish"; exit 1; }
  s="$(status)"
  echo "     after the retry: $s"
  total=$(( $(num pending "$s") + $(num sent "$s") ))
  if [ "$total" -eq 5000 ] && grep -q "token set" <<<"$s"; then ok "the retry converged: exactly 5,000 samples queued, token stored"; else fail "after the retry the queue holds $total samples (expected 5000)"; fi
  a logcat -c; wr DELETE_ALL; sleep 2
  ;;
engine)
  case "$serial" in emulator-*) echo "process-death: the engine test needs the signed-in phone (the emulator is not signed in)" >&2; exit 2;; esac
  hr() { local n; n="$(python3 "$root/scripts/android-hc-counts.py" | awk '$1=="heartRate" && $2=="final" {print $3; exit}')"; echo "${n:-0}"; }
  base="$(hr)"
  echo "     heart-rate Observations on the server before: $base"
  a logcat -c; wr HR_WRITE
  wait_for HGWriter "Wrote one heart-rate record" 30 >/dev/null || { fail "the writer did not write"; exit 1; }
  a logcat -c; hg ARM --es name engine.afterSend --ei skip 0
  wait_for HGDebug "armed" 20 >/dev/null || { fail "could not arm"; exit 1; }
  a logcat -c; hg RUN
  if died; then ok "the process was killed right after the server accepted the upload"; else fail "the process was not killed"; fi
  after_kill="$(hr)"
  if [ "$after_kill" -eq $((base + 3)) ]; then ok "the server has the 3 samples ($after_kill)"; else fail "the server holds $after_kill (expected $((base + 3)))"; fi
  s="$(status)"; echo "     after the kill: $s"
  if [ "$(num pending "$s")" -ge 3 ]; then ok "the queue was not told: the 3 samples still wait"; else fail "the queue does not hold the 3 samples"; fi
  a logcat -c; hg RUN
  wait_for HGDebug "run done" 120 >/dev/null || { fail "the retry did not finish"; exit 1; }
  after_retry="$(hr)"
  s="$(status)"; echo "     after the retry: $s"
  if [ "$after_retry" -eq $((base + 3)) ] && [ "$(num pending "$s")" -eq 0 ]; then ok "the retry converged: still $after_retry samples on the server, nothing waits"; else fail "after the retry: server $after_retry (expected $((base + 3))), pending $(num pending "$s")"; fi
  a logcat -c; wr HR_DELETE; sleep 2; hg RUN
  wait_for HGDebug "run done" 120 >/dev/null || true
  [ "$(hr)" = "$base" ] && ok "cleaned up: the server is back to $base" || fail "cleanup left $(hr) heart-rate Observations (expected $base)"
  ;;
*)
  echo "usage: ANDROID_SERIAL=<serial> scripts/android-process-death-test.sh collector|engine" >&2
  exit 2
  ;;
esac

echo
if [ "$fails" -eq 0 ]; then echo "PROCESS-DEATH TEST ($mode) PASSED"; else echo "PROCESS-DEATH TEST ($mode) FAILED ($fails)"; exit 1; fi
