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
