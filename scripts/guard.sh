#!/usr/bin/env bash
# Data-leak guard. A BACKSTOP, not proof: it catches obvious real-data and secret
# patterns before they are committed. It cannot recognize real health values.
#
# Usage:
#   scripts/guard.sh          scan staged files (used by the pre-commit hook)
#   scripts/guard.sh --all    scan all non-ignored files in the working tree
#
# A line containing the marker  guard:allow  is skipped (use sparingly, with a reason).
# Files under scripts/ are not content-scanned (they contain the patterns themselves).

set -u
mode="${1:-staged}"
root="$(git rev-parse --show-toplevel)" || exit 2
cd "$root" || exit 2

if [ "$mode" = "--all" ]; then
  files="$(git ls-files -co --exclude-standard)"
else
  files="$(git diff --cached --name-only --diff-filter=ACM)"
fi

[ -z "$files" ] && exit 0

fail=0
report() { echo "guard: BLOCKED: $1" >&2; fail=1; }

# 1. Filenames that should never be committed
name_re='(^|/)(export\.xml|export_cda\.xml|apple_health_export[^/]*|id_rsa|id_ed25519)$|\.(pem|key|p12|pfx|jks|keystore|mobileprovision)$|(^|/)\.env($|\.[^/]*$)'
while IFS= read -r f; do
  [ -z "$f" ] && continue
  case "$f" in *.env.example|*/.env.example|.env.example) continue ;; esac
  if printf '%s' "$f" | grep -Eq "$name_re"; then
    report "file name looks like a secret or health export: $f"
  fi
done <<EOF
$files
EOF

# 2. Content patterns (text files only)
key_re='-----BEGIN [A-Z ]*PRIVATE KEY-----'
aws_re='AKIA[0-9A-Z]{16}'
jwt_re='eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}'
bearer_re='[Aa]uthorization: *[Bb]earer +[A-Za-z0-9._~+/=-]{20,}'
cred_re='(password|passwd|secret|api[_-]?key|token)[A-Za-z_]* *[:=] *["'"'"'][^"'"'"' ]{8,}["'"'"']'
hk_re='<(Record type="HK|HealthData |ClinicalRecord )'

while IFS= read -r f; do
  [ -z "$f" ] && continue
  case "$f" in scripts/*) continue ;; esac
  [ -f "$f" ] || continue
  if [ "$mode" = "--all" ]; then content_cmd=(cat -- "$f"); else content_cmd=(git show ":$f"); fi
  text="$("${content_cmd[@]}" 2>/dev/null | grep -Iv 'guard:allow')" || true
  [ -z "$text" ] && continue
  for pair in "private key:$key_re" "AWS access key:$aws_re" "JWT:$jwt_re" "bearer token:$bearer_re" "credential assignment:$cred_re" "Apple Health export content:$hk_re"; do
    label="${pair%%:*}"; re="${pair#*:}"
    if printf '%s\n' "$text" | grep -Eq -- "$re"; then
      report "$label pattern in $f"
    fi
  done
done <<EOF
$files
EOF

if [ "$fail" -ne 0 ]; then
  echo "guard: commit blocked. Remove the content, or add 'guard:allow' on a line that is a safe false positive." >&2
  exit 1
fi
exit 0
