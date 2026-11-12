package com.aboutobjects.healthgate.auth

import android.content.Context
import android.content.Intent
import android.net.Uri
import com.aboutobjects.healthgate.config.ServerConfiguration
import java.time.Instant
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.suspendCancellableCoroutine
import net.openid.appauth.AuthorizationException
import net.openid.appauth.AuthorizationRequest
import net.openid.appauth.AuthorizationResponse
import net.openid.appauth.AuthorizationService
import net.openid.appauth.AuthorizationServiceConfiguration
import net.openid.appauth.GrantTypeValues
import net.openid.appauth.ResponseTypeValues
import net.openid.appauth.TokenRequest
import net.openid.appauth.TokenResponse

/** The user closed the browser sign-in without finishing it: not an error. */
class SignInCancelled : Exception("sign-in cancelled")

/**
 * OpenID Connect against Keycloak with AppAuth for Android: authorization code with PKCE (S256), in the phone's browser (a Custom Tab),
 * never in a WebView. All AppAuth use stays inside this class. The app is a public client: there is no client secret anywhere.
 */
class AppAuthClient(context: Context) : OidcClient {
    private val service = AuthorizationService(context.applicationContext)
    private var discovered: AuthorizationServiceConfiguration? = null

    private suspend fun discover(configuration: ServerConfiguration): AuthorizationServiceConfiguration {
        discovered?.let { return it }
        return suspendCancellableCoroutine { cont ->
            AuthorizationServiceConfiguration.fetchFromIssuer(Uri.parse(configuration.issuer)) { found, error ->
                if (found != null) {
                    discovered = found
                    cont.resume(found)
                } else {
                    cont.resumeWithException(OidcException(OidcException.Kind.UNAVAILABLE, "the sign-in server could not be reached (${error?.javaClass?.simpleName})"))
                }
            }
        }
    }

    /** The browser intent that starts the sign-in. `offline_access` lets the session be renewed without signing in again. */
    suspend fun authorizationIntent(configuration: ServerConfiguration): Intent {
        val request = AuthorizationRequest.Builder(
            discover(configuration), configuration.clientId, ResponseTypeValues.CODE, Uri.parse(configuration.redirectUri),
        ).setScope("openid offline_access").build()
        return service.getAuthorizationRequestIntent(request)
    }

    /** The browser came back: exchange the code (with the PKCE verifier AppAuth kept) for tokens. */
    suspend fun complete(data: Intent, configuration: ServerConfiguration): TokenSet {
        val response = AuthorizationResponse.fromIntent(data)
        val error = AuthorizationException.fromIntent(data)
        if (response == null) {
            if (error == null || error == AuthorizationException.GeneralErrors.USER_CANCELED_AUTH_FLOW) throw SignInCancelled()
            throw OidcException(OidcException.Kind.REFUSED, "the sign-in was not completed (${error.errorDescription ?: error.error ?: "error ${error.code}"})")
        }
        val tokens = exchange(response.createTokenExchangeRequest())
        return toTokenSet(tokens, configuration, previousRefresh = null)
    }

    override suspend fun refresh(tokens: TokenSet, configuration: ServerConfiguration): TokenSet {
        val request = TokenRequest.Builder(discover(configuration), configuration.clientId)
            .setGrantType(GrantTypeValues.REFRESH_TOKEN)
            .setRefreshToken(tokens.refreshToken)
            .build()
        return toTokenSet(exchange(request), configuration, previousRefresh = tokens.refreshToken)
    }

    private suspend fun exchange(request: TokenRequest): TokenResponse = suspendCancellableCoroutine { cont ->
        service.performTokenRequest(request) { response, error ->
            when {
                response != null -> cont.resume(response)
                // the server answered with an OAuth error (for example invalid_grant): the session is over; anything else is a network problem
                error?.type == AuthorizationException.TYPE_OAUTH_TOKEN_ERROR ->
                    cont.resumeWithException(OidcException(OidcException.Kind.REFUSED, "the server refused the token request (${error.error})"))
                else -> cont.resumeWithException(OidcException(OidcException.Kind.UNAVAILABLE, "the token request could not be completed"))
            }
        }
    }

    private fun toTokenSet(r: TokenResponse, configuration: ServerConfiguration, previousRefresh: String?): TokenSet {
        val access = r.accessToken ?: throw OidcException(OidcException.Kind.REFUSED, "the server returned no access token")
        val expires = r.accessTokenExpirationTime ?: Instant.now().plusSeconds(300).toEpochMilli()
        return TokenSet(access, r.refreshToken ?: previousRefresh, expires, configuration.issuer)
    }
}
