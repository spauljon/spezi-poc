package com.aboutobjects.healthgate.queue

import android.content.ContentValues
import android.database.sqlite.SQLiteDatabase
import androidx.test.platform.app.InstrumentationRegistry
import com.aboutobjects.healthgate.ingest.IngestItem
import com.aboutobjects.healthgate.mapping.DeviceDescriptor
import com.aboutobjects.healthgate.mapping.Measurement
import com.aboutobjects.healthgate.mapping.MetricSample
import com.aboutobjects.healthgate.mapping.SampleSource
import java.time.Instant
import java.time.ZoneId
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Test

/** The phone holds a version-1 database from M26. Opening it with this build must keep every queued sample and add the new abilities. */
class SqliteMigrationTest {
    private val context = InstrumentationRegistry.getInstrumentation().targetContext
    private val name = "migration-test-${System.nanoTime()}.db"
    private val t0 = Instant.parse("2026-03-02T12:00:00Z")

    @After fun cleanUp() { context.deleteDatabase(name) }

    private fun item(id: String) = IngestItem(
        MetricSample(Measurement.Quantity("heartRate", 72.0), t0, t0, t0, ZoneId.of("UTC"), SampleSource.SYNTHETIC, id), DeviceDescriptor.Synthetic,
    )

    @Test fun aVersionOneDatabaseOpensKeepsItsRowsAndGainsTheNewColumns() {
        val path = context.getDatabasePath(name)
        path.parentFile?.mkdirs()
        SQLiteDatabase.openOrCreateDatabase(path, null).use { db ->
            db.execSQL(
                "CREATE TABLE samples (seq INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL UNIQUE, item TEXT NOT NULL, " +
                    "state INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0, next_attempt INTEGER NOT NULL DEFAULT 0, note TEXT)",
            )
            db.execSQL("CREATE INDEX samples_due ON samples (state, next_attempt, seq)")
            for ((id, state) in listOf("waiting" to 0, "sent" to 1)) {
                val i = item(id)
                db.insert("samples", null, ContentValues().apply { put("key", i.key); put("item", StoredItem.of(i).encode()); put("state", state) })
            }
            db.version = 1
        }
        val queue = SqliteSampleQueue(context, name)
        try {
            assertEquals(QueueCounts(pending = 1, sent = 1), queue.counts())
            val due = queue.nextBatch(10, t0).single()
            assertEquals("waiting", due.item.sample.id)
            assertEquals(QueueOp.CREATE, due.op)
            // a repeat of the old rows is still known (the old behaviour), and a new Health Connect sample can be queued, changed and deleted
            assertEquals(Enqueued(0, 1), queue.enqueue(listOf(item("sent"))))
            val hc = IngestItem(
                MetricSample(Measurement.Quantity("heartRate", 70.0), t0, t0, t0, ZoneId.of("UTC"), SampleSource.HEALTH_CONNECT, "h1", group = "rec"),
                DeviceDescriptor.OriginApp("com.example.writer"),
            )
            queue.enqueue(listOf(hc))
            queue.markSent(listOf(hc.key))
            assertEquals(listOf(hc.key), queue.keysForGroup("rec"))
            assertEquals(Enqueued(0, 0, deleted = 1), queue.apply(ChangeSet(deleteKeys = listOf(hc.key))))
        } finally {
            queue.close()
        }
    }

    @Test fun aVersionTwoDatabaseGainsTheRouteColumnAndItsRowsAreTestRows() {
        val path = context.getDatabasePath(name)
        path.parentFile?.mkdirs()
        SQLiteDatabase.openOrCreateDatabase(path, null).use { db ->
            db.execSQL(
                "CREATE TABLE samples (seq INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL UNIQUE, item TEXT NOT NULL, " +
                    "state INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0, next_attempt INTEGER NOT NULL DEFAULT 0, note TEXT, " +
                    "op INTEGER NOT NULL DEFAULT 0, content TEXT NOT NULL DEFAULT '', sent_content TEXT, grp TEXT)",
            )
            db.execSQL("CREATE TABLE hc_ledger (record_id TEXT PRIMARY KEY, grp TEXT NOT NULL, content_key TEXT, start_ms INTEGER NOT NULL, ord INTEGER NOT NULL)")
            val i = item("old")
            db.insert("samples", null, ContentValues().apply { put("key", i.key); put("item", StoredItem.of(i).encode()); put("state", 1) })
            db.version = 2
        }
        val queue = SqliteSampleQueue(context, name)
        try {
            assertEquals(QueueCounts(sent = 1), queue.counts())
            assertEquals("an older row is a test row until it is delivered again", 0, queue.pendingCount("real"))
            val real = item("new").copy(route = com.aboutobjects.healthgate.ingest.PatientRoute.REAL)
            queue.enqueue(listOf(real))
            assertEquals(1, queue.pendingCount("real"))
            assertEquals(emptyList<String>(), queue.nextBatch(10, t0, setOf("real")).map { it.item.sample.id })
            assertEquals(listOf("new"), queue.nextBatch(10, t0).map { it.item.sample.id })
        } finally {
            queue.close()
        }
    }
}
