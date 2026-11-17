package com.aboutobjects.healthgate.queue

import com.aboutobjects.healthgate.ingest.IngestItem
import java.security.MessageDigest

/** What the server is to be told about a queued sample: create it, replace it (an edit), or delete it (decision A11). */
enum class QueueOp(val code: Int) {
    CREATE(0), UPDATE(1), DELETE(2);

    companion object {
        fun of(code: Int): QueueOp = entries.first { it.code == code }
    }
}

/** A row's state. WAITING rows are those still to upload; the others have been answered. */
object RowState {
    const val WAITING = 0
    const val SENT = 1
    const val REJECTED = 2
    const val SKIPPED = 3

    /** A delete the server accepted: the Observation is gone from search. */
    const val DELETED = 4
}

/** What a queue remembers about one key, enough to decide what a new delivery or a deletion means. */
data class RowSnapshot(val state: Int, val op: QueueOp, val content: String, val sentContent: String?)

/** What to do with one row. [Set] replaces the row's state (and, for an upsert, its item and content); attempts and back-off are reset. */
sealed interface RowAction {
    data object Insert : RowAction
    data object Known : RowAction
    data object FlagDuplicate : RowAction
    data object Remove : RowAction
    data class Set(val state: Int, val op: QueueOp, val replaceItem: Boolean) : RowAction
}

/**
 * The one set of rules for what a delivery or a deletion means to a queued sample, used by every queue implementation (the in-memory fake
 * and SQLite), so they cannot differ. Only a Health Connect sample ([updatable]) can change or go away: every other source's sample is
 * create-only and keeps the earlier behaviour exactly (a repeat is known; a repeat of a waiting one is flagged `duplicate-resolved`).
 *
 * "Content" is what the server would hold (value, times, zones, flags, meal, device), not when the app produced it.
 */
object QueueRules {

    fun contentOf(item: IngestItem): String {
        val stored = StoredItem.of(item).copy(issuedMs = 0, lateArrival = false, duplicateResolved = false)
        return MessageDigest.getInstance("SHA-256").digest(stored.encode().toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
    }

    fun onUpsert(existing: RowSnapshot?, content: String, updatable: Boolean): RowAction {
        if (existing == null) return RowAction.Insert
        if (!updatable) return if (existing.state == RowState.WAITING) RowAction.FlagDuplicate else RowAction.Known
        return when (existing.state) {
            RowState.WAITING -> when {
                existing.op == QueueOp.DELETE ->
                    // delivered again before the delete went out: the Observation was never gone, if it is what the server holds
                    if (content == existing.sentContent) RowAction.Set(RowState.SENT, QueueOp.CREATE, replaceItem = true) else RowAction.Set(RowState.WAITING, QueueOp.UPDATE, replaceItem = true)
                content == existing.content -> RowAction.Known
                existing.op == QueueOp.UPDATE && content == existing.sentContent -> RowAction.Set(RowState.SENT, QueueOp.CREATE, replaceItem = true) // the edit was undone
                else -> RowAction.Set(RowState.WAITING, existing.op, replaceItem = true)
            }
            RowState.SENT -> if (content == existing.sentContent) RowAction.Known else RowAction.Set(RowState.WAITING, QueueOp.UPDATE, replaceItem = true)
            RowState.DELETED -> RowAction.Set(RowState.WAITING, QueueOp.CREATE, replaceItem = true) // the identity is back: created again, a new resource
            else -> if (content == existing.content) RowAction.Known else RowAction.Set(RowState.WAITING, QueueOp.CREATE, replaceItem = true) // rejected or skipped, now different
        }
    }

    fun onDelete(existing: RowSnapshot?, updatable: Boolean): RowAction {
        if (existing == null || !updatable) return RowAction.Known
        return when (existing.state) {
            RowState.DELETED -> RowAction.Known
            RowState.REJECTED, RowState.SKIPPED -> RowAction.Remove
            RowState.WAITING -> when {
                existing.op == QueueOp.DELETE -> RowAction.Known
                existing.sentContent == null -> RowAction.Remove // deleted before it was uploaded: nothing is sent, no deletion either
                else -> RowAction.Set(RowState.WAITING, QueueOp.DELETE, replaceItem = false)
            }
            else -> RowAction.Set(RowState.WAITING, QueueOp.DELETE, replaceItem = false)
        }
    }

    /** What a row becomes under a [RowAction.Set]; [newContent] is the incoming delivery's content (an upsert) and unused for a delete. */
    fun next(existing: RowSnapshot, action: RowAction.Set, newContent: String?): RowSnapshot {
        if (!action.replaceItem) return existing.copy(state = action.state, op = action.op)
        val content = newContent!!
        val sent = when {
            action.state == RowState.SENT -> content // the delivery equals what the server holds
            existing.state == RowState.DELETED || existing.state == RowState.REJECTED || existing.state == RowState.SKIPPED -> null // the server holds nothing
            else -> existing.sentContent
        }
        return RowSnapshot(action.state, action.op, content, sent)
    }

    /** How an action is reported: one of added, known, updated, deleted, cancelled. */
    fun tally(action: RowAction): String = when (action) {
        RowAction.Insert -> "added"
        RowAction.Known, RowAction.FlagDuplicate -> "known"
        RowAction.Remove -> "cancelled"
        is RowAction.Set -> when {
            !action.replaceItem -> "deleted"
            action.state == RowState.SENT -> "known"
            action.op == QueueOp.UPDATE -> "updated"
            else -> "added"
        }
    }

    /** What a row becomes when the server has accepted it. */
    fun sent(row: RowSnapshot): RowSnapshot =
        if (row.op == QueueOp.DELETE) row.copy(state = RowState.DELETED, sentContent = null) else row.copy(state = RowState.SENT, sentContent = row.content)

    /** When a row that has just been set may first be sent: a delete waits for [hold]. */
    fun due(op: QueueOp, hold: java.time.Instant?): java.time.Instant = if (op == QueueOp.DELETE) (hold ?: java.time.Instant.EPOCH) else java.time.Instant.EPOCH
}
