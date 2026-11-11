# android/ — Android capture app (M24: probe only so far)

Follow the root [CLAUDE.md](../CLAUDE.md) (data rules, milestone workflow, FHIR rules) and [docs/planning/android-brief.md](../docs/planning/android-brief.md). The data rules apply here without exception: the only real data is the developer's own Health Connect data, it never appears in the repo, logs, screenshots, commit messages or conversation, and only counts and field names may be reported.

- Stack: Kotlin 2.1.21, Android Gradle Plugin 8.13.0, Gradle 8.13 (the wrapper), compileSdk and targetSdk 36, minSdk 31, bytecode target Java 17. These are SpeziKt's sample-app versions, which M24 verified build on JDK 17 and 21. **They fail on JDK 25**, which is what Android Studio bundles: set Studio's Gradle JDK to 21, and build from a terminal with `JAVA_HOME` set to JDK 21 (`export JAVA_HOME=$(/usr/libexec/java_home -v 21)`), never the machine default.
- Dependencies beyond the AndroidX basics need the developer's approval. SpeziKt is not a dependency yet: M24's spike decides it.
- The probe (package `com.aboutobjects.healthgate.probe`) reads Health Connect with read permissions only and keeps structure only: `RecordSummary` has no field for a value, a food name or a title (its fields are structure, plus a record-id hash prefix, the meal type code and the start hour, approved 2026-11-11), and `ProbeSourceTest` pins the field list and scans for logging. `IdLedger` keeps only hash prefixes between reads. `ProbeTypes.kt` is the only file that touches records. The one `Log` call is in `MainActivity.show`, debug builds only, and logs the finished aggregate text.
- A new field on `RecordSummary` or a new log call needs the developer's approval and a test change in the same commit.
- Build and test: `cd android && ./gradlew :app:testDebugUnitTest :app:assembleDebug` (with `JAVA_HOME` as above). Device: `adb` from `~/Library/Android/sdk/platform-tools`, USB debugging, Auto Blocker off.
- Commit prefix: `android:`
