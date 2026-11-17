package com.aboutobjects.healthgate.queue

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import com.aboutobjects.healthgate.ingest.IngestItem
import java.time.Instant

/**
 * The upload queue in the app's private SQLite database (no extra library: plain `SQLiteOpenHelper`). One row per sample key; see
 * [RowState] for `state` and [QueueOp] for `op`. The rules for what a delivery or a deletion does to a row are [QueueRules], shared with
 * the in-memory fake, so the two cannot differ. A second table, `hc_ledger`, remembers the Health Connect records seen, and is written
 * in the same transaction as the samples. The database lives in app-private storage and the app does not back it up
 * (`allowBackup=false`), so samples are never copied off the phone except by the uploader.
 */
class SqliteSampleQueue(context: Context, name: String? = "samples.db") : SampleQueue {
    private val helper = object : SQLiteOpenHelper(context, name, null, VERSION) {
        override fun onCreate(db: SQLiteDatabase) {
            db.execSQL(
                "CREATE TABLE samples (" +
                    "seq INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL UNIQUE, item TEXT NOT NULL, " +
                    "state INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0, next_attempt INTEGER NOT NULL DEFAULT 0, note TEXT, " +
                    "op INTEGER NOT NULL DEFAULT 0, content TEXT NOT NULL DEFAULT '', sent_content TEXT, grp TEXT)",
            )
            db.execSQL("CREATE INDEX samples_due ON samples (state, next_attempt, seq)")
            db.execSQL("CREATE INDEX samples_group ON samples (grp)")
            createLedger(db)
        }

        override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
            if (oldVersion < 2) {
                // version 2 (M27): update and delete operations, content for change detection, the group, and the ledger
                db.execSQL("ALTER TABLE samples ADD COLUMN op INTEGER NOT NULL DEFAULT 0")
                db.execSQL("ALTER TABLE samples ADD COLUMN content TEXT NOT NULL DEFAULT ''")
                db.execSQL("ALTER TABLE samples ADD COLUMN sent_content TEXT")
                db.execSQL("ALTER TABLE samples ADD COLUMN grp TEXT")
                db.execSQL("CREATE INDEX samples_group ON samples (grp)")
                createLedger(db)
            }
        }

