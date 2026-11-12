package com.aboutobjects.healthgate.sync

import com.aboutobjects.healthgate.Golden
import com.aboutobjects.healthgate.ingest.IngestItem
import com.aboutobjects.healthgate.ingest.SyntheticConfig
import com.aboutobjects.healthgate.ingest.SyntheticGenerator
import com.aboutobjects.healthgate.mapping.DeviceDescriptor
import com.aboutobjects.healthgate.mapping.Measurement
import com.aboutobjects.healthgate.mapping.QualityFlagger
import com.aboutobjects.healthgate.queue.InMemorySampleQueue
import com.aboutobjects.healthgate.queue.QueueCounts
import java.io.File
import java.time.Duration
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** A scripted FHIR server: it keeps what it was sent, so a resend is "already present", and it can fail in every way the real one can. */
class FakeFhirServer {
    val requests = mutableListOf<FhirRequest>()
    val tokensSeen = mutableListOf<String>()
    val stored = mutableSetOf<String>()
    var patientExists = false
    var duplicatePatients = false
    var offline = false
    var rejectIdentifiers: Set<String> = emptySet()
    var bundleDelayMs = 0L
    /** An override for the next bundle POSTs: return a response to force it, or null to behave normally. */
    var forceBundle: (() -> FhirResponse?)? = null
    var shortResponse = false
    private val json = Json

    val bundles get() = requests.filter { it.method == "POST" && it.path.isEmpty() }

    suspend fun send(request: FhirRequest, token: String): FhirResponse {
        if (offline) throw TransportFailure("Network: UnknownHostException")
        requests.add(request)
        tokensSeen.add(token)
        if (request.method == "GET" && request.path.startsWith("Patient?")) {
            val ids = if (duplicatePatients) listOf("p1", "p2") else if (patientExists) listOf("p1") else emptyList()
            val entries = ids.joinToString(",") { """{"resource":{"resourceType":"Patient","id":"$it"}}""" }
            return FhirResponse(200, if (ids.isEmpty()) """{"resourceType":"Bundle","type":"searchset"}""" else """{"resourceType":"Bundle","entry":[$entries]}""")
        }
        if (request.method == "POST" && request.path == "Patient") {
            patientExists = true
            return FhirResponse(201, """{"resourceType":"Patient","id":"p1"}""")
        }
        if (request.method == "POST" && request.path.isEmpty()) {
            if (bundleDelayMs > 0) delay(bundleDelayMs)
            forceBundle?.invoke()?.let { return it }
            val entries = json.parseToJsonElement(request.body!!).jsonObject.getValue("entry").jsonArray.map { it.jsonObject }
            val ids = entries.filter { it.getValue("request").jsonObject.getValue("url").jsonPrimitive.content == "Observation" }
                .map { it.getValue("resource").jsonObject.getValue("identifier").jsonArray[0].jsonObject.getValue("value").jsonPrimitive.content }
            if (ids.any { it in rejectIdentifiers }) {
                return FhirResponse(422, """{"resourceType":"OperationOutcome","issue":[{"severity":"error","diagnostics":"HAPI-1234: invalid Observation"}]}""")
            }
            val statuses = entries.map { e ->
                val isObs = e.getValue("request").jsonObject.getValue("url").jsonPrimitive.content == "Observation"
                if (!isObs) "201 Created" else {
                    val id = e.getValue("resource").jsonObject.getValue("identifier").jsonArray[0].jsonObject.getValue("value").jsonPrimitive.content
                    if (stored.add(id)) "201 Created" else "200 OK"
                }
            }.let { if (shortResponse) it.dropLast(1) else it }
            return FhirResponse(200, """{"resourceType":"Bundle","type":"transaction-response","entry":[${statuses.joinToString(",") { """{"response":{"status":"$it"}}""" }}]}""")
        }
        return FhirResponse(404, "")
    }
}

class SyncEngineTest {
    private val registry = Golden.registry()
    private val generator = SyntheticGenerator(registry)
    private val flagger = QualityFlagger(registry)
    private val patientSystem = registry.systems.identifier.getValue("patient")
    private val day0: Instant = LocalDate.of(2026, 3, 2).atStartOfDay(ZoneId.of("UTC")).toInstant()

    private var clock = day0.plus(Duration.ofDays(1))
    private val server = FakeFhirServer()
    private val queue = InMemorySampleQueue()
    private var signedOut = false
    private var tokenCalls = 0

