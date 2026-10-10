#!/usr/bin/env bash
# Runs the iOS app's tests on an installed simulator (macOS with Xcode only).
#
#   scripts/ios-test.sh          unit tests (Swift Testing), fast
#   scripts/ios-test.sh --ui     unit tests and the UI tests (launches the app in the simulator)
#
# Simulator: $POC_IOS_SIMULATOR (a name or UDID), else the first available iPhone.
# Derived data goes to a temp dir, never into the repo. Exits non-zero on any failure.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ui=false
[ "${1:-}" = "--ui" ] && ui=true

if [ "$(uname -s)" != "Darwin" ] || ! command -v xcodebuild > /dev/null 2>&1; then
  echo "ios: SKIPPED (needs macOS with Xcode; this host has neither)" >&2
  exit 0
fi

dest="${POC_IOS_SIMULATOR:-}"
if [ -z "$dest" ]; then
  dest=$(xcrun simctl list devices available -j | python3 -c '
import json, sys
for runtime, devices in sorted(json.load(sys.stdin)["devices"].items()):
    for d in devices:
        if d.get("isAvailable") and d["name"].startswith("iPhone"):
            print(d["udid"]); sys.exit(0)')
fi
[ -n "$dest" ] || { echo "ios: no iPhone simulator available (xcrun simctl list devices available)" >&2; exit 1; }

dd="$(mktemp -d "${TMPDIR:-/tmp}/spezipoc-ios.XXXXXX")"
trap 'rm -rf "$dd"' EXIT

only=(-only-testing:TemplateApplicationTests)
$ui && only+=(-only-testing:TemplateApplicationUITests)

echo "ios: testing on simulator $dest ($($ui && echo 'unit + UI' || echo 'unit'))"
cd "$root/ios"

# The sign-in UI test types the synthetic capture user's password into Keycloak's login page. It comes from the
# git-ignored idp/.env.local and reaches the test runner only as an environment variable (xcodebuild forwards
# TEST_RUNNER_-prefixed ones); it is never printed or put on a command line. Without it that test is skipped.
if $ui && [ -f "$root/idp/.env.local" ]; then
  pw=$(grep '^POC_CAPTURE_USER_PASSWORD=' "$root/idp/.env.local" | cut -d= -f2- || true)
  [ -n "$pw" ] && export TEST_RUNNER_POC_CAPTURE_PASSWORD="$pw"
  unset pw
fi
# -skipMacroValidation: the command-line form of Xcode's "Trust & Enable" for the Swift macro in the ThreadLocal
# package (a StanfordBDHG dependency of Spezi). See ios/README.md.
# Stream to a log file (kept in the temp dir) so a stall is visible; a watchdog stops xcodebuild if it neither
# finishes nor prints for $POC_IOS_TEST_STALL seconds (it can fail to exit after a failed test).
log="$dd/xcodebuild.log"
stall="${POC_IOS_TEST_STALL:-240}"
xcodebuild test -project TemplateApplication.xcodeproj -scheme TemplateApplication \
    -destination "id=$dest" -derivedDataPath "$dd" -skipPackagePluginValidation -skipMacroValidation \
    "${only[@]}" > "$log" 2>&1 &
pid=$!
last=$(wc -c < "$log" | tr -d ' '); quiet=0
while kill -0 "$pid" 2> /dev/null; do
  sleep 5
  now=$(wc -c < "$log" | tr -d ' ')
  if [ "$now" != "$last" ]; then last=$now; quiet=0; else quiet=$((quiet + 5)); fi
  if grep -q -E '\*\* TEST (SUCCEEDED|FAILED) \*\*' "$log" && [ "$quiet" -ge 15 ]; then kill "$pid" 2> /dev/null || true; break; fi
  if [ "$quiet" -ge "$stall" ]; then
    echo "ios: STALLED: no output for ${stall}s, stopping xcodebuild. Last lines:" >&2; tail -8 "$log" >&2
    kill "$pid" 2> /dev/null || true; pkill -f "xcodebuild test.*$dd" 2> /dev/null || true; exit 1
  fi
done
wait "$pid" 2> /dev/null || true
out=$(cat "$log")
# Pattern match, not `echo | grep -q`: under pipefail a SIGPIPE from an early-exiting grep -q fails the pipeline.
if [[ "$out" != *"** TEST SUCCEEDED **"* ]]; then
  echo "$out" | grep -E "error:|✘|failed|TEST FAILED" | head -30 >&2
  echo "ios: TESTS FAILED (log: $log)" >&2
  trap - EXIT   # keep the log for inspection
  exit 1
fi

# A run that executed no tests is not a pass (a wrong -only-testing filter still prints TEST SUCCEEDED).
swift_testing=$(echo "$out" | grep -E 'Test run with [0-9]+ tests? .*passed' | tail -1 || true)
n_swift=$(echo "$swift_testing" | sed -E 's/.*Test run with ([0-9]+) tests?.*/\1/')
case "$n_swift" in ''|*[!0-9]*) n_swift=0 ;; esac
n_xctest=$({ echo "$out" | grep -E "Test Case .* passed" || true; } | wc -l | tr -d ' ')
if [ "$n_swift" -lt 1 ]; then echo "ios: FAILED: no Swift Testing unit tests ran (check the filter)" >&2; exit 1; fi
if $ui && [ "$n_xctest" -lt 1 ]; then echo "ios: FAILED: no UI tests ran" >&2; exit 1; fi
n_skipped=$({ echo "$out" | grep -E "Test Case .* skipped" || true; } | wc -l | tr -d ' ')
echo "ios: $n_swift unit tests passed$($ui && echo ", $n_xctest UI test(s) passed, $n_skipped skipped")"
if [ "$n_skipped" -gt 0 ]; then
  echo "ios: WARNING: $n_skipped UI test(s) were SKIPPED and did not run (the sign-in test needs idp/.env.local and a running stack)" >&2
fi
