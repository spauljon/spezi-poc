package com.aboutobjects.healthgate.healthconnect

import com.aboutobjects.healthgate.ingest.healthconnect.CollectorStateStore
import com.aboutobjects.healthgate.ingest.healthconnect.HcChange
import com.aboutobjects.healthgate.ingest.healthconnect.HcChanges
import com.aboutobjects.healthgate.ingest.healthconnect.HcPage
import com.aboutobjects.healthgate.ingest.healthconnect.HcRecord
import com.aboutobjects.healthgate.ingest.healthconnect.HcType
import com.aboutobjects.healthgate.ingest.healthconnect.HealthConnectGateway
import com.aboutobjects.healthgate.queue.ChangeSet
import com.aboutobjects.healthgate.queue.Enqueued
import com.aboutobjects.healthgate.queue.SampleQueue
import com.aboutobjects.healthgate.sync.FhirRequest
import com.aboutobjects.healthgate.sync.FhirResponse
import com.aboutobjects.healthgate.sync.FhirTransport
import java.net.URLDecoder
import java.time.Instant
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

class InMemoryCollectorState(override var token: String? = null, override var routingEpoch: Int = com.aboutobjects.healthgate.ingest.healthconnect.HealthConnectCollector.ROUTING_EPOCH) : CollectorStateStore

/**
 * A Health Connect that behaves as the real one is documented to: live records, a change log that a token points into (so a record can be
 * delivered again, changed, or deleted), pages, an expiring token, and failures on demand.
 */
class FakeHealthConnect : HealthConnectGateway {
    private val live = LinkedHashMap<String, HcRecord>()
    private val log = ArrayList<HcChange>()
    var changePageSize = Int.MAX_VALUE
    var tokensExpired = false
    var failChangesWith: RuntimeException? = null
    val readPageCalls = ArrayList<String>()

    /** Insert a record, or replace the one with this id (a change), and log it. */
    fun put(record: HcRecord) { live[record.id] = record; log += HcChange.Upsert(record) }

    /** Log a delivery of the record again, exactly as it is now. */
    fun redeliver(id: String) { log += HcChange.Upsert(live.getValue(id)) }

    fun remove(id: String) { live.remove(id); log += HcChange.Delete(id) }

    /** A record vanishes with no change logged (what an expired token cannot tell us). */
    fun vanish(id: String) { live.remove(id) }

    override suspend fun changesToken(): String = "t${log.size}"

    override suspend fun changes(token: String): HcChanges {
        failChangesWith?.let { throw it }
        if (tokensExpired) return HcChanges(emptyList(), token, hasMore = false, tokenExpired = true)
        val from = token.removePrefix("t").toInt()
        val to = minOf(log.size.toLong(), from.toLong() + changePageSize).toInt()
        return HcChanges(log.subList(from, to).toList(), "t$to", hasMore = to < log.size)
    }

    private fun typeOf(r: HcRecord): HcType = when (r) {
        is HcRecord.HeartRate -> HcType.HEART_RATE
        is HcRecord.Instantaneous -> if (r.kind == HcRecord.Instantaneous.Kind.RESTING_HEART_RATE) HcType.RESTING_HEART_RATE else HcType.HRV_RMSSD
        is HcRecord.Sleep -> HcType.SLEEP
        is HcRecord.Hydration -> HcType.HYDRATION
        is HcRecord.Nutrition -> HcType.NUTRITION
    }

    override suspend fun readPage(type: HcType, from: Instant, to: Instant, pageToken: String?, pageSize: Int): HcPage {
        readPageCalls += "$type:${pageToken ?: "-"}"
        val all = live.values.filter { typeOf(it) == type }
        val start = pageToken?.toInt() ?: 0
        val end = minOf(all.size, start + pageSize)
        return HcPage(all.subList(start, end), if (end < all.size) end.toString() else null)
    }
}

/** What the fake server was told to do with an Observation. */
data class ServerOp(val kind: String, val identifier: String)

/**
 * A HAPI as far as this app can tell: conditional create (POST + ifNoneExist), conditional update (PUT by identifier, which creates when
 * nothing matches) and conditional delete (DELETE by identifier, soft: the resource keeps a deleted version, a later PUT makes a NEW
 * resource). It also enforces what the real server's ChangePolicy does, so a wrongly shaped entry fails here as it would there.
 */
class FakeHapi : FhirTransport {
    private class Obs(val id: Int, var resource: JsonObject, var version: Int = 1, var deleted: Boolean = false)

    private val json = Json
    private val patients = LinkedHashMap<String, String>()
    private val byIdentifier = LinkedHashMap<String, MutableList<Obs>>()
    private var nextId = 1
    val ops = ArrayList<ServerOp>()
    var bundles = 0
    var failNextBundle: FhirResponse? = null
    var offline = false

    private fun identifierOf(url: String): String {
        val q = url.substringAfter("identifier=", "")
        require(q.isNotEmpty() && !q.contains('&')) { "not a single-identifier conditional: $url" }
        return URLDecoder.decode(q, "UTF-8")
    }

