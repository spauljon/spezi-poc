package com.aboutobjects.healthgate.queue

import com.aboutobjects.healthgate.ingest.IngestItem
import java.time.Instant

/** A queue held in memory, for tests of everything that uses the queue. It must behave exactly as [SampleQueue] says (see SampleQueueContract). */
class InMemorySampleQueue : SampleQueue {
    private class Row(var item: IngestItem, var state: Int = 0, var attempts: Int = 0, var nextAttempt: Instant = Instant.EPOCH, var note: String? = null)

    private val rows = LinkedHashMap<String, Row>()

    @Synchronized
    override fun enqueue(items: List<IngestItem>): Enqueued {
        var added = 0
        var known = 0
        for (item in items) {
            val existing = rows[item.key]
            if (existing == null) {
                rows[item.key] = Row(item)
                added++
            } else {
                known++
                if (existing.state == 0 && !existing.item.sample.duplicateResolved) {
                    existing.item = existing.item.copy(sample = existing.item.sample.copy(duplicateResolved = true))
                }
            }
        }
        return Enqueued(added, known)
    }

    @Synchronized
    override fun nextBatch(limit: Int, now: Instant): List<QueuedItem> =
        rows.values.filter { it.state == 0 && it.nextAttempt <= now }.take(limit).map { QueuedItem(it.item, it.attempts) }

    @Synchronized override fun markSent(keys: List<String>) { keys.forEach { rows[it]?.state = 1 } }

    @Synchronized override fun markSkipped(keys: List<String>) { keys.forEach { rows[it]?.state = 3 } }

    @Synchronized override fun markRejected(key: String, reason: String) { rows[key]?.let { it.state = 2; it.note = reason } }

    @Synchronized
    override fun recordFailure(keys: List<String>, error: String, retryAt: Instant) {
        for (k in keys) rows[k]?.takeIf { it.state == 0 }?.let { it.attempts++; it.nextAttempt = retryAt; it.note = error }
    }

    @Synchronized override fun makeAllDue() { rows.values.filter { it.state == 0 }.forEach { it.nextAttempt = Instant.EPOCH } }

    @Synchronized
    override fun counts(): QueueCounts = QueueCounts(
        pending = rows.values.count { it.state == 0 }, sent = rows.values.count { it.state == 1 },
        rejected = rows.values.count { it.state == 2 }, skipped = rows.values.count { it.state == 3 },
    )

    @Synchronized override fun earliestDue(): Instant? = rows.values.filter { it.state == 0 }.minOfOrNull { it.nextAttempt }
}
