package com.aboutobjects.healthgate.ui

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
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
    val scope = rememberCoroutineScope()
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { result -> model.onSignInResult(result.data) }

    Column(
        Modifier.verticalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 24.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text("HealthGate", style = MaterialTheme.typography.headlineMedium)
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
                OutlinedButton(onClick = model::signOut) { Text("Sign out") }
            } else {
                Button(
                    enabled = auth != AuthState.SigningIn,
                    onClick = { scope.launch { model.signInIntent()?.let { launcher.launch(it) } } },
                ) { Text("Sign in") }
            }
        }

        Section("Capture") {
            Text("Source: Synthetic (the same source the emulator and the tests use).")
            Button(onClick = model::generate) { Text("Generate the last 24 hours") }
            captureMessage?.let { Text(it) }
        }

        Section("Upload") {
            val c = sync.counts
            Text("Waiting: ${c.pending}   Uploaded: ${c.sent}   Rejected: ${c.rejected}   Skipped: ${c.skipped}")
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
            sync.lastError?.let { Text("Last problem: $it") }
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Button(enabled = !paused && sync.phase != SyncPhase.Syncing, onClick = model::syncNow) { Text("Sync now") }
                Text("Pause")
                Switch(checked = paused, onCheckedChange = model::setPaused)
                Text(if (paused) "Paused" else "Running")
            }
            Text("Server count: created ${sync.created}, already there ${sync.alreadyPresent}.")
        }

        Section("Attempts") {
            if (sync.history.isEmpty()) Text("No attempts yet.")
            for (a in sync.history) Text("${clock.format(a.at)}: ${a.summary}")
        }
    }
}

@Composable
private fun Section(title: String, content: @Composable () -> Unit) {
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(title, style = MaterialTheme.typography.titleMedium)
            content()
        }
    }
}
