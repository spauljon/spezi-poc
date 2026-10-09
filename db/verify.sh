#!/usr/bin/env bash
# M1-M3a verification for a RUNNING stack (compose project spezi-poc, see compose.yaml).
# Run after: make stack-up. Synthetic data only.
# Addresses services through `docker compose` (project namespace), never by container name.
# Exits non-zero if any check fails. UNTESTED until you run it.
set -uo pipefail

for tool in docker curl openssl python3; do
  command -v "$tool" >/dev/null 2>&1 || { echo "verify.sh needs $tool on PATH" >&2; exit 2; }
done

cd "$(dirname "${BASH_SOURCE[0]}")/.."
dc() { ./scripts/compose.sh "$@"; }

fail=0
skipped=0
ok()   { echo "ok   - $1"; }
bad()  { echo "FAIL - $1"; fail=1; }
skip() { echo "SKIP - $1"; skipped=$((skipped+1)); }
check() { if eval "$2" >/dev/null 2>&1; then ok "$1"; else bad "$1"; fi; }

health() { docker inspect -f '{{.State.Health.Status}}' "$(dc ps -q "$1")" 2>/dev/null; }

osql() { # osql <service-name> : run SQL from stdin as SYSDBA inside the oracle service
  dc exec -T oracle bash -c "sqlplus -S \"sys/\$ORACLE_PWD@localhost:1521/$1 as sysdba\""
}
scalar() { printf 'set heading off feedback off pagesize 0 verify off\n%s\nexit;\n' "$2" | osql "$1" | tr -d '[:space:]'; }

echo "== services (project spezi-poc)"
for svc in oracle hapi; do
  [ "$(health $svc)" = healthy ] && ok "$svc is healthy" || bad "$svc health is '$(health $svc)'"
done

echo "== PDBs"
for p in FHIRPDB ANALYTICSPDB; do
  mode=$(scalar FREE "select open_mode from v\$pdbs where name = '$p';")
  [ "$mode" = "READWRITE" ] && ok "$p is open (READ WRITE)" || bad "$p open_mode is '$mode'"
done

echo "== schema placement and least privilege"
envv() { dc exec -T oracle bash -c "echo \${$1:-$2}" | tr -d '\r' | tr '[:lower:]' '[:upper:]'; }
owner=$(envv FHIR_DB_OWNER hapi_owner)
app=$(envv FHIR_DB_USER hapi)
expected=$(grep -c -i -E '^create[[:space:]]+table' hapi/schema/oracle.sql)
n=$(scalar FHIRPDB "select count(*) from dba_tables where owner = '$owner' and temporary = 'N';")
[ "$n" = "$expected" ] && ok "tables owned by $owner in FHIRPDB: $n (matches the $expected in hapi/schema/oracle.sql)" \
  || bad "tables owned by $owner: '$n', expected $expected from hapi/schema/oracle.sql"
t=$(scalar FHIRPDB "select count(*) from dba_tables where owner = '$owner' and temporary = 'Y';")
expected_t=$(grep -c -i -E '^create[[:space:]]+global[[:space:]]+temporary[[:space:]]+table' hapi/schema/oracle-temp-tables.sql)
[ "$t" = "$expected_t" ] && ok "temporary (HTE_*) tables owned by $owner: $t (match hapi/schema/oracle-temp-tables.sql)" || bad "temporary tables: '$t', expected $expected_t"
auth=$(scalar FHIRPDB "select authentication_type from dba_users where username = '$owner';")
[ "$auth" = "NONE" ] && ok "$owner cannot log in (authentication NONE)" || bad "$owner authentication_type is '$auth', expected NONE"
extra=$(scalar FHIRPDB "select count(*) from dba_sys_privs where grantee = '$app' and privilege <> 'CREATE SESSION';")
has=$(scalar FHIRPDB "select count(*) from dba_sys_privs where grantee = '$app' and privilege = 'CREATE SESSION';")
[ "$extra" = "0" ] && [ "$has" = "1" ] && ok "$app has CREATE SESSION only" || bad "$app system privileges: $has CREATE SESSION, $extra others"
owned=$(scalar FHIRPDB "select count(*) from dba_objects where owner = '$app' and object_type <> 'SYNONYM';")
[ "$owned" = "0" ] && ok "$app owns no objects other than synonyms" || bad "$app owns $owned non-synonym objects"
want=$(scalar FHIRPDB "select (select count(*) from dba_tables where owner = '$owner') + (select count(*) from dba_sequences where sequence_owner = '$owner') from dual;")
have=$(scalar FHIRPDB "select count(*) from dba_synonyms where owner = '$app' and table_owner = '$owner';")
[ "$have" = "$want" ] && ok "$app has $have synonyms (one per table and sequence of $owner)" || bad "$app has '$have' synonyms, expected $want"
sess=$(scalar FHIRPDB "select count(*) from v\$session where username = '$app';")
[ "${sess:-0}" -ge 1 ] 2>/dev/null && ok "HAPI is connected as $app ($sess sessions)" || bad "no sessions for $app"
n=$(scalar ANALYTICSPDB "select count(*) from dba_tables where owner = '$owner';")
[ "$n" = "0" ] && ok "no HAPI tables in ANALYTICSPDB" || bad "ANALYTICSPDB has '$n' tables owned by $owner"
a_auth=$(scalar ANALYTICSPDB "select authentication_type from dba_users where username = '$(envv ANALYTICS_DB_OWNER analytics_owner)';")
[ "$a_auth" = "NONE" ] && ok "analytics owner cannot log in" || bad "analytics owner authentication_type is '$a_auth'"

