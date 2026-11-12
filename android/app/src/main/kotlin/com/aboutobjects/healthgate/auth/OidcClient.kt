package com.aboutobjects.healthgate.auth

import com.aboutobjects.healthgate.config.ServerConfiguration

/** The IdP refused ([REFUSED]: the session is over) or could not be reached ([UNAVAILABLE]: try again later). */
class OidcException(val kind: Kind, message: String) : Exception(message) {
    enum class Kind { REFUSED, UNAVAILABLE }
}

/** The part of OpenID Connect that needs no browser: swapping a refresh token for new tokens. (Signing in itself is interactive: see AppAuthClient.) */
interface OidcClient {
    suspend fun refresh(tokens: TokenSet, configuration: ServerConfiguration): TokenSet
}