    private val transport = object : FhirTransport {
        override suspend fun send(request: FhirRequest, token: String) = server.send(request, token)
    }
    private val tokens = TokenProvider {
        tokenCalls++
        if (signedOut) throw AuthException(AuthException.Kind.SIGNED_OUT, "signed out")
        "tok-$tokenCalls"
    }

    private fun engine(batch: Int = 100) = SyncEngine(
        queue, transport, tokens, registry, SyncEngine.Settings(patientIdentifier = "poc-android-01", patientSystem = patientSystem, batchSize = batch),
        now = { clock }, random = { 0.5 },
    )

    private fun fill(): List<IngestItem> {
        val items = generator.generate(SyntheticConfig(seed = 3, zone = ZoneId.of("UTC")), day0, day0.plus(Duration.ofDays(1)), clock)
            .map { it.copy(sample = flagger.applied(it.sample)) }
        queue.enqueue(items)
        return items
    }

    private fun run(e: SyncEngine) = runBlocking { e.drain() }

    @Test fun aWholeDayUploadsInBatchesAndEverythingIsSent() {
        val items = fill()
        val status = run(engine(batch = 100))
        assertEquals(SyncPhase.Idle, status.phase)
        assertEquals(QueueCounts(sent = items.size), status.counts)
        assertEquals(items.size, status.created)
        assertEquals(0, status.alreadyPresent)
        assertEquals("one bundle per hundred samples", (items.size + 99) / 100, server.bundles.size)
        val first = Json.parseToJsonElement(server.bundles.first().body!!).jsonObject.getValue("entry").jsonArray.map { it.jsonObject }
        val device = first.first()
        assertEquals("the Device goes first", "Device", device.getValue("request").jsonObject.getValue("url").jsonPrimitive.content)
        assertTrue(device.getValue("request").jsonObject.getValue("ifNoneExist").jsonPrimitive.content.startsWith("identifier="))
        val obs = first[1].getValue("resource").jsonObject
        assertEquals(device.getValue("fullUrl"), obs.getValue("device").jsonObject.getValue("reference"))
        assertEquals("Patient/p1", obs.getValue("subject").jsonObject.getValue("reference").jsonPrimitive.content)
        assertEquals("ifNoneExist keys every Observation on its identifier", 1, first.count { it.getValue("request").jsonObject.getValue("url").jsonPrimitive.content == "Device" })
        assertTrue(status.history.first().summary.startsWith("Uploaded"))
    }

    @Test fun anExistingPatientIsFoundAndNotCreatedAgain() {
        server.patientExists = true
        fill()
        run(engine())
        assertTrue(server.requests.none { it.method == "POST" && it.path == "Patient" })
        // the control: with no Patient it IS created
        val other = FakeFhirServer().also { s -> runBlocking { engineWith(s).drain() } }
        assertTrue(other.requests.any { it.method == "POST" && it.path == "Patient" })
    }

    private fun engineWith(s: FakeFhirServer): SyncEngine {
        val q = InMemorySampleQueue().also { it.enqueue(generator.generate(SyntheticConfig(), day0, day0.plus(Duration.ofHours(1)), clock)) }
        return SyncEngine(q, object : FhirTransport { override suspend fun send(request: FhirRequest, token: String) = s.send(request, token) }, tokens, registry,
            SyncEngine.Settings("poc-android-01", patientSystem), now = { clock }, random = { 0.5 })
    }

    @Test fun twoPatientsWithTheSameIdentifierBlockTheUpload() {
        server.duplicatePatients = true
        fill()
        val status = run(engine())
        assertTrue(status.phase is SyncPhase.Blocked && (status.phase as SyncPhase.Blocked).blocker is SyncBlocker.Configuration)
        assertEquals(0, queue.counts().sent)
        assertTrue(server.bundles.isEmpty())
    }

    @Test fun aResendIsAlreadyPresentNotCreatedAgain() {
        val items = fill()
        run(engine())
        // the app sends the same samples again after a restart that lost the queue state
        val fresh = InMemorySampleQueue().also { it.enqueue(items) }
        val e = SyncEngine(fresh, transport, tokens, registry, SyncEngine.Settings("poc-android-01", patientSystem), now = { clock }, random = { 0.5 })
        val status = runBlocking { e.drain() }
        assertEquals(0, status.created)
        assertEquals(items.size, status.alreadyPresent)
        assertEquals(QueueCounts(sent = items.size), status.counts)
        assertEquals("the server holds each sample once", items.size, server.stored.size)
    }

