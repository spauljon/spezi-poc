package com.aboutobjects.healthgate

import com.aboutobjects.healthgate.ingest.SyntheticConfig
import com.aboutobjects.healthgate.ingest.SyntheticGenerator
import com.aboutobjects.healthgate.mapping.QualityFlagger
import com.aboutobjects.healthgate.queue.InMemorySampleQueue
import com.aboutobjects.healthgate.queue.QueueCounts
import com.aboutobjects.healthgate.sync.FhirRequest
import com.aboutobjects.healthgate.sync.OkHttpTransport
import com.aboutobjects.healthgate.sync.SyncEngine
import com.aboutobjects.healthgate.sync.SyncPhase
import com.aboutobjects.healthgate.sync.TokenProvider
import java.io.File
import java.security.KeyStore
import java.security.cert.CertificateFactory
import java.time.Duration
import java.time.Instant
import java.time.ZoneId
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509TrustManager
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test

/**
 * Live: the Kotlin engine uploads a synthetic window to the developer's own HAPI as the Android persona. It runs only when
 * scripts/android-live-test.sh supplies a token (HEALTHGATE_LIVE_TOKEN); otherwise it is reported as skipped, which that script treats as a failure.
 * Synthetic data only. Nothing here can delete: the samples stay on the persona's synthetic Patient.
 */
class LiveUploadTest {
    private val token = System.getenv("HEALTHGATE_LIVE_TOKEN")
    private val host = System.getenv("POC_HOST") ?: "macpro16.local"
    private val registry = Golden.registry()

    /** An HTTP client that trusts the local POC CA (public certificate) and nothing else the JVM does not already trust. */
    private fun client(): OkHttpClient {
        val ca = File(System.getenv("POC_TLS_DIR") ?: "${System.getProperty("user.home")}/.poc-ca", "ca.crt")
        check(ca.isFile) { "the POC CA certificate was not found at $ca" }
        val store = KeyStore.getInstance(KeyStore.getDefaultType()).apply { load(null) }
        store.setCertificateEntry("poc-ca", ca.inputStream().use { CertificateFactory.getInstance("X.509").generateCertificate(it) })
        val tmf = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm()).apply { init(store) }
        val trust = tmf.trustManagers.filterIsInstance<X509TrustManager>().first()
        val ssl = SSLContext.getInstance("TLS").apply { init(null, arrayOf(trust), null) }
        return OkHttpClient.Builder().sslSocketFactory(ssl.socketFactory, trust).callTimeout(Duration.ofSeconds(60)).build()
    }

    @Test fun aSyntheticWindowUploadsAndARepeatIsAlreadyThere() {
        assumeTrue("set by scripts/android-live-test.sh", !token.isNullOrBlank())
        val http = client()
        val transport = OkHttpTransport("https://$host:8443/fhir", http)
        val settings = SyncEngine.Settings(patientIdentifier = "poc-android-01", patientSystem = registry.systems.identifier.getValue("patient"), batchSize = 100)
        val now = Instant.now()
        val items = SyntheticGenerator(registry).generate(SyntheticConfig(seed = 20260301L, zone = ZoneId.of("UTC")), now.minus(Duration.ofHours(3)), now, now)
            .map { it.copy(sample = QualityFlagger(registry).applied(it.sample)) }
        assertTrue("a three-hour window has samples", items.size >= 30)

        // first upload: everything is accepted by the real server (request validation on); some may already be there from an earlier run
        val queue = InMemorySampleQueue().also { it.enqueue(items) }
        val first = runBlocking { SyncEngine(queue, transport, TokenProvider { token!! }, registry, settings).drain() }
        assertEquals(first.lastError ?: "no error", SyncPhase.Idle, first.phase)
        assertEquals(QueueCounts(sent = items.size), first.counts)
        assertEquals("every sample was either created or already there", items.size, first.created + first.alreadyPresent)

        // second upload of the same samples from a fresh queue: nothing new is created (conditional create is idempotent)
        val again = InMemorySampleQueue().also { it.enqueue(items) }
        val second = runBlocking { SyncEngine(again, transport, TokenProvider { token!! }, registry, settings).drain() }
        assertEquals(0, second.created)
        assertEquals(items.size, second.alreadyPresent)

        // what HAPI holds: the persona's Patient, and each sample's Observation under its identifier
        val tokens = TokenProvider { token!! }
        fun get(path: String) = runBlocking { transport.send(FhirRequest("GET", path, mapOf("Cache-Control" to "no-cache")), tokens.accessToken()) }
        val sampleSystem = registry.systems.identifier.getValue("synthetic")
        val one = items.first().sample.id
        val found = get("Observation?identifier=" + com.aboutobjects.healthgate.sync.FhirSearch.percentEncode("$sampleSystem|$one") + "&_summary=count")
        assertEquals(200, found.status)
        assertEquals("exactly one Observation holds the sample's identifier", 1, Json.parseToJsonElement(found.body).jsonObject.getValue("total").jsonPrimitive.content.toInt())
        // the control: an identifier nobody uploaded finds nothing
        val none = get("Observation?identifier=" + com.aboutobjects.healthgate.sync.FhirSearch.percentEncode("$sampleSystem|no-such-android-sample") + "&_summary=count")
        assertEquals(0, Json.parseToJsonElement(none.body).jsonObject.getValue("total").jsonPrimitive.content.toInt())
        val patient = get("Patient?" + com.aboutobjects.healthgate.sync.FhirSearch.identifierQuery(registry.systems.identifier.getValue("patient"), "poc-android-01") + "&_summary=count")
        assertEquals(1, Json.parseToJsonElement(patient.body).jsonObject.getValue("total").jsonPrimitive.content.toInt())
    }
}
