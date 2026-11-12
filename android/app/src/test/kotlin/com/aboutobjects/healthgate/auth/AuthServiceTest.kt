package com.aboutobjects.healthgate.auth

import com.aboutobjects.healthgate.config.ServerConfiguration
import com.aboutobjects.healthgate.sync.AuthException
import java.io.File
import java.time.Duration
import java.time.Instant
import java.util.Base64
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

private fun b64(text: String) = Base64.getUrlEncoder().withoutPadding().encodeToString(text.toByteArray())

/** A JWT-shaped string with the claims the display reads (the signature is not real: the app never verifies it). */
private fun jwt(user: String, roles: List<String>, exp: Instant) =
    "${b64("""{"alg":"none"}""")}.${b64("""{"preferred_username":"$user","roles":[${roles.joinToString(",") { "\"$it\"" }}],"exp":${exp.epochSecond}}""")}.sig"

class FakeOidc : OidcClient {
    var calls = 0
    var failure: OidcException? = null
    var delayMs = 0L
    var nextExpiry: Instant = Instant.EPOCH
    var user = "android-user"

    override suspend fun refresh(tokens: TokenSet, configuration: ServerConfiguration): TokenSet {
        calls++
        if (delayMs > 0) delay(delayMs)
        failure?.let { throw it }
        return TokenSet(jwt(user, listOf("capture-writer"), nextExpiry), "refresh-$calls", nextExpiry.toEpochMilli(), configuration.issuer)
    }
}

class AuthServiceTest {
    private val config = ServerConfiguration.forHost("macpro16.local")
    private var now = Instant.parse("2026-03-02T12:00:00Z")
    private val client = FakeOidc()
    private val store = InMemoryTokenStore()
    private val service = AuthService(client, store, config, now = { now })

    private fun tokens(expiresIn: Duration, refresh: String? = "r0", issuer: String = config.issuer) =
        TokenSet(jwt("android-user", listOf("capture-writer"), now.plus(expiresIn)), refresh, now.plus(expiresIn).toEpochMilli(), issuer)

    @Test fun nothingStoredIsSignedOut() {
        service.restore()
        assertEquals(AuthState.SignedOut, service.state.value)
    }

    @Test fun storedTokensRestoreTheSessionWithTheNameAndRolesToDisplay() {
        store.save(tokens(Duration.ofMinutes(5)))
        service.restore()
        val s = service.state.value as AuthState.SignedIn
        assertEquals("android-user", s.username)
        assertEquals(listOf("capture-writer"), s.roles)
    }

    @Test fun tokensOfAnotherIssuerOrExpiredWithoutRefreshAreDroppedButExpiredWithRefreshIsKept() {
        store.save(tokens(Duration.ofMinutes(5), issuer = "https://other.example/realms/poc"))
        service.restore()
        assertEquals(AuthState.SignedOut, service.state.value)
        assertNull("the foreign tokens were cleared", store.load())

        store.save(tokens(Duration.ofMinutes(-5), refresh = null))
        service.restore()
        assertEquals(AuthState.SignedOut, service.state.value)
        assertNull(store.load())

        store.save(tokens(Duration.ofMinutes(-5), refresh = "r0")) // the control: a refresh token keeps the session
        service.restore()
        assertTrue(service.state.value is AuthState.SignedIn)
    }

    @Test fun aValidTokenIsReturnedWithoutAnyRefresh() = runBlocking {
        val t = tokens(Duration.ofMinutes(5))
        store.save(t)
        assertEquals(t.accessToken, service.accessToken())
        assertEquals(0, client.calls)
    }

    @Test fun aTokenNearExpiryIsRefreshedAndTheNewOnesAreSaved() = runBlocking {
        store.save(tokens(Duration.ofSeconds(30))) // inside the 60-second skew
        client.nextExpiry = now.plus(Duration.ofMinutes(10))
        val access = service.accessToken()
        assertEquals(1, client.calls)
        assertEquals(store.load()!!.accessToken, access)
        assertEquals("refresh-1", store.load()!!.refreshToken)
        assertTrue(service.state.value is AuthState.SignedIn)
    }

    @Test fun manyCallersAtOnceShareOneRefresh() = runBlocking {
        store.save(tokens(Duration.ofSeconds(10)))
        client.nextExpiry = now.plus(Duration.ofMinutes(10))
        client.delayMs = 50
        val results = (1..10).map { async { service.accessToken() } }.awaitAll()
        assertEquals(1, client.calls)
        assertEquals("every caller got the same fresh token", 1, results.toSet().size)
    }

    @Test fun aRefreshTheServerRefusesEndsTheSession() = runBlocking {
        store.save(tokens(Duration.ofSeconds(10)))
        client.failure = OidcException(OidcException.Kind.REFUSED, "invalid_grant")
        try {
            service.accessToken()
            fail("a refused refresh must not return a token")
        } catch (e: AuthException) {
            assertEquals(AuthException.Kind.SIGNED_OUT, e.kind)
        }
        assertNull("the tokens were cleared", store.load())
        assertEquals(AuthState.SignedOut, service.state.value)
    }

    @Test fun aRefreshThatFailsForLackOfNetworkKeepsTheSession() = runBlocking {
        store.save(tokens(Duration.ofSeconds(10)))
        service.restore()
        client.failure = OidcException(OidcException.Kind.UNAVAILABLE, "offline")
        try {
            service.accessToken()
            fail("no token can be had offline")
        } catch (e: AuthException) {
            assertEquals(AuthException.Kind.UNAVAILABLE, e.kind)
        }
        assertNotNull("the session is kept", store.load())
        assertTrue(service.state.value is AuthState.SignedIn)
        // the control: when the network is back the same call succeeds
        client.failure = null
        client.nextExpiry = now.plus(Duration.ofMinutes(10))
        assertNotNull(service.accessToken())
    }

    @Test fun noTokensMeansSignedOut() = runBlocking {
        try {
            service.accessToken()
            fail("signed out")
        } catch (e: AuthException) {
            assertEquals(AuthException.Kind.SIGNED_OUT, e.kind)
        }
    }

    @Test fun aTokenWithNoRefreshTokenIsUsedUntilItExpiresAndThenTheSessionEnds() = runBlocking {
        val t = tokens(Duration.ofSeconds(30), refresh = null)
        store.save(t)
        assertEquals("not yet expired, nothing to refresh with: still usable", t.accessToken, service.accessToken())
        now = now.plus(Duration.ofMinutes(1))
        try {
            service.accessToken()
            fail("expired")
        } catch (e: AuthException) {
            assertEquals(AuthException.Kind.SIGNED_OUT, e.kind)
        }
        assertNull(store.load())
    }

    @Test fun signingOutClearsTheTokens() {
        service.signedIn(tokens(Duration.ofMinutes(5)))
        assertNotNull(store.load())
        service.signOut()
        assertNull(store.load())
        assertEquals(AuthState.SignedOut, service.state.value)
    }

    @Test fun aTokenSetNeverShowsATokenWhenPrinted() {
        val t = TokenSet("access-secret-123", "refresh-secret-456", 1000, "https://x")
        assertFalse(t.toString().contains("access-secret-123") || t.toString().contains("refresh-secret-456"))
        assertTrue("the control: the values are really in the object", t.accessToken == "access-secret-123" && t.refreshToken == "refresh-secret-456")
    }

    @Test fun claimsAreReadForDisplayAndGarbageGivesNothing() {
        val c = TokenClaims.parse(jwt("android-user", listOf("capture-writer"), now))!!
        assertEquals("android-user", c.preferredUsername)
        assertEquals(listOf("capture-writer"), c.roles)
        assertNull(TokenClaims.parse("not-a-jwt"))
    }

    @Test fun theServerMustBeReachedOverHttps() {
        assertEquals("https://macpro16.local:8443/fhir", config.fhirBase)
        try {
            ServerConfiguration(host = "h", fhirBase = "http://h:8080/fhir", issuer = "https://h/realms/poc", clientId = "c", redirectUri = "r:/x", patientIdentifier = "p")
            fail("plain http must be refused")
        } catch (e: IllegalArgumentException) {
            // refused for the stated reason; the control is the https configuration above
        }
    }

    // ---- tokens must never reach a log: the auth package has no logging at all
    private val logging = Regex("""\b(Log\.[a-z]+|println|print|printStackTrace|Timber)\s*\(""")

    @Test fun theAuthPackageHasNoLoggingAndTheScannerCanSeeOne() {
        val files = File("src/main/kotlin/com/aboutobjects/healthgate/auth").listFiles { f -> f.extension == "kt" }!!.toList()
        assertTrue(files.size >= 5)
        assertEquals(emptyList<String>(), files.filter { logging.containsMatchIn(it.readText()) }.map { it.name })
        assertTrue(logging.containsMatchIn("fun f(t: String) { Log.d(\"x\", t) }"))
    }
}