    @Test fun a401IsRetriedOnceWithAFreshTokenThenBlocksAsSignInRequired() {
        fill()
        var failures = 1
        server.forceBundle = { if (failures-- > 0) FhirResponse(401, "") else null }
        val before = tokenCalls
        val ok = run(engine())
        assertEquals(SyncPhase.Idle, ok.phase)
        assertTrue("the token was asked for again", tokenCalls - before >= 3) // patient + bundle + the retry
        // always 401: blocked, and the samples are untouched (nothing is lost or counted as a failed attempt)
        val q2 = InMemorySampleQueue().also { it.enqueue(generator.generate(SyntheticConfig(), day0, day0.plus(Duration.ofHours(1)), clock)) }
        server.forceBundle = { FhirResponse(401, "") }
        val e = SyncEngine(q2, transport, tokens, registry, SyncEngine.Settings("poc-android-01", patientSystem), now = { clock }, random = { 0.5 })
        val blocked = runBlocking { e.drain() }
        assertEquals(SyncPhase.Blocked(SyncBlocker.SignInRequired), blocked.phase)
        assertEquals(0, q2.counts().sent)
        assertEquals(0, q2.nextBatch(1, clock).single().attempts)
    }

    @Test fun a403BlocksWithTheServersReasonAndLeavesTheQueueAlone() {
        val items = fill()
        server.forceBundle = { FhirResponse(403, """{"resourceType":"OperationOutcome","issue":[{"diagnostics":"HAPI-0333: role not allowed"}]}""") }
        val status = run(engine())
        val blocker = (status.phase as SyncPhase.Blocked).blocker as SyncBlocker.Forbidden
        assertEquals("HAPI-0333: role not allowed", blocker.reason)
        assertEquals(QueueCounts(pending = items.size), queue.counts())
    }

    @Test fun aServerErrorBacksOffAndTheNextDrainAfterTheDelaySucceeds() {
        val items = fill()
        server.forceBundle = { FhirResponse(503, "") }
        val waiting = run(engine())
        val until = (waiting.phase as SyncPhase.Waiting).until
        assertEquals("first retry: 5 s with no jitter at random 0.5", clock.plusSeconds(5), until)
        assertEquals(0, queue.counts().sent)
        // only the batch that failed is held back (as on iOS): its 100 samples are not due until the retry time, the rest still are
        val heldKeys = items.take(100).map { it.key }.toSet()
        val dueNow = queue.nextBatch(10_000, clock).map { it.key }.toSet()
        assertTrue("the failed batch is held until its retry time", dueNow.none { it in heldKeys })
        assertEquals("the samples after it are still due", items.size - 100, dueNow.size)
        assertTrue("and the held batch is due again at the retry time", queue.nextBatch(10_000, until).map { it.key }.toSet().containsAll(heldKeys))
        server.forceBundle = null
        clock = until
        val ok = run(engine())
        assertEquals(SyncPhase.Idle, ok.phase)
        assertEquals(QueueCounts(sent = items.size), ok.counts)
    }

    @Test fun beingOfflineWaitsAndKeepsEverything() {
        val items = fill()
        server.offline = true
        val status = run(engine())
        assertTrue(status.phase is SyncPhase.Waiting)
        assertEquals(QueueCounts(pending = items.size), status.counts)
        assertTrue(status.lastError!!.startsWith("Network"))
        // the control: back online, the same queue uploads
        server.offline = false
        clock = clock.plus(Duration.ofHours(1))
        assertEquals(SyncPhase.Idle, run(engine()).phase)
    }

    @Test fun aRefusedBatchIsHalvedUntilTheOneBadSampleIsRejected() {
        val items = fill().take(30)
        val bad = items[17]
        val badId = bad.sample.id
        server.rejectIdentifiers = setOf(badId)
        // only the first 30 are queued for this test
        val q = InMemorySampleQueue().also { it.enqueue(items) }
        val e = SyncEngine(q, transport, tokens, registry, SyncEngine.Settings("poc-android-01", patientSystem), now = { clock }, random = { 0.5 })
        val status = runBlocking { e.drain() }
        assertEquals(QueueCounts(sent = 29, rejected = 1), status.counts)
        assertTrue("more than one bundle was needed to isolate it", server.bundles.size > 1)
        assertTrue(server.stored.none { it == badId } && server.stored.size == 29)
        // the control: with nothing refused all thirty are sent in one bundle
        val clean = FakeFhirServer()
        val q2 = InMemorySampleQueue().also { it.enqueue(items) }
        val e2 = SyncEngine(q2, object : FhirTransport { override suspend fun send(request: FhirRequest, token: String) = clean.send(request, token) }, tokens, registry,
            SyncEngine.Settings("poc-android-01", patientSystem), now = { clock }, random = { 0.5 })
        runBlocking { e2.drain() }
        assertEquals(QueueCounts(sent = 30), q2.counts())
        assertEquals(1, clean.bundles.size)
    }

