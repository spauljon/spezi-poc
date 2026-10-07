# UX Brief: Clinical Longitudinal Monitoring POC

Status: DRAFT for developer review. Produced with `digital-health-ux-planning`.

## 1. Purpose and framing

A learning POC that exercises the real shape of a remote-monitoring system: a patient-side **capture app** (Spezi mobile) that sources health metrics from HealthKit or a synthetic device, a **FHIR service** (HAPI FHIR 7.6.0, R4; target endpoint `https://macpro16.local:8443/fhir` with TLS and authentication, built in the implementation plan's M2-M4; the POC's own HAPI starts at a loopback-only `http://127.0.0.1:8192/fhir` (plain HTTP, no authn/authz) in M1 and is HTTPS-only from M2) as the system of record, and a **clinician web app** that reviews longitudinal data by querying the service.

Two projects:
1. **Capture app** — Spezi mobile (platform to be chosen at platform selection; HealthKit strongly implies Apple-native).
2. **Clinician web app** — outside the Spezi templates; reads the same FHIR service.

Success for the POC is architectural: real-world behaviors (batched/late/duplicate samples, gaps, multi-scale longitudinal views, FHIR mapping and search) are handled for real, not hand-waved.

## 2. User segments

| Segment | Role in POC | Notes |
|---|---|---|
| Patient (primary on capture app) | The developer, as the single fixed patient | Thin experience: authorize data types, see source and sync status, no clinical interpretation. |
| Clinician (primary overall) | The developer, as the single fixed clinician | Reviews one patient's longitudinal metrics. Time-poor, scans before drilling down, expects EHR flowsheet conventions. |
| Developer/operator | The developer | Drives the synthetic source and inspects pipeline behavior. Not a clinical user. |

Constraints: clinician needs fast answers and low cognitive load; patient burden must be near zero (passive capture). Single patient and single clinician with a fixed pairing; multiple patients/clinicians is a future extension, so no hard-coded single-patient assumptions in the data model or URLs.

## 3. Metrics in scope (initial)

| Metric | Data shape | Why chosen |
|---|---|---|
| Resting heart rate | Daily summary, sparse | Longitudinal baseline trend |
| Heart rate / HRV | Dense, irregular samples | Intraday zoom, gaps, high volume |
| Sleep | Category intervals (stages) | Interval modeling, hypnogram |

Additional HealthKit types can be added later via a metric registry (type -> FHIR code, unit, category, aggregation). Availability of some metrics depends on Watch model and watchOS version, to be verified before planning against them.

## 4. Core jobs to be done

Clinician:
- "Is this patient's trend changing, and by how much, over weeks to months?"
- "What happened in this specific episode or day?" (drill from trend to intraday)
- "Can I trust this data?" (provenance, source, gaps, late arrival, flagged artifacts)
- "Find it": filter and sort observations by metric, time range, source, status.

Patient (minimal):
- Grant or revoke access to the data types I choose.
- Know whether my data is being captured and has synced.

## 5. Core journeys

### Capture app
1. **First run**: orientation (what is read, where it goes) -> choose source (HealthKit or synthetic) -> authorize HealthKit types only if HealthKit chosen -> capture begins.
2. **Ongoing capture**: passive; patient can check source, last sync, queued count, and errors.
3. **Synthetic source controls** (simulator screen, visible only when source = synthetic): cadence, jitter, gaps, late/batched delivery, duplicates, outliers/artifacts, scenario presets.
4. **Recover**: sync failure, permission revoked, server unreachable -> clear state and retry, no silent data loss.

### Clinician web app
1. **Open the patient**: patient banner (identity, data sources, last data received, data-quality indicators).
2. **Longitudinal trend + flowsheet**: per-metric daily min/median/max band over weeks to months, with an EHR-style table below. Filter by metric, date range, source, status; sort by any column.
3. **Drill down to intraday**: select a day from the trend to open the dense heart rate/HRV view with zoom/pan and gap markers.
4. **Sleep review**: hypnogram for one night plus a nightly summary across weeks (duration, stage proportions, awakenings).
5. **Assess data quality**: see which values are late, duplicated, flagged, or gaps, and their provenance.

