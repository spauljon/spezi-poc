package com.aboutobjects.healthgate.queue

import com.aboutobjects.healthgate.ingest.IngestItem
import java.time.Instant

/** A queue held in memory, for tests of everything that uses the queue. It must behave exactly as [SampleQueue] says (see SampleQueueContract). */
class InMemorySampleQueue : SampleQueue {
    private class Row(
        var item: IngestItem, var state: Int = RowState.WAITING, var op: QueueOp = QueueOp.CREATE, var content: String, var sentContent: String? = null,
        var attempts: Int = 0, var nextAttempt: Instant = Instant.EPOCH, var note: String? = null,
    ) {
        fun snapshot() = RowSnapshot(state, op, content, sentContent)
    }

    private val rows = LinkedHashMap<String, Row>()
    private val ledger = LinkedHashMap<String, LedgerEntry>()
    private var nextOrder = 1L

    private fun act(key: String, row: Row?, action: RowAction, item: IngestItem?, hold: Instant?, tally: MutableMap<String, Int>) {
        tally.merge(QueueRules.tally(action), 1, Int::plus)
        when (action) {
            RowAction.Insert -> rows[key] = Row(item!!, content = QueueRules.contentOf(item))
            RowAction.Known -> Unit
            RowAction.FlagDuplicate -> if (!row!!.item.sample.duplicateResolved) row.item = row.item.copy(sample = row.item.sample.copy(duplicateResolved = true))
            RowAction.Remove -> rows.remove(key)
            is RowAction.Set -> {
                val r = row!!
                val newContent = item?.let { QueueRules.contentOf(it) }
                val next = QueueRules.next(r.snapshot(), action, newContent)
                if (action.replaceItem) r.item = item!!
                r.state = next.state; r.op = next.op; r.content = next.content; r.sentContent = next.sentContent
                r.attempts = 0; r.note = null
                r.nextAttempt = QueueRules.due(next.op, hold)
            }
        }
    }

    @Synchronized
    override fun apply(change: ChangeSet): Enqueued {
        val tally = HashMap<String, Int>()
        for (key in change.deleteKeys) {
            val row = rows[key]
            act(key, row, QueueRules.onDelete(row?.snapshot(), row?.item?.updatable ?: false), null, change.holdDeletesUntil, tally)
        }
        for (item in change.upserts) {
            val row = rows[item.key]
            act(item.key, row, QueueRules.onUpsert(row?.snapshot(), QueueRules.contentOf(item), item.updatable), item, null, tally)
        }
        for (e in change.ledgerPut) {
            val old = ledger[e.recordId]
            ledger[e.recordId] = e.copy(order = old?.order ?: nextOrder++)
        }
        change.ledgerRemove.forEach { ledger.remove(it) }
        return Enqueued(tally["added"] ?: 0, tally["known"] ?: 0, tally["updated"] ?: 0, tally["deleted"] ?: 0, tally["cancelled"] ?: 0)
    }

    @Synchronized
    override fun nextBatch(limit: Int, now: Instant): List<QueuedItem> =
        rows.values.filter { it.state == RowState.WAITING && it.nextAttempt <= now }.take(limit).map { QueuedItem(it.item, it.attempts, it.op) }

    @Synchronized
    override fun markSent(keys: List<String>) {
        for (k in keys) rows[k]?.let { r ->
            val next = QueueRules.sent(r.snapshot())
            r.state = next.state; r.sentContent = next.sentContent
        }
    }

    @Synchronized override fun markSkipped(keys: List<String>) { keys.forEach { rows[it]?.state = RowState.SKIPPED } }

    @Synchronized override fun markRejected(key: String, reason: String) { rows[key]?.let { it.state = RowState.REJECTED; it.note = reason } }

    @Synchronized
    override fun recordFailure(keys: List<String>, error: String, retryAt: Instant) {
        for (k in keys) rows[k]?.takeIf { it.state == RowState.WAITING }?.let { it.attempts++; it.nextAttempt = retryAt; it.note = error }
    }

    @Synchronized override fun makeAllDue() { rows.values.filter { it.state == RowState.WAITING }.forEach { it.nextAttempt = Instant.EPOCH } }

    @Synchronized
    override fun counts(): QueueCounts = QueueCounts(
        pending = rows.values.count { it.state == RowState.WAITING }, sent = rows.values.count { it.state == RowState.SENT },
        rejected = rows.values.count { it.state == RowState.REJECTED }, skipped = rows.values.count { it.state == RowState.SKIPPED },
        deleted = rows.values.count { it.state == RowState.DELETED },
    )

    @Synchronized override fun earliestDue(): Instant? = rows.values.filter { it.state == RowState.WAITING }.minOfOrNull { it.nextAttempt }

    @Synchronized
    override fun keysForGroup(group: String): List<String> = rows.entries.filter { (_, r) ->
        r.item.sample.group == group && (r.state == RowState.SENT || r.state == RowState.WAITING && r.op != QueueOp.DELETE)
    }.map { it.key }

    @Synchronized override fun ledgerEntry(recordId: String): LedgerEntry? = ledger[recordId]

    @Synchronized override fun ledgerForContentKey(contentKey: String): List<LedgerEntry> = ledger.values.filter { it.contentKey == contentKey }.sortedBy { it.order }

    @Synchronized override fun ledgerSince(startMs: Long): List<LedgerEntry> = ledger.values.filter { it.startMs >= startMs }.sortedBy { it.order }
}
