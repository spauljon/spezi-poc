#!/usr/bin/env bash
# Accessibility check of the capture app's home screen from its accessibility tree (what TalkBack sees), over adb. No extra package.
#
#   ANDROID_SERIAL=<device> scripts/android-a11y-check.sh
#
# Opens the app, then dumps the UI hierarchy (`uiautomator dump`) at the top and after each scroll, and checks every control (a node that is
# clickable, checkable or long-clickable):
#   1. it has a name a screen reader can say: its own text or content description, or the text of something inside it;
#   2. its touch target is at least 48 x 48 dp (Android's minimum; the device's density is read from the device).
# Prints counts and the names of failing controls only, never the dump. Not covered here (a person must look): colour contrast, focus order,
# and how TalkBack reads each line; see "Accessibility" in docs/runbooks/android-device.md. Synthetic or the developer's own screen: the
# text on it is counts and words, but the dump is deleted from the phone and kept nowhere.
set -euo pipefail
adb="${ANDROID_HOME:-$HOME/Library/Android/sdk}/platform-tools/adb"
serial="${ANDROID_SERIAL:-}"
[ -n "$serial" ] || { echo "a11y: set ANDROID_SERIAL (adb devices lists the choices)" >&2; exit 2; }
a() { "$adb" -s "$serial" "$@"; }

a shell am start -n com.aboutobjects.healthgate/.MainActivity >/dev/null
sleep 3
density="$(a shell wm density | grep -oE '[0-9]+' | tail -n 1)"
size="$(a shell wm size | grep -oE '[0-9]+x[0-9]+' | tail -n 1)"
width="${size%x*}"; height="${size#*x}"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"; a shell rm -f /sdcard/hg-a11y.xml >/dev/null 2>&1 || true' EXIT

a shell input swipe $((width / 2)) $((height / 5)) $((width / 2)) $((height * 4 / 5)) 200 >/dev/null; sleep 1   # to the top
for page in $(seq 0 13); do
  a shell uiautomator dump /sdcard/hg-a11y.xml >/dev/null 2>&1
  a pull /sdcard/hg-a11y.xml "$tmp/page$page.xml" >/dev/null 2>&1
  a shell input swipe $((width / 2)) $((height * 7 / 10)) $((width / 2)) $((height * 4 / 10)) 400 >/dev/null; sleep 1   # a third of a screen at a time: each control is seen whole
done

python3 - "$tmp" "$density" "${A11Y_MIN_CONTROLS:-5}" <<'E'
import glob, re, sys, xml.etree.ElementTree as ET
tmp, density, minimum = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
dp = lambda px: px * 160 / density
# a control is measured at its LARGEST visible size over all the scroll positions (a control scrolled half under the status bar is clipped, not small)
best = {}

def text_inside(node):
    parts = [node.get("text", ""), node.get("content-desc", "")]
    for child in node.iter():
        parts += [child.get("text", ""), child.get("content-desc", "")]
    return " ".join(p for p in parts if p).strip()

for path in sorted(glob.glob(tmp + "/page*.xml")):
    for node in ET.parse(path).getroot().iter("node"):
        if node.get("package") != "com.aboutobjects.healthgate":
            continue
        if not any(node.get(a) == "true" for a in ("clickable", "checkable", "long-clickable")):
            continue
        m = re.match(r"\[(\d+),(\d+)\]\[(\d+),(\d+)\]", node.get("bounds", ""))
        if not m:
            continue
        x1, y1, x2, y2 = map(int, m.groups())
        name = text_inside(node)
        key = (name, x2 - x1) if name else ("", x2 - x1, "unnamed")
        w, h = dp(x2 - x1), dp(y2 - y1)
        old = best.get(key)
        if old is None or h > old[1]:
            best[key] = (w, h, name)
controls = len(best)
bad = []
for key, (w, h, name) in best.items():
    label = name or "(no name)"
    if not name:
        bad.append("a control of %.0f x %.0f dp has no name a screen reader can say" % (w, h))
    if w < 48 or h < 48:
        bad.append("'%s' is %.0f x %.0f dp (the minimum is 48 x 48)" % (label[:50], w, h))
print("controls checked: %d (each at its largest visible size over the scroll positions)" % controls)
if controls < minimum:
    print("FAIL - fewer than %d controls found: the screen was not read (is the app open and unlocked?)" % minimum)
    sys.exit(1)
for b in bad:
    print("FAIL - " + b)
print("ACCESSIBILITY CHECK PASSED" if not bad else "ACCESSIBILITY CHECK FAILED (%d)" % len(bad))
sys.exit(1 if bad else 0)
E
