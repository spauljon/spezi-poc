# HAPI FHIR deployment

HAPI FHIR 7.6.0 (R4) for the POC: Oracle datasource now (M1), TLS (M2), token verification and authorization (M4). No data in this directory.

Planned in [docs/implementation-plan.md](../docs/implementation-plan.md) (M1, M2, M4). Planning briefs and the FHIR spec live in [docs/planning/](../docs/planning/).

## Files

| File | Role |
|---|---|
| `Dockerfile` | Multi-stage: builds `ext/` with a digest-pinned Maven image (running its unit tests), then `hapiproject/hapi:v7.6.0` plus busybox (healthcheck) plus the extension jar in `/app/extra-classes` |
| `ext/` | The M4 extension (Java 17, thin jar): token verification, role rules, removal of two unused endpoints; see "Authentication and authorization" below |
| `auth.py` | `seed` (create/find the one synthetic Patient with a capture token) and `check` (the live 79-check auth matrix) |
| `application.yaml` | Oracle datasource at `jdbc:oracle:thin:@oracle:1521/FHIRPDB` (connects as the application user `hapi`; objects belong to `hapi_owner`, reached through synonyms), `HapiFhirOracleDialect`, R4, request validation on |
| `schema/oracle.sql` | HAPI 7.6.0 Oracle base schema (54 tables, 96 indexes), loaded once by `db/init.sh` |
| (`scripts/make-tls.sh`) | Creates the local CA (once), the `macpro16.local` server certificate and the PKCS12 keystore HAPI serves TLS from (it also issues the IdP certificates). Keys live in `~/.poc-ca/` (outside the repo); run via `make tls` or `make stack-up` |
| `.env.example` | Names of the credentials in the gitignored `.env.local` |

Runs in the root [compose.yaml](../compose.yaml), project `spezi-poc`, serving **HTTPS only** at `https://macpro16.local:8443/fhir`, published on the network since M4 (see below); bring-up order is in [db/README.md](../db/README.md).

## TLS

The CA certificate to trust on a device is `~/.poc-ca/ca.crt` (public, safe to share); its key `ca.key` never leaves `~/.poc-ca/` and is never mounted. Talking to HAPI from this machine before the name resolves publicly:

```bash
curl --cacert ~/.poc-ca/ca.crt --resolve macpro16.local:8443:127.0.0.1 https://macpro16.local:8443/fhir/metadata
```

The server certificate is valid 365 days; `make tls` regenerates it when under 30 days remain (then restart HAPI).

### The CA is name-constrained

`ca.crt` carries a **critical Name Constraints** extension: it may vouch only for `macpro16.local` (and its subdomains) and for no IP address. So even if `ca.key` leaked, a certificate it signed for any other name (a bank, a mail server) would fail validation on a device that trusts this CA. `make tls` ends with a self-test that issues a throwaway `evil.example` certificate and requires it to be rejected with *permitted subtree violation*, and `make stack-verify` checks the extension is present.

Constraints are part of the CA certificate and cannot be amended. `make tls` therefore **retires** a CA that lacks them (moves it, with its leaf and keystore, to `~/.poc-ca/retired-<timestamp>/`, never deleting it) and creates a constrained one; any device that trusted the retired CA must be re-pointed at the new `ca.crt`. Do this before installing the CA on a phone or browser.

### Design note: why HAPI terminates TLS itself

Common enterprise alternatives are edge termination (an ingress or reverse proxy terminates TLS and the service speaks cleartext on an internal network) and mesh mTLS (a sidecar terminates and encrypts every hop). For this POC HAPI terminates TLS itself: fewest moving parts, one process to reason about, and no cleartext FHIR listener anywhere. A reverse proxy was considered and deliberately not adopted (decision 2026-10-09); the certificates here would carry over to one if that changes. Whatever the TLS placement, token verification and authorization stay inside HAPI (M4): "trusted because it is inside the network" is not an assumption this design relies on.

Known cleartext hop (accepted for a single-host POC): HAPI to Oracle over the private Compose network. A real deployment would encrypt it.

## Authentication and authorization (M4)

HAPI does not authenticate; `AuthorizationInterceptor` only evaluates rules. Keycloak authenticates and issues the JWT; the extension in `ext/` verifies it and applies rules. Three small classes plus one verifier:

