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
# -skipMacroValidation: the command-line form of Xcode's "Trust & Enable" for the Swift macro in the ThreadLocal
# package (a StanfordBDHG dependency of Spezi). See ios/README.md.
out=$(xcodebuild test -project TemplateApplication.xcodeproj -scheme TemplateApplication \
        -destination "id=$dest" -derivedDataPath "$dd" -skipPackagePluginValidation -skipMacroValidation \
        "${only[@]}" 2>&1) || { echo "$out" | grep -E "error:|✘|failed|TEST FAILED" | head -30 >&2; echo "ios: TESTS FAILED" >&2; exit 1; }
# A run that executed no tests is not a pass (a wrong -only-testing filter still prints TEST SUCCEEDED).
swift_testing=$(echo "$out" | grep -E 'Test run with [0-9]+ tests? .*passed' | tail -1 || true)
n_swift=$(echo "$swift_testing" | sed -E 's/.*Test run with ([0-9]+) tests?.*/\1/')
case "$n_swift" in ''|*[!0-9]*) n_swift=0 ;; esac
n_xctest=$({ echo "$out" | grep -E "Test Case .* passed" || true; } | wc -l | tr -d ' ')
if [ "$n_swift" -lt 1 ]; then echo "ios: FAILED: no Swift Testing unit tests ran (check the filter)" >&2; exit 1; fi
if $ui && [ "$n_xctest" -lt 1 ]; then echo "ios: FAILED: no UI tests ran" >&2; exit 1; fi
echo "ios: $n_swift unit tests passed$($ui && echo ", $n_xctest UI test(s) passed")"
