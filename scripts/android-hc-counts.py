#!/usr/bin/env python3
"""What HAPI holds for the Android persona's Health Connect Observations: COUNTS ONLY (never a value), read as the clinician role.

  python3 scripts/android-hc-counts.py            all Health Connect Observations of poc-android-01 (the test patient), by metric, and the writer's share
  python3 scripts/android-hc-counts.py --patient poc-real-android   the same for another patient (M30: the real one)
  python3 scripts/android-hc-counts.py --history 2026-11-17T00:00:00Z   also the history entries since then, by method (POST create, PUT update, DELETE delete)

The "writer" share is the Observations whose Device was written by the synthetic test tool (:writer: manufacturer Synthetic, model Writer),
so a phone test can say exactly which Observations came from the tool's records. Needs the stack up and idp/.env.local. The token goes to
curl on stdin (see hapi/auth.py), never on a command line. Synthetic or the developer's own data only; this prints counts and metric names.
"""
import importlib.util, json, os, sys, urllib.parse

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("hapi_auth", os.path.join(HERE, "..", "hapi", "auth.py"))
auth = importlib.util.module_from_spec(spec)
spec.loader.exec_module(auth)

PATIENT = sys.argv[sys.argv.index("--patient") + 1] if "--patient" in sys.argv else auth.ANDROID_PATIENT_VALUE
CONTRACT = json.load(open(os.path.join(HERE, "..", "contract", "metrics.json")))
SYS = CONTRACT["systems"]["identifier"]
META_SOURCE = CONTRACT["systems"]["metaSource"]["healthConnect"]
NAMES = {}
for m in CONTRACT["metrics"]:
    if m.get("loinc"):
        NAMES[m["loinc"]["code"]] = m["id"]
    if m.get("customCode"):
        NAMES[m["customCode"]["code"]] = m["id"]
    for st in (m.get("stages") or {}).values():
        NAMES[st["code"]] = "sleepStage"


def get(path, tok):
    st, text = auth.call("GET", auth.BASE + path, tok, None, {"Cache-Control": "no-cache"})
    if st != 200:
        sys.exit("HAPI answered %s for %s" % (st, path.split("?")[0]))
    return json.loads(text)


def observations(tok, extra=""):
    """Every Observation of the persona from the Health Connect source, paged (counts need the codes only)."""
    pid = None
    b = get("/Patient?" + urllib.parse.urlencode({"identifier": "%s|%s" % (auth.PATIENT_SYSTEM, PATIENT), "_elements": "id"}), tok)
    ids = [e["resource"]["id"] for e in b.get("entry", [])]
    if len(ids) != 1:
        sys.exit("the Patient %s was not found exactly once (%d found)" % (PATIENT, len(ids)))
    pid = ids[0]
    url = "/Observation?" + urllib.parse.urlencode({"subject": "Patient/" + pid, "_source": META_SOURCE, "_count": "200", "_elements": "code,status,device,meta"}) + extra
    out = []
    while url:
        page = get(url, tok)
        out += [e["resource"] for e in page.get("entry", [])]
        nxt = [l["url"] for l in page.get("link", []) if l.get("relation") == "next"]
        url = nxt[0].split("/fhir", 1)[1] if nxt else None
    return out


def metric_of(obs):
    for c in obs.get("code", {}).get("coding", []):
        if c.get("code") in NAMES:
            return NAMES[c["code"]]
    return "other"


def main():
    tok = auth.token("clinician")
    allobs = observations(tok)
    writer = observations(tok, "&" + urllib.parse.urlencode({"device.manufacturer": "Synthetic", "device.model": "Writer"}))
    def tally(items):
        t = {}
        for o in items:
            key = (metric_of(o), o.get("status"))
            t[key] = t.get(key, 0) + 1
        return t
    for title, items in (("Health Connect Observations of " + PATIENT, allobs), ("of which written by the synthetic test tool", writer)):
        print("%s: %d" % (title, len(items)))
        for (metric, status), n in sorted(tally(items).items()):
            print("   %-22s %-17s %d" % (metric, status, n))
    if "--history" in sys.argv:
        # Observation/_history?_since=...: HAPI gives no `total` for a paged history, so count the entries, by HTTP method, following `next`
        since = sys.argv[sys.argv.index("--history") + 1] if len(sys.argv) > sys.argv.index("--history") + 1 else None
        if not since:
            sys.exit("usage: --history <UTC time>, for example --history 2026-11-17T00:00:00Z")
        url, counts = "/Observation/_history?" + urllib.parse.urlencode({"_since": since, "_count": "200"}), {}
        while url:
            page = get(url, tok)
            for e in page.get("entry", []):
                m = e.get("request", {}).get("method", "?")
                counts[m] = counts.get(m, 0) + 1
            nxt = [l["url"] for l in page.get("link", []) if l.get("relation") == "next"]
            url = nxt[0].split("/fhir", 1)[1] if nxt else None
        print("history entries of ALL Observations since %s: %s" % (since, ", ".join("%s %d" % kv for kv in sorted(counts.items())) or "none"))


if __name__ == "__main__":
    main()
