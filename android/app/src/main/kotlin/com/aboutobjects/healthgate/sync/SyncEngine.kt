package com.aboutobjects.healthgate.sync

import com.aboutobjects.healthgate.contract.MetricRegistry
import com.aboutobjects.healthgate.queue.QueueCounts
import com.aboutobjects.healthgate.queue.QueuedItem
import com.aboutobjects.healthgate.queue.SampleQueue
import java.time.Instant
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

/** Why uploading cannot continue until something outside the queue changes. */
sealed interface SyncBlocker {
    data object SignInRequired : SyncBlocker
    data class Forbidden(val reason: String) : SyncBlocker
    data class Configuration(val message: String) : SyncBlocker
}

sealed interface SyncPhase {
    data object Idle : SyncPhase
    data object Syncing : SyncPhase
    data class Waiting(val until: Instant) : SyncPhase
    data class Blocked(val blocker: SyncBlocker) : SyncPhase
}

data class Attempt(val at: Instant, val summary: String)

data class SyncStatus(
    val phase: SyncPhase = SyncPhase.Idle,
    val counts: QueueCounts = QueueCounts(),
    val lastSuccess: Instant? = null,
    val lastError: String? = null,
    val created: Int = 0,
    val alreadyPresent: Int = 0,
    /** The last attempts, newest first (shown on the home screen; never contains a sample's content or a token). */
    val history: List<Attempt> = emptyList(),
)

/** Signing in is needed ([SIGNED_OUT]) or the token could not be had right now ([UNAVAILABLE]). */
class AuthException(val kind: Kind, message: String) : Exception(message) {
    enum class Kind { SIGNED_OUT, UNAVAILABLE }
}

fun interface TokenProvider {
    /** A valid access token (refreshing it if needed), or an [AuthException]. The token is never logged. */
    suspend fun accessToken(): String
}

/**
 * Uploads the queue to the developer's own HAPI: resolve the Patient, send batches as transaction Bundles of conditional creates, and
 * record the outcome of each in the queue. The Kotlin counterpart of iOS's `SyncEngine`, without the retraction (M27).
 */
