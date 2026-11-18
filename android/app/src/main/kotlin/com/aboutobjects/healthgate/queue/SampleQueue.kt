package com.aboutobjects.healthgate.queue

import com.aboutobjects.healthgate.ingest.IngestItem
import java.time.Instant

/** A queued sample, how many times uploading it has failed so far, and what the server is to be told ([op]). */
data class QueuedItem(val item: IngestItem, val attempts: Int, val op: QueueOp = QueueOp.CREATE) {
    val key: String get() = item.key
}

data class QueueCounts(val pending: Int = 0, val sent: Int = 0, val rejected: Int = 0, val skipped: Int = 0, val deleted: Int = 0) {
    val total: Int get() = pending + sent + rejected + skipped + deleted
}

/**
 * [added] keys were new; [known] needed nothing. For a Health Connect sample: [updated] was changed since it was uploaded (an update is
 * now waiting), [deleted] has a delete waiting, [cancelled] was never uploaded and is simply gone, [refiled] is on the server under the
 * wrong patient (its route changed): a delete waits, and the next delivery creates it under the right one.
 */
data class Enqueued(val added: Int, val known: Int, val updated: Int = 0, val deleted: Int = 0, val cancelled: Int = 0, val refiled: Int = 0)

/**
 * What the collector knows about one Health Connect record it has seen: the group its Observations carry (the record id, or a nutrition
 * item's `<content key>#<n>`), its content key (nutrition only) and when it started. [order] is assigned by the queue the first time the
 * record is put and never changes, so a content key's records can be told apart in a stable order.
 */
data class LedgerEntry(val recordId: String, val group: String, val contentKey: String?, val startMs: Long, val order: Long = 0)

/**
 * Everything one hand-off from Health Connect changes, applied in ONE transaction (so the collector can advance its changes token only
 * after this has committed). Order inside: deletions, then upserts, then the ledger. A deletion followed by the same sample delivered
 * again in one change set therefore cancels out.
 */
data class ChangeSet(
    val upserts: List<IngestItem> = emptyList(),
    val deleteKeys: List<String> = emptyList(),
    /** When a deletion may first be sent (a grace period, so a delete and its re-created twin arriving apart do not churn the server). */
    val holdDeletesUntil: Instant? = null,
    val ledgerPut: List<LedgerEntry> = emptyList(),
    val ledgerRemove: List<String> = emptyList(),
)

/**
 * The durable upload queue. A sample is queued once (its key is source and id) and uploaded when the server accepts it. A synthetic or
 * HealthKit-style sample is never re-sent: a repeated key is "known". A Health Connect sample can also change (an update waits) or go
 * away (a delete waits): see [QueueRules]. The calls are plain blocking functions; the engine runs them off the main thread.
 */
interface SampleQueue {
    /** Applies one hand-off in one transaction. */
    fun apply(change: ChangeSet): Enqueued

    /** Adds the items (an [apply] of upserts only). */
    fun enqueue(items: List<IngestItem>): Enqueued = apply(ChangeSet(upserts = items))

    /** Waiting samples whose retry time has come, oldest first, leaving out the routes in [excludeRoutes] (a route with no patient configured is held, never sent). */
    fun nextBatch(limit: Int, now: Instant, excludeRoutes: Set<String> = emptySet()): List<QueuedItem>

    /** How many samples of this route wait to be sent (a route held for want of a patient shows here). */
    fun pendingCount(route: String): Int

    /** The server accepted these: an upload or update is done; a delete is done and the sample is gone. */
    fun markSent(keys: List<String>)

    /** A valid sample that deliberately produces no resource (`inBed`): nothing to upload. */
    fun markSkipped(keys: List<String>)

    /** A sample the server or the mapper refused: it can never upload as it is. */
    fun markRejected(key: String, reason: String)

    /** The upload failed for a reason that may pass: try again at [retryAt]. */
    fun recordFailure(keys: List<String>, error: String, retryAt: Instant)

    /** Makes every waiting sample due now (the user asked to sync). */
    fun makeAllDue()

    fun counts(): QueueCounts

    /** When the earliest waiting sample is next due, or null when none waits. */
    fun earliestDue(): Instant?

    /** The keys of the samples of this group that exist on the server or will (not rejected, skipped, deleted or about to be deleted). */
    fun keysForGroup(group: String): List<String>

    fun ledgerEntry(recordId: String): LedgerEntry?

    /** The records with this content key, in the order they were first seen. */
    fun ledgerForContentKey(contentKey: String): List<LedgerEntry>

    /** The records that started at or after [startMs] (what a window re-read must account for). */
    fun ledgerSince(startMs: Long): List<LedgerEntry>
}
