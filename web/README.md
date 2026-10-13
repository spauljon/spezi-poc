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

## What M13 adds: the flowsheet

Below the banner, a table of the patient's Observations across metrics (quantities and sleep-stage intervals):

- **Filters:** metrics (checkboxes), UTC date range (end day inclusive), source (any / synthetic / HealthKit),
  status (any, or one of the R4 Observation statuses), rows per page (25, 50, 100). Any filter change returns to page 1.
- **Sort:** Measured, Metric, Value, Status, Received by server; click a header to sort, again to reverse
  (`aria-sort` follows; the headers are buttons, so the table is keyboard operable). Source is not sortable.
- **Paging, filtering, ordering and the total are the server's work** (`_count`, `_offset`, `_sort`, `_total=accurate`),
  so the table stays correct over thousands of rows and the page holds only what is shown. `_id` is the last sort
  key so equal keys cannot reorder between pages.
- **Provenance and oddities stay visible:** units beside every value; period-valued samples show their start and
  end; a status other than `final` is flagged (and `entered-in-error` rows are struck through, not hidden);
  an unknown code, a missing value or a unit that differs from the contract's is shown as such, not corrected.
- **States:** loading (previous rows stay while a new page loads), empty (with "Clear filters"), an inverted date
  range explained without a request, server errors with retry. A response that arrives after a newer request was
  made is discarded.

### Assumptions made in M13 (review these)

- **F1 Sort columns were verified against this HAPI**, not assumed: `date`, `code`, `value-quantity`, `status` and
  `_lastUpdated` order correctly (checked over the whole data set, both directions; status after seeding two
  synthetic Observations with other statuses). `_source` is accepted but returned rows out of order, so Source is
  filterable and not sortable.
- **F2 "Measured" sorts by `date`**, which HAPI indexes as the instant, or the START of a period.
- **F3 Sorting by Value mixes units** when several metrics are selected (ms and /min are ordered as bare numbers).
  The unit is always beside the value; filter to one metric for a meaningful value order.
- **F4 The metric list is the contract's** (3 quantities, 5 sleep stages): an Observation with another code is
  never requested. `_source:not` is ignored by this HAPI (it returned the positive match), so there is no
  "unknown source" filter; such rows show as "Unknown source".
- **F5 HAPI writes `meta.source` as `<uri>#<request id>`.** Source detection compares the URI part. (This was a
  bug in M12's banner, invisible to its unit tests because they used the bare URI; fixed here and covered by a
  unit test and by the live test.)
- **F6 Dates are UTC days** (as everywhere else, A6); the filter is applied to the sample's instant.
- **F7 State is not in the URL**: a reload resets filters (and signs in again, W2). Linkable views are a later
  refinement.
- **F8 The Observation status list is the R4 value set**, a FHIR constant, not part of the contract.

## Run

```bash
make web-dev          # https://macpro16.local:3000 (TLS, all interfaces); Ctrl-C stops
make test-web         # typecheck + 82 unit and component tests (no stack needed)
make test-web-live    # read-only: banner and flowsheet against the live HAPI with a clinician token
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
