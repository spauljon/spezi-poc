package com.aboutobjects.healthgate.queue

import com.aboutobjects.healthgate.ingest.IngestItem
import java.time.Instant

/** A queued sample, and how many times uploading it has failed so far. */
data class QueuedItem(val item: IngestItem, val attempts: Int) {
    val key: String get() = item.key
}

data class QueueCounts(val pending: Int = 0, val sent: Int = 0, val rejected: Int = 0, val skipped: Int = 0) {
    val total: Int get() = pending + sent + rejected + skipped
}

/** [added] keys were new; [known] were already in the queue in any state. */
data class Enqueued(val added: Int, val known: Int)

/**
 * The durable upload queue. A sample is queued once (its key is source and id), uploaded when the server accepts it, and never
 * re-sent: a repeated key is "known". The calls are plain blocking functions; the engine runs them off the main thread.
 */
interface SampleQueue {
    /**
     * Adds the items. A key already waiting to upload is not added again: it is flagged `duplicateResolved` (contract rule: two
     * deliveries met in the queue before upload). A key that was already sent, rejected or skipped is only counted as known.
     */
    fun enqueue(items: List<IngestItem>): Enqueued

    /** Waiting samples whose retry time has come, oldest first. */
    fun nextBatch(limit: Int, now: Instant): List<QueuedItem>

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
}
