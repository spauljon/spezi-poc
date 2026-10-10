#!/usr/bin/env bash
# Copies contract/metrics.json into the iOS app's bundle resources. The copy must stay byte-identical: `make
# test-contract` and the app's unit tests fail if it differs. Run after every change to metrics.json.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cp "$root/contract/metrics.json" "$root/ios/TemplateApplication/Resources/metrics.json"
echo "contract: copied metrics.json to ios/TemplateApplication/Resources/"