    @Test fun anUnmappedStageIsSkippedAndAnInvalidSampleIsRejectedWithItsReason() {
        val t = day0.plusSeconds(3600)
        val good = generator.generate(SyntheticConfig(), day0, day0.plus(Duration.ofHours(2)), clock).take(3)
        val inBed = IngestItem(good[0].sample.copy(measurement = Measurement.Sleep("inBed"), end = t.plusSeconds(600), id = "bed-1"), DeviceDescriptor.Synthetic)
        val invalid = IngestItem(good[0].sample.copy(measurement = Measurement.Quantity("heartRate", -5.0), id = "neg-1"), DeviceDescriptor.Synthetic)
        queue.enqueue(good + inBed + invalid)
        val status = run(engine())
        assertEquals(QueueCounts(sent = 3, rejected = 1, skipped = 1), status.counts)
        assertEquals(3, server.stored.size)
    }

    @Test fun beingSignedOutBlocksWithoutCallingTheServerAndSigningInResumes() {
        val items = fill()
        signedOut = true
        val status = run(engine())
        assertEquals(SyncPhase.Blocked(SyncBlocker.SignInRequired), status.phase)
        assertTrue("no request was made", server.requests.isEmpty())
        assertEquals(QueueCounts(pending = items.size), status.counts)
        signedOut = false
        assertEquals(SyncPhase.Idle, run(engine()).phase)
    }

    @Test fun aResponseThatDoesNotMatchTheRequestIsTreatedAsAFailure() {
        val items = fill()
        server.shortResponse = true
        val status = run(engine())
        assertTrue(status.phase is SyncPhase.Waiting)
        assertEquals(0, status.counts.sent)
        assertEquals(items.size, status.counts.pending)
    }

    @Test fun twoDrainsAtOnceUploadOnce() {
        val items = fill()
        server.bundleDelayMs = 40
        val e = engine(batch = 1000)
        val (a, b) = runBlocking {
            val first = async { e.drain() }
            delay(10)
            val second = async { e.drain() }
            first.await() to second.await()
        }
        assertEquals("the second call returned the running status at once", SyncPhase.Syncing, b.phase)
        assertEquals(1, server.bundles.size)
        assertEquals(QueueCounts(sent = items.size), a.counts)
    }

    @Test fun theTokenTravelsOnlyAsTheBearerCredentialAndNeverInAUrlOrBody() {
        fill()
        run(engine())
        assertTrue(server.tokensSeen.isNotEmpty() && server.tokensSeen.all { it.startsWith("tok-") })
        for (r in server.requests) {
            assertTrue(!r.path.contains("tok-") && r.body?.contains("tok-") != true && r.headers.values.none { it.contains("tok-") })
        }
        // the control: the scan can see a token if one were put in a body
        assertTrue(FhirRequest("POST", "", body = """{"x":"tok-1"}""").body!!.contains("tok-"))
    }

    // ---- a token or a sample must never reach a log: the packages that hold them have no logging at all
    private val logging = Regex("""\b(Log\.[a-z]+|println|print|printStackTrace|Timber)\s*\(""")

    @Test fun theSyncPackageHasNoLoggingAndTheScannerCanSeeOne() {
        val dir = File("src/main/kotlin/com/aboutobjects/healthgate/sync")
        val files = dir.listFiles { f -> f.extension == "kt" }!!.toList()
        assertTrue(files.size >= 5)
        assertEquals(emptyList<String>(), files.filter { logging.containsMatchIn(it.readText()) }.map { it.name })
        val bad = File.createTempFile("log", ".kt").apply { writeText("fun f(t: String) { Log.d(\"x\", t) }"); deleteOnExit() }
        assertTrue(logging.containsMatchIn(bad.readText()))
    }
}
