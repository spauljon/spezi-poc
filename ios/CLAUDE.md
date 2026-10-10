# ios/ — iOS capture app

Follow the root [CLAUDE.md](../CLAUDE.md) (data rules, milestone workflow, FHIR rules). The data rules apply here without exception: synthetic data only in fixtures, tests and logs.

- Stack: Swift 6 (strict concurrency, language mode 6), SwiftUI, Spezi, iOS 18.6 deployment target, Xcode 27. Copied from the Spezi Template Application at commit `d52014a` without its `.git` (see README.md). Spezi packages and requirements are listed in README.md; adding a package needs the developer's approval.
- The target and module are named `TemplateApplication`; the product is "Spezi POC Capture" (`com.blueysoft.spezipoc`). Do not rename the target by hand.
- Project file: the template's `.xcodeproj` with synchronized folder groups, so source files are included by living under `TemplateApplication/` (no per-file project edits). Package and build-setting changes are edits to `project.pbxproj`: validate with `plutil -lint` and a dangling-UUID check, then build.
- Configuration comes from `Config/Defaults.xcconfig` (committed, non-secret) and the git-ignored `Config/Local.xcconfig`, via Info.plist keys read by `ServerConfiguration`. Never put a password, token or secret in any of these, in source, in launch arguments committed to the repo, or in logs. The app is a public OAuth client.
- Metrics: never hand-copy a code, unit or category into Swift: read the registry. Changing mapping behaviour means changing `contract/metrics.json` and `contract/golden/generate.py` (the independent implementation) first, then `contract/sync.sh`; a mapper change that needs a different golden means one of the two implementations is wrong: find out which.
- Tokens: only in the Keychain via `KeychainTokenStore`; never logged, never in `UserDefaults`, never shown (`TokenSet.description` is redacted: keep it). `TokenClaims` is unverified and for display only; never authorize on it. All OIDC library use stays inside `AppAuthClient`. A new auth feature gets a fake-client unit test, and any "refused" test needs a positive control.
- Never type or pass a real credential through a tool call or chat: UI tests get the synthetic password from `idp/.env.local` via `scripts/ios-test.sh`, as an environment variable.
- The simulator needs the POC CA (`scripts/ios-sim-trust.sh install`); a "certificate invalid" error from the app is a trust problem, "could not connect" is the stack being down: do not confuse them.
- Do not reintroduce `ManagedNavigationStack` or the template's sheet-over-`EmptyView` onboarding without re-checking that it renders on the current Xcode/iOS (see README, "Deviations"). After any UI change, look at the real simulator (a screenshot) as well as the tests: a blank screen can pass a test that only checks the build.
- HealthKit is deliberately absent until M17 (no module, entitlement or usage string). The synthetic and HealthKit sources must share one ingest interface (M6/M7).
- Build and test from the command line with `-skipMacroValidation -skipPackagePluginValidation` (see README.md for why). `make test-ios` runs the unit tests and `make test-ios-ui` adds the UI test (both via `scripts/ios-test.sh`, which fails if no tests ran).
- Swift Testing for unit tests; every refusal test needs a positive control (see the root rules).
- Milestones: M5, M5b, M6-M8, M17, M18
- Contract: codes, units and categories come from `contract/metrics.json` (added in M6), never hand-copied.
- Commit prefix: `ios:`
