#!/usr/bin/env bash
# Makes ONE iOS simulator trust the POC CA, so the capture app can reach https://macpro16.local (macOS + Xcode only).
#
#   scripts/ios-sim-trust.sh install [device]   add ~/.poc-ca/ca.crt to that simulator's trusted roots
#   scripts/ios-sim-trust.sh reset   [device]   RESET that simulator's keychain (removes the CA, and every other
#                                               keychain item in that simulator, including a stored sign-in)
#
# device: a simulator name or UDID; default = the first booted simulator.
#
# What this changes: only the named simulator's trust store. It does not touch the Mac's keychain, your iPhone, or
# the system trust of anything else. The CA is the name-constrained POC CA (it may vouch only for macpro16.local;
# see hapi/README.md), and only its PUBLIC certificate is used. The CA private key never leaves ~/.poc-ca.
# There is no per-certificate removal in `simctl keychain`; `reset` (or erasing the simulator) is the way back.
set -euo pipefail

cmd="${1:-}"
device="${2:-booted}"
ca="${POC_TLS_DIR:-$HOME/.poc-ca}/ca.crt"

if [ "$(uname -s)" != "Darwin" ] || ! command -v xcrun > /dev/null 2>&1; then
  echo "ios-sim-trust: needs macOS with Xcode" >&2; exit 1
fi
case "$cmd" in
  install)
    [ -f "$ca" ] || { echo "ios-sim-trust: $ca not found (run make tls)" >&2; exit 1; }
    # Refuse anything that is not a CA certificate, and show what is being trusted.
    openssl x509 -in "$ca" -noout -text | grep -q "CA:TRUE" || { echo "ios-sim-trust: $ca is not a CA certificate" >&2; exit 1; }
    echo "ios-sim-trust: trusting for simulator '$device':"
    openssl x509 -in "$ca" -noout -subject -fingerprint -sha256 | sed 's/^/  /'
    openssl x509 -in "$ca" -noout -text | grep -A2 "Name Constraints" | sed 's/^/  /' || true
    xcrun simctl keychain "$device" add-root-cert "$ca"
    echo "ios-sim-trust: installed."
    ;;
  reset)
    echo "ios-sim-trust: resetting the keychain of simulator '$device' (removes the CA and any stored sign-in)"
    xcrun simctl keychain "$device" reset
    echo "ios-sim-trust: reset."
    ;;
  *)
    sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'
    exit 2
    ;;
esac
