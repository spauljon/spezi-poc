package com.aboutobjects.healthgate.auth

import com.aboutobjects.healthgate.config.ServerConfiguration
import com.aboutobjects.healthgate.sync.AuthException
import com.aboutobjects.healthgate.sync.TokenProvider
import java.time.Instant
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

sealed interface AuthState {
    data object SignedOut : AuthState
    data object SigningIn : AuthState
    data class SignedIn(val username: String?, val roles: List<String>, val expiresAt: Instant) : AuthState
    data class Failed(val message: String) : AuthState
}

/**
 * Holds the signed-in state and hands out access tokens. A token near expiry is refreshed once, however many callers ask at the same
 * time. A refresh the IdP REFUSES ends the session (tokens cleared, signed out); a refresh that fails for lack of a network keeps the
 * session and reports the token as temporarily unavailable.
 */
class AuthService(
    private val client: OidcClient,
    private val store: TokenStore,
    private val configuration: ServerConfiguration,
    private val now: () -> Instant = { Instant.now() },
) : TokenProvider {
    private val _state = MutableStateFlow<AuthState>(AuthState.SignedOut)
    val state: StateFlow<AuthState> get() = _state
    private val refreshing = Mutex()

    /** Reads the stored tokens at launch: tokens of another issuer, or expired with no way to refresh, are dropped. */
    fun restore() {
        val tokens = store.load()
        if (tokens == null) { _state.value = AuthState.SignedOut; return }
        if (tokens.issuer != configuration.issuer || (tokens.isExpired(now()) && tokens.refreshToken == null)) {
            store.clear()
            _state.value = AuthState.SignedOut
            return
        }
        _state.value = signedInState(tokens)
    }

    fun beginSignIn() { _state.value = AuthState.SigningIn }

    /** The browser sign-in finished: keep the tokens. */
    fun signedIn(tokens: TokenSet) {
        store.save(tokens)
        _state.value = signedInState(tokens)
    }

    fun cancelled() { _state.value = AuthState.SignedOut }

    fun failed(message: String) { _state.value = AuthState.Failed(message) }

    fun signOut() {
        store.clear()
        _state.value = AuthState.SignedOut
    }

    private fun signedInState(tokens: TokenSet): AuthState.SignedIn {
        val claims = TokenClaims.parse(tokens.accessToken)
        return AuthState.SignedIn(claims?.preferredUsername, claims?.roles ?: emptyList(), tokens.expiresAt)
    }

    override suspend fun accessToken(): String {
        var tokens = store.load() ?: run { _state.value = AuthState.SignedOut; throw AuthException(AuthException.Kind.SIGNED_OUT, "not signed in") }
        if (!tokens.needsRefresh(now())) return tokens.accessToken
        return refreshing.withLock {
            // another caller may have refreshed while this one waited
            tokens = store.load() ?: run { _state.value = AuthState.SignedOut; throw AuthException(AuthException.Kind.SIGNED_OUT, "not signed in") }
            if (!tokens.needsRefresh(now())) return@withLock tokens.accessToken
            if (tokens.refreshToken == null) {
                if (tokens.isExpired(now())) { signOut(); throw AuthException(AuthException.Kind.SIGNED_OUT, "the session expired") }
                return@withLock tokens.accessToken // not yet expired and nothing to refresh with
            }
            try {
                val fresh = client.refresh(tokens, configuration)
                store.save(fresh)
                _state.value = signedInState(fresh)
                fresh.accessToken
            } catch (e: OidcException) {
                when (e.kind) {
                    OidcException.Kind.REFUSED -> { signOut(); throw AuthException(AuthException.Kind.SIGNED_OUT, "the session was refused") }
                    OidcException.Kind.UNAVAILABLE -> throw AuthException(AuthException.Kind.UNAVAILABLE, "no network for a token refresh")
                }
            }
        }
    }
}
