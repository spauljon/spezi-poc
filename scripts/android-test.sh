#!/usr/bin/env bash
# Android tests.
#   scripts/android-test.sh            unit tests of the app and the probe on the JVM (no device)
#   scripts/android-test.sh --device   the on-device tests (SQLite queue, Keystore) on a connected phone or a running emulator
# Both fail if no test ran, so a build that compiled nothing cannot pass. Needs JDK 17 or 21 (set JAVA_HOME, or on macOS it is found)
# and the Android SDK (ANDROID_HOME).
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mode="${1:-unit}"

if [ -z "${JAVA_HOME:-}" ] && [ -x /usr/libexec/java_home ]; then
  JAVA_HOME="$(/usr/libexec/java_home -v 21 2>/dev/null || /usr/libexec/java_home -v 17 2>/dev/null || true)"
fi
if [ -z "${JAVA_HOME:-}" ] || [ ! -x "$JAVA_HOME/bin/java" ]; then
  echo "android: no JDK 17 or 21 found. Set JAVA_HOME (Android Studio's bundled JDK 25 also works with Gradle 9)." >&2
  exit 1
fi
if [ -z "${ANDROID_HOME:-}" ]; then ANDROID_HOME="$HOME/Library/Android/sdk"; [ -d "$ANDROID_HOME" ] || ANDROID_HOME="$HOME/Android/Sdk"; fi
if [ ! -d "$ANDROID_HOME" ]; then
  echo "android: the Android SDK was not found. Install Android Studio and set ANDROID_HOME (see android/CLAUDE.md)." >&2
  exit 1
fi
export JAVA_HOME ANDROID_HOME

# add up the tests that ran, from JUnit XML reports (tests="N" on the first testsuite line of each file)
count_tests() {
  local total=0 f n
  for f in "$@"; do
    [ -e "$f" ] || continue
    n="$(grep -o 'tests="[0-9]*"' "$f" | head -1 | grep -o '[0-9]*' || true)"
    total=$((total + ${n:-0}))
  done
  echo "$total"
}

cd "$root/android"
case "$mode" in
  unit)
    # clear the previous results with Gradle itself, so a stale report can never be counted
    ./gradlew :app:cleanTestDebugUnitTest :probe:cleanTestDebugUnitTest :app:testDebugUnitTest :probe:testDebugUnitTest -q
    total="$(count_tests app/build/test-results/testDebugUnitTest/*.xml probe/build/test-results/testDebugUnitTest/*.xml)"
    [ "$total" -gt 0 ] || { echo "android: no tests ran" >&2; exit 1; }
    echo "android: $total unit tests passed"
    ;;
  --device)
    adb="$ANDROID_HOME/platform-tools/adb"
    if ! "$adb" devices | grep -qE '[[:space:]]device$'; then
      echo "android: no device or emulator is connected (adb devices is empty): plug in the phone or start the emulator" >&2
      exit 1
    fi
    ./gradlew :app:connectedDebugAndroidTest -q
    total="$(count_tests app/build/outputs/androidTest-results/connected/*/*.xml)"
    [ "$total" -gt 0 ] || { echo "android: no on-device tests ran" >&2; exit 1; }
    echo "android: $total on-device tests passed"
    ;;
  *)
    echo "usage: scripts/android-test.sh [--device]" >&2
    exit 2
    ;;
esac
