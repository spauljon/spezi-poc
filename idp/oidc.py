#!/usr/bin/env python3
"""OIDC helper and realm security checks for the POC IdP (https://macpro16.local:8444, realm poc).

  python3 idp/oidc.py token worker|capture|clinician [--raw]   fetch a token and print its decoded claims
                                                               (the raw token is printed only with --raw)
  python3 idp/oidc.py check                                    run the realm's security checks; exit 1 on any FAIL

Everything goes through the public proxy (the same path a phone or the web app uses), trusting only the POC CA.
Secrets are read from the gitignored idp/.env.local and sent to curl on STDIN, never on a command line.
Works on Python 3.6+. Uses only the standard library and the system curl.
"""
import base64, json, os, subprocess, sys, time, urllib.parse

HERE = os.path.dirname(os.path.abspath(__file__))
HOST = "macpro16.local"
PORT = int(os.environ.get("POC_IDP_PORT", "8444"))
BASE = "https://%s:%d" % (HOST, PORT)
ISSUER = BASE + "/realms/poc"
TLS_DIR = os.environ.get("POC_TLS_DIR", os.path.expanduser("~/.poc-ca"))
ENV_FILE = os.environ.get("POC_IDP_ENV_FILE", os.path.join(HERE, ".env.local"))
IOS_REDIRECT = "com.blueysoft.spezipoc:/oauth2redirect"
TOKEN_PATH = "/realms/poc/protocol/openid-connect/token"
AUTH_PATH = "/realms/poc/protocol/openid-connect/auth"


def load_env():
    env = {}
    with open(ENV_FILE) as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                env[k] = v
    return env