echo "== HAPI startup log"
errs=$(dc logs --no-color --no-log-prefix hapi 2>&1 | grep -c -E 'ORA-|SQLSyntaxError| ERROR |CommandAcceptanceException')
[ "$errs" = "0" ] && ok "no Oracle/DDL errors in the HAPI log" || bad "$errs Oracle/DDL error lines in the HAPI log (is Hibernate trying to alter the schema?)"

# --- portable helpers (macOS and Linux): no BSD-only or GNU-only flags -------------------------------
# tcp_state <host> <port> prints "open" or "closed" (refused, unreachable or timed out after 2s).
tcp_state() {
  python3 - "$1" "$2" <<'PY'
import socket, sys
s = socket.socket(); s.settimeout(2)
try:
    s.connect((sys.argv[1], int(sys.argv[2]))); print("open")
except OSError:
    print("closed")
finally:
    s.close()
PY
}
# host_ips prints every non-loopback IPv4 address of this host, one per line (Linux: `ip`; macOS/BSD:
# `ifconfig`; both print "inet <addr>"). If neither tool works it falls back to the default-route source
# address (a UDP "connect" sends no packet). Prints nothing if no address can be found.
host_ips() {
  python3 - <<'PY'
import re, socket, subprocess
def run(*cmd):
    try:
        return subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, universal_newlines=True, timeout=5).stdout
    except Exception:
        return ""
found = set(re.findall(r"inet (\d+\.\d+\.\d+\.\d+)", run("ip", "-o", "-4", "addr", "show")))
if not found:
    found = set(re.findall(r"inet (\d+\.\d+\.\d+\.\d+)", run("ifconfig")))
if not found:
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1)); found.add(s.getsockname()[0])
    except OSError:
        pass
    finally:
        s.close()
for a in sorted(x for x in found if not x.startswith("127.")):
    print(a)
PY
}

# --- TLS (M2): HAPI serves HTTPS only, from a certificate signed by the local CA ---------------------
tls_dir="${POC_TLS_DIR:-$HOME/.poc-ca}"
host=macpro16.local
base="https://$host:8443/fhir"
# curl that trusts only our CA and maps the host name to loopback (the port is loopback-bound until M4)
curlt() { curl -s --cacert "$tls_dir/ca.crt" --resolve "$host:8443:127.0.0.1" "$@"; }

echo "== TLS"
code=$(curlt -o /dev/null -w '%{http_code}' "$base/metadata")
if [ "$code" = "200" ]; then ok "GET /fhir/metadata over HTTPS with the POC CA (HTTP $code)"; tls_up=true
else bad "GET /fhir/metadata over HTTPS returned '$code'"; tls_up=false; fi

cax=$(openssl x509 -in "$tls_dir/ca.crt" -noout -text)
echo "$cax" | grep -q "X509v3 Name Constraints: critical" && ok "the POC CA carries a critical Name Constraints extension" || bad "the POC CA is NOT name-constrained (rerun make tls)"
echo "$cax" | grep -A3 "Name Constraints" | grep -q "DNS:$host" && ok "the CA permits only DNS:$host" || bad "the CA's permitted name is not $host"

