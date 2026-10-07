#!/usr/bin/env bash
# Verifies the data-leak guard blocks what it should and allows what it should.
# Runs in a temporary git repo; touches nothing in this repo.
set -u
here="$(cd "$(dirname "$0")" && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
cd "$tmp" && git init -q . && git config user.email t@example.invalid && git config user.name t
mkdir scripts && cp "$here/guard.sh" scripts/guard.sh

pass=0; failn=0
expect() { # expect <block|allow> <description>
  if ./scripts/guard.sh >/dev/null 2>&1; then got=allow; else got=block; fi
  if [ "$got" = "$1" ]; then echo "ok   - $2"; pass=$((pass+1)); else echo "FAIL - $2 (expected $1, got $got)"; failn=$((failn+1)); fi
  git reset -q; rm -f f.txt export.xml server.pem .env
}

# Strings are assembled from pieces so this file never contains a literal match.
printf '%s %s %s\n' '-----BEGIN' 'RSA PRIVATE' 'KEY-----' > f.txt; git add f.txt
expect block "private key header"

printf 'AK%s\n' 'IAABCDEFGHIJKLMNOP' > f.txt; git add f.txt
expect block "AWS-style access key"

printf 'client_secret = "%s"\n' 'abcdefgh12345678' > f.txt; git add f.txt
expect block "quoted credential assignment"

printf 'Authorization: Bearer %s\n' 'abcdefghijklmnopqrstuvwxyz012345' > f.txt; git add f.txt
expect block "bearer token"

printf '<Record type="HK%s" value="1"/>\n' 'QuantityTypeIdentifierHeartRate' > f.txt; git add f.txt
expect block "Apple Health export content"

echo x > export.xml; git add export.xml
expect block "export.xml file name"

echo x > server.pem; git add server.pem
expect block ".pem file name"

echo "TOKEN=abc" > .env; git add .env
expect block ".env file"

echo "TOKEN=" > .env.example; git add .env.example
expect allow ".env.example is allowed"; rm -f .env.example

printf 'client_secret = "%s" # guard:allow\n' 'abcdefgh12345678' > f.txt; git add f.txt
expect allow "guard:allow marker skips a line"

echo "resting heart rate sample (synthetic)" > f.txt; git add f.txt
expect allow "ordinary text"

echo "---"; echo "passed: $pass  failed: $failn"
[ "$failn" -eq 0 ]
