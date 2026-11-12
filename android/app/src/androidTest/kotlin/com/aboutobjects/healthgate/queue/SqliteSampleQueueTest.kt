package com.aboutobjects.healthgate.queue

import androidx.test.platform.app.InstrumentationRegistry
import java.time.Instant
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** The queue contract, run against the real SQLite queue on the device, plus what only a real database can show (it survives a reopen). */
class SqliteSampleQueueTest : SampleQueueContract() {
    private val context = InstrumentationRegistry.getInstrumentation().targetContext
    private val dbName = "queue-test-${System.nanoTime()}.db"
    private var current: SqliteSampleQueue? = null

    override fun newQueue(): SampleQueue = SqliteSampleQueue(context, dbName).also { current = it }

    override fun closeQueue() {
        current?.close()
        context.deleteDatabase(dbName)
    }

    @Test fun whatWasQueuedSurvivesClosingAndReopeningTheDatabase() {
        queue.enqueue(listOf(item("keep-1"), item("keep-2", meal = com.aboutobjects.healthgate.contract.Meal("lunch", "Lunch"))))
        queue.markSent(listOf("synthetic|keep-1"))
        queue.recordFailure(listOf("synthetic|keep-2"), "HTTP 503", Instant.parse("2026-03-02T12:05:00Z"))
        current!!.close()
        val reopened = SqliteSampleQueue(context, dbName)
        try {
            assertEquals(QueueCounts(pending = 1, sent = 1), reopened.counts())
            val due = reopened.nextBatch(10, Instant.parse("2026-03-02T12:10:00Z")).single()
            assertEquals("keep-2", due.item.sample.id)
            assertEquals("the attempt count survived", 1, due.attempts)
            assertEquals("lunch", due.item.sample.meal?.code)
        } finally {
            reopened.close()
        }
    }

    @Test fun aTwoThousandSampleBatchIsStoredAndReadBackInOrder() {
        val items = (1..2000).map { item("bulk-%05d".format(it)) }
        assertEquals(Enqueued(2000, 0), queue.enqueue(items))
        val first = queue.nextBatch(100, Instant.parse("2026-03-02T12:00:00Z"))
        assertEquals(100, first.size)
        assertEquals("bulk-00001", first.first().item.sample.id)
        assertTrue(queue.counts().pending == 2000)
    }
}