    /** Identifier -> the live Observation's value, for what a search would find. */
    fun liveValues(): Map<String, Double> = byIdentifier.mapNotNull { (k, v) -> v.lastOrNull { !it.deleted }?.let { k to it.resource.getValue("valueQuantity").jsonObject.getValue("value").jsonPrimitive.content.toDouble() } }.toMap()

    fun liveIdentifiers(): Set<String> = liveValues().keys

    /** Sample identity -> the patient reference its live Observation is filed under. */
    fun liveSubjects(): Map<String, String> = byIdentifier.mapNotNull { (k, v) -> v.lastOrNull { !it.deleted }?.let { k to it.resource.getValue("subject").jsonObject.getValue("reference").jsonPrimitive.content } }.toMap()

    fun resourceId(identifier: String): Int? = byIdentifier[identifier]?.lastOrNull { !it.deleted }?.id

    fun count(kind: String) = ops.count { it.kind == kind }

    override suspend fun send(request: FhirRequest, token: String): FhirResponse {
        if (offline) throw com.aboutobjects.healthgate.sync.TransportFailure("Network: UnknownHostException")
        if (request.method == "GET" && request.path.startsWith("Patient?")) {
            // a patient exists for any identifier asked for (created on first use), each with its own id
            val value = URLDecoder.decode(request.path.substringAfter("identifier=").substringBefore("&"), "UTF-8").substringAfter('|')
            val id = patients.getOrPut(value) { "p-$value" }
            return FhirResponse(200, """{"resourceType":"Bundle","entry":[{"resource":{"resourceType":"Patient","id":"$id"}}]}""")
        }
        if (request.method == "POST" && request.path.isEmpty()) {
            failNextBundle?.let { failNextBundle = null; return it }
            bundles++
            val entries = json.parseToJsonElement(request.body!!).jsonObject.getValue("entry").jsonArray.map { it.jsonObject }
            val statuses = ArrayList<String>()
            // the real server runs deletes first, then creates, then updates; this applies them in that order and answers in request order
            val answers = arrayOfNulls<String>(entries.size)
            for (phase in listOf("DELETE", "POST", "PUT")) {
                for ((i, e) in entries.withIndex()) {
                    val req = e.getValue("request").jsonObject
                    if (req.getValue("method").jsonPrimitive.content != phase) continue
                    val url = req.getValue("url").jsonPrimitive.content
                    if (url != "Observation" && !url.startsWith("Observation?")) { answers[i] = "201 Created"; continue }
                    answers[i] = when (phase) {
                        "DELETE" -> delete(identifierOf(url))
                        "POST" -> create(identifierOf("x?" + req.getValue("ifNoneExist").jsonPrimitive.content), e.getValue("resource").jsonObject)
                        else -> put(identifierOf(url), e.getValue("resource").jsonObject)
                    }
                }
            }
            statuses += answers.map { it!! }
            return FhirResponse(200, """{"resourceType":"Bundle","type":"transaction-response","entry":[${statuses.joinToString(",") { """{"response":{"status":"$it"}}""" }}]}""")
        }
        return FhirResponse(404, "")
    }

    private fun identifiers(resource: JsonObject) = resource.getValue("identifier").jsonArray.map { it.jsonObject }

    private fun create(identifier: String, resource: JsonObject): String {
        val live = byIdentifier[identifier]?.lastOrNull { !it.deleted }
        if (live != null) return "200 OK"
        ops += ServerOp("CREATE", identifier)
        byIdentifier.getOrPut(identifier) { ArrayList() }.add(Obs(nextId++, resource))
        return "201 Created"
    }

    private fun put(identifier: String, resource: JsonObject): String {
        val sys = identifier.substringBefore('|')
        val value = identifier.substringAfter('|')
        check(identifiers(resource).any { it.getValue("system").jsonPrimitive.content == sys && it.getValue("value").jsonPrimitive.content == value }) { "the update does not carry the identifier of its URL" }
        val live = byIdentifier[identifier]?.lastOrNull { !it.deleted }
        return if (live != null) {
            ops += ServerOp("UPDATE", identifier)
            live.resource = resource
            live.version++
            "200 OK"
        } else {
            ops += ServerOp("CREATE-BY-PUT", identifier)
            byIdentifier.getOrPut(identifier) { ArrayList() }.add(Obs(nextId++, resource))
            "201 Created"
        }
    }

    private fun delete(identifier: String): String {
        val live = byIdentifier[identifier]?.lastOrNull { !it.deleted }
        if (live != null) {
            ops += ServerOp("DELETE", identifier)
            live.deleted = true
            live.version++
        }
        return "204 No Content"
    }
}

/** A queue that records how it was used, and can be made to fail, so a hand-off interrupted midway can be tested. */
class SpyQueue(private val inner: SampleQueue) : SampleQueue by inner {
    val applied = ArrayList<ChangeSet>()
    var failOnApplyNumber: Int? = null

    override fun apply(change: ChangeSet): Enqueued {
        applied += change
        if (applied.size == failOnApplyNumber) throw IllegalStateException("injected failure")
        return inner.apply(change)
    }

    override fun enqueue(items: List<com.aboutobjects.healthgate.ingest.IngestItem>): Enqueued = apply(ChangeSet(upserts = items))
}
