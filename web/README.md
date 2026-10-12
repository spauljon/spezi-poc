# Clinician web app

React and TypeScript, built with Vite. M12 built the scaffold, sign-in and the patient banner; the flowsheet, trend,
intraday and sleep views follow (M13 to M16). Planned in [docs/implementation-plan.md](../docs/implementation-plan.md).

## What M12 shows

After signing in as the clinician (Keycloak, authorization code + PKCE), a patient banner:

- the patient (name and business identifier),
- the **latest value per metric** with unit, measured time (UTC) and source,
- **last data received** (the newest time the server received anything for the patient, sleep stages included),
- a **staleness indicator**: data older than 30 minutes (configurable) is shown as an alert in words and with a
  mark, never by colour alone; "no data received yet" is a separate state, and a metric with no value says "No data".

It re-reads every minute and re-evaluates the age against the clock every 15 seconds, so staleness appears by
itself when data stops arriving.

## Run

```bash
make web-dev          # https://macpro16.local:3000 (TLS, all interfaces); Ctrl-C stops
make test-web         # typecheck + 51 unit and component tests (no stack needed)
make test-web-live    # read-only: the banner's data path against the live HAPI with a clinician token
```

The browser must trust the POC CA (`~/.poc-ca/ca.crt`), as for the iOS simulator. The app needs the stack up
(`make stack-up`) and, for later milestones, `make analytics-api`. Certificates come from `make tls`
(`~/.poc-ca/web/web.{key,crt}`).

## How it is wired

The browser talks only to its own origin. The web dev server (`vite.config.ts`) serves the bundle and relays two paths:

| Path | Goes to | Notes |
|---|---|---|
| `/fhir/*` | HAPI `https://127.0.0.1:8443` | GET/HEAD only (others get 405 here); the bearer token is passed through |
| `/analytics/*` | analytic API `https://127.0.0.1:8445` (prefix stripped) | the API is loopback-only, so it is reached server-side |

HAPI therefore needs no CORS configuration (it is deliberately off). Keycloak is called directly by the browser
(token endpoint and discovery send `Access-Control-Allow-Origin` for `https://macpro16.local:3000`, checked). The
dev server serves only `web/` and `contract/` (`server.fs.allow`): the repository root holds git-ignored credentials
and is not served; `/@fs` requests for them are refused (403, checked).

Source layout: `src/auth` (OIDC client, provider), `src/fhir` (typed read-only client), `src/banner` (model, loader,
components), `src/contract.ts` (reads `contract/metrics.json`; a test refuses any code or unit literal in `src/`).

## Decisions and assumptions (M12; review these)

- **W1 `$lastn` is not used.** The plan said `Observation/$lastn`. On this HAPI (no Elasticsearch) it was observed to
  return unrelated, unordered Observations, ignoring both `code` and `max`. The banner uses plain searches instead:
  per metric `_sort=-date&_count=1`, plus one `_sort=-_lastUpdated&_count=1` for "last data received".
- **W2 Tokens live in memory only.** A page reload asks the clinician to sign in again (one click; Keycloak's own
  session makes it quick). Nothing is written to localStorage or sessionStorage. Refresh uses the refresh token
  while the page is open.
- **W3 Sign-out is local.** It forgets the session in the page; ending the Keycloak session needs a registered
  post-logout redirect URI that the realm does not have yet.
- **W4 Staleness is by server receipt**, not by measurement time: a late batch of old measurements delivered a
  minute ago is "current" (the connection is alive), and the measured times are shown beside it. The 30-minute
  threshold is a default (`VITE_POC_STALE_AFTER_MINUTES`), not a clinical standard.
- **W5 The role check in the UI is a courtesy.** The servers verify the token; the UI hides the banner when the
  token's `roles` claim (read for display only) lacks `clinician-reader`.
- **W6 The patient is found by business identifier** (`systems.identifier.patient` from the contract and
  `VITE_POC_PATIENT_IDENTIFIER`, default `poc-0001`), not hard-coded to one id; more than one match is an error.
- **W7 Not verified by a browser session.** Sign-in redirects through Keycloak's login page, where the password is
  typed by a person; I did not do that. The auth flow is covered by component tests with a fake OIDC client, the
  library settings are asserted, and the data path by the live test. The first real sign-in is yours to try.
- Not done: charts, flowsheet, intraday and sleep views (M13 to M16), a production build/hosting story, CSP headers.