# Negative checks mean something only if the positive control above passed (otherwise "refused" could just
# mean "HAPI is down"), and each must fail for the STATED reason: curl exit 60 = certificate not accepted.
if [ "$tls_up" = true ]; then
  curl -s -o /dev/null --resolve "$host:8443:127.0.0.1" "$base/metadata"; rc=$?
  [ "$rc" = "60" ] && ok "HTTPS fails without the POC CA (curl exit 60: certificate not trusted)" || bad "without the POC CA expected curl exit 60 (certificate rejected), got $rc"
  curl -s -o /dev/null --cacert "$tls_dir/ca.crt" --resolve "other.local:8443:127.0.0.1" "https://other.local:8443/fhir/metadata"; rc=$?
  [ "$rc" = "60" ] && ok "a different host name is rejected (curl exit 60: name mismatch, SAN enforced)" || bad "other host name: expected curl exit 60 (name mismatch), got $rc"
else
  skip "negative TLS checks (HTTPS is not up, so a refusal would prove nothing)"
fi

sclient() { echo | openssl s_client -connect 127.0.0.1:8443 -servername "$host" -CAfile "$tls_dir/ca.crt" "$@" 2>&1; }
# tls_result <s_client output> -> accepted | refused | unknown.
# "Verify return code: 0" is NOT evidence of success: a handshake the server aborts also prints it.
# Success means a real negotiated cipher ("Cipher is ECDHE-..."; a failure prints "Cipher is (NONE)");
# a server refusal is a protocol-version alert.
tls_result() {
  if echo "$1" | grep -qiE "alert protocol version|alert number 70"; then echo refused
  elif echo "$1" | grep -qE "Cipher is [A-Za-z0-9]"; then echo accepted
  else echo unknown; fi
}
out12=$(sclient -tls1_2)
if [ "$(tls_result "$out12")" = "accepted" ] && echo "$out12" | grep -q "Verify return code: 0"; then
  ok "TLS 1.2 handshake completes with a real cipher and the chain verifies"
  if openssl s_client -help 2>&1 | grep -q -e "-tls1_3"; then
    out13=$(sclient -tls1_3)
    [ "$(tls_result "$out13")" = "accepted" ] && ok "TLS 1.3 handshake completes" || bad "TLS 1.3 handshake did not complete"
  else
    skip "TLS 1.3 handshake (this openssl has no -tls1_3 option)"
  fi
  # TLS 1.1 must be refused BY THE SERVER (a protocol-version alert), not merely fail locally.
  if openssl s_client -help 2>&1 | grep -q -e "-tls1_1"; then
    case "$(tls_result "$(sclient -tls1_1)")" in
      refused)  ok "TLS 1.1 is refused by the server (protocol version alert)" ;;
      accepted) bad "TLS 1.1 was accepted (protocol floor not enforced)" ;;
      *)        skip "TLS 1.1 refusal inconclusive (no server alert; this openssl/OS policy may not offer TLS 1.1)" ;;
    esac
  else
    skip "TLS 1.1 refusal (this openssl has no -tls1_1 option)"
  fi
else
  bad "TLS 1.2 handshake did not complete with a verified chain"
fi

if openssl x509 -in "$tls_dir/server.crt" -noout -checkend $((30*86400)) > /dev/null; then
  ok "server certificate is valid for at least 30 more days ($(openssl x509 -in "$tls_dir/server.crt" -noout -enddate))"
else
  bad "server certificate expires within 30 days (rerun make tls)"
fi

# Positive control for the port probe: it must be able to see an open port before "closed" means anything.
if [ "$(tcp_state 127.0.0.1 8443)" = "open" ]; then ok "port probe works (127.0.0.1:8443 is open)"; probe_ok=true
else bad "port probe cannot see 127.0.0.1:8443 open (HAPI down, or the probe is broken)"; probe_ok=false; fi
if [ "$probe_ok" = true ]; then
  [ "$(tcp_state 127.0.0.1 8192)" = "closed" ] && ok "no plain-HTTP FHIR port (8192 is closed)" || bad "something still listens on 127.0.0.1:8192 (the old plain-HTTP port)"
