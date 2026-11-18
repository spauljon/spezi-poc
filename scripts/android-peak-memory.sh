#!/usr/bin/env bash
# Peak memory of the app during one read-and-upload of a fresh 5,000-sample synthetic heart-rate record (M28), on the connected phone.
#
#   ANDROID_SERIAL=<phone> scripts/android-peak-memory.sh
#
# The :writer test tool writes the record, then ONE sync run (read Health Connect, upload) is made while the debug build samples its own
# memory every 20 ms (Debug.getMemoryInfo: total PSS, the memory the app really holds with shared pages shared out; and the Java heap in use). The record is deleted again at the end. Debug builds only. Needs the stack up and the phone signed in. Prints sizes in MB,
# seconds and counts: nothing from any record.
set -euo pipefail
adb="${ANDROID_HOME:-$HOME/Library/Android/sdk}/platform-tools/adb"
serial="${ANDROID_SERIAL:-}"
[ -n "$serial" ] || { echo "peak-memory: set ANDROID_SERIAL (adb devices lists the choices)" >&2; exit 2; }
a() { "$adb" -s "$serial" "$@"; }
app=com.aboutobjects.healthgate
writer=com.aboutobjects.healthgate.writer
hg() { a shell am broadcast -f 0x20 -n "$app/.debug.DebugControlReceiver" -a "com.aboutobjects.healthgate.debug.$1" "${@:2}" >/dev/null; }
wr() { a shell am broadcast -f 0x20 -n "$writer/.ControlReceiver" -a "com.aboutobjects.healthgate.writer.$1" >/dev/null; }
wait_for() { local tag="$1" pattern="$2" limit="$3" i=0; while [ "$i" -lt "$limit" ]; do a logcat -d -s "$tag:I" | grep -qE "$pattern" && return 0; sleep 1; i=$((i + 1)); done; return 1; }

# one RUN so the app process exists and any waiting work is done, then the baseline
a logcat -c; hg RUN; wait_for HGDebug "run done" 120 || { echo "peak-memory: the app did not answer (debug build installed? stack up?)" >&2; exit 1; }
pss() { a shell dumpsys meminfo "$app" | awk '/TOTAL PSS:/ {print $3; exit}'; }
heap() { a shell dumpsys meminfo "$app" | awk '/Java Heap:/ {print $3; exit}'; }
echo "baseline, app idle:   total PSS $(( $(pss) / 1024 )) MB, Java heap $(( $(heap) / 1024 )) MB"
echo "phone RAM: $(a shell dumpsys meminfo | awk '/Total RAM:/ {print $3, $4; exit}' ) total"

a logcat -c; wr HR_LARGE
wait_for HGWriter "Wrote one heart-rate record with 5000" 60 || { echo "peak-memory: the writer did not write" >&2; exit 1; }

a logcat -c; hg RUN
wait_for HGDebug "run done" 300 || { echo "peak-memory: the run did not finish in 300 s" >&2; exit 1; }
echo "during one run (5,000 samples read, queued and uploaded; the app samples its own memory every 20 ms):"
a logcat -d -s HGDebug:I | grep "memory:" | tail -n 1 | sed -E 's/.*memory: /  /'
a logcat -d -s HGDebug:I | grep "run done" | tail -n 1 | sed -E 's/.*run done: /  result: /'
echo "after the run:        total PSS $(( $(pss) / 1024 )) MB, Java heap $(( $(heap) / 1024 )) MB"

a logcat -c; wr HR_LARGE_DELETE; sleep 2; hg RUN; wait_for HGDebug "run done" 300 >/dev/null || true
echo "cleaned up (the record deleted and the deletions sent)"
