#!/usr/bin/env bash
# Copies contract/metrics.json into the iOS app's bundle resources and the Android app's assets. The copy must stay byte-identical: `make
# test-contract` and the app's unit tests fail if it differs. Run after every change to metrics.json.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cp "$root/contract/metrics.json" "$root/ios/HealthGate/Resources/metrics.json"
mkdir -p "$root/android/app/src/main/assets"
cp "$root/contract/metrics.json" "$root/android/app/src/main/assets/metrics.json"
echo "contract: copied metrics.json to ios/HealthGate/Resources/ and android/app/src/main/assets/"