        private fun createLedger(db: SQLiteDatabase) {
            db.execSQL(
                "CREATE TABLE hc_ledger (record_id TEXT PRIMARY KEY, grp TEXT NOT NULL, content_key TEXT, start_ms INTEGER NOT NULL, ord INTEGER NOT NULL)",
            )
            db.execSQL("CREATE INDEX hc_ledger_content ON hc_ledger (content_key, ord)")
        }
    }

    private val db: SQLiteDatabase get() = helper.writableDatabase

    private class Stored(val seq: Long, val item: IngestItem, val snapshot: RowSnapshot)

    private fun find(key: String): Stored? =
        db.rawQuery("SELECT seq, item, state, op, content, sent_content FROM samples WHERE key = ?", arrayOf(key)).use { c ->
            if (!c.moveToFirst()) null
            else Stored(
                c.getLong(0), StoredItem.decode(c.getString(1)).toItem(),
                RowSnapshot(c.getInt(2), QueueOp.of(c.getInt(3)), c.getString(4), if (c.isNull(5)) null else c.getString(5)),
            )
        }

    private fun act(key: String, row: Stored?, action: RowAction, item: IngestItem?, hold: Instant?, tally: MutableMap<String, Int>) {
        tally.merge(QueueRules.tally(action), 1, Int::plus)
        when (action) {
            RowAction.Insert -> {
                val values = ContentValues().apply {
                    put("key", key)
                    put("item", StoredItem.of(item!!).encode())
                    put("content", QueueRules.contentOf(item))
                    put("grp", item.sample.group)
                }
                db.insertOrThrow("samples", null, values)
            }
            RowAction.Known -> Unit
            RowAction.FlagDuplicate -> {
                // a second delivery of a sample that is still waiting: one Observation will result, tagged `duplicate-resolved`
                val stored = StoredItem.of(row!!.item)
                if (!stored.duplicateResolved) {
                    db.update("samples", ContentValues().apply { put("item", stored.copy(duplicateResolved = true).encode()) }, "key = ?", arrayOf(key))
                }
            }
            RowAction.Remove -> db.delete("samples", "key = ?", arrayOf(key))
            is RowAction.Set -> {
                val next = QueueRules.next(row!!.snapshot, action, item?.let { QueueRules.contentOf(it) })
                val values = ContentValues().apply {
                    if (action.replaceItem) {
                        put("item", StoredItem.of(item!!).encode())
                        put("grp", item.sample.group)
                    }
                    put("state", next.state)
                    put("op", next.op.code)
                    put("content", next.content)
                    put("sent_content", next.sentContent)
                    put("attempts", 0)
                    put("note", null as String?)
                    put("next_attempt", QueueRules.due(next.op, hold).toEpochMilli())
                }
                db.update("samples", values, "key = ?", arrayOf(key))
            }
        }
    }

    @Synchronized
    override fun apply(change: ChangeSet): Enqueued {
        val tally = HashMap<String, Int>()
        db.beginTransaction()
        try {
            for (key in change.deleteKeys) {
                val row = find(key)
                act(key, row, QueueRules.onDelete(row?.snapshot, row?.item?.updatable ?: false), null, change.holdDeletesUntil, tally)
            }
            for (item in change.upserts) {
                val row = find(item.key)
                act(item.key, row, QueueRules.onUpsert(row?.snapshot, QueueRules.contentOf(item), item.updatable), item, null, tally)
            }
            for (e in change.ledgerPut) putLedger(e)
            for (id in change.ledgerRemove) db.delete("hc_ledger", "record_id = ?", arrayOf(id))
            db.setTransactionSuccessful()
        } finally {
            db.endTransaction()
        }
        return Enqueued(tally["added"] ?: 0, tally["known"] ?: 0, tally["updated"] ?: 0, tally["deleted"] ?: 0, tally["cancelled"] ?: 0)
    }

    private fun putLedger(e: LedgerEntry) {
        val order = db.rawQuery("SELECT ord FROM hc_ledger WHERE record_id = ?", arrayOf(e.recordId)).use { c ->
            if (c.moveToFirst()) c.getLong(0)
            else db.rawQuery("SELECT COALESCE(MAX(ord), 0) + 1 FROM hc_ledger", null).use { m -> m.moveToFirst(); m.getLong(0) }
        }
        val values = ContentValues().apply {
            put("record_id", e.recordId); put("grp", e.group); put("content_key", e.contentKey); put("start_ms", e.startMs); put("ord", order)
        }
        db.insertWithOnConflict("hc_ledger", null, values, SQLiteDatabase.CONFLICT_REPLACE)
    }

    @Synchronized
    override fun nextBatch(limit: Int, now: Instant): List<QueuedItem> {
        val out = ArrayList<QueuedItem>()
        db.rawQuery(
            "SELECT item, attempts, op FROM samples WHERE state = 0 AND next_attempt <= ? ORDER BY seq LIMIT ?",
            arrayOf(now.toEpochMilli().toString(), limit.toString()),
        ).use { c ->
            while (c.moveToNext()) out.add(QueuedItem(StoredItem.decode(c.getString(0)).toItem(), c.getInt(1), QueueOp.of(c.getInt(2))))
        }
        return out
    }

    private fun setState(keys: List<String>, state: Int, note: String? = null) {
        db.beginTransaction()
        try {
            for (key in keys) {
                val values = ContentValues().apply { put("state", state); put("note", note) }
                db.update("samples", values, "key = ?", arrayOf(key))
            }
            db.setTransactionSuccessful()
        } finally {
            db.endTransaction()
        }
    }

    @Synchronized
    override fun markSent(keys: List<String>) {
        db.beginTransaction()
        try {
            for (key in keys) {
                val row = find(key) ?: continue
                val next = QueueRules.sent(row.snapshot)
                val values = ContentValues().apply { put("state", next.state); put("sent_content", next.sentContent); put("note", null as String?) }
                db.update("samples", values, "key = ?", arrayOf(key))
            }
            db.setTransactionSuccessful()
        } finally {
            db.endTransaction()
        }
    }

    @Synchronized override fun markSkipped(keys: List<String>) = setState(keys, RowState.SKIPPED)

    @Synchronized override fun markRejected(key: String, reason: String) = setState(listOf(key), RowState.REJECTED, reason)

    @Synchronized
    override fun recordFailure(keys: List<String>, error: String, retryAt: Instant) {
        db.beginTransaction()
        try {
            for (key in keys) {
                db.execSQL("UPDATE samples SET attempts = attempts + 1, next_attempt = ?, note = ? WHERE key = ? AND state = 0",
                    arrayOf(retryAt.toEpochMilli(), error, key))
            }
            db.setTransactionSuccessful()
        } finally {
            db.endTransaction()
        }
    }

    @Synchronized override fun makeAllDue() = db.execSQL("UPDATE samples SET next_attempt = 0 WHERE state = 0")

    @Synchronized
    override fun counts(): QueueCounts {
        var counts = QueueCounts()
        db.rawQuery("SELECT state, COUNT(*) FROM samples GROUP BY state", null).use { c ->
            while (c.moveToNext()) {
                val n = c.getInt(1)
                counts = when (c.getInt(0)) {
                    RowState.WAITING -> counts.copy(pending = n)
                    RowState.SENT -> counts.copy(sent = n)
                    RowState.REJECTED -> counts.copy(rejected = n)
                    RowState.SKIPPED -> counts.copy(skipped = n)
                    RowState.DELETED -> counts.copy(deleted = n)
                    else -> counts
                }
            }
        }
        return counts
    }

    @Synchronized
    override fun earliestDue(): Instant? =
        db.rawQuery("SELECT MIN(next_attempt) FROM samples WHERE state = 0", null).use { c ->
            if (c.moveToFirst() && !c.isNull(0)) Instant.ofEpochMilli(c.getLong(0)) else null
        }

    @Synchronized
    override fun keysForGroup(group: String): List<String> =
        db.rawQuery("SELECT key FROM samples WHERE grp = ? AND (state = 1 OR (state = 0 AND op <> 2)) ORDER BY seq", arrayOf(group)).use { c ->
            buildList { while (c.moveToNext()) add(c.getString(0)) }
        }

    private fun ledgerRows(sql: String, args: Array<String>): List<LedgerEntry> =
        db.rawQuery(sql, args).use { c ->
            buildList { while (c.moveToNext()) add(LedgerEntry(c.getString(0), c.getString(1), if (c.isNull(2)) null else c.getString(2), c.getLong(3), c.getLong(4))) }
        }

    @Synchronized
    override fun ledgerEntry(recordId: String): LedgerEntry? =
        ledgerRows("SELECT record_id, grp, content_key, start_ms, ord FROM hc_ledger WHERE record_id = ?", arrayOf(recordId)).firstOrNull()

    @Synchronized
    override fun ledgerForContentKey(contentKey: String): List<LedgerEntry> =
        ledgerRows("SELECT record_id, grp, content_key, start_ms, ord FROM hc_ledger WHERE content_key = ? ORDER BY ord", arrayOf(contentKey))

    @Synchronized
    override fun ledgerSince(startMs: Long): List<LedgerEntry> =
        ledgerRows("SELECT record_id, grp, content_key, start_ms, ord FROM hc_ledger WHERE start_ms >= ? ORDER BY ord", arrayOf(startMs.toString()))

    fun close() = helper.close()

    private companion object {
        const val VERSION = 2
    }
}
