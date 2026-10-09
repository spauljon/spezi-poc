#!/usr/bin/env python3
"""HAPI token verification and authorization: seed and end-to-end checks (M4).

  python3 hapi/auth.py seed    create-or-find the one synthetic Patient using a capture-writer token; print its id
  python3 hapi/auth.py check   run the authentication/authorization matrix; exit 1 on any FAIL

Real tokens come from the POC realm through the public proxy (idp/oidc.py). Tokens go to curl on STDIN, never on a
command line. Python 3.6+, standard library plus the system curl and openssl. Synthetic data only.

Coverage note, stated so nobody assumes more: an EXPIRED token and a WRONG-AUDIENCE/ISSUER token cannot be minted by
this realm on demand (every client gets the right audience; lifetime is 600 s). Those rules are proved by the unit
tests that run in the image build (hapi/ext JwtVerifierTest, each with a positive control). Here, forged tokens
(tampered, role-swapped, alg=none, attacker-signed with a copied kid and claims) prove the signature check end to end.
"""
import base64, importlib.util, json, os, subprocess, sys, tempfile, urllib.parse

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("oidc", os.path.join(HERE, "..", "idp", "oidc.py"))
oidc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(oidc)

HOST = "macpro16.local"
PORT = int(os.environ.get("POC_HAPI_PORT", "8443"))
CONNECT_TO = os.environ.get("POC_HAPI_CONNECT", "127.0.0.1")   # where the name resolves to for this check
ORIGIN = "https://%s:%d" % (HOST, PORT)
BASE = ORIGIN + "/fhir"
TLS_DIR = os.environ.get("POC_TLS_DIR", os.path.expanduser("~/.poc-ca"))
PATIENT_SYSTEM = "http://blueysoft.com/fhir/identifier/poc-patient"
PATIENT_VALUE = "poc-0001"
OBS_SYSTEM = "http://blueysoft.com/fhir/identifier/poc-observation"
OBS_VALUE = "auth-check-0001"
DEVICE_SYSTEM = "http://blueysoft.com/fhir/identifier/poc-device"
DEVICE_VALUE = "auth-check-device-0001"
TAG_SYSTEM = "http://blueysoft.com/fhir/tag"


