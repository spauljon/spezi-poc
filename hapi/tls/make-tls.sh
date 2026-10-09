#!/usr/bin/env bash
# Creates (once) a local CA, a server certificate for the POC host, and the PKCS12 keystore HAPI
# serves TLS from. Idempotent: reuses what exists, regenerates the server cert if it is missing
# or expires within 30 days. Nothing here is committed: keys live outside the repo.
#
#   ~/.poc-ca/ca.key, ca.crt          the CA (key mode 600, NEVER mounted into a container)
#   ~/.poc-ca/server.key, server.crt  the server leaf key and certificate
#   ~/.poc-ca/hapi/server.p12         keystore mounted read-only into the HAPI container
#
# The keystore password is generated and written to hapi/.env.local (gitignored) as
# TLS_KEYSTORE_PASSWORD. Override the location with POC_TLS_DIR, the host name with POC_TLS_HOST.
#
# The CA is NAME-CONSTRAINED (critical): it may only vouch for ${POC_TLS_HOST} (and its subdomains),
# and for no IP address. Constraints live inside the CA certificate and cannot be amended, so a CA
# without them is retired (moved to ~/.poc-ca/retired-<timestamp>/, never deleted) and replaced.
# After every run a self-test proves the constraint is enforced.
# UNTESTED until the first run.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TLS_DIR="${POC_TLS_DIR:-$HOME/.poc-ca}"
HOST="${POC_TLS_HOST:-macpro16.local}"
ENV_FILE="${POC_ENV_FILE:-$ROOT/hapi/.env.local}"   # override only for tests

[ -f "$ENV_FILE" ] || { echo "hapi/.env.local is missing; run 'make stack-env' first" >&2; exit 1; }

umask 077
mkdir -p "$TLS_DIR/hapi"
chmod 700 "$TLS_DIR"
chmod 755 "$TLS_DIR/hapi"   # the keystore directory must be traversable by the container runtime
cd "$TLS_DIR"

# --- 0. retire a CA that is not name-constrained -----------------------------------------------
if [ -f ca.crt ] && ! openssl x509 -in ca.crt -noout -text | grep -q "X509v3 Name Constraints"; then
  old="retired-$(date +%Y%m%d%H%M%S)"
  mkdir "$old"
  for f in ca.key ca.crt server.key server.crt hapi/server.p12; do [ -e "$f" ] && mv "$f" "$old/$(basename "$f")"; done
  echo "The existing CA has no name constraints; retired it to $TLS_DIR/$old/ and creating a constrained one."
fi

# --- 1. the CA (once) ---------------------------------------------------------------------------
if [ ! -f ca.key ] || [ ! -f ca.crt ]; then
  echo "Creating the local CA ..."
  cat > ca.cnf <<EOF
[req]
distinguished_name = dn
prompt = no
x509_extensions = v3_ca
[dn]
CN = Spezi POC Local CA
[v3_ca]
basicConstraints = critical,CA:TRUE,pathlen:0
keyUsage = critical,keyCertSign,cRLSign
subjectKeyIdentifier = hash
nameConstraints = critical,permitted;DNS:${HOST},excluded;IP:0.0.0.0/0.0.0.0,excluded;IP:0:0:0:0:0:0:0:0/0:0:0:0:0:0:0:0
EOF
  openssl ecparam -name prime256v1 -genkey -noout -out ca.key
  openssl req -x509 -new -key ca.key -sha256 -days 3650 -config ca.cnf -out ca.crt
  rm -f ca.cnf
  chmod 600 ca.key; chmod 644 ca.crt
else
  echo "CA already exists, reusing it."
fi

# --- 2. the server certificate (when missing or expiring) ---------------------------------------
need_leaf=false
if [ ! -f server.key ] || [ ! -f server.crt ] || [ ! -f hapi/server.p12 ]; then
  need_leaf=true
elif ! openssl x509 -in server.crt -noout -checkend $((30*86400)) > /dev/null; then
  echo "Server certificate expires within 30 days; regenerating."
  need_leaf=true
fi

if [ "$need_leaf" = true ]; then
  echo "Creating the server certificate for ${HOST} ..."
  cat > leaf.cnf <<EOF
[v3_leaf]
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature
extendedKeyUsage = serverAuth
subjectAltName = DNS:${HOST}
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid
EOF
  openssl ecparam -name prime256v1 -genkey -noout -out server.key
  openssl req -new -key server.key -subj "/CN=${HOST}" -out server.csr
  openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
    -days 365 -sha256 -extfile leaf.cnf -extensions v3_leaf -out server.crt
  rm -f leaf.cnf server.csr ca.srl
  chmod 600 server.key; chmod 644 server.crt

  # --- 3. the keystore HAPI loads; password goes to the gitignored env file ----------------------
  pw="P$(openssl rand -hex 12)"
  openssl pkcs12 -export -inkey server.key -in server.crt -certfile ca.crt \
    -name poc-server -passout "pass:${pw}" -out hapi/server.p12
  chmod 644 hapi/server.p12   # password-protected; the password lives only in hapi/.env.local

  tmp="$(mktemp)"
  { grep -v '^TLS_KEYSTORE_PASSWORD=' "$ENV_FILE" || true; echo "TLS_KEYSTORE_PASSWORD=${pw}"; } > "$tmp"
  cat "$tmp" > "$ENV_FILE"; rm -f "$tmp"
  echo "Wrote hapi/server.p12 and TLS_KEYSTORE_PASSWORD (value not shown) to hapi/.env.local"
else
  echo "Server certificate is current ($(openssl x509 -in server.crt -noout -enddate))."
fi

# --- 4. self-test: the chain is valid AND the name constraint is actually enforced ---------------
openssl verify -CAfile ca.crt server.crt > /dev/null || { echo "self-test FAILED: server.crt does not verify against ca.crt" >&2; exit 1; }
t="$(mktemp -d)"; trap 'rm -rf "$t"' EXIT
printf '[v3]\nbasicConstraints = critical,CA:FALSE\nkeyUsage = critical,digitalSignature\nextendedKeyUsage = serverAuth\nsubjectAltName = DNS:evil.example\n' > "$t/e.cnf"
openssl ecparam -name prime256v1 -genkey -noout -out "$t/e.key"
openssl req -new -key "$t/e.key" -subj "/CN=evil.example" -out "$t/e.csr"
openssl x509 -req -in "$t/e.csr" -CA ca.crt -CAkey ca.key -CAcreateserial -CAserial "$t/ca.srl" -days 1 -sha256 \
  -extfile "$t/e.cnf" -extensions v3 -out "$t/e.crt" > /dev/null 2>&1
[ -s "$t/e.crt" ] || { echo "self-test FAILED: could not create the throwaway evil.example certificate" >&2; exit 1; }
if out="$(openssl verify -CAfile ca.crt "$t/e.crt" 2>&1)"; then
  echo "self-test FAILED: a certificate for evil.example verified; the CA is NOT constraining names" >&2; exit 1
fi
# It must be rejected BECAUSE of the name constraint, not for some unrelated reason.
echo "$out" | grep -qi "permitted subtree violation" \
  || { echo "self-test FAILED: rejected, but not by the name constraint: $out" >&2; exit 1; }
echo "self-test ok: chain valid; a certificate for another domain is rejected (permitted subtree violation)"

echo "CA certificate (install this on devices you want to trust): $TLS_DIR/ca.crt"
