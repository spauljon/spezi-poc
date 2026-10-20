#!/usr/bin/env bash
# Fails if a retired name of the iOS app is still in use: the template's "TemplateApplication" (module, folders, scheme)
# or the old bundle id "com.blueysoft.spezipoc" (redirect scheme, Keychain service), or the old FHIR namespace
# "blueysoft.com/fhir" (identifier and code systems; the Java package is com.aboutobjects too). The app is HealthGate.
#
# Allowed: the upstream project's own name ("SpeziTemplateApplication", "Spezi Template Application"), and the
# runbook section that explains moving from the old bundle id. Nothing else.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

pattern='TemplateApplication|com\.blueysoft|blueysoft\.com'
allowed_re='SpeziTemplateApplication|Spezi Template Application'
# Files that may mention the old names, with the reason.
skip_re='^(\.agents/|scripts/check-names\.sh$|docs/runbooks/ios-device\.md$)'

# $1 = newline-separated file list. Prints offending "file:line:text" and "path:" entries.
scan() {
  local files="$1" hits="" f
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    [[ "$f" =~ $skip_re ]] && continue
    if [[ "$f" =~ $pattern ]]; then hits+="$f: file or folder name"$'\n'; fi
    [ -f "$f" ] || continue
    grep -InE "$pattern" "$f" 2>/dev/null | grep -vE "$allowed_re" | sed "s|^|$f:|" || true
  done <<< "$files"
  printf '%s' "$hits"
}

# Positive control: the scan must see both retired names, and must let the upstream name through.
tmp="$(mktemp -d "${TMPDIR:-/tmp}/names.XXXXXX")"; trap 'rm -rf "$tmp"' EXIT
printf 'import TemplateApplication\n'  > "$tmp/a.txt"
printf 'com.blueysoft.spezipoc\n'      > "$tmp/b.txt"
printf 'http://blueysoft.com/fhir/x\n'  > "$tmp/d.txt"
printf 'Spezi Template Application\n'  > "$tmp/c.txt"
mkdir "$tmp/TemplateApplicationTests"; : > "$tmp/TemplateApplicationTests/x.txt"
seen="$(cd "$tmp" && root="" scan "$(printf 'a.txt\nb.txt\nc.txt\nd.txt\nTemplateApplicationTests/x.txt')")"
[ "$(printf '%s\n' "$seen" | grep -c .)" -eq 4 ] && ! printf '%s' "$seen" | grep -q 'c.txt' \
  || { echo "check-names: the control did not behave (got: $seen)" >&2; exit 2; }

files="$(git ls-files -co --exclude-standard)"
[ "$(printf '%s\n' "$files" | grep -c .)" -gt 100 ] || { echo "check-names: file list looks wrong" >&2; exit 2; }
bad="$(scan "$files")"
if [ -n "$bad" ]; then
  echo "check-names: retired app name still in use:" >&2
  printf '%s\n' "$bad" >&2
  exit 1
fi
echo "check-names: ok"
