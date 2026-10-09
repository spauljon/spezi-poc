#!/usr/bin/env bash
# Tests the IdP edge proxy's allowlist against a RUNNING proxy. Usable with or without Keycloak behind it.
#   idp/verify-allowlist.sh [port] [ip]   default port 8444 and ip 127.0.0.1; always asks for macpro16.local
# Blocked cases must be denied BY THE EDGE (X-Edge-Denied header), not merely fail to connect or be
# refused by Keycloak; allowed cases must NOT be denied by the edge (502 is fine without Keycloak).
# Sends raw paths (curl --path-as-is) so dot-segments and encodings reach nginx exactly as written.
set -uo pipefail

port="${1:-8444}"
connect_ip="${2:-127.0.0.1}"
host=macpro16.local
tls_dir="${POC_TLS_DIR:-$HOME/.poc-ca}"
fail=0; skipped=0
ok()  { echo "ok   - $1"; }
bad() { echo "FAIL - $1"; fail=1; }

# req <raw-path-and-query> [curl args...] -> prints "<status>|<X-Edge-Denied value or empty>"
req() {
  local path=$1; shift
  curl -s -o /dev/null --path-as-is --max-time 10 \
    --cacert "$tls_dir/ca.crt" --resolve "$host:$port:$connect_ip" \
    -D - -w '\n%{http_code}' "$@" "https://$host:$port$path" 2>/dev/null \
  | awk 'BEGIN{h=""} tolower($1)=="x-edge-denied:"{gsub(/\r/,"",$2); h=$2} {last=$0} END{printf "%s|%s\n", last, h}'
}

# 1. Positive control: the edge answers (so a "denied" below cannot just mean "nothing is listening").
r=$(req /ping)
[ "${r%%|*}" = "200" ] && ok "positive control: /ping answers 200 over TLS" || { bad "positive control failed: /ping returned '${r%%|*}' (is the proxy up on $port?)"; echo; echo "SOME CHECKS FAILED"; exit 1; }

# 2. Blocked: must be denied by the edge with the expected status.
blocked() { # blocked <expected-status> <path> <why>
  local r st h; r=$(req "$2"); st=${r%%|*}; h=${r#*|}
  if [ "$st" = "$1" ] && [ -n "$h" ]; then ok "$3 -> $st denied by the edge ($h)"
  else bad "$3: expected edge denial $1 for $2, got status '$st' header '$h'"; fi
}
blocked 404 /admin/                                            "admin console"
blocked 404 /admin/master/console/                             "admin console (deep)"
blocked 404 /realms/master/                                    "master realm"
blocked 404 /realms/master/protocol/openid-connect/auth        "master realm login"
blocked 404 /realms/%6dmaster/                                 "master realm, encoded letter"
blocked 404 /%61dmin/                                          "admin, encoded letter"
blocked 404 /metrics                                           "metrics"
blocked 404 /health                                            "health"
blocked 404 /                                                  "root"
blocked 404 /robots.txt                                        "unlisted path"
blocked 404 /realms/pocx/                                      "realm name prefix trick"
blocked 404 /Realms/poc/                                       "case variation"
blocked 400 //admin/                                           "double slash"
blocked 400 /realms/poc/../master/                             "dot-segment into master"
blocked 400 /realms/poc/%2e%2e/master/                         "encoded dot-segment"
blocked 400 "/realms/poc/..;/admin/"                           "semicolon path parameter"
blocked 400 /realms/poc%2f..%2fmaster/                         "encoded slash traversal"
blocked 400 /realms/poc/a%5cb                                  "encoded backslash"

# 3. Allowed: the edge must let these through (no X-Edge-Denied). 502 is expected when Keycloak is not up.
allowed() { # allowed <path> <why> [curl args]
  local p=$1 w=$2; shift 2; local r st h; r=$(req "$p" "$@"); st=${r%%|*}; h=${r#*|}
  # Every denial issued by the edge carries X-Edge-Denied; a 400 WITHOUT it is Keycloak answering (for example
  # "client not found"), which is exactly a request that passed the edge.
  if [ -z "$h" ] && [ "$st" != "000" ]; then ok "$w -> passes the edge (status $st)"
  else bad "$w: expected to pass the edge, got status '$st' header '$h'"; fi
}
allowed /realms/poc/.well-known/openid-configuration "realm discovery document"
allowed /realms/poc/protocol/openid-connect/certs     "realm JWKS"
allowed /resources/abc/login/keycloak.v2/css/login.css "static resources"
allowed /.well-known/openid-configuration              "root well-known"
allowed "/realms/poc/protocol/openid-connect/auth?client_id=x&redirect_uri=https%3A%2F%2Fexample.invalid%2Fcb&state=s" \
        "auth request with an encoded redirect_uri in the QUERY"

# 4. Host and method rules.
r=$(req /ping -H "Host: other.local"); [ "${r%%|*}" = "421" ] && [ -n "${r#*|}" ] && ok "wrong Host header -> 421 by the edge" || bad "wrong Host: got '$r'"
r=$(req /realms/poc/ -X DELETE);        [ "${r%%|*}" = "405" ] && [ -n "${r#*|}" ] && ok "DELETE -> 405 by the edge" || bad "DELETE: got '$r'"

echo
if [ "$fail" -eq 0 ]; then echo "ALL ALLOWLIST CHECKS PASSED"; else echo "SOME ALLOWLIST CHECKS FAILED"; fi
exit "$fail"
