package com.aboutobjects.healthgate.ingest.healthconnect

import java.time.Instant

/** The five metrics' record classes (sleep and hydration included), as the collector asks Health Connect for them. */
enum class HcType { HEART_RATE, RESTING_HEART_RATE, HRV_RMSSD, SLEEP, NUTRITION, HYDRATION }

/** One page of a time-range read. [nextPageToken] is null on the last page. */
data class HcPage(val records: List<HcRecord>, val nextPageToken: String?)

sealed interface HcChange {
    /** A record was inserted or changed: it is the whole record as it is now. */
    data class Upsert(val record: HcRecord) : HcChange

    /** A record was deleted. Health Connect says nothing but its id. */
    data class Delete(val recordId: String) : HcChange
}

/**
 * One page of the changes since a token. [nextToken] replaces the token once the page is safely stored; [tokenExpired] means the token is
 * too old to use (they last 30 days) and the changes cannot be had: the collector then re-reads the window.
 */
data class HcChanges(val changes: List<HcChange>, val nextToken: String, val hasMore: Boolean, val tokenExpired: Boolean = false)

/**
 * The only door to Health Connect. The real one ([AndroidHealthConnectGateway]) wraps `HealthConnectClient`; tests use a fake that
 * can deliver a record three times, deliver it changed, delete it, and fail, so the collector's rules are tested without a phone.
 */
interface HealthConnectGateway {
    /** A token for "everything from now on" (changes of all the types above). */
    suspend fun changesToken(): String

    suspend fun readPage(type: HcType, from: Instant, to: Instant, pageToken: String?, pageSize: Int): HcPage

    suspend fun changes(token: String): HcChanges
}

/** Where the collector keeps its changes token. It is advanced only after the samples it covers are committed to the queue. */
interface CollectorStateStore {
    /** The token to continue from, or null on the first run. Reading and writing are synchronous (a write is durable when it returns). */
    var token: String?

    /** Which routing rules the queue was last filled under (M30). When it is behind, the collector reads the window again once, so every record is filed under the right patient. */
    var routingEpoch: Int
}
