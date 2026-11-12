package com.aboutobjects.healthgate.ui

import android.content.Intent
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import com.aboutobjects.healthgate.AppContainer
import com.aboutobjects.healthgate.auth.OidcException
import com.aboutobjects.healthgate.auth.SignInCancelled
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

    private val _paused = MutableStateFlow(false)
    val paused: StateFlow<Boolean> get() = _paused

    private val _captureMessage = MutableStateFlow<String?>(null)
    val captureMessage: StateFlow<String?> get() = _captureMessage

    init {
        container.auth.restore()
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
            container.engine.drain()
        }
    }

    fun setPaused(paused: Boolean) { _paused.value = paused }

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