else
  skip "plain-HTTP port check (the port probe failed its positive control)"
fi

echo "== FHIR round trip (synthetic Patient, over HTTPS)"
ident='http://blueysoft.com/fhir/identifier/poc-patient|poc-0001'
patient='{"resourceType":"Patient","identifier":[{"system":"http://blueysoft.com/fhir/identifier/poc-patient","value":"poc-0001"}],"name":[{"family":"Synthetic","given":["Poc"]}]}'
code=$(curlt -o /dev/null -w '%{http_code}' -X POST "$base/Patient" -H 'Content-Type: application/fhir+json' \
         -H "If-None-Exist: identifier=$ident" -d "$patient")
case "$code" in
  200|201) ok "conditional create Patient (HTTP $code)" ;;
  *)       bad "conditional create Patient returned HTTP $code" ;;
esac
# '|' must be URL-encoded: a raw '|' in the query is rejected with HTTP 400.
total=$(curlt -G "$base/Patient" --data-urlencode "identifier=$ident" --data-urlencode "_summary=count" -H 'Accept: application/fhir+json' \
          | python3 -c "import sys,json; print(json.load(sys.stdin).get('total'))" 2>/dev/null)
[ "$total" = "1" ] && ok "search finds exactly one synthetic Patient" || bad "search returned total='$total', expected 1"

echo "== network exposure"
for pair in "oracle 1521" "hapi 8443"; do
  set -- $pair
  mapping=$(dc port "$1" "$2" 2>/dev/null)
  case "$mapping" in
    127.0.0.1:*) ok "$1:$2 is published on loopback only ($mapping)" ;;
    "")          bad "$1:$2 is not published" ;;
    *)           bad "$1:$2 is published beyond loopback ($mapping)" ;;
  esac
done
ips=$(host_ips)
if [ -z "$ips" ]; then
  skip "LAN exposure checks (no non-loopback IPv4 address found); check by hand"
elif [ "$probe_ok" != true ]; then
  skip "LAN exposure checks (the port probe failed its positive control)"
else
  for ip in $ips; do
    for port in 8443 8192 1522; do
      [ "$(tcp_state "$ip" "$port")" = "closed" ] && ok "$ip refuses $port" || bad "$ip accepts connections on $port"
    done
  done
fi

echo "== IdP (M3a): Keycloak behind the allowlist proxy"
if ! docker ps --format '{{.Names}}' | grep -q '^spezi-poc-idp-edge$'; then
  skip "IdP checks (the IdP containers are not running; start the stack with make stack-up)"
