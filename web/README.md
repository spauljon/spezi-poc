# Clinician web app

Operating the stack (start, logs, updating a service, resets, failures): [docs/runbooks/operations.md](../docs/runbooks/operations.md).

React and TypeScript, built with Vite. M12 built the scaffold, sign-in and the patient banner; the flowsheet, trend,
intraday and sleep views follow (M13 to M16; M14 trends is built). Planned in [docs/implementation-plan.md](../docs/implementation-plan.md).

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
- **F6 Dates are UTC days** (as everywhere else, A6). For an instant the filter applies to that instant. For a **period** (resting heart rate: one per local day; sleep stages) HAPI matches any period that *overlaps* the range, so a period that straddles a UTC midnight appears under both days. (Found by the live test once the simulator produced Los Angeles-day resting-heart-rate periods: the previous wording, "applied to the sample's instant", was wrong for periods. Overlap is kept: a sleep stage running through midnight belongs to both days a clinician might filter on.)
- **F7 State is not in the URL**: a reload resets filters (and signs in again, W2). Linkable views are a later
  refinement.
- **F8 The Observation status list is the R4 value set**, a FHIR constant, not part of the contract.

## What M14 adds: trends

A **Trends** view (the default; **Flowsheet** is the other tab, and the banner stays above both): daily min, median and
max per metric, read from the analytic API (`GET /v1/patients/{id}/bands`) through the `/analytics` relay.

