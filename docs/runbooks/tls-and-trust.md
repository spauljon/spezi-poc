# Runbook: TLS and trusting the POC CA

How the POC's TLS is created, how to make each device trust it, how to check it, and how to undo it. Written 2026-10-17 after a full rebuild; each step says whether it was run then.

## The idea in five lines

1. A **certificate** is a server's ID card ("I am `macpro16.local`"). The matching **private key** is the secret that proves the card is yours.
2. A **CA** (certificate authority) stamps ID cards. A device keeps a short list of authorities it believes; **trusting our CA is what makes a device accept every card it stamped.**
3. We run our own CA, because no public authority issues cards for a name like `macpro16.local`.
4. Each service has its **own** key and card, all stamped by the one CA. Devices need only the CA's **public** certificate, `ca.crt`.
5. The CA is limited to one name: it can vouch only for `macpro16.local` (and no IP address), so even a leaked CA key could not impersonate anything else. Details: [hapi/README.md](../../hapi/README.md#the-ca-is-name-constrained).

## What exists and where

Everything lives in `~/.poc-ca` (outside the repo; nothing in it is ever committed).

| File | Public? | Used by |
|---|---|---|
| `ca.crt` | **yes**: the only file that goes on devices | every client, and every container that calls another service |
| `ca.key` | **never leaves the Mac**; never mounted into a container | only `make tls`, to sign |
| `server.key`, `server.crt`, `hapi/server.p12` | key is secret | HAPI (port 8443); the `.p12` is the key plus certificate plus CA in one password-protected file, the format Java loads |
| `idp/keycloak.key/.crt/.p12` | key is secret | Keycloak, internal only (never published) |
| `idp/edge.key/.crt` | key is secret | the nginx proxy in front of Keycloak (port 8444), the identity phones and browsers see during sign-in |
| `analytics/api.key/.crt` | key is secret | the analytic API (loopback port 8445) |
| `web/web.key/.crt` | key is secret | the clinician web app (port 3000) |

All six key pairs are elliptic-curve (P-256). The CA lasts 10 years, each leaf certificate 1 year. Leaves are server-only (`serverAuth`); there are **no client certificates**: callers authenticate with Keycloak bearer tokens, and TLS only proves the server's identity and encrypts the traffic. The `.p12` passwords live in the git-ignored `hapi/.env.local` and `idp/.env.local`.

## 1. Create (or confirm) the CA and certificates

```bash
make tls
```

Idempotent: it reuses what exists and regenerates a leaf certificate that expires within 30 days. `make stack-up` also runs it if the material is missing. It ends with a self-test that proves the CA refuses a certificate for any other domain. Print the CA's fingerprint, to check later that every device holds the same CA:

```bash
openssl x509 -in ~/.poc-ca/ca.crt -noout -subject -enddate -fingerprint -sha1
```

*Run on 2026-10-17: yes.*

## 2. Trust the CA on the Mac (optional; needs `sudo`)

None of the project's scripts or containers need this: they pass `--cacert` or set `NODE_EXTRA_CA_CERTS`. It only matters if you want a browser or a plain `curl` to accept the stack.

```bash
sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain ~/.poc-ca/ca.crt
```

Check it is there (and that the fingerprint matches step 1):

```bash
security find-certificate -a -c "Spezi POC" -Z /Library/Keychains/System.keychain
```

*Run on 2026-10-17: the check command, yes; the `sudo` install, no (the developer's step).*

## 3. Trust the CA on an iPhone

1. If an older "Spezi POC Local CA" profile exists, **remove it first** (step 7): two CAs with the same name are confusing, and only the one you switch on is trusted.
2. AirDrop `~/.poc-ca/ca.crt` to the phone, open it, and install the profile (Settings > Profile Downloaded).
3. Switch it **on**: Settings > General > About > Certificate Trust Settings > "Spezi POC Local CA". **Installing alone is not enough**: until this toggle is on, Safari shows "This Connection Is Not Private", and tapping through only stores an exception.
4. Test in a **new Private Browsing tab** (an old tab can hold a remembered exception): `https://macpro16.local:8444/ping` should show "IdP edge reachable" with no warning.

The phone must be on the same network as the Mac and able to resolve `macpro16.local` (it may use IPv6 link-local and never IPv4). If the page does not load at all, check the macOS firewall. More background: [idp/README.md](../../idp/README.md#trusting-the-ca-on-a-phone-iphone).

*Last run: 2026-10-09 (original setup); not re-run after the 2026-10-17 rebuild, which created a **new** CA.*

## 4. Trust the CA in the iOS Simulator

The simulator has its own keychain, so it does not trust the CA until told to. Without it, sign-in shows "The certificate for this server is invalid".

```bash
scripts/ios-sim-trust.sh install
```

It prints the subject, fingerprint and name constraints before installing, and changes only that simulator. There is no per-certificate removal: see step 7. More: [ios/README.md](../../ios/README.md#the-simulator-must-trust-the-poc-ca).

*Not re-run after the 2026-10-17 rebuild.*

## 5. Verify

With the stack up:

```bash
make stack-verify
```

Every `SKIP` line means a check **did not run**. On a Mac using the built-in LibreSSL, four TLS-version checks are skipped (a TLS 1.3 handshake works and TLS 1.1 is refused, on ports 8443 and 8444); they were run by hand with Homebrew's OpenSSL 3.5 on 2026-10-17: TLS 1.3 and 1.2 accepted, TLS 1.1 refused by the server with a `protocol_version` alert.

Every negative check needs a positive control. For one endpoint by hand:

```bash
curl -sS --cacert ~/.poc-ca/ca.crt -o /dev/null -w '%{http_code}\n' https://macpro16.local:8443/fhir/metadata
```

That must print `200`. Without `--cacert` (and before the Mac trusts the CA) the same request must fail with curl **exit 60** (certificate refused), not exit 7 (could not connect): the two mean different things.

## 6. Rotation and expiry

- Leaf certificates last 365 days. `make tls` regenerates one within 30 days of expiry and rewrites the keystore passwords. The containers read the files only at start, so restart afterwards: `make stack-down` then `make stack-up` (keeps the data volume).
- The CA lasts 10 years. **Replacing the CA** (deleting `~/.poc-ca` and running `make tls`) creates a *different* key, so **every device must trust the new CA** (steps 2 to 4) and the old trust must be removed (step 7).
- The CA's name constraint cannot be edited. Changing the host name (`POC_TLS_HOST`) needs a new CA.

## 7. Undo everything

| Where | How |
|---|---|
| Mac | `sudo security remove-trusted-cert -d ~/.poc-ca/ca.crt`, then `sudo security delete-certificate -Z <SHA-1 from step 2> /Library/Keychains/System.keychain`. Confirm with the find-certificate command in step 2. *(Not run here: needs `sudo`.)* |
| iPhone | Settings > General > VPN & Device Management > the CA profile > Remove Profile (this also removes its trust setting) |
| Simulator | `scripts/ios-sim-trust.sh reset` (**resets that simulator's whole keychain**, including any stored sign-in) |
| The CA itself | `rm -rf ~/.poc-ca` once nothing trusts it. This deletes `ca.key`; the certificates cannot then be renewed, only replaced (step 6) |

## Troubleshooting

| Symptom | Meaning | Fix |
|---|---|---|
| App says "The certificate for this server is invalid" | the device does not trust the CA | steps 3 or 4 (on a phone, check the Certificate Trust Settings toggle) |
| App says "could not connect" | the server is unreachable, not a trust problem | `make stack-ps`; same network; firewall |
| Safari: "This Connection Is Not Private" | CA profile installed but the trust toggle is off, or the wrong CA is installed | step 3.3; compare fingerprints |
| `curl` exit 60 | certificate not trusted by this client | pass `--cacert ~/.poc-ca/ca.crt`, or do step 2 |
| `curl` exit 7 | could not connect | the stack is down |
| Works with the CA file, fails in a browser | the Mac does not trust the CA | step 2 |
| It worked yesterday, now every device fails | the CA was replaced (new key) | trust the new CA everywhere; remove the old |

## Never

- Install, copy or mount `ca.key` anywhere. Only `ca.crt` goes on devices.
- Commit anything from `~/.poc-ca` or the `.env.local` files.
- Switch on trust for a CA whose fingerprint you have not compared with step 1.
