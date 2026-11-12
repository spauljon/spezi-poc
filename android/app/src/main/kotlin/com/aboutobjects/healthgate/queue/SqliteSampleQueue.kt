package com.aboutobjects.healthgate.queue

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import com.aboutobjects.healthgate.ingest.IngestItem
import java.time.Instant

/**
 * The upload queue in the app's private SQLite database (no extra library: plain `SQLiteOpenHelper`). One row per sample key;
 * [state] 0 waiting, 1 sent, 2 rejected, 3 skipped. The database lives in app-private storage and the app does not back it up
 * (`allowBackup=false`), so samples are never copied off the phone except by the uploader.
 */
class SqliteSampleQueue(context: Context, name: String? = "samples.db") : SampleQueue {
    private val helper = object : SQLiteOpenHelper(context, name, null, VERSION) {
        override fun onCreate(db: SQLiteDatabase) {
            db.execSQL(
                "CREATE TABLE samples (" +
                    "seq INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL UNIQUE, item TEXT NOT NULL, " +
                    "state INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0, next_attempt INTEGER NOT NULL DEFAULT 0, note TEXT)",
            )
            db.execSQL("CREATE INDEX samples_due ON samples (state, next_attempt, seq)")
        }

        override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) = Unit
    }

    private val db: SQLiteDatabase get() = helper.writableDatabase

    @Synchronized
    override fun enqueue(items: List<IngestItem>): Enqueued {
        var added = 0
        var known = 0
        db.beginTransaction()
        try {
            for (item in items) {
                val values = ContentValues().apply {
                    put("key", item.key)
                    put("item", StoredItem.of(item).encode())
                }
                if (db.insertWithOnConflict("samples", null, values, SQLiteDatabase.CONFLICT_IGNORE) != -1L) {
                    added++
                } else {
                    known++
                    flagDuplicate(item.key)
                }
            }
            db.setTransactionSuccessful()
        } finally {
            db.endTransaction()
        }
        return Enqueued(added, known)
    }

    /** A second delivery of a sample that is still waiting: one Observation will result, tagged `duplicate-resolved`. */
    private fun flagDuplicate(key: String) {
        db.rawQuery("SELECT item FROM samples WHERE key = ? AND state = 0", arrayOf(key)).use { c ->
            if (!c.moveToFirst()) return
            val stored = StoredItem.decode(c.getString(0))
            if (stored.duplicateResolved) return
            val values = ContentValues().apply { put("item", stored.copy(duplicateResolved = true).encode()) }
            db.update("samples", values, "key = ?", arrayOf(key))
        }
    }

    @Synchronized
    override fun nextBatch(limit: Int, now: Instant): List<QueuedItem> {
        val out = ArrayList<QueuedItem>()
        db.rawQuery(
            "SELECT item, attempts FROM samples WHERE state = 0 AND next_attempt <= ? ORDER BY seq LIMIT ?",
            arrayOf(now.toEpochMilli().toString(), limit.toString()),
        ).use { c ->
            while (c.moveToNext()) out.add(QueuedItem(StoredItem.decode(c.getString(0)).toItem(), c.getInt(1)))
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

    @Synchronized override fun markSent(keys: List<String>) = setState(keys, 1)

    @Synchronized override fun markSkipped(keys: List<String>) = setState(keys, 3)

    @Synchronized override fun markRejected(key: String, reason: String) = setState(listOf(key), 2, reason)

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
                    0 -> counts.copy(pending = n)
                    1 -> counts.copy(sent = n)
                    2 -> counts.copy(rejected = n)
                    3 -> counts.copy(skipped = n)
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

    fun close() = helper.close()

    private companion object {
        const val VERSION = 1
    }
}