class SyncEngine(
    private val queue: SampleQueue,
    private val transport: FhirTransport,
    private val tokens: TokenProvider,
    registry: MetricRegistry,
    private val settings: Settings,
    private val now: () -> Instant = { Instant.now() },
    private val random: () -> Double = { Math.random() },
) {
    data class Settings(
        val patientIdentifier: String,
        val patientSystem: String,
        val batchSize: Int = 100,
        val backoff: BackoffPolicy = BackoffPolicy(),
    )

    private val builder = BundleBuilder(registry)
    private val json = Json { ignoreUnknownKeys = true }
    private val gate = Mutex()
    private var patientId: String? = null
    private var state = SyncStatus()
    private val _status = MutableStateFlow(state)
    val status: StateFlow<SyncStatus> get() = _status

    private fun publish(change: (SyncStatus) -> SyncStatus) {
        state = change(state)
        _status.value = state
    }

    private suspend fun <T> io(block: () -> T): T = withContext(Dispatchers.IO) { block() }

    suspend fun refresh(): SyncStatus {
        runCatching { io { queue.counts() } }.onSuccess { c -> publish { it.copy(counts = c) } }
        return state
    }

    private sealed interface Step {
        data object Done : Step
        data class Stop(val phase: SyncPhase) : Step
    }

    private sealed interface Stop {
        data class Transient(val message: String) : Stop
        data class Blocked(val blocker: SyncBlocker, val message: String) : Stop
    }

    /** Uploads everything that is due. Only one drain runs at a time: a second call returns the current status at once. */
    suspend fun drain(): SyncStatus {
        if (!gate.tryLock()) return state
        try {
            val uploadedBefore = state.created + state.alreadyPresent
            publish { it.copy(phase = SyncPhase.Syncing, lastError = null) }
            try {
                while (true) {
                    val due = io { queue.nextBatch(settings.batchSize, now()) }
                    if (due.isEmpty()) break
                    val attempts = due.maxOf { it.attempts }
                    val pid = when (val r = resolvePatient()) {
                        is Resolved.Id -> r.id
                        is Resolved.Failed -> {
                            finish(r.stop, due.map { it.key }, attempts)
                            return finishAttempt(uploadedBefore)
                        }
                    }
                    when (val step = upload(due, attempts, pid)) {
                        Step.Done -> continue
                        is Step.Stop -> {
                            publish { it.copy(phase = step.phase) }
                            refresh()
                            return finishAttempt(uploadedBefore)
                        }
                    }
                }
                publish { it.copy(phase = SyncPhase.Idle, lastSuccess = now()) }
            } catch (e: Exception) {
                publish { it.copy(phase = SyncPhase.Blocked(SyncBlocker.Configuration("The local queue failed: ${e.javaClass.simpleName}")), lastError = "The local queue failed: ${e.javaClass.simpleName}") }
            }
            refresh()
            return finishAttempt(uploadedBefore)
        } finally {
            gate.unlock()
        }
    }

    private fun finishAttempt(uploadedBefore: Int): SyncStatus {
        val sent = state.created + state.alreadyPresent - uploadedBefore
        val summary = when (val p = state.phase) {
            is SyncPhase.Blocked -> "Blocked: ${state.lastError ?: "see the status"}"
            is SyncPhase.Waiting -> "Will retry: ${state.lastError ?: "a temporary problem"}"
            else -> if (sent > 0) "Uploaded $sent" else "Nothing to upload"
        }
        publish { it.copy(history = (listOf(Attempt(now(), summary)) + it.history).take(HISTORY)) }
        return state
    }

    private fun retryAt(attempts: Int): Instant =
        now().plusMillis((settings.backoff.delaySeconds(attempts + 1, random()) * 1000).toLong())

    private suspend fun finish(stop: Stop, keys: List<String>, attempts: Int) {
        when (stop) {
            is Stop.Transient -> {
                val due = retryAt(attempts)
                io { queue.recordFailure(keys, stop.message, due) }
                publish { it.copy(phase = SyncPhase.Waiting(due), lastError = stop.message) }
            }
            is Stop.Blocked -> publish { it.copy(phase = SyncPhase.Blocked(stop.blocker), lastError = stop.message) }
        }
        refresh()
    }

    private suspend fun upload(items: List<QueuedItem>, attempts: Int, patientId: String): Step {
        val built = builder.build(items.map { it.key to it.item }, patientId)
        for ((key, error) in built.invalid) io { queue.markRejected(key, "Not mappable: ${error.code}") }
        if (built.unmappedKeys.isNotEmpty()) io { queue.markSkipped(built.unmappedKeys) }
        if (built.observationKeys.isEmpty()) return Step.Done
        return send(built, attempts, mayRefresh = true)
    }

    private suspend fun send(built: BuildResult, attempts: Int, mayRefresh: Boolean): Step {
        val bearer = try {
            tokens.accessToken()
        } catch (e: AuthException) {
            val phase = if (e.kind == AuthException.Kind.SIGNED_OUT) SyncPhase.Blocked(SyncBlocker.SignInRequired) else SyncPhase.Waiting(retryAt(attempts))
            publish { it.copy(phase = phase, lastError = if (e.kind == AuthException.Kind.SIGNED_OUT) "Sign in to upload." else "Could not get an access token.") }
            return Step.Stop(phase)
        }
        val response = try {
            transport.send(FhirRequest("POST", "", body = builder.bundle(built.entries)), bearer)
        } catch (e: TransportFailure) {
            return transient(built.observationKeys, e.description, attempts)
        }
        return when (response.status) {
            in 200..299 -> {
                val tally = tally(response.body, skipping = built.deviceEntries.size)
                if (tally == null || tally.total != built.entries.size) {
                    return transient(built.observationKeys, "The server's response did not match the request.", attempts)
                }
                io { queue.markSent(built.observationKeys) }
                publish { it.copy(created = it.created + tally.created, alreadyPresent = it.alreadyPresent + maxOf(0, built.observationKeys.size - tally.created), lastSuccess = now()) }
                refresh()
                Step.Done
            }
            401 -> {
                if (mayRefresh) return send(built, attempts, mayRefresh = false)
                val phase = SyncPhase.Blocked(SyncBlocker.SignInRequired)
                publish { it.copy(phase = phase, lastError = "The server did not accept the sign-in. Sign in again.") }
                Step.Stop(phase)
            }
            403 -> {
                val reason = diagnostics(response.body) ?: "Forbidden"
                val phase = SyncPhase.Blocked(SyncBlocker.Forbidden(reason))
                publish { it.copy(phase = phase, lastError = "The server refused this user: $reason") }
                Step.Stop(phase)
            }
            408, 429, in 500..599 -> transient(built.observationKeys, "Server returned HTTP ${response.status}.", attempts)
            else -> {
                val reason = diagnostics(response.body) ?: "HTTP ${response.status}"
                val only = built.observationKeys.singleOrNull()
                if (only != null) {
                    io { queue.markRejected(only, "HTTP ${response.status}: $reason") }
                    refresh()
                    Step.Done
                } else {
                    bisect(built, attempts)
                }
            }
        }
    }

    /** A batch the server refused as a whole: send each half on its own until the bad sample is alone and can be rejected. */
    private suspend fun bisect(built: BuildResult, attempts: Int): Step {
        val observations = built.observationEntries
        val middle = observations.size / 2
        for (range in listOf(0 until middle, middle until observations.size)) {
            if (range.isEmpty()) continue
            val slice = observations.slice(range)
            val used = slice.mapNotNull { it.resource["device"]?.jsonObject?.get("reference")?.jsonPrimitive?.content }.toSet()
            val part = BuildResult(built.deviceEntries.filter { it.fullUrl in used } + slice, built.observationKeys.slice(range), emptyList(), emptyList())
            when (val step = send(part, attempts, mayRefresh = true)) {
                Step.Done -> continue
                is Step.Stop -> return step
            }
        }
        return Step.Done
    }

    private suspend fun transient(keys: List<String>, message: String, attempts: Int): Step {
        val due = retryAt(attempts)
        io { queue.recordFailure(keys, message, due) }
        val phase = SyncPhase.Waiting(due)
        publish { it.copy(phase = phase, lastError = message) }
        refresh()
        return Step.Stop(phase)
    }

    private sealed interface Resolved {
        data class Id(val id: String) : Resolved
        data class Failed(val stop: Stop) : Resolved
    }

    /** Finds the capture Patient by its identifier, or creates it (a conditional create: safe to repeat). */
    private suspend fun resolvePatient(): Resolved {
        patientId?.let { return Resolved.Id(it) }
        val bearer = try {
            tokens.accessToken()
        } catch (e: AuthException) {
            return Resolved.Failed(if (e.kind == AuthException.Kind.SIGNED_OUT) Stop.Blocked(SyncBlocker.SignInRequired, "Sign in to upload.") else Stop.Transient("Could not get an access token."))
        }
        val query = FhirSearch.identifierQuery(settings.patientSystem, settings.patientIdentifier)
        try {
            val found = transport.send(FhirRequest("GET", "Patient?$query&_elements=id"), bearer)
            when (found.status) {
                200 -> {
                    val ids = patientIds(found.body)
                    if (ids.size == 1) { patientId = ids[0]; return Resolved.Id(ids[0]) }
                    if (ids.size > 1) return Resolved.Failed(Stop.Blocked(SyncBlocker.Configuration("More than one Patient has this identifier."), "More than one Patient has this identifier."))
                }
                401 -> return Resolved.Failed(Stop.Blocked(SyncBlocker.SignInRequired, "The server did not accept the sign-in. Sign in again."))
                403 -> return Resolved.Failed(Stop.Blocked(SyncBlocker.Forbidden("Forbidden"), "The server refused this user."))
                else -> return Resolved.Failed(Stop.Transient("Patient lookup returned HTTP ${found.status}."))
            }
            val patient: JsonObject = buildJsonObject {
                put("resourceType", "Patient")
                put("identifier", buildJsonArray { add(buildJsonObject { put("system", settings.patientSystem); put("value", settings.patientIdentifier) }) })
            }
            val created = transport.send(
                FhirRequest("POST", "Patient", mapOf("If-None-Exist" to query, "Prefer" to "return=representation"), patient.toString()), bearer,
            )
            return when (created.status) {
                200, 201 -> resourceId(created.body)?.let { patientId = it; Resolved.Id(it) } ?: Resolved.Failed(Stop.Transient("The server did not return the Patient id."))
                403 -> Resolved.Failed(Stop.Blocked(SyncBlocker.Forbidden("Forbidden"), "The server refused this user."))
                else -> Resolved.Failed(Stop.Transient("Patient create returned HTTP ${created.status}."))
            }
        } catch (e: TransportFailure) {
            return Resolved.Failed(Stop.Transient(e.description))
        }
    }

    private data class Tally(val total: Int, val created: Int)

    /** The transaction response's entries: how many there are, and how many of the Observation entries were created (201). */
    private fun tally(body: String, skipping: Int): Tally? = try {
        val entries = json.parseToJsonElement(body).jsonObject["entry"]?.jsonArray ?: return null
        val statuses = entries.map { it.jsonObject["response"]?.jsonObject?.get("status")?.jsonPrimitive?.content ?: "" }
        Tally(statuses.size, statuses.drop(skipping).count { it.startsWith("201") })
    } catch (e: Exception) {
        null
    }

    private fun patientIds(body: String): List<String> = try {
        json.parseToJsonElement(body).jsonObject["entry"]?.jsonArray?.mapNotNull { it.jsonObject["resource"]?.jsonObject?.get("id")?.jsonPrimitive?.content } ?: emptyList()
    } catch (e: Exception) {
        emptyList()
    }

    private fun resourceId(body: String): String? = try {
        json.parseToJsonElement(body).jsonObject["id"]?.jsonPrimitive?.content
    } catch (e: Exception) {
        null
    }

    /** The server's own explanation of a refusal (an OperationOutcome), if there is one. */
    private fun diagnostics(body: String): String? = try {
        json.parseToJsonElement(body).jsonObject["issue"]?.jsonArray?.firstOrNull()?.jsonObject?.let { i ->
            (i["diagnostics"] ?: i["details"]?.jsonObject?.get("text"))?.jsonPrimitive?.content?.take(200)
        }
    } catch (e: Exception) {
        null
    }

    private companion object {
        const val HISTORY = 20
    }
}