| Class | Job |
|---|---|
| `PocAuthorizationInterceptor` (extends HAPI's `AuthorizationInterceptor`, default DENY) | Verifies the bearer token and builds rules from its roles. Hooked at `SERVER_INCOMING_REQUEST_POST_PROCESSED` with `order = -1`, i.e. before the request validator; the stock `PRE_HANDLED` hook is made a no-op. The one anonymous request is `GET /fhir/metadata`; a token that is *present* must be valid even there. 401 if bad, 503 if the signing keys cannot be fetched. |
| `JwtVerifier` | Signature via the realm's JWKS (RS256 only), `iss` exact match, `aud` contains `hapi-fhir`, `exp` required, 30 s clock skew. Reads `roles` only after the signature verified. |
| `AuthConfig` | Builds the verifier from the `poc.auth.*` keys in `application.yaml`; fails startup if the CA file or URL is unusable. |
| `UnusedEndpointRemover` (Spring `BeanDefinitionRegistryPostProcessor`) | Removes two web endpoints of the stock image that nothing uses and that sit outside the FHIR servlet (below). |

### Why authorization is hooked earlier than stock

HAPI's `RequestValidatingInterceptor` (on because `hapi.fhir.validation.requests_enabled: true`) hooks `SERVER_INCOMING_REQUEST_POST_PROCESSED`; `AuthorizationInterceptor` decides at `SERVER_INCOMING_REQUEST_PRE_HANDLED`. Reproduced against 7.6.0 with an interceptor on the stock hook and no token:

| Unauthenticated `POST` | Stock hook order |
|---|---|
| well-formed, valid resource | 401 |
| single resource that fails validation (unknown field, bad code, missing required element, bad date) | **422**, with the validator's findings in the body |
| JSON that does not parse (e.g. `"entry": []`) | 422 |
| not JSON | 400 |
| transaction Bundle that parses but has errors (no `fullUrl`) | 401 (Bundle contents are validated later, after authorization) |

With `requests_enabled: false` the 422s became 401s, which identifies the validator as the source. So an anonymous caller could make the server run full instance validation (terminology bindings, cardinality, invariants) on a single-resource body and read the findings: no data is written or disclosed, but the answer is not 401 and the work is done before identity is known.

The fix is to run authorization first: the interceptor re-hooks the parent's logic at `POST_PROCESSED`, `order = -1` (the validator is order 0), and neutralizes the original `PRE_HANDLED` hook. **This pattern is taken from the VA `smart-pgd-fhir-service` (`JwtAuthorizationInterceptor`), which runs it in production.** An earlier version of this milestone used a servlet filter instead; it was dropped in favour of this single, HAPI-native interceptor. `auth.py check` asserts that invalid bodies get 401 with no validator output without a token, and that the same invalid body *with* a valid token still gets 422 (so the validator is still on).

### Endpoints outside the FHIR servlet

No HAPI hook sees requests that Spring MVC handles outside `/fhir`. The prebuilt image serves two such controllers, both unauthenticated when first probed:

- `ca.uhn.fhir.jpa.starter.web.JobController`: `GET /control/jobs` lists batch2 jobs and `DELETE /control/jobs` cancels one. An unconditional `@RestController`; no property disables it.
- `ca.uhn.fhir.to.Controller`: the "tester" web UI at `/` (enabled whenever any `hapi.fhir.tester*` property exists, which the image defaults do, so config cannot switch it off; the image defaults also set `refuse_to_fetch_third_party_urls: false`, i.e. the server fetches URLs on a visitor's behalf).

Nothing calls either: no class, template or script in the image references them, and neither do the POC's apps. So `UnusedEndpointRemover` drops their bean definitions at startup (the startup log says `Removed unused web endpoint bean ...`; it warns loudly if nothing matched, e.g. after an upgrade), and `springdoc.api-docs.enabled: false` plus `openapi_enabled: false` remove `/v3/api-docs` and the Swagger UI. The VA service does not need this because it is built from the starter source, which has no `JobController`. `auth.py check` asserts all of these paths are not served, with and without a valid token, and that odd spellings of a protected path (`/fhir//Patient`, `;`, `%`-encoding, dot segments) never return data without a token. Mutation-tested: restoring either piece makes those checks fail.

### Rules by role

| Role (token `roles` claim) | Allowed | Everything else |
|---|---|---|
| `capture-writer` | create and read (search) `Observation`, `Device`, `Patient` | 403: update, delete, other types, `$lastn`, transactions |
| `clinician-reader`, `worker-reader` | read and search every type; `Observation/$lastn`; metadata | 403: any write, any transaction, admin operations |
| any other or no role | metadata only | 403 |

### Assumptions to review

- **Transactions are refused for every role.** If the iOS upload sends a transaction or batch Bundle (decide in the upload milestone), a rule is added then. Note for that milestone: a Bundle entry needs `fullUrl` when its resource holds relative references, or the request validator answers 422.
- **`SearchNarrowingInterceptor` is not used.** There is one patient; narrowing reads on a claim would add a moving part with nothing to narrow. Revisit when a second patient exists: the token would carry a patient-compartment claim.
- **Roles come from a flat `roles` claim** that the realm's client mappers add (idp/realm/poc-realm.json); `realm_access` is deliberately not read. A role outside the three grants nothing.
- **Request bodies are not parsed before the rules run** (unlike the VA service, whose compartment rules need the resource). Our rules are by resource type and operation, which HAPI evaluates from the request; creates are re-checked per resource at the storage hooks. The matrix proves creates of other types and all transactions are 403 and that updates/deletes are 403.
- **Anonymous metadata** exposes the capability statement (resource types, search parameters). Accepted so a phone can confirm trust before signing in.
- **`azp` (which client) is logged but not enforced.** Roles decide access, not the client.

### Clock skew, key rotation, and what is never trusted

- **Clock skew.** `exp` (and `nbf` if present) are checked with 30 s of tolerance. HAPI, Keycloak and the Mac share one clock under Docker, so skew is not expected; a token older than `exp + 30 s` is rejected even if its signature is perfect. Access tokens last 10 minutes.
- **Key rotation.** Signing keys are fetched from `https://macpro16.local:8444/realms/poc/protocol/openid-connect/certs`, cached 5 minutes. A token naming an unknown `kid` triggers one refetch, rate-limited to one per 30 s; so a rotated key is picked up within seconds of its first use, and a flood of garbage `kid`s cannot hammer Keycloak. If Keycloak is down: cached keys keep working for the cache lifetime, then requests get 503 (never 401, never accepted unverified).
- **JWKS transport.** HAPI reaches the IdP proxy under its public name (a Compose network alias on `idp-edge`) over HTTPS with normal host-name verification, trusting only the POC CA through a private `SSLContext` (not the JVM-wide truststore).
- **Never trusted.** Nothing in a token is read before its signature verifies; `alg: none`, HMAC, and any algorithm other than RS256 are rejected; the key comes from the JWKS by `kid`, never from the token; the roles used for rules are the verified token's, never a header or attribute from the client.
- **What the tests prove, and what they do not.** Expired, wrong-issuer and wrong-audience tokens cannot be minted by this realm on demand, so they are proved by unit tests in the image build (each case changes one thing from a token the verifier accepts). The live matrix proves signature checking end to end with forged tokens (tampered signature, rewritten roles, `alg: none`, attacker-signed with the real `kid` and claims).

### Verifying

```bash
make test-hapi                # extension unit tests (run in the image build)
python3 hapi/auth.py check    # live matrix against the running stack (also part of make stack-verify)
python3 hapi/auth.py seed     # create-or-find the one synthetic Patient (also part of make stack-verify)
```

`auth.py check` leaves exactly one tagged synthetic `Observation` and one `Device` (conditional creates, so reruns do not accumulate). No role can delete; an Oracle volume reset clears them.

## Provenance

Adapted from the governance project (`pghd-governance-mapping-tool-service`, commit `1d86695`, `docker/` directory). Copied and adapted, never mounted or referenced:

| Here | From | Change |
|---|---|---|
| `schema/oracle.sql` | `docker/oracle/oracle.sql` | None (sha256 `d8bcf0e4105f9fd2461038605d533a3c295930b32a2837045ad2287269158acb`). Checked: no governance-specific names. |
| `application.yaml` | `docker/hapi/application.yaml` | Reduced to the keys the source sets; datasource URL points at the POC; dropped the governance bean package, CORS allow-any-origin with credentials, and the external "global tester" |
| `Dockerfile`, `ext/pom.xml` | `docker/hapi/Dockerfile`, `ext/pom.xml` | M4: kept the multi-stage thin-jar pattern (all dependencies `provided`), pinned the Maven image by digest, added JUnit (test scope) and ran the tests in the build; the Java sources are new |
| `db/init.sh`, `db/sql/*` | `docker/oracle/init.sh`, `setup.sql` | Rewritten for two PDBs and least-privilege users |

Deliberately not taken: `chg-log.sql`, `objects.sql` (governance change journal, triggers, flashback grant).