- **One filter row** above the charts: 7, 14, 30 or 90 days ending today (UTC), or a custom range (at most 366 days,
  the API's limit); *Refresh* re-reads. Every chart uses the same range.
- **Three stacked charts** (heart rate, resting heart rate, HRV), each a median line over a min-to-max wash. Resting
  heart rate has one value a day, so it is drawn as points only.
- **Gaps are gaps.** A day with no row is `null` in what the chart is given, the line and the wash break there, a day
  between two gaps gets a marker so it cannot vanish, and nothing is interpolated. The summary, the table and the
  readout each say "no data" in words; the API's `completeness` block is the source of the missing days.
- **Every value is available without a pointer:** a text summary above each chart (also its accessible description), a
  readout under it that follows the pointer or the arrow keys (Home and End jump), and a *Table view* with one row per
  day, "No data" for gaps and an *Intraday* link per day with data.
- **While loading** the previous charts stay, dimmed (`aria-busy`); an answer that was superseded is discarded; errors
  are explained in words with a retry where one can help (503 "analytic store not available", 401, 403, network).
- **The metric list is checked** against `contract/metrics.json` once per visit; a disagreement (a unit, a missing or an
  unknown metric) is shown, never silently corrected. The analytic answer itself is validated, not cast: a response
  that is not the documented shape is an error, not a chart.
- **Drill:** *Intraday* leads to `#/day/<date>?metric=<id>`, a placeholder that says the dense view arrives in M15.

### Charting library: uPlot 1.6.32 (approved)

Chosen over hand-rolled SVG because M15's dense intraday view needs a canvas library anyway, so M14 would otherwise
have meant two chart stacks. Checked before adding: MIT, no dependencies, bundled types, and what it does against our
CSP (`style-src 'self'`): it injects no `<style>`, never sets a `style` attribute as text and has no `eval`; it only
assigns CSSOM properties. It is loaded on demand (its own 51 kB chunk, 22 kB gzipped), so the sign-in page does not
carry it. Costs accepted: the API is imperative and canvas-based, so accessibility is entirely ours (the table twin,
the summary and the keyboard readout above), and it needs a canvas, so unit tests run against a recording stand-in
(`test/uplot-fake.ts`) and assert on what the app asks the chart to draw.

Time axes are computed by us (ticks at UTC midnights), not by uPlot's time scale, which uses the browser's zone.

### Colour

Each metric always wears one categorical slot, its position in the contract (never its rank in a filtered list). Slots
1 to 3 (blue, orange, aqua) were run through the `dataviz` skill's validator in both modes, all pairs: every check
passes. One warning stays: aqua is 2.74:1 against the light surface (below 3:1), which the method allows only with
visible labels and a table view, both of which exist.

### Assumptions made in M14 (review these)

- **T1 Days are UTC calendar days** (A6), shown in words from the API's own `dayDefinition`.
- **T2 The default range ends today (UTC), not on the newest day with data.** Data older than the range is simply not
  shown (all gaps); use *Custom* or a longer preset.
- **T3 "Points only" is decided by the data**, not by a metric id: when every day with data holds one sample.
- **T4 "No data" and "not delivered yet" are indistinguishable** (the API says so). `pendingWindows > 0` is shown as
  "values may be out of date"; it is not a missing day.
- **T5 Metric display names are the contract's LOINC displays** ("Heart rate --resting"); they are not prettified.
- **T6 The intraday link is a stub** until M15.
- **T7 Verified in a real browser once, by hand** (a throwaway harness rendering the real `TrendChart` with live
  analytic data under the app's exact CSP, in dark and light): the gap breaks the line and wash, markers, hover
  crosshair and readout, table twin. That is not automated: the unit tests assert what is *passed* to the chart, and
  the canvas itself is not asserted on.
- **T8 Screen readers were not run** (no VoiceOver pass): the structure (heading, summary text, labelled group,
  live readout, table with scoped headers) is asserted in tests, not listened to.
- **T9 The live test now writes two synthetic fixtures** (a `preliminary` and an `entered-in-error` Observation, by
  conditional create as the capture user) because the flowsheet's status controls need non-final rows and a fresh
  stack has none. They are idempotent.

## What M15 adds: the intraday view

A day's raw samples for heart rate and HRV, reached from the trends (each day with data has an *Intraday* link) or at
`#/day/<date>?metric=<id>`: two stacked charts on one shared, zoomable UTC time axis.

- **Where the samples come from:** HAPI directly (the system of record), through the existing `/fhir` relay, paged by
  `_offset` with `_count=1000`, sorted by `date` then `_id` so equal instants cannot reorder between pages. A failure on
  any page fails the load; a partial day is never shown as the day. Progress is shown while a dense day loads.
- **Zoom and pan without a pointer:** buttons for the full day, 6 hours and 1 hour, and earlier/later; drag across
  a chart to zoom (both charts follow); arrow keys step one sample, Page Up/Down an hour's worth (60), Home/End the
  first and last, scrolling the window to keep the sample visible. Raw points appear by themselves once zoomed in.
- **Gaps** are shaded behind the line, the line is broken across each, and they are listed in words (and in a
  *Gaps* list). **Stored data-quality flags** are drawn as an outlined diamond (a shape, not a colour), named in the
  readout and listed in *Flagged samples*. The summary says whether the highest and lowest values are flagged.
- **Text equivalent:** the summary above each chart, an *Hourly table* (24 rows: samples, min, median, max, flagged)
  and the lists. A table of 19k rows is not an equivalent, so there is none.
- **Back to trends** returns to the range the drill came from (carried in the URL fragment); previous/next day move
  along the same route.

### Three rules decided in one place (`src/intraday/model.ts`)

1. **A gap** is an interval between consecutive samples longer than max(10 minutes, 10 x the day's median interval).
   The day's edges count: a day that starts or ends with no samples has a gap there, except that an unfinished day
   ends at "now" and has no trailing gap.
2. **A flag is only what is stored** (`meta.tag` in the contract's `dataQualityFlag` system). Nothing is inferred from
   a value: an implausible value that nobody flagged is drawn as it is, unmarked, and the summary says "not flagged".
3. **A retracted Observation (`entered-in-error`) is not drawn**, and neither is one with another unit, no value or no
   time; each is counted and stated ("Left out: ...").

### Contract 1.2.0 (additive)

The flag system and codes now live in `contract/metrics.json` (`systems.dataQualityFlag`, `dataQualityFlags`, and
assumption A30), the iOS bundled copy and the golden fixtures were regenerated, and iOS, analytics and web were
re-tested. v1 ingest writes **no** flags; nothing in the project produces them yet except the verification tool
below, so on real or simulated data the view will correctly say "No sample carries a stored data-quality flag".

### Verification data

`make web-seed-dense-day` writes one synthetic day (default 2026-09-25 UTC) idempotently as the capture user:
heart rate every 4 s (19,830 samples), three pauses of 37, 15 and 62 minutes, a 4-minute pause that must *not* be a
gap, six samples with a stored `artifact-suspected` flag, two implausible values with **no** flag, and 48 HRV samples.
The live test recomputes the day independently from the raw Observations and checks each of those.

### Measured (not estimated)

| What | Result |
|---|---|
| 19,830 samples fetched (20 pages) and modelled, over the LAN | about 2.7 s |
| The same day as JSON | 9.8 MB raw (HAPI gzips it on the wire) |
| Real browser, CPU cost to build and issue a first draw | 8.5 ms |
| Real browser, CPU cost of a zoom or pan (42 operations) | median 3.2 ms, p95 3.6 ms, max 4.5 ms |

The browser figures were taken in a page that the app reported as hidden, so they are the cost of building and
issuing the draw, not of rasterising it; the result was then looked at in a real browser, dark and light (T7 in M14).

### Found in a real browser (and why a unit test could not)

The first version looked right in tests and ignored every zoom. uPlot passes a requested zoom through the scale's
`range`; an **array** `range` is returned for every request, and a **function** that ignores its inputs does the same, so
both silently undo the zoom. The test stand-in for uPlot cannot model that. The fix is an ordinary automatic x scale plus
two value-less anchor points at the window edges (so "full day" is the whole day), and the initial window is applied in
uPlot's `ready` hook. There is a test that the x scale has no `range`, but that guards the cause, not the symptom: the
symptom was only visible on the canvas.

A second defect found on the way: the load effect depended on the whole sign-in context object, so any change of
sign-in state re-downloaded the entire dense day and rebuilt the chart. It now depends only on the (stable) token
function, with a regression test. The banner, flowsheet and patient page still depend on the whole object; they
refetch small amounts and were left alone.

### Assumptions made in M15 (review these)

- **I1 The gap threshold** (10 minutes, or 10 x the median interval) is my judgment, not a clinical standard. Real
  HealthKit heart rate is irregular, so one fixed number will be wrong for some patterns.
- **I2 No artifact is detected here.** A value that nobody flagged is not marked however implausible. If you want
  a plausibility rule, it is a separate, labelled "viewer rule" (needs your clinical thresholds), or the ingest/worker
  must write the flag (M19).
- **I3 The day is a UTC day** (A6), so for a patient in Los Angeles a night's sleep, and a workout, can straddle two
  days. Times are shown as UTC everywhere.
- **I4 Only heart rate and HRV have an intraday view.** Resting heart rate is one value a day; sleep is M16.
- **I5 A day in progress** ends at the time the page loaded; it does not refresh itself (use *Refresh*).
- **I6 Zoom resets on Refresh and on a change of day.**
- **I7 The hourly table is the table twin.** There is no per-sample table; the keyboard steps through samples.
- **I8 Not tried:** a screen reader, touch gestures (pinch, two-finger pan), very small screens, or a day with many
  more than 20k samples (the loader stops at 200 pages, i.e. 200,000 samples, and says nothing special).
- **I9 A window with one or two samples** auto-scales the y axis tightly (HRV in a 15-minute window), which is honest
  but can look dramatic; there is no "no samples in this window" hint.

## What M16 adds: sleep

A **Sleep** tab (`#/sleep`, and `#/sleep/<night>[?s=<session start, epoch seconds>]`): the last 14, 30 or 90 nights from
the analytic API, and one night's hypnogram from the stage Observations in HAPI.

- **Nights:** a stacked bar per night (deep, light, REM, unspecified, then awake time inside the night), the main
  sleep only; a night without sleep is an empty slot and is said to be (the API's `completeness` lists them, nothing
  is estimated). A table twin gives asleep time, stage shares, awake time, awakenings, time to fall asleep and naps,
  with an *Open* link per night. A date with a nap offers both sessions.
- **One night:** stage lanes (Awake, REM, Light, Deep; "Asleep (unspecified)" only when present), one bar per stretch
  of the resolved timeline. A stretch with no recorded interval is hatched and said to be unscored; where intervals
  overlapped, a mark shows that the later start was drawn. Arrow keys read it a stretch at a time; a table lists every
  stretch with its minutes and a note. A written summary gives the totals, awakenings, latency and the data-quality
  facts (unscored and overlapped minutes).
- **Checked against the summary:** the hypnogram's statistics are computed from the intervals and compared with the
  API's for the same session; if they differ, the page says which figure and by how much instead of choosing.

### Where the timeline comes from (option A)

The web reads the session's stage Observations from HAPI (the data-model brief's design, about 20 for a night) and
applies the worker's overlap rule itself (`src/sleep/model.ts`): every instant gets one stage; the interval that
starts later wins; ties go to the more specific stage, then the lower id. That rule therefore exists in two languages.
Three guards: an in-page comparison with the API (above), a live test that compares the two for **every** session the
API holds (16 on the verification stack), and a third, deliberately naive per-minute reading in the fixture tool that
the API and the web must both equal.

### Times as recorded, and clock changes

Each sample carries the offset of the device's own zone, so a night is drawn and labelled in the device's clock
(`23:00 UTC-07:00`), never converted to the browser's zone. When the offset changes within a night (a DST change) the
page says so, gives the real length against the clock length ("7 h 00 min of real time, 8 h 00 min on the clock"), and
labels no tick inside the interval that spans the change with a clock time (the data does not say when inside it the
clock changed): such a tick is shown in UTC. The minutes are always real elapsed minutes.

### Colour

The four stages use slots 4 to 7 of the validated categorical palette (Awake yellow, REM magenta, Light green, Deep
violet), checked with the `dataviz` validator as a set in both modes: all checks pass; the one warning (yellow and
magenta under 3:1 on the light surface) is relieved by labelled lanes and the tables. A first attempt with a blue
ramp failed the dark-mode lightness band and was dropped. Stage identity is the lane, never colour alone.

### Verification data

`make web-seed-sleep-nights` writes three known nights idempotently (30 Observations): **2026-09-28** (an overlap, an
unscored gap, a 3-minute awake that is not an awakening, a 10-minute one that is), **2026-09-30** (a night and a nap
on the same date) and **2026-03-08** (across the Los Angeles spring-forward, one interval spanning the change). Each
is described once, with what it must come to read minute by minute. The analytic API's summaries equal that reading
on every field for all three, and the live test holds the web to it too.

### Assumptions made in M16 (review these)

- **S1 Light sleep is HealthKit's "core" sleep.** That mapping is the contract's clinical judgment (A4); the page says so.
- **S2 A night is dated by the UTC date of the final waking** (A6). For a patient far east of UTC that can be the day
  before the calendar day they woke on; the page says so rather than hiding it.
- **S3 The chart shows only the main sleep of a date;** naps are in the table and selectable, not stacked.
- **S4 Awake time inside the night is the top segment;** latency and wake-after-end are in the table and the
  summary, not drawn in the bars.
- **S5 No interpretation:** no scoring, norms or targets. The view states what was recorded.
- **S6 Tick labels inside an interval that spans a clock change are in UTC** (see above); I do not guess the instant
  the clock changed.
- **S7 The loader reads at most 2,000 intervals per session** (10 pages of 200) and stops without special notice.
- **S8 Not tried:** a screen reader, touch gestures, or a session with an unusually large number of intervals.
- **S9 Nothing polls.** *Refresh* re-reads; a night in progress is not updated.
- **S10 The page lists what HAPI returned for the session's window,** excluding an interval that merely touches it
  (HAPI matches overlapping periods, so such an interval is returned and discarded here; there is a test).

## What M23 adds: nutrition

A **Nutrition** tab (`#/nutrition`, optionally `?nutrient=<contract id>`) shows daily dietary totals from the analytic API's `/v1/patients/{id}/nutrition` (M22). It honours the data-set switch (the real set has the nutrition; the synthetic one has the seeded days) and never shows one patient's totals while another's load.

- **Day as recorded, said everywhere.** Days are the date written in each entry's own timestamp, not the UTC day Trends and Sleep use: the page says so, the axis says so, and the table's first column is "Day (as recorded)". The last day shown is today's date in UTC (a later recorded date east of UTC appears once UTC reaches it; stated on the page).
- **One nutrient in detail** (Energy, Protein, Carbohydrates, Fat, Fiber, Sugar, Sodium, Water, in the contract's order; each wears its contract slot): a text summary, an SVG bar chart from 0, a key, an arrow-key readout (Left, Right, Home, End: one day in words, with its meals and flags) and a table twin. 7, 14, 30 or 90 days.
- **A gap is a gap.** A day with no entries is an empty slot with a hollow marker, "No entries" in the table and "no entries (nothing recorded, not a total of 0)" in the readout, and it is left out of the average. A day whose entries add up to 0 is a different thing: a baseline mark, the figure 0, "entries that add up to nothing" in the summary.
- **Split by meal (D5).** One toggle stacks each bar by meal (breakfast, lunch, dinner, snack, other in the contract's order; "No meal recorded" last), with a key; the table twin always has the meal columns, and the meals add up to the day (the parser refuses an answer where they do not).
- **Energy and macronutrients** in one table, newest first, with **estimated** shares of energy from protein, carbohydrates and fat (grams times 4, 4 and 9 kcal per gram over the day's reported energy). The column headings, a note and the dashes all say these are estimates; a share is not worked out when a nutrient has no entries that day or energy is 0.
- **Flags** are the stored ones from the analytic API (M19 rules): a sentence says how many entries are flagged and that the totals include them, and a triangle marks the day on the chart. Nothing is flagged by its size (the seeded 7,200 kcal entry carries the capture app's tag; without it, it would show no mark).
- **Failures are explained, not drawn over:** an answer of the wrong shape (a negative total, meals that do not add up, a day both present and listed as missing) is an error; an unreachable service offers "Try again"; a contract without intake metrics says so.

**Verification data:** `make web-seed-nutrition-days` seeds 24 known synthetic days (382 Observations, idempotent): three gaps, a day of zero entries, an evening entry at 23:40 UTC-7 that is the next day in UTC, an entry with no meal, a dessert created then retracted as the app does, and one flagged absurd entry. `make test-web-live` compares the API, the view's own cells and an independent decimal sum of the FHIR Observations for every nutrient and day (the seed's own sums are a third implementation).

**Found in a real browser (and why a unit test could not):** with the real page in a browser (Chromium engine, light and dark, 750 px and desktop widths) the bars, hollow gap markers, zero marks, stacked meals, focus ring and highlighted column, and arrow-key readout all drew as intended. It showed three things the jsdom tests cannot see: a single flagged outlier (9,060 kcal) flattened the other bars with nothing on the chart pointing at it (now a triangle on that day and a key entry); at phone width the chart's text shrank to unreadable and the macronutrient table pushed the whole page sideways (now each scrolls inside its own box, and the page does not); and the long day-definition sentence repeated itself (shortened). **How it was checked, honestly:** the built-in browser pane blocks the sign-in server (`ERR_BLOCKED_BY_CLIENT`), so the deployed page could not be signed in to from there. The real `NutritionPage` was instead served by a throwaway loopback-only Vite harness (removed afterwards) answering with a capture of the synthetic patient's API responses, so layout and interaction are real-browser verified; the deployed, signed-in page is for you to look at (the steps are in the plan).

### Assumptions made in M23 (review these)

- **W1 The range ends on today's date in UTC.** An entry recorded at a later calendar date east of UTC is not shown until UTC reaches that date. Said on the page.
- **W2 Averages are over days with entries only,** and are labelled so; a gap is never counted as 0. A "typical day" is therefore not a per-calendar-day mean.
- **W3 The estimates use fixed general factors** (4, 4, 9 kcal per gram). They ignore fibre, alcohol and sugar alcohols, so shares need not total 100%; they are labelled as estimates and are never stored.
- **W4 Time of day is not shown.** The API gives UTC instants for the first and last entry, not the recorded offset, so a local clock time cannot be shown honestly (nutrition brief N5: time of day is indicative anyway).
- **W5 Meal colours reuse categorical slots 1 to 5 and the muted ink,** nutrients use slots 1 to 8 by contract position: no new colour, so no new validation. The same hue therefore means "breakfast" in the split chart and "Energy" in the plain one; the key, the readout and the table always name it.
- **W6 One nutrient per chart, four extra requests.** The page asks for the selected nutrient plus the four the table needs (energy, protein, carbohydrates, fat): at most five small requests per view.
- **W7 Not tried:** a screen reader, touch gestures, and the deployed page signed in (see above); the first two are as in M15 and M16 (S8).

## What M19 adds: data-quality flags and an accessibility audit

- **Flowsheet:** a **Flags** column with each Observation's stored flags in words (artifact suspected, late arrival, duplicate resolved, entered by hand), or *none stored*. A value is **never flagged by how it looks**; *none stored* does not mean checked (contract A31). A tag in another system, or an unknown code, is shown as unrecognised, never hidden.
- **Trends:** each day carries the analytic API's counts of flagged values. A visible paragraph says how many values on how many days are flagged as suspected artifacts or late, and that **the range shown includes them**; the table twin has *Flagged* and *Late* columns; the arrow-key readout adds them for the day. The paragraph is its own element (the chart's text summary does not repeat it, so it is announced once). A band with missing, negative or fractional counts, or more flagged than samples, is refused as a malformed answer, not drawn.
- **One helper** (`src/flags.ts`) reads flags from a resource's tags and words them; the intraday view uses it too.
- **Accessibility audit** (`test/a11y-audit.ts`, no package): names for every control and tab-focusable element, table captions and header scopes, heading order, unique ids, nothing focusable inside `aria-hidden`, images with alt. Each rule has a positive control (a defect it must find, and the same markup repaired). It runs on the trends and flowsheet pages. **Not covered:** contrast, focus order on a real screen, a screen reader, and the intraday, sleep and banner pages (not yet audited). Those need a real browser and an interactive sign-in, which was not done.

## Data set switch (M17)

The page header offers **Synthetic data** (default) and **Real data (Apple Health)**. Each loads its own Patient by
business identifier (`VITE_POC_PATIENT_IDENTIFIER`, default `poc-0001`; `VITE_POC_HEALTHKIT_PATIENT_IDENTIFIER`,
default `poc-real`); the two are never combined. The real set shows a "Real data" note, and a missing real patient is
explained in words. The choice is held in memory only: a reload returns to synthetic. A hand-entered sample appears
among the flagged samples as "entered by hand, not measured by a device".

## Deployed vs development (M13a)

`make stack-up` also deploys the web app: `web/Dockerfile` builds the app (`vite build`, Node 24 by digest) and
serves it with the already-local pinned nginx image at `https://macpro16.local:3000` (TLS, all interfaces). The
nginx (`web/nginx/nginx.conf`) relays GET/HEAD `/fhir` to HAPI and `/analytics` to the analytic API **inside the
compose network with certificate verification**, sets a Content-Security-Policy (scripts from its own origin only;
connections to itself and to Keycloak), serves hashed assets as immutable and `index.html` uncached, and answers
the SPA fallback for `/callback`. It runs as the invoking user, read-only, with no capabilities.

`make web-dev` (Vite's dev server, hot reload) is for development and uses the same port: it refuses to start
while the deployed service owns it (`docker stop spezi-poc-web` first).

## Run

```bash
make web-dev          # https://macpro16.local:3000 (TLS, all interfaces); Ctrl-C stops
make test-web         # typecheck + unit and component tests (no stack needed)
make web-seed-nutrition-days   # 24 known synthetic dietary intake days for the nutrition view (idempotent)
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
