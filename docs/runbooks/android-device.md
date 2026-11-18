# Runbook: the capture app on an Android phone

Install, sign in, read what the app is doing, and recover from the usual problems. Written 2026-11-17 (M28), tested on a Galaxy A15 5G (Android 16, One UI 8.5, 4 GB). The trust steps are in [tls-and-trust.md](tls-and-trust.md); the design is in [../planning/android-brief.md](../planning/android-brief.md) and [../../android/CLAUDE.md](../../android/CLAUDE.md).

## One-time setup

1. Android Studio (its bundled JDK works) and `adb` from `~/Library/Android/sdk/platform-tools`. On the phone: **Developer options, USB debugging on**; on Samsung turn **Auto Blocker off** (it blocks installs over USB).
2. Install and trust the POC CA on the phone as a **CA certificate** (Settings, Security and privacy, More security settings, Install from device storage, CA certificate). The browser sign-in needs it: a browser ignores an app's own trust configuration.
3. Build and install the debug app: `cd android && JAVA_HOME=$(/usr/libexec/java_home -v 21) ./gradlew :app:installDebug` (with `ANDROID_SERIAL=<serial>` when more than one device or emulator is connected). Installing over an existing build keeps its sign-in and queue; **uninstalling deletes them**.
4. Open the app and **Sign in** (browser, the `android-user` account). The Upload card says who you are.
5. **Health Connect card, Allow Health Connect access**: heart rate, resting heart rate, heart-rate variability, sleep, nutrition and hydration (read only) and, where the phone supports it, **reading while the app is closed**. Without the last one the scheduled sync cannot read Health Connect while the app is closed; the attempt history then says so.
6. **Battery.** Open the app's **Background** card. If it says "optimised", use **Open battery settings** and set the app to **Unrestricted** (on Samsung: Battery, Background usage limits, make sure the app is not in "Sleeping apps" or "Deep sleeping apps"). Samsung's battery management may otherwise stop the sync when the app is closed.

## Daily use

- **Read Health Connect now** reads and uploads at once. The first read takes the last **30 days**. After that a read continues from where the last one stopped (a saved position, the changes token), so it picks up only what changed, including deletions. If the phone was not read for more than about 30 days the position expires and the next read takes the 30 days again and notices what was deleted meanwhile.
- **Background sync** runs about every **15 minutes when there is a network** (Android chooses the exact time; it can be later when the phone is idle, in Doze, or restricted). It reads Health Connect and uploads, the same as the button. **Pause** (a switch on the Upload card) stops it, and the choice survives the app being closed.
- **Signing in** (or signing in again after a refusal) runs a sync at once: samples read while signed out are held and go up then.
- A **changed** record is sent as an **update** of the same Observation; a **deleted** record as a **delete** (HAPI keeps a deleted version in history). A deleted *food* waits **5 minutes** before its delete is sent, in case the app that wrote it (MyFitnessPal) is only re-creating it.

## Reading the screen (counts and times only; never values)

| Line | Meaning |
|---|---|
| Waiting / Uploaded / Rejected / Skipped / Deleted | the queue: waiting to go, accepted by the server, refused for good, nothing to send, deleted on the server |
| Server count: created, already there, updated, deleted | what the server answered since the app started |
| Health Connect card, last read | what the last read did: records, samples queued, records deleted |
| Background card | paused or on; battery unrestricted or optimised |
| Attempts | the last 20 runs, kept across the app being closed: `Background: read the changes: 1 records, 3 samples queued, 0 deleted` (what was read, with who started it), `Sent 3 (3 created, 0 updated, 0 deleted, 0 already there)` (what the server took), `Will retry` / `Blocked` with the reason |

## Testing without a wearable: the writer

`:writer` is a **test tool** that writes synthetic Health Connect records (heart rate, resting heart rate, HRV, sleep, nutrition, hydration), edits, grows and deletes them, so every case can be tried on the phone. Install it with `./gradlew :writer:installDebug`, open it, **Allow writing**, then tap the scenarios. Health Connect lets an app change only records it wrote, which is why this is a separate app. After each step, **Read Health Connect now** in the capture app, then check the server (counts only):

```bash
python3 scripts/android-hc-counts.py --history 2026-11-17T00:00:00Z
```

(Observations by metric and status, and the history entries since that UTC time by method: POST created, PUT updated, DELETE deleted. HAPI's own totals above 9,999 are not reliable, which is why it counts entries.)

Scenarios worth running: write a heart-rate record (3), add 2 samples (5, only 2 created), change its first sample (still 5, one PUT), delete it (0, five DELETEs); write a lunch, re-create it (nothing at the server), edit it (the old item goes after 5 minutes); write the 5,000-sample record. **Delete everything this tool wrote** when done.

## Process-death and memory tests (debug builds; scripts)

```bash
ANDROID_SERIAL=emulator-5554 scripts/android-process-death-test.sh collector   # kills the app mid-read, checks nothing is lost
ANDROID_SERIAL=<the phone>   scripts/android-process-death-test.sh engine      # kills it right after the server accepted an upload
ANDROID_SERIAL=<the phone>   scripts/android-peak-memory.sh                    # peak memory during a 5,000-sample read and upload
```

The debug build has named **failpoints** (`collector.afterCommit`, `collector.beforeToken`, `engine.afterSend`) and a control receiver the scripts use; the release build has neither. The `collector` test clears app data, so it refuses to run on a real phone.

## Problems

| Sign | Cause and what to do |
|---|---|
| "Not allowed yet" on the Health Connect card | grant the read permissions (the button), or Settings, Apps, Health Connect, App permissions |
| Attempts say "Health Connect did not allow the read" for Background runs | allow **reading while the app is closed** (the Health Connect card), then Refresh |
| Nothing arrives while the app is closed | the Background card says Paused, or the battery is **optimised** (set it to Unrestricted), or the phone is in Doze: open the app once and see whether Read now catches up |
| "Stopped: sign in to continue" | the refresh token was refused: Sign in again; held samples go up at once |
| "Stopped: the server refused this user" | the signed-in account lacks the capture role: sign in as `android-user` |
| "Will retry" | no network or a server error: it retries by itself (back-off), or tap Sync now |
| Read says "stopped (…)" | nothing was lost: the saved position did not move, and the next read repeats from the same place |
| `adb devices` shows `unauthorized` | accept the prompt on the phone; **Revoke USB debugging authorizations** and replug if it never appears |
| The app was uninstalled | its queue and sign-in are gone: sign in again; the first read takes the last 30 days and the server, which keeps its own Observations, absorbs what was already sent |

## What to expect from background sync

Measured on the phone on 2026-11-17 and 18 (see the plan's M28 status for the numbers): with the battery on **Unrestricted** a record written while the app was closed and the phone unplugged reached the server in about 17 minutes; with Samsung's default **Optimised** setting nothing ran for 45 minutes while the phone was idle on battery, and the waiting data went up the moment the setting changed. A VPN that blocks the local network (NordVPN did, on the Mac) also stops uploads and `adb`: pause it. Android promises nothing about exact timing: a periodic job is run when the system finds a window, at most every 15 minutes, and not at all for a force-stopped app until it is opened again. **Swiping an app away from Recents is not a force stop; "Force stop" in App info is.**