else
  idp_health() { docker inspect -f '{{.State.Health.Status}}' "$(dc ps -q "$1")" 2>/dev/null; }
  for svc in keycloak idp-edge; do
    [ "$(idp_health $svc)" = healthy ] && ok "$svc is healthy" || bad "$svc health is '$(idp_health $svc)'"
  done
  curle() { curl -s --cacert "$tls_dir/ca.crt" --resolve "$host:8444:127.0.0.1" "$@"; }
  code=$(curle -o /dev/null -w '%{http_code}' "https://$host:8444/ping")
  if [ "$code" = "200" ]; then
    ok "GET /ping over HTTPS on 8444 with the POC CA (HTTP $code)"
    curl -s -o /dev/null --resolve "$host:8444:127.0.0.1" "https://$host:8444/ping"; rc=$?
    [ "$rc" = "60" ] && ok "8444 fails without the POC CA (curl exit 60)" || bad "8444 without the POC CA: expected curl exit 60, got $rc"
    curl -s -o /dev/null --cacert "$tls_dir/ca.crt" --resolve "other.local:8444:127.0.0.1" "https://other.local:8444/ping"; rc=$?
    [ "$rc" = "60" ] && ok "8444 rejects a different host name (curl exit 60, SAN enforced)" || bad "8444 other host name: expected curl exit 60, got $rc"
  else
    bad "GET /ping on 8444 returned '$code' (is the proxy up?)"
  fi
  sclient_p() { local port=$1; shift; echo | openssl s_client -connect "127.0.0.1:$port" -servername "$host" -CAfile "$tls_dir/ca.crt" "$@" 2>&1; }
  o12=$(sclient_p 8444 -tls1_2)
  if [ "$(tls_result "$o12")" = "accepted" ] && echo "$o12" | grep -q "Verify return code: 0"; then
    ok "8444: TLS 1.2 completes with a verified chain"
    if openssl s_client -help 2>&1 | grep -q -e "-tls1_3"; then
      [ "$(tls_result "$(sclient_p 8444 -tls1_3)")" = "accepted" ] && ok "8444: TLS 1.3 completes" || bad "8444: TLS 1.3 did not complete"
    else skip "8444: TLS 1.3 (this openssl has no -tls1_3 option)"; fi
    if openssl s_client -help 2>&1 | grep -q -e "-tls1_1"; then
      case "$(tls_result "$(sclient_p 8444 -tls1_1)")" in
        refused)  ok "8444: TLS 1.1 refused by the server" ;;
        accepted) bad "8444: TLS 1.1 was accepted" ;;
        *)        skip "8444: TLS 1.1 refusal inconclusive" ;;
      esac
    else skip "8444: TLS 1.1 refusal (this openssl has no -tls1_1 option)"; fi
  else
    bad "8444: TLS 1.2 handshake did not complete with a verified chain"
  fi
  if out=$(./idp/verify-allowlist.sh 8444 127.0.0.1 2>&1); then ok "allowlist suite via loopback ($(echo "$out" | grep -c '^ok') checks)"
  else bad "allowlist suite via loopback failed:"; echo "$out" | grep '^FAIL' | sed 's/^/        /'; fi
  # Host-port bindings of the Keycloak container; `compose port` is unreliable for this (it prints an error for an unpublished port).
  kc_bound=$(docker inspect -f '{{range $p,$b := .NetworkSettings.Ports}}{{if $b}}{{$p}} {{end}}{{end}}' "$(dc ps -q keycloak)" 2>/dev/null)
  [ -z "$kc_bound" ] && ok "Keycloak publishes no host port" || bad "Keycloak has published ports: $kc_bound"
  nginx_img=nginx@sha256:4a73073bd557c65b759505da037898b61f1be6cbcc3c2c3aeac22d2a470c1752
  if docker image inspect "$nginx_img" >/dev/null 2>&1; then
    peer() { docker run --rm --pull never --network spezi-poc_default --entrypoint sh "$nginx_img" -c "nc -z -w 3 keycloak $1 >/dev/null 2>&1 && echo reachable || echo refused"; }
    if [ "$(peer 8443)" = "reachable" ]; then
      ok "positive control: another container reaches keycloak:8443"
      [ "$(peer 9000)" = "refused" ] && ok "Keycloak's management port 9000 is NOT reachable from other containers" || bad "keycloak:9000 is reachable from another container"
    else bad "positive control failed: keycloak:8443 not reachable from another container"; fi
  else skip "management-port reachability (the pinned nginx image is not local)"; fi
  if [ "$probe_ok" = true ]; then
    # 8444 is the one endpoint meant to be network-reachable. Docker serves the LAN interface but not every
    # interface (a VPN tunnel is not served), so require at least ONE address to serve it and run the
    # allowlist suite on every address that does; addresses that do not serve it are reported, not failed.
    served=0
    for ip in $(host_ips); do
      if [ "$(tcp_state "$ip" 8444)" = "open" ]; then
        served=$((served+1)); ok "$ip serves 8444 (the one intended network endpoint)"
        if out=$(./idp/verify-allowlist.sh 8444 "$ip" 2>&1); then ok "allowlist suite via $ip ($(echo "$out" | grep -c '^ok') checks)"
        else bad "allowlist suite via $ip failed:"; echo "$out" | grep '^FAIL' | sed 's/^/        /'; fi
      else
        echo "info - $ip does not serve 8444 (not required: not the interface a phone would use)"
      fi
    done
    [ "$served" -ge 1 ] && ok "8444 is reachable on $served non-loopback address(es)" || bad "8444 is not reachable on any non-loopback address (a phone could not reach it)"
  else skip "IdP LAN checks (the port probe failed its positive control)"; fi
fi

echo
if [ "$fail" -eq 0 ]; then
  echo "ALL CHECKS PASSED ($skipped skipped)"; [ "$skipped" -gt 0 ] && echo "Skipped checks did NOT run: read the SKIP lines above."
else
  echo "SOME CHECKS FAILED ($skipped skipped)"
fi
exit "$fail"
