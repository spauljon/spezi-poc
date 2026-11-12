package com.aboutobjects.healthgate.auth

import java.time.Duration
import java.time.Instant
import java.util.Base64
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/** The tokens of one sign-in. [toString] is redacted on purpose: a token must never reach a log or a screen. */
@Serializable
data class TokenSet(
    val accessToken: String,
    val refreshToken: String?,
    val expiresAtMs: Long,
    /** The issuer that minted them: tokens from another server are never used. */
    val issuer: String,
) {
    val expiresAt: Instant get() = Instant.ofEpochMilli(expiresAtMs)

    fun isExpired(now: Instant, skew: Duration = Duration.ZERO): Boolean = !now.plus(skew).isBefore(expiresAt)

    /** True when the access token is expired or about to be (within [skew]). */
    fun needsRefresh(now: Instant, skew: Duration = REFRESH_SKEW): Boolean = isExpired(now, skew)

    override fun toString(): String = "TokenSet(accessToken=<redacted>, refreshToken=${if (refreshToken == null) "none" else "<redacted>"}, expiresAt=$expiresAt, issuer=$issuer)"

    companion object {
        val REFRESH_SKEW: Duration = Duration.ofSeconds(60)
    }
}

/**
 * Claims read from an access token for DISPLAY ONLY (who is signed in). The signature is not checked here and the result must never be
 * used to decide what a user may do: the server verifies every token and authorizes every request.
 */
data class TokenClaims(val preferredUsername: String?, val roles: List<String>, val expiresAt: Instant?) {
    companion object {
        fun parse(jwt: String): TokenClaims? = try {
            val payload = jwt.split('.').getOrNull(1) ?: return null
            val json = Json.parseToJsonElement(String(Base64.getUrlDecoder().decode(payload), Charsets.UTF_8)).jsonObject
            TokenClaims(
                preferredUsername = json["preferred_username"]?.jsonPrimitive?.content,
                roles = json["roles"]?.jsonArray?.map { it.jsonPrimitive.content } ?: emptyList(),
                expiresAt = json["exp"]?.jsonPrimitive?.content?.toLongOrNull()?.let { Instant.ofEpochSecond(it) },
            )
        } catch (e: Exception) {
            null
        }
    }
}
