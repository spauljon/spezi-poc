package com.aboutobjects.healthgate.ui

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.health.connect.client.PermissionController
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.selection.toggleable
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.aboutobjects.healthgate.auth.AuthState
import com.aboutobjects.healthgate.ingest.healthconnect.CollectOutcome
import com.aboutobjects.healthgate.sync.SyncBlocker
import com.aboutobjects.healthgate.sync.SyncPhase
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import kotlinx.coroutines.launch

private val clock = DateTimeFormatter.ofLocalizedDateTime(FormatStyle.SHORT).withZone(ZoneId.systemDefault())

/** The home screen: sign-in, capture, upload and the attempt history. Every state is said in words, never by colour alone. */
@Composable
fun HomeScreen(model: HomeViewModel) {
    val auth by model.auth.collectAsStateWithLifecycle()
    val sync by model.sync.collectAsStateWithLifecycle()
    val paused by model.paused.collectAsStateWithLifecycle()
    val captureMessage by model.captureMessage.collectAsStateWithLifecycle()
    val hc by model.healthConnect.collectAsStateWithLifecycle()
    val reading by model.reading.collectAsStateWithLifecycle()
    val lastRead by model.lastRead.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    val context = androidx.compose.ui.platform.LocalContext.current
    val bgSupported by model.backgroundSupported.collectAsStateWithLifecycle()
    val bgAllowed by model.backgroundAllowed.collectAsStateWithLifecycle()
    val battery by model.batteryUnrestricted.collectAsStateWithLifecycle()
    val permissions = rememberLauncherForActivityResult(PermissionController.createRequestPermissionResultContract()) { model.refreshHealthConnect() }
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { result -> model.onSignInResult(result.data) }

    Column(
        Modifier.verticalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 24.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text("HealthGate", style = MaterialTheme.typography.headlineMedium, modifier = Modifier.semantics { heading() })
        Text("Synthetic data to ${model.serverHost}", style = MaterialTheme.typography.bodyMedium)

        Section("Sign-in") {
            Text(
                when (val a = auth) {
                    AuthState.SignedOut -> "Signed out. Sign in to upload."
                    AuthState.SigningIn -> "Signing in…"
                    is AuthState.SignedIn -> "Signed in as ${a.username ?: "unknown user"}" + if (a.roles.isNotEmpty()) " (${a.roles.joinToString()})" else ""
                    is AuthState.Failed -> "Sign-in problem: ${a.message}"
                },
            )
            if (auth is AuthState.SignedIn) {
                OutlinedButton(modifier = Modifier.heightIn(min = 48.dp), onClick = model::signOut) { Text("Sign out") }
            } else {
                Button(modifier = Modifier.heightIn(min = 48.dp), enabled = auth != AuthState.SigningIn,
                    onClick = { scope.launch { model.signInIntent()?.let { launcher.launch(it) } } },
                ) { Text("Sign in") }
            }
        }

        Section("Capture") {
            Text("Source: Synthetic (the same source the emulator and the tests use).")
            Button(modifier = Modifier.heightIn(min = 48.dp), onClick = model::generate) { Text("Generate the last 24 hours") }
            captureMessage?.let { Text(it) }
        }

        Section("Health Connect") {
            Text(
                when (hc) {
                    HomeViewModel.HealthConnectState.Unavailable -> "Health Connect is not available on this phone."
                    HomeViewModel.HealthConnectState.UpdateRequired -> "Health Connect needs an update before it can be read."
                    HomeViewModel.HealthConnectState.NeedsPermission -> "Not allowed yet: heart rate, resting heart rate, heart-rate variability, sleep, nutrition and hydration (read only)."
                    HomeViewModel.HealthConnectState.Ready -> "Allowed to read heart rate, resting heart rate, heart-rate variability, sleep, nutrition and hydration."
                },
            )
            if (hc == HomeViewModel.HealthConnectState.Ready) {
                Text(
                    when {
                        !bgSupported -> "Reading while the app is closed is not supported by this phone's Health Connect: data is read when the app is open."
                        bgAllowed -> "Allowed to read while the app is closed."
                        else -> "Not allowed to read while the app is closed: the background sync will stop with a note in the attempts."
                    },
                )
                if (bgSupported && !bgAllowed) Button(onClick = { permissions.launch(model.healthConnectPermissions) }) { Text("Allow reading while closed") }
            }
            if (hc == HomeViewModel.HealthConnectState.NeedsPermission) {
                Button(modifier = Modifier.heightIn(min = 48.dp), onClick = { permissions.launch(model.healthConnectPermissions) }) { Text("Allow Health Connect access") }
            }
            if (hc == HomeViewModel.HealthConnectState.Ready) {
                Button(modifier = Modifier.heightIn(min = 48.dp), enabled = !reading, onClick = model::readHealthConnect) { Text(if (reading) "Reading…" else "Read Health Connect now") }
            }
            Text("Records written by other apps on this phone are your own data and go to the real patient; the test tool's records go to the test patient. They are never mixed.")
            lastRead?.let { r -> Text(readSummary(r)) }
        }

        Section("Upload") {
            val c = sync.counts
            Text("Waiting: ${c.pending}   Uploaded: ${c.sent}   Rejected: ${c.rejected}   Skipped: ${c.skipped}   Deleted: ${c.deleted}")
            Text(
                when (val p = sync.phase) {
                    SyncPhase.Idle -> "Idle." + (sync.lastSuccess?.let { " Last upload ${clock.format(it)}." } ?: "")
                    SyncPhase.Syncing -> "Uploading…"
                    is SyncPhase.Waiting -> "Waiting to retry at ${clock.format(p.until)}."
                    is SyncPhase.Blocked -> "Stopped: " + when (val b = p.blocker) {
                        SyncBlocker.SignInRequired -> "sign in to continue."
                        is SyncBlocker.Forbidden -> "the server refused this user (${b.reason})."
                        is SyncBlocker.Configuration -> b.message
                    }
                },
            )
            if (sync.held > 0) {
                Text("${sync.held} samples from your own apps are held: no real patient is configured, so they are not sent anywhere.")
            }
            sync.lastError?.let { Text("Last problem: $it") }
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Button(modifier = Modifier.heightIn(min = 48.dp), enabled = !paused && sync.phase != SyncPhase.Syncing, onClick = model::syncNow) { Text("Sync now") }
                // one control for a screen reader: "Pause syncing, switch, on/off" (a bare Switch next to a Text reads as an unlabelled switch)
                Row(
                    Modifier.heightIn(min = 48.dp).semantics { contentDescription = "Pause syncing" }
                        .toggleable(value = paused, role = Role.Switch, onValueChange = { model.setPaused(it, context) }),
                    verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    Text("Pause syncing")
                    Switch(checked = paused, onCheckedChange = null)
                    Text(if (paused) "Paused" else "Running")
                }
            }
            Text("Server count: created ${sync.created}, already there ${sync.alreadyPresent}, updated ${sync.updated}, deleted ${sync.deleted}.")
        }

        Section("Background") {
            Text(if (paused) "Paused: nothing is read or sent, and the schedule is off." else "On: every 15 minutes when there is a network (Android decides the exact time).")
            Text(
                if (battery) "Battery: unrestricted for this app."
                else "Battery: optimised. Some phones (Samsung) may stop the sync when the app is closed; set this app to Unrestricted in the phone's battery settings.",
            )
            if (!battery) OutlinedButton(modifier = Modifier.heightIn(min = 48.dp), onClick = {
                context.startActivity(android.content.Intent(android.provider.Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS).addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK))
            }) { Text("Open battery settings") }
            OutlinedButton(modifier = Modifier.heightIn(min = 48.dp), onClick = model::refreshHealthConnect) { Text("Refresh these statuses") }
        }

        Section("Attempts") {
            if (sync.history.isEmpty()) Text("No attempts yet.")
            for (a in sync.history) Text("${clock.format(a.at)}: ${a.summary}")
        }
    }
}

/** What one read did, in words and counts (never a value, a name or a time of the person's data). */
private fun readSummary(r: CollectOutcome): String = when {
    r.mode == CollectOutcome.Mode.BUSY -> "A read is already running."
    r.failure != null -> "The read stopped (${r.failure}); nothing was lost and the next read continues from the same place."
    else -> (if (r.mode == CollectOutcome.Mode.WINDOW) "Read the last 30 days: " else "Read the changes: ") +
        "${r.recordsUpserted} records, ${r.samplesQueued} samples queued, ${r.recordsDeleted} records deleted" +
        (if (r.recordsRefused > 0) ", ${r.recordsRefused} refused" else "") + "."
}

@Composable
private fun Section(title: String, content: @Composable () -> Unit) {
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(title, style = MaterialTheme.typography.titleMedium, modifier = Modifier.semantics { heading() })
            content()
        }
    }
}