def http(method, path, form=None):
    """Return (status, headers{lower: value}, body_text). Never follows redirects."""
    cmd = ["curl", "-s", "-i", "--max-time", "20", "--cacert", os.path.join(TLS_DIR, "ca.crt"),
           "--resolve", "%s:%d:127.0.0.1" % (HOST, PORT), "-X", method, BASE + path]
    stdin = None
    if form is not None:
        cmd += ["-H", "Content-Type: application/x-www-form-urlencoded", "--data-binary", "@-"]
        stdin = urllib.parse.urlencode(form).encode()
    p = subprocess.run(cmd, input=stdin, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    raw = p.stdout.decode("utf-8", "replace")
    if not raw.startswith("HTTP/"):
        return 0, {}, raw
    head, _, body = raw.partition("\r\n\r\n")
    lines = head.split("\r\n")
    status = int(lines[0].split()[1])
    headers = {}
    for h in lines[1:]:
        if ":" in h:
            k, v = h.split(":", 1)
            headers[k.strip().lower()] = v.strip()
    return status, headers, body


def jwt_claims(token):
    payload = token.split(".")[1]
    payload += "=" * (-len(payload) % 4)
    return json.loads(base64.urlsafe_b64decode(payload.encode()).decode())


def as_list(v):
    return v if isinstance(v, list) else ([] if v is None else [v])


def fetch_token(who):
    env = load_env()
    if who == "worker":
        form = {"grant_type": "client_credentials", "client_id": "analytics-worker",
                "client_secret": env["POC_WORKER_CLIENT_SECRET"]}
    else:
        user = {"capture": ("capture-user", "POC_CAPTURE_USER_PASSWORD"),
                "clinician": ("clinician-user", "POC_CLINICIAN_USER_PASSWORD")}[who]
        form = {"grant_type": "password", "client_id": "poc-devtest", "username": user[0], "password": env[user[1]]}
    status, _, body = http("POST", TOKEN_PATH, form)
    try:
        data = json.loads(body)
    except ValueError:
        data = {"error": "non-json response", "status": status}
    return status, data


def cmd_token(argv):
    if not argv or argv[0] not in ("worker", "capture", "clinician"):
        sys.exit("usage: oidc.py token worker|capture|clinician [--raw]")
    status, data = fetch_token(argv[0])
    if status != 200 or "access_token" not in data:
        print(json.dumps({"status": status, "error": data.get("error"), "error_description": data.get("error_description")}))
        return 1
    c = jwt_claims(data["access_token"])
    show = {k: c.get(k) for k in ("iss", "aud", "azp", "typ", "preferred_username", "roles", "scope")}
    show["lifetime_seconds"] = c["exp"] - c["iat"]
    show["expires_in_seconds"] = c["exp"] - int(time.time())
    show["sub"] = (c.get("sub") or "")[:8] + "..."
    print(json.dumps(show, indent=2))
    if "--raw" in argv:
        print(data["access_token"])
    return 0


# ----------------------------------------------------------------------------- checks
FAILS = []


def ok(msg):
    print("ok   - " + msg)


def bad(msg):
    print("FAIL - " + msg)
    FAILS.append(msg)


def expect(cond, good, problem):
    ok(good) if cond else bad(problem)


def pkce_pair():
    return "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"  # S256 challenge of the RFC 7636 example verifier


def auth_query(client, redirect, **extra):
    q = {"client_id": client, "response_type": "code", "scope": "openid", "redirect_uri": redirect,
         "state": "s", "nonce": "n"}
    q.update(extra)
    return AUTH_PATH + "?" + urllib.parse.urlencode(q)


def cmd_check():
    env = load_env()

    # --- discovery and keys through the proxy, as a client would see them
    status, _, body = http("GET", "/realms/poc/.well-known/openid-configuration")
    disc = {}
    if status == 200:
        disc = json.loads(body)
    expect(status == 200, "discovery document is served through the proxy", "discovery document returned %s" % status)
    expect(disc.get("issuer") == ISSUER, "issuer is %s" % ISSUER, "issuer is %r, expected %r (hostname/proxy headers?)" % (disc.get("issuer"), ISSUER))
    expect(str(disc.get("token_endpoint", "")).startswith(ISSUER), "advertised endpoints use the public URL", "token_endpoint is %r" % disc.get("token_endpoint"))
    expect("S256" in disc.get("code_challenge_methods_supported", []), "server advertises PKCE S256", "S256 not advertised")
    status, _, body = http("GET", "/realms/poc/protocol/openid-connect/certs")
    keys = json.loads(body).get("keys", []) if status == 200 else []
    expect(len(keys) >= 1, "JWKS has %d signing key(s)" % len(keys), "JWKS empty or unavailable (%s)" % status)

    # --- tokens: who gets what
    for who, want_role, other_roles, user in (("worker", "worker-reader", ("capture-writer", "clinician-reader"), None),
                                              ("capture", "capture-writer", ("worker-reader", "clinician-reader"), "capture-user"),
                                              ("clinician", "clinician-reader", ("capture-writer", "worker-reader"), "clinician-user")):
        status, data = fetch_token(who)
        if status != 200 or "access_token" not in data:
            bad("%s token request failed (%s %s)" % (who, status, data.get("error")))
            continue
        c = jwt_claims(data["access_token"])
        roles = as_list(c.get("roles"))
        expect(c.get("iss") == ISSUER, "%s token: iss is the public issuer" % who, "%s token: iss is %r" % (who, c.get("iss")))
        expect("hapi-fhir" in as_list(c.get("aud")), "%s token: audience includes hapi-fhir" % who, "%s token: aud is %r" % (who, c.get("aud")))
        expect(want_role in roles, "%s token: roles claim has %s" % (who, want_role), "%s token: roles are %r" % (who, roles))
        expect(not any(r in roles for r in other_roles), "%s token: has none of the other POC roles" % who, "%s token: unexpected roles %r" % (who, roles))
        expect(c["exp"] - c["iat"] == 600, "%s token: lifetime is 600 s" % who, "%s token: lifetime is %s s" % (who, c["exp"] - c["iat"]))
        if user:
            expect(c.get("preferred_username") == user, "%s token: subject user is %s" % (who, user), "%s token: user is %r" % (who, c.get("preferred_username")))

    # --- things that must be REFUSED, each for the stated reason
    status, _, body = http("POST", TOKEN_PATH, {"grant_type": "client_credentials", "client_id": "analytics-worker", "client_secret": "wrong"})
    err = json.loads(body).get("error") if body.startswith("{") else None
    expect(status in (400, 401) and err in ("unauthorized_client", "invalid_client"), "wrong client secret is rejected (%s)" % err, "wrong secret: status %s error %r" % (status, err))
    status, _, body = http("POST", TOKEN_PATH, {"grant_type": "password", "client_id": "poc-devtest", "username": "nobody", "password": "x"})
    err = json.loads(body).get("error") if body.startswith("{") else None
    expect(status in (400, 401) and err == "invalid_grant", "unknown user / bad password is rejected (%s)" % err, "bad user: status %s error %r" % (status, err))
    for client in ("ios-capture", "clinician-web"):
        status, _, body = http("POST", TOKEN_PATH, {"grant_type": "password", "client_id": client, "username": "capture-user", "password": env["POC_CAPTURE_USER_PASSWORD"]})
        err = json.loads(body).get("error") if body.startswith("{") else None
        expect(status in (400, 401) and err == "unauthorized_client", "%s cannot use the password grant (%s)" % (client, err), "%s password grant: status %s error %r" % (client, status, err))
        status, _, body = http("POST", TOKEN_PATH, {"grant_type": "client_credentials", "client_id": client})
        err = json.loads(body).get("error") if body.startswith("{") else None
        expect(status in (400, 401) and err in ("unauthorized_client", "invalid_client"), "%s cannot use client credentials (%s)" % (client, err), "%s client credentials: status %s error %r" % (client, status, err))

    # --- PKCE is enforced (the attribute name was unverified: only behavior proves it)
    for client, redirect in (("ios-capture", IOS_REDIRECT), ("clinician-web", "https://macpro16.local:3000/cb")):
        status, headers, body = http("GET", auth_query(client, redirect))
        loc = headers.get("location", "")
        expect(status == 302 and "error=" in loc and "code_challenge" in urllib.parse.unquote_plus(loc),
               "%s: an authorization request WITHOUT PKCE is refused" % client,
               "%s: no-PKCE request returned %s %r" % (client, status, loc[:120]))
        status, headers, body = http("GET", auth_query(client, redirect, code_challenge=pkce_pair(), code_challenge_method="plain"))
        loc = headers.get("location", "")
        expect(status == 302 and "error=" in loc, "%s: PKCE method 'plain' is refused" % client, "%s: plain method returned %s %r" % (client, status, loc[:120]))
        status, headers, body = http("GET", auth_query(client, redirect, code_challenge=pkce_pair(), code_challenge_method="S256"))
        expect(status == 200 and "<form" in body, "%s: a PKCE S256 request reaches the login page" % client, "%s: S256 request returned %s (no login form)" % (client, status))

    # --- redirect URI must match exactly
    status, headers, body = http("GET", auth_query("ios-capture", "https://evil.example/cb", code_challenge=pkce_pair(), code_challenge_method="S256"))
    loc = headers.get("location", "")
    expect("evil.example" not in loc and not (status == 200 and "<form" in body), "a foreign redirect_uri is refused (no redirect, no login form)", "foreign redirect_uri: status %s location %r" % (status, loc[:100]))

    # --- the admin side stays closed
    status, headers, _ = http("GET", "/realms/master/.well-known/openid-configuration")
    expect(status == 404 and headers.get("x-edge-denied"), "the master realm is refused by the edge", "master realm: status %s" % status)
    status, headers, _ = http("GET", "/admin/")
    expect(status == 404 and headers.get("x-edge-denied"), "the admin console is refused by the edge", "admin console: status %s" % status)

    print()
    print("ALL REALM CHECKS PASSED" if not FAILS else "SOME REALM CHECKS FAILED (%d)" % len(FAILS))
    return 1 if FAILS else 0


if __name__ == "__main__":
    if len(sys.argv) < 2 or sys.argv[1] not in ("token", "check"):
        sys.exit(__doc__)
    sys.exit(cmd_token(sys.argv[2:]) if sys.argv[1] == "token" else cmd_check())
