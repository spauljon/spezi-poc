#!/bin/bash
# M1+M2 verification for a RUNNING stack (compose project spezi-poc, see compose.yaml).
# Run after: make stack-up. Synthetic data only.
# Addresses services through `docker compose` (project namespace), never by container name.
# Exits non-zero if any check fails. UNTESTED until you run it.
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
dc() { ./scripts/compose.sh "$@"; }

fail=0
ok()   { echo "ok   - $1"; }
bad()  { echo "FAIL - $1"; fail=1; }
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

# --- TLS (M2): HAPI serves HTTPS only, from a certificate signed by the local CA ---------------------
tls_dir="${POC_TLS_DIR:-$HOME/.poc-ca}"
host=macpro16.local
base="https://$host:8443/fhir"
# curl that trusts only our CA and maps the host name to loopback (the port is loopback-bound until M4)
curlt() { curl -s --cacert "$tls_dir/ca.crt" --resolve "$host:8443:127.0.0.1" "$@"; }

echo "== TLS"
code=$(curlt -o /dev/null -w '%{http_code}' "$base/metadata")
[ "$code" = "200" ] && ok "GET /fhir/metadata over HTTPS with the POC CA (HTTP $code)" || bad "GET /fhir/metadata over HTTPS returned '$code'"
if curl -s -o /dev/null --resolve "$host:8443:127.0.0.1" "$base/metadata"; then bad "HTTPS succeeds WITHOUT the POC CA (system store trusts it?)"; else ok "HTTPS fails without the POC CA (not in the system trust store)"; fi
if curl -s -o /dev/null --cacert "$tls_dir/ca.crt" --resolve "other.local:8443:127.0.0.1" "https://other.local:8443/fhir/metadata"; then bad "a different host name was accepted (hostname verification is off?)"; else ok "a different host name is rejected (SAN is enforced)"; fi
sclient() { echo | openssl s_client -connect 127.0.0.1:8443 -servername "$host" -CAfile "$tls_dir/ca.crt" "$@" 2>&1; }
sclient -tls1_2 | grep -q "Verify return code: 0" && ok "TLS 1.2 handshake works and the chain verifies" || bad "TLS 1.2 handshake or chain verification failed"
sclient -tls1_1 | grep -q "Verify return code: 0" && bad "TLS 1.1 was accepted (protocol floor not enforced)" || ok "TLS 1.1 is refused"
days=$(python3 - "$tls_dir/server.crt" <<'PY'
import subprocess,sys,datetime
out=subprocess.check_output(['openssl','x509','-in',sys.argv[1],'-noout','-enddate']).decode().strip().split('=',1)[1]
print((datetime.datetime.strptime(out,'%b %d %H:%M:%S %Y %Z')-datetime.datetime.utcnow()).days)
PY
)
[ "${days:-0}" -ge 30 ] && ok "server certificate has $days days left" || bad "server certificate expires in '${days}' days (rerun make tls)"
if nc -z -G 2 127.0.0.1 8192 >/dev/null 2>&1; then bad "something still listens on 127.0.0.1:8192 (the old plain-HTTP port)"; else ok "no plain-HTTP FHIR port (8192 is closed)"; fi

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
lan=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)
if [ -n "$lan" ]; then
  for port in 8443 8192 1522; do
    if nc -z -G 2 "$lan" "$port" >/dev/null 2>&1; then bad "LAN address $lan accepts connections on $port"; else ok "LAN address $lan refuses $port"; fi
  done
else
  echo "skip - could not determine the LAN address (check by hand)"
fi

echo
[ "$fail" -eq 0 ] && echo "ALL CHECKS PASSED" || echo "SOME CHECKS FAILED"
exit "$fail"
