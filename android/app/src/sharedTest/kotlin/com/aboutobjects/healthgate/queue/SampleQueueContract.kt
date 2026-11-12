package com.aboutobjects.healthgate.queue

import com.aboutobjects.healthgate.contract.Meal
import com.aboutobjects.healthgate.ingest.IngestItem
import com.aboutobjects.healthgate.mapping.DeviceDescriptor
import com.aboutobjects.healthgate.mapping.Measurement
import com.aboutobjects.healthgate.mapping.MetricSample
import com.aboutobjects.healthgate.mapping.SampleSource
import java.time.Instant
import java.time.ZoneId
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * What every [SampleQueue] must do. It runs against the in-memory fake on the JVM and against the SQLite queue on the phone, so the two
 * cannot drift apart.
 */
abstract class SampleQueueContract {
    protected lateinit var queue: SampleQueue

    abstract fun newQueue(): SampleQueue

    open fun closeQueue() = Unit

    @Before fun open() { queue = newQueue() }

    @After fun close() = closeQueue()

    private val t0 = Instant.parse("2026-03-02T12:00:00Z")

    protected fun item(id: String, value: Double = 72.0, meal: Meal? = null, device: DeviceDescriptor = DeviceDescriptor.Synthetic) = IngestItem(
        MetricSample(Measurement.Quantity("heartRate", value), t0, t0, t0, ZoneId.of("America/Los_Angeles"), SampleSource.SYNTHETIC, id, meal = meal), device,
    )

    @Test fun enqueueAddsAndARepeatIsKnown() {
        assertEquals(Enqueued(2, 0), queue.enqueue(listOf(item("a"), item("b"))))
        assertEquals(Enqueued(1, 1), queue.enqueue(listOf(item("b"), item("c"))))
        assertEquals(QueueCounts(pending = 3), queue.counts())
    }

    @Test fun aRepeatOfAWaitingSampleIsFlaggedDuplicateResolvedOnce() {
        queue.enqueue(listOf(item("a")))
        assertFalse(queue.nextBatch(10, t0).single().item.sample.duplicateResolved)
        queue.enqueue(listOf(item("a")))
        assertTrue(queue.nextBatch(10, t0).single().item.sample.duplicateResolved)
        queue.enqueue(listOf(item("a")))
        assertEquals("still one row", 1, queue.counts().total)
    }

    @Test fun aRepeatOfASentSampleIsKnownAndNotQueuedAgain() {
        queue.enqueue(listOf(item("a")))
        queue.markSent(listOf("synthetic|a"))
        assertEquals(Enqueued(0, 1), queue.enqueue(listOf(item("a"))))
        assertEquals(QueueCounts(sent = 1), queue.counts())
        assertTrue(queue.nextBatch(10, t0).isEmpty())
    }

    @Test fun theBatchIsOldestFirstAndLimited() {
        queue.enqueue((1..5).map { item("s$it") })
        assertEquals(listOf("s1", "s2", "s3"), queue.nextBatch(3, t0).map { it.item.sample.id })
        assertEquals(5, queue.nextBatch(10, t0).size)
    }

    @Test fun aFailedSampleIsNotDueUntilItsRetryTimeAndCountsTheAttempt() {
        queue.enqueue(listOf(item("a"), item("b")))
        val later = t0.plusSeconds(60)
        queue.recordFailure(listOf("synthetic|a"), "HTTP 503", later)
        assertEquals(listOf("b"), queue.nextBatch(10, t0).map { it.item.sample.id })
        val due = queue.nextBatch(10, later)
        assertEquals(listOf("a", "b"), due.map { it.item.sample.id })
        assertEquals(1, due.first { it.item.sample.id == "a" }.attempts)
        assertEquals(0, due.first { it.item.sample.id == "b" }.attempts)
        queue.recordFailure(listOf("synthetic|a"), "HTTP 503", later.plusSeconds(60))
        assertEquals(2, queue.nextBatch(10, later.plusSeconds(60)).first { it.item.sample.id == "a" }.attempts)
    }

    @Test fun sentRejectedAndSkippedLeaveTheBatchAndAreCounted() {
        queue.enqueue(listOf(item("a"), item("b"), item("c"), item("d")))
        queue.markSent(listOf("synthetic|a"))
        queue.markRejected("synthetic|b", "HTTP 422")
        queue.markSkipped(listOf("synthetic|c"))
        assertEquals(QueueCounts(pending = 1, sent = 1, rejected = 1, skipped = 1), queue.counts())
        assertEquals(listOf("d"), queue.nextBatch(10, t0).map { it.item.sample.id })
        // a failure recorded for a sample that is no longer waiting changes nothing
        queue.recordFailure(listOf("synthetic|a"), "late", t0.plusSeconds(10))
        assertEquals(QueueCounts(pending = 1, sent = 1, rejected = 1, skipped = 1), queue.counts())
    }

    @Test fun makeAllDueBringsWaitingSamplesBackNow() {
        queue.enqueue(listOf(item("a")))
        queue.recordFailure(listOf("synthetic|a"), "HTTP 503", t0.plusSeconds(900))
        assertTrue(queue.nextBatch(10, t0).isEmpty())
        queue.makeAllDue()
        assertEquals(1, queue.nextBatch(10, t0).size)
    }

    @Test fun earliestDueIsNullWhenNothingWaits() {
        assertNull(queue.earliestDue())
        queue.enqueue(listOf(item("a")))
        queue.recordFailure(listOf("synthetic|a"), "x", t0.plusSeconds(30))
        assertEquals(t0.plusSeconds(30), queue.earliestDue())
        queue.markSent(listOf("synthetic|a"))
        assertNull(queue.earliestDue())
    }

    @Test fun aStoredSampleComesBackExactly() {
        val full = IngestItem(
            MetricSample(
                Measurement.Quantity("dietaryEnergy", 450.5), t0, t0.plusSeconds(60), t0.plusSeconds(120), ZoneId.of("Asia/Kolkata"), SampleSource.SYNTHETIC, "id-é-1",
                userEntered = true, artifactSuspected = true, lateArrival = true, duplicateResolved = true, meal = Meal("lunch", "Lunch"),
            ),
            DeviceDescriptor.SourceApp("Example App", "com.example.app"),
        )
        val sleep = IngestItem(MetricSample(Measurement.Sleep("asleepDeep"), t0, t0.plusSeconds(2400), t0, ZoneId.of("UTC"), SampleSource.SYNTHETIC, "sl-1"), DeviceDescriptor.Synthetic)
        val watch = item("w-1", device = DeviceDescriptor.HealthKit("Watch", "Maker", "M1", "hw1", "sw2"))
        queue.enqueue(listOf(full, sleep, watch))
        val back = queue.nextBatch(10, t0).map { it.item }
        assertEquals(listOf(full, sleep, watch), back)
    }
}