def call(method, url, token=None, body=None, headers=None, raw_auth=None):
    """Return (status, body_text). The Authorization header travels on curl's stdin (curl --config -)."""
    cfg = ['url = "%s"' % url, 'request = "%s"' % method, 'header = "Accept: application/fhir+json"']
    auth = raw_auth if raw_auth is not None else (("Bearer " + token) if token else None)
    if auth is not None:
        cfg.append('header = "Authorization: %s"' % auth)
    for k, v in (headers or {}).items():
        cfg.append('header = "%s: %s"' % (k, v))
    cmd = ["curl", "-s", "--max-time", "30", "--path-as-is", "--cacert", os.path.join(TLS_DIR, "ca.crt"),
           "--resolve", "%s:%d:%s" % (HOST, PORT, CONNECT_TO), "-w", "\n%{http_code}", "--config", "-"]
    tmp = None
    if body is not None:
        tmp = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False)
        tmp.write(body if isinstance(body, str) else json.dumps(body))
        tmp.close()
        cmd += ["--data-binary", "@" + tmp.name]
        cfg.append('header = "Content-Type: application/fhir+json"')
    try:
        p = subprocess.run(cmd, input=("\n".join(cfg) + "\n").encode(), stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    finally:
        if tmp:
            os.unlink(tmp.name)
    out = p.stdout.decode("utf-8", "replace")
    text, _, code = out.rpartition("\n")
    return (int(code) if code.isdigit() else 0), text


def token(who):
    status, data = oidc.fetch_token(who)
    if status != 200 or "access_token" not in data:
        sys.exit("cannot get a %s token (%s %s); is the stack up?" % (who, status, data.get("error")))
    return data["access_token"]


def b64(obj):
    return base64.urlsafe_b64encode(json.dumps(obj, separators=(",", ":")).encode()).rstrip(b"=").decode()


def parts(tok):
    h, p, s = tok.split(".")
    pad = lambda x: x + "=" * (-len(x) % 4)
    return json.loads(base64.urlsafe_b64decode(pad(h))), json.loads(base64.urlsafe_b64decode(pad(p))), s


def patient_resource():
    return {"resourceType": "Patient",
            "identifier": [{"system": PATIENT_SYSTEM, "value": PATIENT_VALUE}],
            "name": [{"family": "Synthetic", "given": ["Poc"]}]}


def seed(tok):
    ident = "%s|%s" % (PATIENT_SYSTEM, PATIENT_VALUE)
    status, text = call("POST", BASE + "/Patient", tok, patient_resource(), {"If-None-Exist": "identifier=" + ident})
    if status not in (200, 201):
        return None, status
    if status == 201:
        return json.loads(text)["id"], status
    # 200 = already exists: find it
    q = urllib.parse.urlencode({"identifier": ident, "_elements": "id"})
    st, t = call("GET", BASE + "/Patient?" + q, tok)
    entries = json.loads(t).get("entry", []) if st == 200 else []
    return (entries[0]["resource"]["id"] if len(entries) == 1 else None), status


def observation(patient_id):
    return {"resourceType": "Observation", "status": "final",
            "meta": {"tag": [{"system": TAG_SYSTEM, "code": "auth-check", "display": "Created by hapi/auth.py check; synthetic"}]},
            "identifier": [{"system": OBS_SYSTEM, "value": OBS_VALUE}],
            "category": [{"coding": [{"system": "http://terminology.hl7.org/CodeSystem/observation-category", "code": "vital-signs"}]}],
            "code": {"coding": [{"system": "http://loinc.org", "code": "8867-4", "display": "Heart rate"}]},
            "subject": {"reference": "Patient/" + patient_id},
            "effectiveDateTime": "2026-01-01T00:00:00Z",
            "valueQuantity": {"value": 60, "unit": "beats/minute", "system": "http://unitsofmeasure.org", "code": "/min"}}


def txn_entry(patient_id):
    """A well-formed transaction entry (R4 needs fullUrl when the resource has relative references), so a 403 below
    can only come from authorization, not from validation."""
    return {"fullUrl": "urn:uuid:11111111-2222-4333-8444-555555555555", "request": {"method": "POST", "url": "Observation"},
            "resource": observation(patient_id)}


FAILS = []


def expect(label, got, want):
    want = want if isinstance(want, (list, tuple, set)) else [want]
    if got in want:
        print("ok   - %s (HTTP %s)" % (label, got))
    else:
        print("FAIL - %s: got HTTP %s, wanted %s" % (label, got, "/".join(str(w) for w in want)))
        FAILS.append(label)


def cmd_seed():
    pid, status = seed(token("capture"))
    if pid is None:
        sys.exit("seed failed (HTTP %s)" % status)
    print("Patient/%s (HTTP %s)" % (pid, status))
    return 0


def cmd_check():
    cap, cli, wrk = token("capture"), token("clinician"), token("worker")

    print("== positive controls first: each probe must be able to see a success")
    st, _ = call("GET", BASE + "/metadata")
    expect("GET /fhir/metadata without a token is served", st, 200)
    pid, st = seed(cap)
    expect("capture-writer: conditional create Patient", st, [200, 201])
    if pid is None:
        print("FAIL - cannot continue without the seeded Patient")
        return 1
    st, _ = call("GET", BASE + "/Patient/" + pid, cli)
    expect("clinician-reader: read Patient/%s" % pid, st, 200)

    print("== no credentials")
    for label, m, path, body in (("GET Patient", "GET", "/Patient", None), ("GET Observation search", "GET", "/Observation?code=8867-4", None),
                                 ("POST Patient", "POST", "/Patient", patient_resource()),
                                 ("POST transaction at the base", "POST", "", {"resourceType": "Bundle", "type": "transaction", "entry": []})):
        st, _ = call(m, BASE + path, None, body)
        expect("no token: " + label + " is refused", st, 401)
    head = subprocess.run(["curl", "-s", "-i", "--cacert", os.path.join(TLS_DIR, "ca.crt"), "--resolve", "%s:%d:%s" % (HOST, PORT, CONNECT_TO),
                           BASE + "/Patient"], stdout=subprocess.PIPE).stdout.decode().lower()
    expect("the 401 carries a Bearer challenge", 401 if "www-authenticate: bearer" in head and " 401" in head.split("\r\n")[0] else 0, 401)

    print("== malformed or forged credentials (every one must be refused with 401, none with 403/200)")
    for label, raw in (("garbage bearer", "Bearer abc.def.ghi"), ("not a JWT at all", "Bearer x"), ("Basic scheme", "Basic dXNlcjpwYXNz"),
                       ("empty bearer", "Bearer "), ("two tokens", "Bearer a b")):
        st, _ = call("GET", BASE + "/Patient", raw_auth=raw)
        expect(label, st, 401)
    st, _ = call("GET", BASE + "/metadata", raw_auth="Bearer abc.def.ghi")
    expect("garbage bearer is refused even on /metadata (a presented token must be valid)", st, 401)

    h, p, s = parts(cli)
    flipped = cli[:-4] + ("AAAA" if not cli.endswith("AAAA") else "BBBB")
    st, _ = call("GET", BASE + "/Patient", flipped)
    expect("real clinician token with its signature altered", st, 401)
    p2 = dict(p); p2["roles"] = ["capture-writer"]
    st, _ = call("POST", BASE + "/Patient", "%s.%s.%s" % (b64(h), b64(p2), s), patient_resource())
    expect("clinician token with its roles rewritten to capture-writer (signature kept)", st, 401)
    st, _ = call("GET", BASE + "/Patient", "%s.%s." % (b64({"alg": "none", "typ": "JWT"}), b64(p)))
    expect("alg=none token carrying the clinician's real claims", st, 401)
    # attacker-signed: same kid, same claims, RS256 with the attacker's own key
    with tempfile.TemporaryDirectory() as d:
        key = os.path.join(d, "k.pem"); sigf = os.path.join(d, "sig"); msg = os.path.join(d, "msg")
        subprocess.run(["openssl", "genrsa", "-out", key, "2048"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
        signing_input = "%s.%s" % (b64(h), b64(p))
        open(msg, "w").write(signing_input)
        subprocess.run(["openssl", "dgst", "-sha256", "-sign", key, "-out", sigf, msg], check=True)
        sig = base64.urlsafe_b64encode(open(sigf, "rb").read()).rstrip(b"=").decode()
    st, _ = call("GET", BASE + "/Patient", "%s.%s" % (signing_input, sig))
    expect("attacker-signed token with the real kid and the real claims", st, 401)

    print("== authentication comes BEFORE request validation (HAPI 7.6.0 validates single resources before its stock authorization hook)")
    bad_bodies = (("Patient with an unknown field", "/Patient", {"resourceType": "Patient", "bogusField": 1}),
                  ("Patient with a code outside its value set", "/Patient", {"resourceType": "Patient", "gender": "banana"}),
                  ("Observation missing required elements", "/Observation", {"resourceType": "Observation"}),
                  ("Patient with an invalid date", "/Patient", {"resourceType": "Patient", "birthDate": "not-a-date"}),
                  ("JSON that does not parse as FHIR (empty array)", "", {"resourceType": "Bundle", "type": "transaction", "entry": []}),
                  ("a body that is not JSON", "/Patient", "this is not json"))
    for label, path, body in bad_bodies:
        st, text = call("POST", BASE + path, None, body)
        leaked = "diagnostics" in text and "Authentication required" not in text
        expect("no token, invalid body (%s): 401 and no validator output" % label, 401 if (st == 401 and not leaked) else st, 401)
    # control: the validator is still ON, so the 401s above are not just "validation is disabled"
    st, text = call("POST", BASE + "/Patient", cap, {"resourceType": "Patient", "bogusField": 1})
    expect("control: the same invalid Patient WITH a valid token is rejected by the validator", st, 422)

    print("== capture-writer: create and read Observation, Device, Patient; nothing else")
    st, _ = call("POST", BASE + "/Observation", cap, observation(pid), {"If-None-Exist": "identifier=%s|%s" % (OBS_SYSTEM, OBS_VALUE)})
    expect("create Observation (synthetic heart-rate sample, tagged auth-check)", st, [200, 201])
    st, _ = call("GET", BASE + "/Observation?" + urllib.parse.urlencode({"subject": "Patient/" + pid, "code": "http://loinc.org|8867-4"}), cap)
    expect("search Observation", st, 200)
    st, _ = call("POST", BASE + "/Device", cap, {"resourceType": "Device", "status": "active",
                                                  "identifier": [{"system": DEVICE_SYSTEM, "value": DEVICE_VALUE}],
                                                  "deviceName": [{"name": "Synthetic device", "type": "user-friendly-name"}]},
                 {"If-None-Exist": "identifier=%s|%s" % (DEVICE_SYSTEM, DEVICE_VALUE)})
    expect("create Device (conditional, so reruns do not accumulate)", st, [200, 201])
    st, _ = call("PUT", BASE + "/Patient/" + pid, cap, dict(patient_resource(), id=pid))
    expect("update Patient is refused", st, 403)
    st, _ = call("DELETE", BASE + "/Patient/" + pid, cap)
    expect("delete Patient is refused", st, 403)
    st, _ = call("POST", BASE + "/Encounter", cap, {"resourceType": "Encounter", "status": "finished", "class": {"code": "AMB"}})
    expect("create a type outside Observation/Device/Patient is refused", st, 403)
    st, _ = call("GET", BASE + "/Encounter", cap)
    expect("read a type outside Observation/Device/Patient is refused", st, 403)
    st, _ = call("POST", BASE + "", cap, {"resourceType": "Bundle", "type": "transaction", "entry": [txn_entry(pid)]})
    expect("transaction bundle is refused (no transaction rule yet; the upload milestone decides)", st, 403)

    for who, tok in (("clinician-reader", cli), ("worker-reader", wrk)):
        print("== %s: read-only" % who)
        st, _ = call("GET", BASE + "/Patient?" + urllib.parse.urlencode({"identifier": "%s|%s" % (PATIENT_SYSTEM, PATIENT_VALUE)}), tok)
        expect("search Patient", st, 200)
        st, _ = call("GET", BASE + "/Observation?" + urllib.parse.urlencode({"subject": "Patient/" + pid, "_sort": "-date", "_count": "5"}), tok)
        expect("search Observation (sort, page)", st, 200)
        st, _ = call("GET", BASE + "/Observation/$lastn?" + urllib.parse.urlencode({"subject": "Patient/" + pid, "category": "vital-signs"}), tok)
        expect("Observation/$lastn", st, 200)
        st, _ = call("POST", BASE + "/Observation", tok, observation(pid))
        expect("POST Observation is refused", st, 403)
        st, _ = call("POST", BASE + "/Patient", tok, patient_resource())
        expect("POST Patient is refused", st, 403)
        st, _ = call("PUT", BASE + "/Patient/" + pid, tok, dict(patient_resource(), id=pid))
        expect("PUT Patient is refused", st, 403)
        st, _ = call("DELETE", BASE + "/Patient/" + pid, tok)
        expect("DELETE Patient is refused", st, 403)
        st, _ = call("POST", BASE + "", tok, {"resourceType": "Bundle", "type": "transaction", "entry": [txn_entry(pid)]})
        expect("a transaction smuggling a create is refused", st, 403)
        st, _ = call("GET", BASE + "/Patient/$expunge", tok)
        expect("$expunge (an admin operation) is refused", st, [403, 405, 400, 404])

    print("== nothing outside /fhir answers (unused web endpoints are removed, not guarded), with or without a valid token")
    for path in ("/", "/control/jobs?pageStart=0&batchSize=2", "/v3/api-docs", "/swagger-ui/index.html", "/actuator/health", "/fhir/swagger-ui/",
                 "/fhir/../control/jobs", "/fhir/%2e%2e/control/jobs", "//control/jobs", "/resources/js/jquery.min.js"):
        for label, tok in (("no token", None), ("valid token", cap)):
            st, _ = call("GET", ORIGIN + path, tok)
            # under /fhir the FHIR servlet may answer 401 first; everything else must simply not exist
            expect("GET %s (%s) is not served" % (path, label), st, [404, 400] if not path.startswith("/fhir/swagger") else [404, 400, 401])
    for m, path in (("DELETE", "/control/jobs?jobId=x"), ("GET", "/control/jobs")):
        st, _ = call(m, ORIGIN + path, cap)
        expect("%s %s (valid token) is not served" % (m, path), st, [404, 400])
    # odd spellings of a protected path must never return data without a token
    for path in ("/fhir/./Patient", "/fhir//Patient", "/fhir/Patient;x=1", "/fhir/%50atient", "/fhir/Patient/", "/FHIR/Patient"):
        st, _ = call("GET", ORIGIN + path, None)
        expect("GET %s without a token returns no data" % path, st, [401, 400, 404])

    print()
    print("ALL AUTH CHECKS PASSED" if not FAILS else "SOME AUTH CHECKS FAILED (%d)" % len(FAILS))
    return 1 if FAILS else 0


if __name__ == "__main__":
    if len(sys.argv) != 2 or sys.argv[1] not in ("seed", "check"):
        sys.exit(__doc__)
    sys.exit(cmd_seed() if sys.argv[1] == "seed" else cmd_check())
