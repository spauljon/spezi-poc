# iOS capture app (Spezi POC Capture)

Swift 6, SwiftUI, [Spezi](https://github.com/StanfordSpezi/Spezi). It will capture cardiovascular measurements from a
synthetic source (now) or Apple Health (later) and send them as FHIR `Observation`s to the POC's HAPI server. This
milestone (M5) is the scaffold: orientation, source choice (synthetic only), server configuration, home. Planned in
[docs/implementation-plan.md](../docs/implementation-plan.md) (M5 to M8, M17, M18); the data model is in
[docs/planning/fhir-data-model.md](../docs/planning/fhir-data-model.md).

## Provenance

Copied from the [Spezi Template Application](https://github.com/StanfordSpezi/SpeziTemplateApplication), MIT licensed,
**without its `.git`**:

| | |
|---|---|
| Upstream commit | `d52014a54cbfe68ef1f1c364e81a97edecf5e4a8` (2026-06-28, "Migrate unit tests from XCTest to Swift Testing (#121)") |
| Copied | 2026-10-10 |
| Kept as is | `LICENSE.md`, `LICENSES/`, `CONTRIBUTORS.md`, `REUSE.toml`, `.swiftlint.yml`, `TemplateApplication.xctestplan`, the `.icon` asset |

The target and module are still named `TemplateApplication` (renaming a target by hand in the project file is risky and
buys nothing); the product is **Spezi POC Capture**, bundle id `com.blueysoft.spezipoc`.

### What was removed from the template, and why

| Removed | Because |
|---|---|
| Account, Firebase (`SpeziFirebase*`, `firebase-ios-sdk`, `firebase/`, `GoogleService-Info.plist`) | no accounts or Firebase: the identity provider is Keycloak |
| Scheduler, Notifications, Questionnaire, Contact, Consent, License views | not in the POC's scope |
| HealthKit module, permissions screen, entitlements and usage strings | not needed until the real-source milestone (M17), which re-adds them from the template commit above |
| `fastlane/`, `Scripts/` (`create.sh`, `setup.sh`), `.github/`, `codecov.yml`, `CITATION.cff` | template CI and tooling; `setup.sh` installs Homebrew, Java, Node and Firebase tooling system-wide and must not be run |
| `SwiftLintPlugins`, `swift-package-list` build plugins | build-tool plugins need trust prompts on the command line; lint config is kept for later |
| Stanford's `DEVELOPMENT_TEAM` and the manual provisioning profile | not ours; signing is automatic with no team (simulator builds need none) |

### Deviations from the template's behavior (found by running it on Xcode 27 / iOS 27)

| Template | Here | Why |
|---|---|---|
| Onboarding as a `.sheet` over an `EmptyView`, steps in SpeziViews' `ManagedNavigationStack` | The root view switches between onboarding and home; two steps are a plain `@State` switch in `OnboardingFlow` | The template's pattern came up **blank** on the Xcode 27 / iOS 27 simulator: SwiftUI logged the runtime fault "Accessing State<Path>'s value without being installed on a View" (`ManagedNavigationStack.Path`, SpeziViews 1.12.14, the latest 1.x). The same screens render correctly without it (0 faults). Revisit when SpeziViews is updated for that SDK. |
| UI test deletes and reinstalls the app via Springboard | UI test launches with `--showOnboarding` | `deleteAndLaunch(withSpringboardAppName:)` could not find the app icon by name and hung |

### Swift packages (6 direct)

| Package | Requirement | Used for |
|---|---|---|
| `Spezi` | up to next major from 1.9.3 | app delegate, `Standard`, configuration |
| `SpeziViews` | up to next major from 1.12.5 | `ManagedNavigationStack` |
| `SpeziOnboarding` | up to next major from 2.0.3 | the orientation screen |
| `SpeziStorage` (`SpeziKeychainStorage`) | up to next major from 2.1.4 | token storage (sign-in step) |
| `XCTestExtensions` (StanfordBDHG) | up to next major from 1.2.2 | UI tests |
| `AppAuth-iOS` (openid) | **exactly 3.0.0** (commit `a972daac82d449d58ab119e91c68153e29ddac33`), Apache-2.0, no dependencies | OIDC: discovery, authorization code + PKCE, token exchange and refresh (M5b) |

## Metrics layer (M6)

Pure Swift, no network and no HealthKit: it maps the app's own `MetricSample` (what the synthetic source and, later,
HealthKit both produce) to FHIR. Everything it knows comes from the bundled `metrics.json`, a byte-identical copy of
[contract/metrics.json](../contract/metrics.json) (`contract/sync.sh`; tests fail if they differ).

| File | Role |
|---|---|
| `Metrics/MetricRegistry.swift` | Loads and self-checks the contract (supported major version, every metric present, every sleep stage mapped or listed unmapped) |
| `Metrics/MetricSample.swift` | `MetricSample`, `MetricID`, `SleepStage`, `DeviceDescriptor` |
| `Metrics/ObservationMapper.swift` | Sample to Observation, with validation; `inBed` is `.unmapped`, not an error |
| `Metrics/DeviceMapper.swift` | Device resource and the deterministic key (SHA-256, or the fixed synthetic value) |
| `Metrics/FHIRDateTime.swift` | Hand-written `dateTime`: offset at the sample's own instant, no `Z`, fraction only when non-zero |
| `Metrics/FHIRResources.swift` | The minimal Codable FHIR shapes it writes |

Tests (`TemplateApplicationTests/Metrics`): the contract and its refusals, the independent golden fixtures
(`contract/golden/`), the spec's own printed samples, device keys, determinism, and that no date string ever uses `Z`.

## Synthetic source and simulator (M7)

The simulated device is a **pure function** of (config, seed, time), so tests, demos and history backfill are one code
path, and the live runner is that function over a moving window.

| Piece | Role |
|---|---|
| `Ingest/IngestSource.swift` | `IngestSource` protocol (the seam HealthKit will implement in M17), `IngestedSample`, and `InjectedAnomalies` (ground truth: late, batched, artifact, duplicate) |
| `Ingest/KeyedRandom.swift` | Stateless SplitMix64 over (seed, stream, index); reference vectors from an independent Python implementation |
| `Ingest/SyntheticConfig.swift` | The controls (cadence, jitter, gaps, late delivery, batching, duplicates, artifacts) and seven presets |
| `Ingest/SyntheticGenerator.swift` | `emissions(deliveredIn:)`: heart rate, HRV, resting heart rate, sleep nights, with the faults applied |
| `Ingest/SyntheticIngestSource.swift` | The live runner: virtual time at `speed` times real time, from a start up to 14 days ago; injectable clock |
| `Simulator/SimulatorModel.swift`, `SimulatorView.swift` | Controls, run/stop, counters by metric and by injected anomaly, the latest samples; shown only for the synthetic source |

Guarantees (each tested, several by mutation): the same config and seed give the same samples; a window generated in
pieces equals the whole; delivery is never before measurement; late and batched samples keep their true measurement
time and get a later `issued`; duplicates keep identity and content; ids carry the seed so two seeds never collide on
a conditional create; every emitted sample is valid input for the M6 mapper (`inBed` maps to nothing).

### Assumptions made in M7 (review these)

| # | Assumption | Why it matters |
|---|---|---|
| A18 | The waveforms are plausible, not physiological: a circadian heart rate with a night dip and a daily exercise bout, HRV higher at night and inversely related to heart rate, one resting value a day, sleep in ~90-minute cycles | Clinician views get realistic shapes, but nothing here is a clinical model |
| A19 | Gaps remove heart-rate and HRV samples only (a watch off the wrist); sleep intervals and the resting value, which a phone derives, are not dropped | A gap-heavy scenario still shows a night's sleep |
| A20 | Late and batched delivery change only `issued`; measurement times are untouched. A start in the past includes samples measured before the start that are still in flight | Matches how a device that was offline behaves; the first minutes of a "1 day ago" run are mostly late samples |
| A21 | Artifact values are 25/240/280 (heart rate), 3/450 (HRV), 25/230 (resting): implausible but never zero (M6 refuses zero) | The mapper must accept them so they can be stored and flagged, not dropped |
| A22 | Resting heart rate is one period per local day, delivered 60 s after the day ends; DST days are 23 or 25 hours | Matches the spec's "one sample per day" and A6 |
| A23 | A night is in bed from about 23:00 (±45 min) for 6.5 to 8.5 hours asleep, and includes an `inBed` interval | Exercises the unmapped path end to end |

Not done here (by design): flagging artifacts as data-quality tags and the plausibility thresholds for it (M16;
the generator only records ground truth), persistence and upload (M8), and any claim about performance for very large
windows (the 5 s cadence for a day is quick; 14 days at the dense 1 s preset was not measured).

## Sign in (M5b)

| Piece | What it does |
|---|---|
| `Auth/AppAuthClient.swift` | The only code that touches AppAuth. Discovery from the issuer, authorization code + **PKCE S256** (`state` and `nonce` generated and checked by AppAuth; the ID token's issuer, audience, expiry and nonce validated), in an **ephemeral** `ASWebAuthenticationSession` (no shared Safari cookies, so no lingering single-sign-on). Public client: no secret. |
| `Auth/AuthService.swift` | Sign in, restore at launch, refresh when the access token is within 60 s of expiry, sign out. Talks only to the `OIDCClient` and `TokenStore` protocols, so it is unit-tested with fakes. |
| `Auth/TokenStore.swift` | Tokens live **only in the Keychain** (`SpeziKeychainStorage`, one generic-password item). Never `UserDefaults`, a file, or the UI. |
| `Auth/TokenSet.swift` | The stored value. Its `description` is redacted so a token cannot reach a log by interpolation. |
| `Auth/TokenClaims.swift` | Reads user, roles and expiry from the access token's payload **without verifying the signature**: display only. HAPI verifies the token on every request; nothing here authorizes anything. |
| `Auth/ServerProbe.swift` | "Check server": metadata (200, no token), Patient search without a token (401), and with the user's token (200). |

### The simulator must trust the POC CA

The simulator's keychain is its own, so it does not trust the POC CA until told to. Without that, sign-in fails with
"The certificate for this server is invalid" (shown by the app; this is how the trust step was verified).

```bash
scripts/ios-sim-trust.sh install [simulator]   # adds ~/.poc-ca/ca.crt (the PUBLIC certificate) to that simulator only
scripts/ios-sim-trust.sh reset   [simulator]   # the way back: resets that simulator's keychain (CA and stored sign-in)
```

It changes only the named simulator's trust store (not the Mac's keychain, not your iPhone). The CA is name-constrained
to `DNS:macpro16.local`, and the script prints the subject, SHA-256 fingerprint and constraints before installing.
There is no per-certificate removal in `simctl keychain`: `reset`, or erasing the simulator, undoes it.

### What is and is not verified

Verified: the full flow against the running stack (login page, PKCE code exchange, roles claim, 200/401/200 from HAPI,
sign out) by `SignInTests`; the refresh *decision*, storage, restore and sign-out logic by 19 unit tests; that the
test fails when the token is not sent (mutation); that no token or password appears in simulator or xcodebuild logs.

**Not verified live:** the refresh-token grant against Keycloak (access tokens last 10 minutes; the refresh path is
covered with a fake client only), and what happens when Keycloak is down mid-session.

Known gaps, accepted for the POC: **sign-out clears the device only**. It does not call Keycloak's logout or revocation
endpoint, so the refresh token stays valid server-side until the realm's session idle timeout (14 days) even though the
app has discarded it. Revoking it (RFC 7009) is the fix and is not implemented. Keychain items use the default
accessibility.

## Configuration (nothing environment-specific in Swift source)

The app reads four settings from its Info.plist, which Xcode fills from build settings:

| Setting | Default (`Config/Defaults.xcconfig`) |
|---|---|
| `POC_FHIR_BASE_URL` | `https://macpro16.local:8443/fhir` |
| `POC_ISSUER_URL` | `https://macpro16.local:8444/realms/poc` |
| `POC_CLIENT_ID` | `ios-capture` (a public client: no secret exists) |
| `POC_REDIRECT_SCHEME` | `com.blueysoft.spezipoc` (redirect URI `com.blueysoft.spezipoc:/oauth2redirect`, registered in the realm) |

To override for your setup copy `Config/Local.xcconfig.example` to `Config/Local.xcconfig` (git-ignored). **No
credential is ever configured here**: the user types the synthetic user's password into Keycloak's own login page.
`ServerConfiguration` refuses non-https URLs and unresolved placeholders, and the Home screen shows the error.

## Build and test

```bash
cd ios
# Simulator build. -skipMacroValidation is the command-line form of Xcode's "Trust & Enable" for the Swift macro in
# the ThreadLocal package (a StanfordBDHG dependency of Spezi); -skipPackagePluginValidation is kept for future plugins.
xcodebuild -project TemplateApplication.xcodeproj -scheme TemplateApplication \
  -destination 'generic/platform=iOS Simulator' -skipMacroValidation -skipPackagePluginValidation build
```

From the repo root: `make test-ios` runs the 27 unit tests and `make test-ios-ui` adds the 2 UI tests
([scripts/ios-test.sh](../scripts/ios-test.sh): picks the first available iPhone simulator, or `$POC_IOS_SIMULATOR`;
fails if no tests ran or xcodebuild stalls; reports skipped tests). It SKIPs loudly on a host without macOS and Xcode.

- `OnboardingTests` asserts the orientation screen, that Apple Health is listed but cannot be selected, that no
  account, consent or HealthKit screen appears, and that Home shows the synthetic source.
- `SignInTests` is end to end and needs the stack running, the simulator trusting the CA, and the capture user's
  password. The script takes that from the git-ignored `idp/.env.local` and passes it only as an environment variable
  (`TEST_RUNNER_POC_CAPTURE_PASSWORD`); the test types it into Keycloak's login page, and it is never printed. Without
  it the test is SKIPPED and the script says so.

## Launch arguments (UI tests and development)

`--showOnboarding` always shows the onboarding; `--skipOnboarding` skips it.
