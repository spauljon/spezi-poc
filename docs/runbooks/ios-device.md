# Runbook: the capture app on an iPhone

Install, sign in, read what the app is doing, and recover from the usual problems. Written 2026-10-17 (M19). The trust steps are in [tls-and-trust.md](tls-and-trust.md); the design is in [ios/README.md](../../ios/README.md).

## One-time setup

1. `ios/Config/Local.xcconfig` (git-ignored) with your `DEVELOPMENT_TEAM` (copy `Local.xcconfig.example`).
2. Your Apple ID in Xcode (Settings, Accounts). A free account works, including HealthKit and background delivery (checked in M18).
3. On the phone: enable **Developer Mode** (Settings, Privacy & Security; it restarts), pair the phone in Device Hub, and **trust the developer profile** after the first install (Settings, General, VPN & Device Management).
4. Install and trust the POC CA on the phone ([tls-and-trust.md](tls-and-trust.md), step 3). Both the profile **and** the switch under Certificate Trust Settings are needed.
5. Build to the phone from Xcode. The first run on a device copies its system symbols and can take several minutes.

A free-profile build **expires after 7 days**: the app stops opening until it is rebuilt from Xcode. Plan overnight measurements inside the week.

## Daily use

- Open the app, sign in as the capture user, and on Home choose **Apple Health** (read access to heart rate, resting heart rate, HRV, sleep and, since M21, the eight dietary types; if you chose Apple Health before M21, the first launch asks once about the new types). It cannot be chosen until you are signed in and the server is configured; the reason is written beside it.
- **Stop** the Xcode run before testing background behaviour: launch the app from the Home Screen, lock the phone, and do not force-quit it (iOS does not wake a force-quit app).

## Reading the screen (counts and times only; never values)

| Line | Meaning |
|---|---|
| Received since app start | records HealthKit handed over this launch (resets on relaunch) |
| Received in total / Last received | kept across launches |
| Queued / Uploaded | the queue: waiting, and confirmed stored by the server |
| Last upload attempt, and "Recent upload attempts" | the last 20 attempts: time, outcome, how many were sent, whether the app was in the background (identical idle attempts are folded into one line with a count) |
| Deleted in Apple Health, waiting | a deletion HealthKit reported that is not applied yet (waiting for the next upload, the network or a retry) |
| Retracted on the server | the server marked its copy `entered-in-error` (it is not deleted; consumers that read `final` no longer see it) |
| Deleted, nothing on the server | the sample was deleted before it uploaded, or the server never had it |
| Retraction refused | the server will never take that request; the Observation is unchanged |

**Uploaded should equal the server's count** for the `poc-real` Patient. "Received in total" will usually be a little higher (it counts repeat deliveries, which the server stores once).

## What to expect from background delivery

iOS decides when to wake the app. Measured on 2026-10-14: wake-ups about every 41 minutes, so a measurement reaches the server up to about 42 minutes after it was taken. Nothing is promised; low power mode or a stopped stack changes it. A phone that was offline simply catches up.

## Problems

| Symptom | Likely cause | Fix |
|---|---|---|
| Certificate invalid on sign-in | the phone does not trust this CA | Certificate Trust Settings switch, or reinstall the profile after a rebuild |
| Apple Health row is plain text, not a button | not signed in, server not https, or no separate patient configured; the reason is written under it | sign in; check `Config/Defaults.xcconfig` |
| Queue grows, attempts say "Sign in to upload." | signed out; samples are **held**, nothing is uploaded | sign in. Since M20 this also resumes the upload by itself; on an earlier build the state stayed "Sign in required" until you tapped **Sync now** |
| Attempts say "not attempted: offline" | no network | restore the network; no data is lost |
| Server count lower than Uploaded | impossible unless the server was reset | the volume was erased: delete and reinstall the app |
| App will not open | the 7-day profile expired | rebuild from Xcode |
| Nothing arrives from Apple Health | permission off for a type, or the Watch has not synced to the phone | Settings, Health, Data Access & Devices; open the Health app and check it has new data |

## Start again from nothing

Delete the app from the phone (this removes its queue, HealthKit bookmarks, preferences and sign-in), reinstall from Xcode, sign in, choose Apple Health. The first window is the last seven days.

## Moving from the old app name (`com.blueysoft.spezipoc`) to HealthGate (`com.aboutobjects.healthgate`)

iOS treats a new bundle id as a different app, so the old one stays on the phone with its own queue and permissions.

1. Let the old app finish uploading (Queued 0) before you replace it. Its queue is in its own storage and does not move.
2. Open the new project (`ios/HealthGate.xcodeproj`, scheme `HealthGate`), check Signing & Capabilities (team, HealthKit), and run it on the phone. Xcode registers the new App ID with your team.
3. Delete the old app. Open HealthGate, choose Apple Health, grant read access, sign in. The first window is the last seven days; uploads are conditional creates on the sample identifier, so samples the old app already sent are not duplicated.
4. The Keycloak client `ios-capture` must list `com.aboutobjects.healthgate:/oauth2redirect`. The realm file only applies on an empty database, so an existing stack needs the client updated (kcadm, see `idp/README.md`); `python3 idp/oidc.py check` verifies it.
