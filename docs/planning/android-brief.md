# Android capture: planning brief (Health Connect, SpeziKt)

Extends [fhir-data-model.md](fhir-data-model.md) and [nutrition-brief.md](nutrition-brief.md) (both stay authoritative for everything already built). Written 2026-10-29. **Planning only: no application code until the developer has reviewed this brief and the M24 to M30 entries in [../implementation-plan.md](../implementation-plan.md).**

Every platform fact is tagged **[VERIFIED]** (read in a source named here), **[UNVERIFIED]** (from memory or inference, to be checked on the phone or in the library source) or **[DECISION]** (the developer's call).

## Goal

Do for an Android phone what the iOS app does today: read the developer's own health data that other apps (Samsung Health, Google Fit, MyFitnessPal, a watch's companion app) have written to **Android Health Connect**, map it with the same contract, and send it to the developer's own HAPI over TLS with a Keycloak token, so the same analytics and clinician web app show it. The test device is a **Samsung Galaxy A15 5G, model SM-A156U1/DS** (the US unlocked variant; it launched with Android 14 and One UI 6 **[VERIFIED]** in [GSMArena's review](https://m.gsmarena.com/samsung_galaxy_a15_5g-review-2671.php)). It runs **One UI 8.5 on Android 16**, with a **Google Play system update dated 2026-09-01** (the full build number was not recorded). Health Connect is part of the Android system from Android 14 and is updated through Google Play system updates **[VERIFIED]** ([Google's support page](https://support.google.com/android/answer/14119325), [the Android developers blog](https://android-developers.googleblog.com/2023/05/whats-new-in-android-health.html)), so no operating-system upgrade was needed for it; SpeziKt's minimum is Android 12 (API 31). The Health Connect version itself is not known from that date: the probe (M24) records the version the phone reports, and the phone is not upgraded in the middle of a milestone.

## Decisions taken (2026-10-29)

| # | Decision | Consequence |
|---|---|---|
| A1 | **Native Kotlin with SpeziKt** (Stanford Spezi's Kotlin and Android framework) | A new `android/` project beside `ios/`; SpeziKt is a dependency from outside the project, approved by this decision. |
| A2 | **The real-data rule is extended to Health Connect:** the developer's own Health Connect data may go to the developer's own HAPI, under the same conditions as HealthKit data | Applied to the root `CLAUDE.md` Data section on 2026-10-29; the conditions are unchanged (own data only, only to `https://macpro16.local:8443/fhir`, TLS and token, never in the repo, logs, fixtures, screenshots, commit messages or conversation). |
| A3 | **All five metrics:** heart rate, resting heart rate, heart rate variability, sleep, nutrition | HRV is the awkward one: Health Connect gives RMSSD, not SDNN (section 3). |
| A4 | **The Android data belongs to a persona, not to the developer (decided 2026-11-11):** a typical mobile-only user with a **new MyFitnessPal account** (not the developer's), its own FHIR `Patient` **`poc-android-01`** and **its own Keycloak login** | See "The Android persona" below. The persona's meals are not the developer's, so nothing is logged on both phones and no double counting arises. |

### The Android persona

The developer is simulating a typical user who has **only a mobile device for health**, with a new MyFitnessPal account created on the Galaxy A15 5G and not connected to the developer's iPhone data. What the persona needs (2026-11-11):

| Piece | Today (iOS) | For the persona |
|---|---|---|
| FHIR `Patient` | `poc-0001` (synthetic), `poc-real` (the developer's); the app finds or creates the Patient by identifier on first upload | **`poc-android-01`**, same identifier system, created the same way (the capture role may create a Patient); `hapi/auth.py seed` is extended so it can also exist before any data |
| Keycloak user | `capture-user` with the `capture-writer` role; its password is generated into the git-ignored `idp/.env.local` | **a new user** (proposed name `android-user`) with `capture-writer`, in `idp/realm/poc-realm.json` and on the live realm by `kcadm`; the password is generated and never appears in conversation |
| Keycloak client | `ios-capture` (public, PKCE) | `android-capture` (public, PKCE) with its own redirect scheme |
| MyFitnessPal account (the source of the nutrition data) | the developer's own MFP account, signed in with Google (the developer's work Google account) | a **separate MFP account**, created on the Android phone by email sign-up (not a social login) with **a new Google (Gmail) account created for the persona**, with invented profile details; credentials stay with the developer, outside the repo (no addresses or passwords are recorded in this repository) |
| Web | a data-set switch: Synthetic and Real | a third choice for the persona, worded as neither synthetic nor the developer's real data (invented meals on a real phone) |
| Analytics, HAPI rules, contract | read by patient id; the capture role may create Patients | no change expected |

- **Not scoped to a patient:** the capture role can write for any Patient, and the analytics API's reads are unscoped too (assumption A44 in `analytics/README.md`). A separate login models a typical user's sign-in but does not stop that user writing another patient's data. Restricting it (a patient claim in the token and a HAPI rule per patient) is a much larger change and is recorded here as a **known gap**, not part of M25.
- **Data rule:** the persona's meals are invented, but they sit in the developer's own Health Connect on the developer's own phone, so they are handled under the same rules as real data (own HAPI only, TLS and token, never in the repo, logs, screenshots, commit messages or conversation).
- **Metric coverage on the real phone:** a mobile-only user usually has no heart-rate sensor (the A15 5G is not known to have one: **[UNVERIFIED]**, to be checked in the phone's specifications), so heart rate, resting heart rate and HRV probably have **no real source on this device**; sleep depends on an app; nutrition and steps are the realistic real-device metrics. All five stay in scope for the app (A3); the other metrics need a source other than the phone's own sensors, such as synthetic Health Connect records written by a test app (an idea for the plan, **not yet agreed**).

Other open decisions are in section 8.

## 1. What carries over, what is new

| Carries over unchanged | New for Android |
|---|---|
| `contract/metrics.json` as the one code table, the independent golden fixtures, `contract/check.py` | a `healthConnect` description per metric, a Health Connect identity rule, a new HRV metric, a new `meta.source` and identifier system (section 4) |
| HAPI, the narrow retraction rule (it is driven by the contract's identifier systems), TLS and token rules | one more identifier system in the retraction rule; a new Keycloak public client for the app |
| Analytics and web (they read the contract) | HRV RMSSD appears as a new quantity metric; a data-set choice for Android data (section 8) |
| The design lessons of iOS M17 to M21: acknowledged handoff, hold-not-drop while signed out, sign-in wakes the upload, attempt history, no logging of real samples, retraction, a synthetic source behind the same ingest interface | the collector, queue, sync engine, sign-in and UI, written in Kotlin |

## 2. SpeziKt: what it offers, what it does not

Sources: the [repository](https://github.com/StanfordSpezi/SpeziKt) (MIT; last push 2026-09-13), its README, and the `health` module's README and source, read 2026-10-29.

- **Requirements [VERIFIED]:** the latest stable Android Studio, JDK 17 as the stated minimum (a floor, not a ceiling), a device or emulator on Android 12 (API 31) or newer. It is **not published as Gradle coordinates** on the README: you clone it and add modules as project dependencies, apply its convention plugins and declare a `Configuration` on your `Application` class. No project template exists; a `sample-app` does. No maturity level is stated.
- **Modules [VERIFIED]:** `core*` (coroutines, lifecycle, logging, time, viewmodel), `ui*` (design system, theme, account UI, markdown, personal info, validation), `account` and `account-firebase`, `storage-local` and `storage-credential`, `contact`, `questionnaire` (FHIR Questionnaire rendering), `health` (Health Connect), and `testing-*`. **No FHIR module, no onboarding module.**
- **The `health` module wraps all five of our record types [VERIFIED]:** `HeartRate`, `RestingHeartRate`, `HeartRateVariabilityRmssd`, `SleepSession` and `Nutrition` are among its 41 `RecordType` wrappers (so is `Hydration`). Permissions come from the Health Connect library. Collection is declared per type (`collectRecord`), manual or automatic with a polling interval, with a `continueInBackground` flag and a start time; changes go to a `HealthConstraint` through `handleNewRecords`, `handleDeletedRecords` and `onFullyResyncRequired`.
- **Findings from its source that matter to us [VERIFIED by reading `HealthDataCollector.kt`; the second is inferred from the code]:**
  1. **There is no acknowledged handoff.** The changes token is stored **before** the handlers run, the handler's result is not checked, and an exception in a handler leaves the token advanced: those changes are not fetched again. This is exactly the fire-and-forget hand-off that iOS M18 had to remove (root rule: "Never make the handoff fire-and-forget again").
  2. **Background collection is a polling coroutine,** with no WorkManager and no foreground service. Whether it survives the app being in the background on One UI is **[UNVERIFIED]** and doubtful.
  3. On an expired token it asks for a full resync and requests a new token, but appears not to store the `nextChangesToken` of the resync response, so changes may be seen again. This is harmless for us (uploads are idempotent) but is a sign of how young the module is.
- **`account` is built around Firebase [VERIFIED]**, an external service this project does not use. Sign-in stays our own Keycloak OIDC.

### Maturity: the evidence, and why it is not a reason to forgo SpeziKt

From GitHub's API on 2026-10-29 (the commit list was truncated, so only the newest eleven commits were seen): created April 2024; 17 stars, 4 forks, 13 open issues; MIT; not archived; **no releases or tags**; last push 2026-09-13. The `health` module landed in December 2025 (commits "Spezi Health" and "Samples app + Health screen"), so it is under a year old; most of the visible commits are by one author, with a README fix in June 2026. It is young, thinly staffed and unreleased, but active.

**Position: keep it, bounded.** The project's stated purpose is learning Stanford Spezi, and the iOS app uses Spezi; our exposure is small (we write the collector, sign-in, mapper, queue and sync ourselves, so SpeziKt supplies only project structure, permission handling, the record-type wrappers, credential storage, theme and test helpers); and it is cheap to remove (the wrappers sit on Google's Jetpack Health Connect client, which we could call directly). A defect we hit, such as the token advancing before the handler runs, is something we can describe and offer upstream. So maturity justifies bounds, not abstention:

- **Pin it to a commit** (there are no releases, so a floating dependency would be a risk).
- **Depend on the small modules only:** `core`, `health` (record types and permissions), `storage-credential`, `ui-theme`. Not `account*` (Firebase-based), `questionnaire` or `contact`.
- **Keep our code behind our own interfaces,** so the layer stays replaceable.
- **Run a go/no-go spike first (M24),** with the criteria below.

**Go/no-go criteria for the spike.** SpeziKt stays only if all of these hold; if one fails, the app uses the Health Connect client directly and the brief is updated:

1. `sample-app` builds with the current stable Android Studio (its bundled JetBrains Runtime, JDK 25.0.4 in Android Studio 2026.2.2.9, checked on install 2026-11-11) and with the installed JDK 21.0.2 and 17.0.6, without forcing build-tool versions that conflict with what the rest of the app needs. Record which JDKs pass. Command-line builds set `JAVA_HOME` or a Gradle toolchain explicitly, never the machine's default JDK (the developer's machine has 17, 21 and 22 installed; 22 is not an LTS). App bytecode targets Java 17 or lower.
   **Result, 2026-11-11 [VERIFIED, `assembleDebug` of `:sample-app` at SpeziKt `03b4c46`]:** passes with JDK 21.0.2 (3 min 46 s cold, including the Gradle download) and with JDK 17.0.6 (forced rebuild); **fails with Studio's bundled JDK 25.0.4** (Gradle 8.13 stops at configuration with the opaque message "25.0.4"). Its toolchain: Gradle 8.13, AGP 8.13.0, Kotlin 2.1.21 (pinned for a KSP issue), compileSdk 36, minSdk 31, targetSdk 35. **Consequence:** Studio's Gradle JDK setting must be changed from its default to 21 for this project, and command-line builds use `JAVA_HOME` = JDK 21. Gradle installed Build-Tools 35 and Platform 36 into the SDK by itself. Criterion 1 is met.
2. `sample-app` installs and runs on the Galaxy A15 5G (One UI 8.5, Android 16).
3. The Health Connect permission flow works on the phone (the requests appear, grants are honoured, the rationale screen opens).
   **Result so far, 2026-11-11 [VERIFIED on the phone]:** criterion 2 met (the debug APK installs and launches on the Galaxy A15 5G). Criterion 3 partly met: the permission requests appear and individual grants are honoured (read and write are separate grants; the sample requests blood pressure, weight, steps and heart rate, so resting heart rate, HRV, sleep and nutrition are not exercised by the sample). A write-then-read round trip works: the sample's "Insert sample step record" produced "Total: 1" in its "Today's Records" counter (counts only; polls every 5 seconds). **Findings:** the sample's Insert button reads its enabled state once when the screen is built, so a grant made after that leaves it disabled until the app restarts; the `health` module's manifest declares almost every Health Connect permission, with a `WRITE_` entry for each, and it would need stripping with manifest merge rules before we ship.
4. The `health` module can read all five record types we need (heart rate, resting heart rate, HRV RMSSD, sleep session, nutrition) on the phone, counts only.
5. Background collection is measured on One UI with the app closed: whether it keeps running, and for how long. A failure here does not by itself drop SpeziKt (our own collector is the plan, option (a) below), but it must be recorded, because it decides whether anything of its collector is used.
6. A new commit on `main` since 2026-09-13, or a recent issue answered, is noted as a sign of life (informational, not a gate). **Result, 2026-11-11:** `main` is at `03b4c46` (2026-06-28); no commits since 2026-09-13.

**Consequence [DECISION A5, section 8]:** use SpeziKt for what it gives (project structure, permission handling, record types, UI pieces, credential storage, testing helpers) but **do not rely on its collector** for the durable path unless it is changed. Options: (a) our own collector over the Health Connect client that persists the changes token only after the queue write commits, registered from WorkManager, using SpeziKt's types and permissions; (b) patch or fork the module (and offer the change upstream); (c) use it as is (rejected: it can lose data). I recommend (a), and (b) if upstream accepts a change.

## 3. Health Connect: what I know and what must be checked

Facts from Google's documentation and search results, 2026-10-29:

- **[VERIFIED]** [`HeartRateRecord`](https://developer.android.com/reference/androidx/health/connect/client/records/HeartRateRecord): one record = start, end, a **list of timestamped samples** and metadata. (HealthKit gives one sample per reading; the iOS contract's identity rule assumes that.)
- **[VERIFIED]** [`HeartRateVariabilityRmssdRecord`](https://developer.android.com/reference/androidx/health/connect/client/records/HeartRateVariabilityRmssdRecord): **RMSSD**, the root mean square of successive differences. Our contract's HRV is **SDNN** (LOINC `112429-6`). They are different measures and must not be mixed. A search of NLM's LOINC lookup (2026-10-29) found `112429-6` for SDNN and **no LOINC code for RMSSD** (only other R-R interval deviation codes).
- **[VERIFIED]** `NutritionRecord` covers nutrients taken in as part of a meal or a food item; `SleepSessionRecord` covers sleep length and its stages.
- **[VERIFIED]** [Changes API](https://developer.android.com/health-and-fitness/health-connect/sync-data): `getChangesToken` and `getChanges`; upsertion changes carry the record with its id and last-modified time; **deletion changes carry only the id**; an unused token **expires within 30 days** (the app must fall back to a time-range read).
- **[VERIFIED]** Without the history permission, reads reach back **30 days**; a reinstall resets the window to 30 days before the new grant.
- **[VERIFIED]** The Google Fit APIs are being shut down (sign-ups closed in 2024; sources disagree on the final date): Health Connect is the only source we target. See [9to5Google](https://9to5google.com/2024/05/04/google-fit-api-shutdown/).
- **[UNVERIFIED]** in part (the `Metadata` fields named below compile and return on the phone, see the probe results; the rest is still from general knowledge): `Metadata` carries `id`, `dataOrigin.packageName` (the writing app), `lastModifiedTime`, `clientRecordId` and `clientRecordVersion`, `device` (manufacturer, model, type) and `recordingMethod` (unknown, actively recorded, automatically recorded, manual entry); `NutritionRecord` has `energy`, `protein`, `totalCarbohydrate`, `totalFat`, `dietaryFiber`, `sugar`, `sodium`, about forty more nutrient fields, `mealType` (unknown, breakfast, lunch, dinner, snack), a food `name`, start and end with nullable zone offsets; `HydrationRecord` holds a volume; the permission names for reading in the background and for history; and which apps (Samsung Health, MyFitnessPal, Google Fit) really write to Health Connect on the A15 5G.

### First probe run on the phone (M24, 2026-11-11, counts and field names only)

Read by `android/` (the probe, read permissions only) over the last 30 days; the aggregate text came from the debug log. Nothing here is a value.

| Type | Records | Writing apps (package: records) |
|---|---|---|
| `HeartRateRecord` | 0 | none |
| `RestingHeartRateRecord` | 0 | none |
| `HeartRateVariabilityRmssdRecord` | 0 | none |
| `SleepSessionRecord` | 0 | none |
| `HydrationRecord` | 0 | none |
| `NutritionRecord` | 1 | `com.myfitnesspal.android`: 1 |
| `StepsRecord` | 26 | `edu.stanford.spezi.sample.app`: 26 (synthetic, inserted from the sample's button) |

- **[VERIFIED] No vitals source exists on this phone yet.** Samsung Health has written nothing to Health Connect (no steps, heart rate or sleep), although it is allowed to. Whether a Samsung Health sync setting is off is **[UNVERIFIED]**, to be checked in Samsung Health, Settings, Health Connect. The synthetic writer is the only source of heart rate, resting heart rate, HRV and sleep until that is resolved or a wearable is added.
- **[VERIFIED] One MyFitnessPal food item is one `NutritionRecord` carrying all its nutrients.** It has 17 nutrient fields present (energy, protein, total, saturated, monounsaturated, polyunsaturated and trans fat, total carbohydrate, dietary fibre, sugar, cholesterol, sodium, potassium, calcium, iron, vitamin A, vitamin C) and a meal type. It has **no food name**, no unsaturated-fat total and no caffeine. Nutrients are not delivered one at a time as they appeared to be on iOS. The record id looked like the natural group identifier (A9), but see the next findings: MyFitnessPal does not keep it stable.
- **[VERIFIED] A nutrition record carries no time of day for the meal.** Both records (a breakfast and a lunch) span 720 minutes and **both start at 10:00 in their own offset**, so the window is MyFitnessPal's, not the meal's. The date (in the record's own offset) and the meal type are the only timing information. Consequence for the mapping: the Observation's effective time is the record's own period (`effectivePeriod`), not an instant, and the "day as recorded" is the start's date in its own offset, as on iOS; a meal's time of day must never be shown or computed from this.
- **[VERIFIED, 2026-11-11] MyFitnessPal rewrites its records on sync with new record ids.** Read before and after a sync: 2 records before and 2 after, the same meal types and start hour, **0 of 2 record ids seen in the previous read**; the changes API reported 2 upserts and 2 deletions for the rewrite; the next read, with no sync in between, kept both ids (2 of 2). The sample app's step records kept all 26 ids across reads, so id stability is a property of the writing app. **Consequence:** the record id is not a stable identity for MyFitnessPal nutrition, so decisions **A7** and **A9** are **under review** (below). **Not yet known:** whether MyFitnessPal rewrites on every sync or only when the day's entries change (the developer's action between the two reads was not recorded); a test with a sync and no edit settles it.
- **Proposal for the review (not decided): a content-based identity for nutrition.** The key would be the writing app, the meal type, the start and a hash of the nutrient values, so a rewritten but unchanged item keeps its identity and an edited item gets a new one. The app's per-record watermark would map each old record id to its content key, so a deletion change (which carries only the old id) retracts the right Observations only when that content key is not re-delivered in the same batch. Other types (heart rate, sleep) keep the record-id rule until a probe on real records says otherwise. Cost to weigh: a changed nutrient value is then a delete plus an insert, never an in-place update.
- **[VERIFIED] Metadata as read by the library compiles and returns:** `dataOrigin.packageName`, `clientRecordId`, `lastModifiedTime`, `recordingMethod`, `device`, `id`. On the MyFitnessPal record the client record id and the device are absent, the recording method is manual entry, and both zone offsets are present. On the sample's step records the offsets are also present and the method is manual entry. Only the record id is therefore a usable identity for MyFitnessPal data.
- **[VERIFIED] A freshly written record reads as modified after its end** (all 26 sample records): the writer stamps `end = now` and Health Connect stamps the modification milliseconds later. The probe's "updated after end" count now uses a one-minute tolerance, so only a real later edit counts.
- **[VERIFIED] Changes API:** a token is issued and read back (an empty change list when nothing changed). Repeat delivery of a growing record is **not yet measured**: it needs a writer that updates a record after the token is taken (M27's synthetic writer, or a source such as Samsung Health once it writes).
- **Not yet probed:** heart-rate series length, sleep stage shape, overlapping origins, null offsets in the wild, because no such records exist on the phone.

### Where Health Connect data goes besides our app (cloud and backup)

- **Health Connect keeps its data on the device, encrypted.** One secondary source says it does not sync to any cloud unless a user sets that up through individual apps ([fitmesh](https://www.fitmesh.fit/en/blog/how-does-health-connect-work), **[UNVERIFIED]**: not Google's own statement).
- **Health Connect has its own optional backup:** scheduled exports to a cloud provider the user chooses, as a ZIP file, off unless enabled ([Google's help page](https://support.google.com/android/answer/15323271?hl=EN-GB)). Sources disagree on whether the export is encrypted: [Android Authority's test](https://www.androidauthority.com/health-connect-data-backup-3498985/) found it was not. **Do not enable it for real data without checking.**
- **Samsung Health syncs separately** through the Samsung account (its "Sync with Samsung account" setting); one secondary source says Health Connect's backup does not cover other apps' data **[UNVERIFIED]**, to be confirmed in Samsung's documentation.
- **Nothing in this pipeline sends data to Samsung or Google.** The root rule that real data must not go to any third party therefore depends on the phone's own settings: for the persona (invented meals) this is not a concern; for any real data on this phone, check Samsung Health's cloud sync and Health Connect's backup first.
- **Permission is not activity:** Samsung Health holds permission for Nutrition in Health Connect, but whether it reads MyFitnessPal's entries and writes its own copy back (a duplicate with a different data origin) is unverified. The check, with no values: after logging one food in MFP only, does Health Connect's Nutrition list only MyFitnessPal as a data source, or Samsung Health too? M24 counts this under overlapping data origins. **Observed by the developer, 2026-11-11:** a breakfast item logged in MFP was **not visible in Samsung Health's own food log** for the same day. That suggests Samsung Health does not import nutrition from Health Connect, or does not display it; it is **not conclusive** (it might import without showing it, or the sync may not have run), because what matters is whether a second record exists in Health Connect.

### Server-side routes to Samsung data, and what Samsung Health writes to Health Connect (searched 2026-11-11)

Can Validic sync health data directly from Samsung Cloud? **No such route was found.**

- **Validic's Android route is Health Connect on the phone [VERIFIED in its documentation, read through search summaries].** Its [migration guide](https://developer.validic.com/docs/migrating-users-from-samsung-health-sdk-to-health-connect) moves users from its older Samsung Health SDK module to Health Connect in the newer Inform SDK, warns about duplicate data if both run, and suggests disconnecting Samsung Health so the two do not both report the same data. There are Health Connect pages for the [Android Inform SDK](https://helpdocs.validic.com/docs/native-android-mobile-inform-sdk-using-android-health-connect) and its React Native, Flutter and Cordova wrappers. No source found says Validic reads Samsung Cloud: **unconfirmed**.
- **Samsung offers no cloud API for third parties [secondary source, UNVERIFIED against Samsung's own documentation]:** a [third-party guide](https://openwearables.io/blog/samsung-health-api-integration-guide-android-developers) says access is through the on-device [Samsung Health Data SDK](https://developer.samsung.com/health/data), which talks to the Samsung Health app on the same device, and a [Terra analysis](https://tryterra.co/blog/samsung-health-medicare-app-library-developer-access) says distributing an app that uses it needs Samsung's partner approval. Samsung's own [Health Connect guide](https://developer.samsung.com/health/blog/accessing-samsung-health-data-through-health-connect) says Samsung Health data reaches Health Connect once the user connects them, and that this is on-device Android access, not a server API.
- **What this means for us:** a phone-side app that reads Health Connect, which is what this brief builds, is the same pattern Validic uses on Android. There is no server-side route to replace it with, and the pipeline sends nothing to Samsung or Google.
- **What Samsung Health writes to Health Connect [Samsung's mapping table, read through a fetch summary; the scope varies with the Samsung Health version]:** per [Samsung's guide](https://developer.samsung.com/health/blog/accessing-samsung-health-data-through-health-connect), steps, blood glucose, blood oxygen, blood pressure, exercise (session, calories, distance, heart rate, power, speed, VO2 max), **heart rate**, **nutrition**, **sleep sessions and stages**, and weight with body fat, basal metabolic rate and height. **Resting heart rate, heart rate variability and hydration are not listed.** Sync works in both directions since Samsung Health 6.22.5, happens on the phone, and must be switched on in Samsung Health (Settings, Health Connect); Samsung Health's activity tracker data is not synced; read and write permissions are granted separately.
- **A phone alone has no vitals sensors.** Heart rate, blood oxygen and sleep stages come from a Galaxy Watch, whose data reaches Health Connect only after it syncs to Samsung Health on the phone (when the watch reconnects, or when Samsung Health's home screen is opened or pulled down); continuous watch heart rate is not sent to the phone immediately, for battery reasons. For the mobile-only persona this means no real source for heart rate, resting heart rate, HRV or sleep unless a wearable is added; HRV (RMSSD) and resting heart rate may have no Samsung source even then. The synthetic Health Connect writer (M27) covers these metrics on the phone.
- **Samsung's page says Health Connect data can only be retrieved by apps running in the foreground [UNVERIFIED as current]:** that may predate Health Connect's later permission for background reads, so M24 tests background reading on this phone.

## 4. Mapping to the contract (proposal)

| Contract metric | Health Connect source | Notes |
|---|---|---|
| `heartRate` | `HeartRateRecord.samples` | **one Observation per sample.** A sample has no UUID: identity is built from the record id and the sample time (section 5). |
| `restingHeartRate` | `RestingHeartRateRecord` | one reading per record |
| HRV | `HeartRateVariabilityRmssdRecord` | **a new metric, `hrvRmssd`, never mapped onto SDNN.** No LOINC code found, so it would use the contract's own code system (like fibre and sugar). Unit milliseconds. **[DECISION A6]** |
| sleep stages | `SleepSessionRecord.stages` | a stage list maps to the existing per-stage-interval Observations. The stage vocabulary differs from HealthKit's (to be mapped and checked; "light" is HealthKit's "core" by contract A4). **[UNVERIFIED]** the exact stage constants |
| intake (eight nutrients) | `NutritionRecord` (and `HydrationRecord` for water) | **one record holds all of a food item's nutrients**, so the grouping we could not recover on iOS is free here (the record id is a group key; see the scale brief, option B3). One Observation per nutrient, as now, sharing a group identifier. The `mealType` becomes the contract's meal category (absence stays absence); the food `name` is **not** read (nutrition brief N6: meal, never food name). |
| source app | `metadata.dataOrigin.packageName` | the analogue of the iOS bundle id (decision D6); same `app-bundle-id` identifier idea with a package name |
| device | `metadata.device` | manufacturer, model, type; a device-key rule like iOS's |
| times and days | record start and end with their zone offsets | the offset is the recorded offset (A6, D3); a null offset falls back to the phone's current zone, as iOS does (N7). **[UNVERIFIED]** how often it is null |
| quality flags | the same `QualityFlagger` rules | ranges from the contract; `recordingMethod` of manual entry is the analogue of `WasUserEntered` (the `user-entered` flag) **[UNVERIFIED]** |

**New in the contract (proposal, version 1.6.0):** `systems.identifier.healthConnect` (sample identity), `systems.metaSource.healthConnect`, a `healthConnect` field per metric naming the record class, the `hrvRmssd` metric, the Health Connect identity rule, and a group identifier for nutrient Observations. Every change comes with golden fixtures from the independent generator and a check with its control; `contract/sync.sh` gains an Android copy.

## 5. Design problems that iOS did not have

1. **A series record is not a sample, and a record can change.** A `HeartRateRecord` can hold hundreds of samples. Writing apps may follow either of two patterns, and **the app must handle both**:
   - **(a) each record has its own time period:** every change brings a new record with new samples, and nothing is re-sent;
   - **(b) one record fills progressively:** the writer updates the same record (same record id, new last-modified time) as samples accrue. I understand the changes API to deliver the **whole record** again on each update, not only the new samples **[UNVERIFIED]**.

   HealthKit samples are immutable (an edit is a delete plus a new sample), so iOS needed neither. Our create-only server role cannot update (option U below).

   **Sample identity (decision A7, under review for nutrition: see the first probe run):** a sample's identifier is the **record id plus the sample time plus a hash of its value**, and **not** the record's version. The record's version is the wrong key for pattern (b): it changes on every update of a growing record, so using it would give every existing sample a new identifier and upload and store all of them again as duplicates. With the stable rule:
   - a growing record re-sends its old samples under identifiers the server already holds, so the conditional creates are no-ops, and only the new samples are created;
   - a sample whose **value changes** at the same time gets a new identifier (the hash differs), and the old Observation is retracted;
   - a **deleted record** arrives as a deletion change with only the record id: everything that record produced is retracted.

   **The group identifier (decision A9, now; under review for nutrition: see the first probe run):** every Observation also carries the **record id as a second identifier** (a contract system of its own). The app can then ask HAPI which Observations a record produced (`identifier=<health-connect-record system>|<record id>`) and retract exactly the ones that are no longer in the record, so **the server is the ledger** and the app needs no local ledger to apply deletions and edits. It costs one search per deleted or changed record and needs a connection; an offline retraction waits in the queue.

   **A per-record watermark** (the last sample time sent for each record id) stays in the app to avoid re-sending a whole growing record each time; it is an optimisation, not the source of truth.

   **Cases the two patterns do not cover:** (i) **overlapping writers:** two apps may record heart rate for the same time (for example Samsung Health and a watch app), with different record ids, so identity does not merge them and bands and totals would count both: the same cross-source duplication as nutrition (assumption A53 in `analytics/README.md`), recorded here as a known gap; the probe counts how often two data origins overlap in time. (ii) **a record deleted before it was uploaded:** nothing is uploaded and no retraction is sent.

2. **An acknowledged hand-off.** Our collector must advance the Health Connect changes token only after the queue write is durable (iOS M18's rule), restart collection at every launch and from WorkManager, hold records while signed out and resume on sign-in (iOS M20's lesson). This is the reason for section 2's option (a).
3. **A modest phone: 4 GB of memory.** Low-memory phones stop background processes sooner, and One UI adds its own limits. This is a harsh test of background reliability, so a pass here is likely to hold elsewhere. Guards: **bounded page and batch sizes**, stated in the milestone, with a test using a large synthetic record (never load a whole day into memory); a **process-death test** (force-stop the app between reading a change and committing it to the queue, and check that nothing is lost and a retry converges: the Android counterpart of iOS M18's durable-handoff test, done with `adb`); and **peak memory** recorded during an upload in the M28 measurement.

### Option U: a narrow update rule (considered, deferred)

Should the capture role be allowed to update, since the FHIR API supports it? Considered and **deferred**: retract-and-recreate matches the existing, tested retraction machinery; a rule for updates must judge a whole resource (a conditional PUT) or a family of patches, a much larger surface than `RetractionPolicy`'s single accepted patch body; it widens the write power of a phone token from "create and hide" to "alter stored values"; and it conflicts with the "append-only facts" direction of the scale brief. Update would fix the limit of assumption A31 (a flag written at creation cannot be corrected later) and would keep one resource per sample identity. **Revisit** if edits prove common or flag correction is wanted; then use a narrow JSON Patch of a few named paths (the value and the tags) in the style of the retraction rule, not a free PUT.

## 6. The app (mirrors iOS)

- **Layers:** an ingest interface with two sources (a synthetic generator and Health Connect), a mapper driven by `contract/metrics.json` and tested against the shared golden fixtures (the cross-language check: a bug has to be made twice), a durable queue (SQLite), a sync engine (WorkManager, retry with backoff, attempt history), OIDC sign-in with a Keycloak public client and PKCE, a token store in the Android Keystore, and a Compose UI with the same home screen as iOS (capture state, queued, uploaded, attempt history, pause).
- **Sign-in and trust [UNVERIFIED, to be checked early]:** AppAuth for Android against Keycloak (a new client such as `android-capture`, in `idp/realm/poc-realm.json` and on the live realm by `kcadm`, as `ios-capture` was). Apps targeting recent Android do not trust user-installed CAs by default, so the POC CA would be bundled in the app and trusted through a network security configuration (our name-constrained CA, still TLS only, no cleartext). **Whether the phone resolves `macpro16.local` (mDNS) from an app is not known**; the fall-back is the Mac's address, which needs the certificate to cover it.
- **Packages beyond SpeziKt need approval per milestone.** Likely candidates, to be approved when M26 is reviewed: AppAuth-Android, an HTTP client (OkHttp), SQLite access (Room), WorkManager, kotlinx-serialization, test libraries.
- **Development workflow [UNVERIFIED]:** Android Studio, USB debugging, `adb`, a debug build installed on the phone. A debug-signed build does not expire the way the iOS free profile does; no Play Store account is needed.
- **Samsung's battery management** may stop background work for an app it considers idle; the app may need to be exempted by the developer on the phone. **[UNVERIFIED]**

## 7. Risks and unknowns

| Risk | What reduces it |
|---|---|
| SpeziKt's health module loses data and may not run in the background (section 2) | own collector (option a); measure background delivery on the phone before building on it (M24, M27) |
| A record changes under us, or grows over a day (section 5) | the stable sample identity, the record-id group identifier and the per-record watermark; the seven test scenarios of M27 with a fake Health Connect |
| A modest phone (4 GB of memory) stops background work sooner and has less room (section 5) | bounded batches, a process-death test and a peak-memory measurement (M27, M28); the phone is the worst case, not a reason to change target |
| Two apps record the same heart rate (overlapping data origins) | a known gap (section 5); the probe counts the overlap |
| HRV RMSSD has no LOINC code and is not SDNN | a separate metric with its own code (A6); never converted |
| The same nutrition entry written to Apple Health and Health Connect would be counted twice if both go to the same patient | resolved by A4: a separate persona, patient and MFP account, so no meal is on both phones |
| `.local` name resolution and CA trust on Android | check both in M24 before writing the app |
| Health Connect field names and which apps write there are unverified | the device probe (M24), counts and field presence only |
| 30-day default history; token expiry after 30 days unused | state it in the app; fall back to a time-range read; decide on the history permission (A8) |
| SpeziKt is young (no stated maturity, no published artifacts) | pin a commit; keep our code behind our own interfaces |
| Real data on a second device and platform | the root data rule applies unchanged; a source test that no real-sample file logs or prints, as on iOS |

## 8. Decisions (taken and still open)

| # | Question | My recommendation |
|---|---|---|
| A4 | Android data under the iPhone data's patient, or its own? | **decided:** its own patient, `poc-android-01`, with its own Keycloak login (see "The Android persona") |
| A5 | Collector: our own over the Health Connect client (a), patch SpeziKt (b), or as is (c)? | **decided (plan approved 2026-11-11): (a)** |
| A6 | HRV: a new `hrvRmssd` metric with a project code, or skip HRV on Android? | **decided (plan approved 2026-11-11):** the new metric |
| A7 | Sample identity for edited and growing records | **decided, UNDER REVIEW (M24 evidence, 2026-11-11: MyFitnessPal rewrites records with new ids, so record id is not stable for nutrition):** record id + sample time + value hash, not the record version (the version would duplicate every sample of a growing record); see section 5 |
| A8 | Ask for the history permission, to read more than 30 days back? | **decided (plan approved 2026-11-11):** no for the first milestones (30 days is enough to prove the path); revisit |
| A9 | Group identifier for a record's Observations | **decided: now; UNDER REVIEW for nutrition (M24 evidence: MyFitnessPal rewrites records with new ids; the record id may still be right for other types).** The record id is a second identifier on every Observation; the server is the ledger for deletions and edits; the app keeps only a per-record watermark |

## 9. Non-goals

The Google Fit APIs (shutting down); writing to Health Connect from the product app (a separate test writer of **synthetic** records is in scope, M27); Samsung Health's own SDK; Wear OS; Play Store distribution; Firebase and any other external service; the scale work of the scale brief (it applies to both platforms alike).

## 10. Proposed milestones (also in the implementation plan, marked proposed)

| # | Milestone | Verifies |
|---|---|---|
| M24 | **Android environment, SpeziKt spike and Health Connect probe** (read-only, on the phone, counts and field presence only) | which apps write to Health Connect, which record types and how many, whether zone offsets and metadata fields exist, **samples per record and the time span each record covers, whether records carry a client record id, whether a record's last-modified time is later than its end (updated after writing), how often the same record appears in successive changes, how often two data origins overlap in time**, `.local` resolution and CA trust, and whether background work survives on this 4 GB phone; settles the UNVERIFIED items above; and the SpeziKt go/no-go criteria of section 2 |
| M25 | **Contract 1.6.0 and the independent golden fixtures for Health Connect** [contract/, hapi/, idp/] | the new metric, **the stable sample identity and the record-id group identifier** (with golden fixtures for pattern (a), pattern (b) and an edited sample), systems and `healthConnect` fields; the HAPI retraction rule for the new identifier system; the Keycloak client and user |
| M26 | **Android skeleton** [android/] | SpeziKt project, Compose home screen, OIDC sign-in, TLS trust, the Kotlin mapper passing the golden fixtures, a synthetic source uploading to the synthetic patient |
| M27 | **Health Connect ingest** [android/] | own collector with an acknowledged hand-off and durable queue, permissions, the five metrics, series samples, the per-record watermark, **a test writer of synthetic Health Connect records** (so all five metrics and both patterns are testable on the phone), and the seven test scenarios below |
| M28 | **Background sync, retraction and diagnostics** [android/] | WorkManager, backoff, retraction from deletions and edits (by the record-id group identifier), sign-in wake, attempt history, the data-source screen, **the process-death test and a peak-memory measurement** |
| M29 | **Server, analytics and web alignment** [analytics/, web/, docs/] | HRV RMSSD charts, the Android data set, the nutrition group key, runbooks |
| M30 | **Real data on the phone and verification** [android/] | counts only; accessibility checks; the `android-device` runbook |

**The seven test scenarios for M27** (a fake Health Connect, then the synthetic writer on the phone): (1) unique records, delivered once each; (2) one record delivered three times, growing each time: each sample is created exactly once; (3) a growing record where an earlier sample's value changes: the old Observation is retracted and the new one created; (4) a record delivered twice with identical content: no change; (5) a record deleted after upload: all its Observations are retracted; (6) a record deleted before upload: nothing is uploaded and no retraction is sent; (7) a handler fails partway through a record: the changes token does not advance and the retry converges.

**The synthetic writer** inserts synthetic heart-rate, resting heart-rate, HRV, sleep and nutrition records into Health Connect (SpeziKt's `health` module has write support **[VERIFIED]** in its README; Google also publishes a Health Connect toolbox for developers that may add test data **[UNVERIFIED]**), covering patterns (a) and (b), an edit, and a deletion. Records it writes have the test app as their data origin and are synthetic. This is how the metrics a mobile-only phone cannot produce are tested on the device.

One milestone at a time, then stop for review (root rules).
