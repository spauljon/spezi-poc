package com.aboutobjects.healthgate.ui

import android.content.Intent
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import com.aboutobjects.healthgate.AppContainer
import com.aboutobjects.healthgate.auth.OidcException
import com.aboutobjects.healthgate.auth.SignInCancelled
import com.aboutobjects.healthgate.ingest.healthconnect.CollectOutcome
import com.aboutobjects.healthgate.ingest.healthconnect.HealthConnectAccess
import java.time.Duration
import java.time.Instant
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class HomeViewModel(private val container: AppContainer) : ViewModel() {
    val auth = container.auth.state
    val sync = container.engine.status
    val serverHost: String get() = container.configuration.host

    private val _paused = MutableStateFlow(container.pauseStore.paused)
    val paused: StateFlow<Boolean> get() = _paused

    private val _captureMessage = MutableStateFlow<String?>(null)
    val captureMessage: StateFlow<String?> get() = _captureMessage

    /** What Health Connect lets this app do right now. */
    sealed interface HealthConnectState {
        data object Unavailable : HealthConnectState
        data object UpdateRequired : HealthConnectState
        data object NeedsPermission : HealthConnectState
        data object Ready : HealthConnectState
    }

    private val _healthConnect = MutableStateFlow<HealthConnectState>(HealthConnectState.Unavailable)
    val healthConnect: StateFlow<HealthConnectState> get() = _healthConnect

    private val _reading = MutableStateFlow(false)
    val reading: StateFlow<Boolean> get() = _reading

    private val _lastRead = MutableStateFlow<CollectOutcome?>(null)
    val lastRead: StateFlow<CollectOutcome?> get() = _lastRead

    /** The permissions to ask for: the six reads, and (when this phone's Health Connect supports it) reading while the app is closed. */
    val healthConnectPermissions: Set<String>
        get() = HealthConnectAccess.readPermissions + if (backgroundSupported.value) setOf(HealthConnectAccess.BACKGROUND_PERMISSION) else emptySet()

    private val _backgroundSupported = MutableStateFlow(false)
    val backgroundSupported: StateFlow<Boolean> get() = _backgroundSupported

    private val _backgroundAllowed = MutableStateFlow(false)
    val backgroundAllowed: StateFlow<Boolean> get() = _backgroundAllowed

    private val _batteryUnrestricted = MutableStateFlow(container.batteryUnrestricted())
    val batteryUnrestricted: StateFlow<Boolean> get() = _batteryUnrestricted

    init {
        container.auth.restore()
        refreshHealthConnect()
        viewModelScope.launch { container.engine.refresh() }
    }

    /** Synthetic samples for the last 24 hours go into the queue (a repeat adds nothing: the same samples have the same keys). */
    fun generate() {
        viewModelScope.launch {
            val now = Instant.now()
            val result = withContext(Dispatchers.IO) {
                val items = container.source.samples(now.minus(Duration.ofHours(24)), now, now)
                    .map { it.copy(sample = container.flagger.applied(it.sample)) }
                container.queue.enqueue(items)
            }
            _captureMessage.value = "Generated ${result.added + result.known} synthetic samples: ${result.added} new, ${result.known} already queued."
            container.engine.refresh()
        }
    }

    fun syncNow() {
        if (_paused.value) return
        viewModelScope.launch {
            withContext(Dispatchers.IO) { container.queue.makeAllDue() }
            container.runner.run("Manual")
        }
    }

    /** Re-reads what Health Connect allows (after the user came back from its permission screen or its settings). */
    fun refreshHealthConnect() {
        viewModelScope.launch {
            _healthConnect.value = when (container.healthConnectStatus) {
                HealthConnectAccess.Status.UNAVAILABLE -> HealthConnectState.Unavailable
                HealthConnectAccess.Status.UPDATE_REQUIRED -> HealthConnectState.UpdateRequired
                HealthConnectAccess.Status.AVAILABLE -> {
                    val granted = container.healthConnectClient?.permissionController?.getGrantedPermissions() ?: emptySet()
                    _backgroundSupported.value = container.healthConnectClient?.let { HealthConnectAccess.backgroundReadSupported(it) } ?: false
                    _backgroundAllowed.value = HealthConnectAccess.BACKGROUND_PERMISSION in granted
                    _batteryUnrestricted.value = container.batteryUnrestricted()
                    if (granted.containsAll(HealthConnectAccess.readPermissions)) HealthConnectState.Ready else HealthConnectState.NeedsPermission
                }
            }
        }
    }

    /** Reads Health Connect into the queue, then uploads (a changed record is an update, a deleted one a delete). Counts only are kept. */
    fun readHealthConnect() {
        if (container.collector == null || _reading.value) return
        viewModelScope.launch {
            _reading.value = true
            try {
                _lastRead.value = container.runner.run("Manual").collected
            } finally {
                _reading.value = false
            }
        }
    }

    /** Pausing stops the scheduled work too, and is remembered across the app being killed. */
    fun setPaused(paused: Boolean, context: android.content.Context) {
        container.pauseStore.paused = paused
        _paused.value = paused
        if (paused) com.aboutobjects.healthgate.sync.SyncWorker.cancel(context) else com.aboutobjects.healthgate.sync.SyncWorker.schedule(context)
    }

    /** The browser intent for signing in, or null if the sign-in server could not be reached (the state then says so). */
    suspend fun signInIntent(): Intent? {
        container.auth.beginSignIn()
        return try {
            container.appAuth.authorizationIntent(container.configuration)
        } catch (e: OidcException) {
            container.auth.failed("Could not reach the sign-in server. Is the stack running, and is this phone on the same network?")
            null
        }
    }

    fun onSignInResult(data: Intent?) {
        if (data == null) { container.auth.cancelled(); return }
        viewModelScope.launch {
            try {
                container.auth.signedIn(container.appAuth.complete(data, container.configuration))
                container.runner.run("Sign-in") // samples held while signed out go up now
            } catch (e: SignInCancelled) {
                container.auth.cancelled()
            } catch (e: OidcException) {
                container.auth.failed("Sign-in did not complete: ${e.message}")
            }
        }
    }

    fun signOut() = container.auth.signOut()

    class Factory(private val container: AppContainer) : ViewModelProvider.Factory {
        @Suppress("UNCHECKED_CAST")
        override fun <T : ViewModel> create(modelClass: Class<T>): T = HomeViewModel(container) as T
    }
}
