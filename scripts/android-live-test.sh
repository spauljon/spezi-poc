#!/usr/bin/env bash
# Uploads a synthetic window to the LIVE stack with the Kotlin sync engine (the same engine and Bundle format the phone uses) and checks
# what HAPI says. Needs the stack up, ~/.poc-ca/ca.crt and idp/.env.local. The android-user token comes from idp/oidc.py and goes to
# the test through the environment only: it is never printed and never on a command line.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ -z "${JAVA_HOME:-}" ] && [ -x /usr/libexec/java_home ]; then
  JAVA_HOME="$(/usr/libexec/java_home -v 21 2>/dev/null || /usr/libexec/java_home -v 17 2>/dev/null || true)"
fi
[ -n "${JAVA_HOME:-}" ] || { echo "android-live: no JDK found; set JAVA_HOME" >&2; exit 1; }
if [ -z "${ANDROID_HOME:-}" ]; then ANDROID_HOME="$HOME/Library/Android/sdk"; fi
export JAVA_HOME ANDROID_HOME

# the token: the last line of `oidc.py token android --raw`; kept in a variable, never echoed
if ! token="$(python3 "$root/idp/oidc.py" token android --raw | tail -n 1)" || [ "${#token}" -lt 100 ]; then
  echo "android-live: could not get an android-user token (is the stack up and idp/.env.local present?)" >&2
  exit 1
fi
export HEALTHGATE_LIVE_TOKEN="$token"

cd "$root/android"
# cleanTest first: the token comes from the environment, which Gradle does not treat as an input, so the test must never be reported up to date
./gradlew :app:cleanTestDebugUnitTest :app:testDebugUnitTest --tests '*LiveUploadTest' -q
n="$(grep -o 'tests="[0-9]*"' app/build/test-results/testDebugUnitTest/*LiveUploadTest.xml | head -1 | grep -o '[0-9]*')"
s="$(grep -o 'skipped="[0-9]*"' app/build/test-results/testDebugUnitTest/*LiveUploadTest.xml | head -1 | grep -o '[0-9]*')"
if [ "${n:-0}" -eq 0 ] || [ "${s:-0}" -ne 0 ]; then
  echo "android-live: the live test did not run (tests=${n:-0}, skipped=${s:-0})" >&2
  exit 1
fi
echo "android-live: $n live test(s) passed against the stack"
