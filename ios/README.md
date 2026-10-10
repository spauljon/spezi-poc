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

### Swift packages (5 direct)

| Package | Requirement | Used for |
|---|---|---|
| `Spezi` | up to next major from 1.9.3 | app delegate, `Standard`, configuration |
| `SpeziViews` | up to next major from 1.12.5 | `ManagedNavigationStack` |
| `SpeziOnboarding` | up to next major from 2.0.3 | the orientation screen |
| `SpeziStorage` (`SpeziKeychainStorage`) | up to next major from 2.1.4 | token storage (sign-in step) |
| `XCTestExtensions` (StanfordBDHG) | up to next major from 1.2.2 | UI tests |

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

From the repo root: `make test-ios` runs the 8 unit tests and `make test-ios-ui` adds the UI test
([scripts/ios-test.sh](../scripts/ios-test.sh): picks the first available iPhone simulator, or `$POC_IOS_SIMULATOR`;
fails if no tests ran). It SKIPs loudly on a host without macOS and Xcode. The UI test asserts the orientation screen,
that Apple Health is listed but cannot be selected, that no account, consent or HealthKit screen appears, and that Home
shows the synthetic source.

## Launch arguments (UI tests and development)

`--showOnboarding` always shows the onboarding; `--skipOnboarding` skips it.