## 6. Clinical views (initial three)

1. **Longitudinal trend + flowsheet.** Daily min/median/max bands with a filterable, sortable table.
2. **Sleep.** Single-night hypnogram and multi-week nightly summary.
3. **Intraday dense view.** Raw samples for one day, zoom/pan, gap markers.

Candidates for later: distribution view, daily overlay.

## 7. Onboarding strategy

Capture app, minimum necessary:
- One orientation screen: what data, where it goes (own FHIR service), synthetic vs real.
- Source choice. Request HealthKit permissions only when HealthKit is selected, and only for the types in use.
- No account creation, profile or consent flow in the POC (fixed pairing). The app does sign in once with Keycloak as a single synthetic user to obtain a token; that is plumbing for the authorization boundary, not a user-facing account feature. Real pairing/consent is documented as an out-of-scope boundary.

Clinician web app: no onboarding beyond signing in with Keycloak as a single synthetic clinician and selecting the (single) patient.

## 8. Day-to-day workflow

- **Patient**: nothing required. Return only to check sync status or change source/permissions. No streaks, scores, or prompts.
- **Clinician**: lands on patient summary (last data received, quality indicators, trends), then drills in. Stale data (no recent sync) must be visible at a glance so absence of data is never mistaken for a normal reading.

## 9. Engagement principles

- Patient side: no gamification, no nudges, no alerts in the POC. Avoid shame and alert fatigue.
- Clinician side: no automated alerts in the POC; documented as future (thresholds, alert fatigue considerations).

## 10. Accessibility and inclusion

- Never rely on color alone in charts (patterns/labels for bands, stages, flags); meet contrast requirements in light and dark.
- Every chart has a text/table equivalent (the flowsheet) and an accessible summary; keyboard navigation for zoom/pan on web, VoiceOver/Dynamic Type on mobile.
- Plain language on the capture side; clinical terminology on the clinician side, with units always visible.
- Time zones and daylight-saving transitions must be explicit in time-axis display.

## 11. Clinical safety and compliance call-outs

- This is not a medical device. The UI must not present interpretations as diagnoses; show data, ranges, and provenance, not conclusions.
- Missing data is not normal data: gaps, late arrival, and stale sync must be visually distinct.
- Artifact/outlier values are flagged, not silently dropped or silently shown.
- Real health data is subject to the CLAUDE.md data rules: the developer's own HealthKit data may go only to the developer's own HAPI service, and only once TLS and authentication are in place; until then the server receives synthetic data only.

## 12. Out of scope (documented boundaries)

- Real patient-clinician linking, consent, and authorization (`Patient`/`Consent`, scoped access).
- Multiple patients/clinicians (future extension; avoid single-patient hard-coding).
- Alerts, notifications, reminders, PDF/CSV export, EHR-embedded (SMART launch) clinician app.
- Care plans, messaging, and other clinical workflow.

## 13. Unresolved risks and UX questions

1. HAPI has no authn/authz today, and HAPI itself does not authenticate (it evaluates authorization rules only), so the real-data gate stays closed until TLS and authentication exist. Decision: Keycloak is the identity provider (own `idp/` project), HAPI verifies its JWTs and authorizes by role; scheduled as early milestones (M2-M4) before any real-data work.
2. RESOLVED: a physical iPhone cannot reach `localhost`. The developer will configure local-network DNS for the Mac Pro so the iPhone can reach the FHIR service by hostname. TLS (iOS ATS) is still required, and the certificate must match that hostname and be trusted by the device.
3. Clinician web app stack is undecided (outside Spezi templates).
4. Which HealthKit types require Watch hardware/watchOS versions not available to the developer?
5. DECIDED: aggregation is server-side, into a small analytic database (store and technology to be chosen). Still open: how a "day" is defined (patient local time, time-zone changes), how late or corrected samples trigger recomputation, whether rollups are also written back to FHIR as derived Observations, and how the clinician web app reads them (analytic store via an API vs FHIR).
6. Sleep: mapping HealthKit stage categories to FHIR and the display taxonomy is a terminology decision, to be flagged in the FHIR data model brief.
