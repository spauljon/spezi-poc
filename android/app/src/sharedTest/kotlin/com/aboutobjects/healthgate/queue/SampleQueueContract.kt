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

    // ---- Health Connect samples (decision A11): they can change and go away ----

    protected fun hc(id: String, value: Double = 72.0, group: String = "rec-1", zone: String = "America/Los_Angeles", endZone: String? = null) = IngestItem(
        MetricSample(
            Measurement.Quantity("heartRate", value), t0, t0, t0, ZoneId.of(zone), SampleSource.HEALTH_CONNECT, id, group = group,
            endTimeZone = endZone?.let { ZoneId.of(it) },
        ),
        DeviceDescriptor.OriginApp("com.example.writer"),
    )

    private val k = "healthConnect|"

    @Test fun aHealthConnectSampleStoredComesBackExactly() {
        val a = hc("a", group = "g-1", zone = "-08:00", endZone = "+09:00")
        val device = hc("b").copy(device = DeviceDescriptor.HealthConnectDevice("Example Corp", "Band 2", "fitness_band"))
        queue.enqueue(listOf(a, device))
        assertEquals(listOf(a, device), queue.nextBatch(10, t0).map { it.item })
    }

    @Test fun anUnchangedRedeliveryIsKnownAndNeverFlaggedAsADuplicate() {
        queue.enqueue(listOf(hc("a")))
        assertEquals(Enqueued(0, 1), queue.enqueue(listOf(hc("a"))))
        assertFalse("a Health Connect redelivery is normal, not two deliveries of one sample", queue.nextBatch(10, t0).single().item.sample.duplicateResolved)
        queue.markSent(listOf(k + "a"))
        assertEquals(Enqueued(0, 1), queue.enqueue(listOf(hc("a"))))
        assertEquals(QueueCounts(sent = 1), queue.counts())
        // when only the production time differs it is still the same content
        assertEquals(Enqueued(0, 1), queue.enqueue(listOf(hc("a").let { it.copy(sample = it.sample.copy(issued = t0.plusSeconds(999), lateArrival = true)) })))
    }

    @Test fun aChangedValueAfterUploadWaitsAsAnUpdateAndIsDoneOnceSent() {
        queue.enqueue(listOf(hc("a", 72.0)))
        queue.markSent(listOf(k + "a"))
        assertEquals(Enqueued(0, 0, updated = 1), queue.enqueue(listOf(hc("a", 75.0))))
        val due = queue.nextBatch(10, t0).single()
        assertEquals(QueueOp.UPDATE, due.op)
        assertEquals(Measurement.Quantity("heartRate", 75.0), due.item.sample.measurement)
        queue.markSent(listOf(k + "a"))
        assertEquals(QueueCounts(sent = 1), queue.counts())
        assertEquals("the same value again is known", Enqueued(0, 1), queue.enqueue(listOf(hc("a", 75.0))))
    }

    @Test fun anEditThatIsUndoneBeforeItIsSentCancelsTheUpdate() {
        queue.enqueue(listOf(hc("a", 72.0)))
        queue.markSent(listOf(k + "a"))
        queue.enqueue(listOf(hc("a", 75.0)))
        assertEquals(QueueOp.UPDATE, queue.nextBatch(10, t0).single().op)
        queue.enqueue(listOf(hc("a", 72.0)))
        assertEquals(QueueCounts(sent = 1), queue.counts())
        assertTrue(queue.nextBatch(10, t0).isEmpty())
    }

    @Test fun aChangeToASampleStillWaitingReplacesItAndStaysACreate() {
        queue.enqueue(listOf(hc("a", 72.0)))
        queue.enqueue(listOf(hc("a", 80.0)))
        val due = queue.nextBatch(10, t0).single()
        assertEquals(QueueOp.CREATE, due.op)
        assertEquals(Measurement.Quantity("heartRate", 80.0), due.item.sample.measurement)
        assertEquals(1, queue.counts().total)
    }

    @Test fun aDeleteAfterUploadWaitsAndIsDoneOnceSentThenIsKnown() {
        queue.enqueue(listOf(hc("a")))
        queue.markSent(listOf(k + "a"))
        assertEquals(Enqueued(0, 0, deleted = 1), queue.apply(ChangeSet(deleteKeys = listOf(k + "a"))))
        assertEquals(QueueOp.DELETE, queue.nextBatch(10, t0).single().op)
        queue.markSent(listOf(k + "a"))
        assertEquals(QueueCounts(deleted = 1), queue.counts())
        assertEquals("deleting what is deleted needs nothing", Enqueued(0, 1), queue.apply(ChangeSet(deleteKeys = listOf(k + "a"))))
        assertTrue(queue.nextBatch(10, t0).isEmpty())
    }

    @Test fun aDeleteBeforeUploadSendsNothingAtAll() {
        queue.enqueue(listOf(hc("a"), hc("b")))
        assertEquals(Enqueued(0, 0, cancelled = 1), queue.apply(ChangeSet(deleteKeys = listOf(k + "a"))))
        assertEquals("the sample is simply gone, no deletion is queued", listOf("b"), queue.nextBatch(10, t0).map { it.item.sample.id })
        assertEquals(QueueCounts(pending = 1), queue.counts())
        assertEquals("a delete for something never seen needs nothing", Enqueued(0, 1), queue.apply(ChangeSet(deleteKeys = listOf(k + "never"))))
    }

    @Test fun aDeletionIsHeldUntilItsGracePeriodEnds() {
        queue.enqueue(listOf(hc("a")))
        queue.markSent(listOf(k + "a"))
        queue.apply(ChangeSet(deleteKeys = listOf(k + "a"), holdDeletesUntil = t0.plusSeconds(300)))
        assertTrue(queue.nextBatch(10, t0).isEmpty())
        assertEquals(t0.plusSeconds(300), queue.earliestDue())
        assertEquals(QueueOp.DELETE, queue.nextBatch(10, t0.plusSeconds(300)).single().op)
    }

    @Test fun aDeletionAndTheSameSampleDeliveredAgainInOneChangeCancelOut() {
        queue.enqueue(listOf(hc("a")))
        queue.markSent(listOf(k + "a"))
        assertEquals(Enqueued(0, 1, deleted = 1), queue.apply(ChangeSet(deleteKeys = listOf(k + "a"), upserts = listOf(hc("a")))))
        assertEquals(QueueCounts(sent = 1), queue.counts())
        assertTrue("nothing is sent", queue.nextBatch(10, t0).isEmpty())
        // the control: a deletion followed by a DIFFERENT delivery is an update, not a cancellation
        queue.apply(ChangeSet(deleteKeys = listOf(k + "a"), upserts = listOf(hc("a", 99.0))))
        assertEquals(QueueOp.UPDATE, queue.nextBatch(10, t0).single().op)
    }

    @Test fun aDeletedSampleDeliveredAgainIsCreatedAgain() {
        queue.enqueue(listOf(hc("a")))
        queue.markSent(listOf(k + "a"))
        queue.apply(ChangeSet(deleteKeys = listOf(k + "a")))
        queue.markSent(listOf(k + "a"))
        assertEquals(Enqueued(1, 0), queue.enqueue(listOf(hc("a"))))
        assertEquals(QueueOp.CREATE, queue.nextBatch(10, t0).single().op)
    }

    @Test fun onlyAHealthConnectSampleCanBeDeletedOrUpdated() {
        queue.enqueue(listOf(item("s")))
        queue.markSent(listOf("synthetic|s"))
        assertEquals(Enqueued(0, 1), queue.apply(ChangeSet(deleteKeys = listOf("synthetic|s"))))
        assertEquals("a synthetic sample with another value is still just known", Enqueued(0, 1), queue.enqueue(listOf(item("s", 99.0))))
        assertEquals(QueueCounts(sent = 1), queue.counts())
        assertTrue(queue.nextBatch(10, t0).isEmpty())
    }

    @Test fun aGroupListsTheSamplesThatExistOrWillAndNoOthers() {
        queue.enqueue(listOf(hc("a", group = "g"), hc("b", group = "g"), hc("c", group = "g"), hc("d", group = "g"), hc("e", group = "other")))
        queue.markSent(listOf(k + "a", k + "b", k + "c"))
        queue.apply(ChangeSet(deleteKeys = listOf(k + "b")))          // delete waiting
        queue.apply(ChangeSet(deleteKeys = listOf(k + "c")))
        queue.markSent(listOf(k + "c"))                               // deleted
        assertEquals("a is sent, d waits to be created; b is going and c is gone", listOf(k + "a", k + "d"), queue.keysForGroup("g").sorted())
        assertEquals(listOf(k + "e"), queue.keysForGroup("other"))
        assertTrue(queue.keysForGroup("nothing").isEmpty())
    }

    @Test fun theLedgerKeepsTheOrderRecordsWereFirstSeenAndForgetsRemovedOnes() {
        queue.apply(ChangeSet(ledgerPut = listOf(LedgerEntry("r1", "ck#1", "ck", 1000), LedgerEntry("r2", "ck#2", "ck", 2000), LedgerEntry("r3", "other#1", "other", 3000))))
        assertEquals(listOf("r1", "r2"), queue.ledgerForContentKey("ck").map { it.recordId })
        // r1 seen again with a new group keeps its place
        queue.apply(ChangeSet(ledgerPut = listOf(LedgerEntry("r1", "ck#3", "ck", 1000))))
        assertEquals(listOf("r1", "r2"), queue.ledgerForContentKey("ck").map { it.recordId })
        assertEquals("ck#3", queue.ledgerEntry("r1")?.group)
        assertEquals(listOf("r2", "r3"), queue.ledgerSince(2000).map { it.recordId })
        queue.apply(ChangeSet(ledgerRemove = listOf("r1")))
        assertNull(queue.ledgerEntry("r1"))
        assertEquals(listOf("r2"), queue.ledgerForContentKey("ck").map { it.recordId })
        assertNull(queue.ledgerEntry("never"))
    }

    @Test fun aChangeSetIsOneUnit() {
        queue.apply(ChangeSet(upserts = listOf(hc("a"), hc("b")), ledgerPut = listOf(LedgerEntry("rec-1", "rec-1", null, 1))))
        assertEquals(2, queue.counts().pending)
        assertEquals("rec-1", queue.ledgerEntry("rec-1")?.group)
    }

    // ---- patient routes (M30): real data and test data are never filed under the same patient ----

    private fun routed(id: String, route: com.aboutobjects.healthgate.ingest.PatientRoute, value: Double = 72.0) = hc(id, value).copy(route = route)

    @Test fun aSampleFiledUnderOneRouteAndDeliveredUnderAnotherIsRefiledByADeleteThenACreate() {
        val test = com.aboutobjects.healthgate.ingest.PatientRoute.TEST
        val real = com.aboutobjects.healthgate.ingest.PatientRoute.REAL
        queue.enqueue(listOf(routed("a", test)))
        queue.markSent(listOf(k + "a"))
        assertEquals(Enqueued(0, 0, refiled = 1), queue.enqueue(listOf(routed("a", real))))
        val due = queue.nextBatch(10, t0).single()
        assertEquals("the server's copy under the old patient goes first", QueueOp.DELETE, due.op)
        queue.markSent(listOf(k + "a"))
        assertEquals(QueueCounts(deleted = 1), queue.counts())
        // the next delivery creates it, now with the real route
        assertEquals(Enqueued(1, 0), queue.enqueue(listOf(routed("a", real))))
        val again = queue.nextBatch(10, t0).single()
        assertEquals(QueueOp.CREATE, again.op)
        assertEquals(real, again.item.route)
        // the control: the same route again is just known
        queue.markSent(listOf(k + "a"))
        assertEquals(Enqueued(0, 1), queue.enqueue(listOf(routed("a", real))))
    }

    @Test fun aRefileDeleteThatIsWaitingIsNotUndoneByTheNextDelivery() {
        val test = com.aboutobjects.healthgate.ingest.PatientRoute.TEST
        val real = com.aboutobjects.healthgate.ingest.PatientRoute.REAL
        queue.enqueue(listOf(routed("a", test)))
        queue.markSent(listOf(k + "a"))
        queue.enqueue(listOf(routed("a", real)))                        // refile: the delete waits
        assertEquals(Enqueued(0, 1), queue.enqueue(listOf(routed("a", real)))) // delivered again before it went out: nothing changes
        assertEquals(QueueOp.DELETE, queue.nextBatch(10, t0).single().op)
        assertEquals("not reverted to 'sent under the old patient'", 0, queue.counts().sent)
    }

    @Test fun aSampleNeverSentSimplyTakesItsNewRouteWithNoDelete() {
        val test = com.aboutobjects.healthgate.ingest.PatientRoute.TEST
        val real = com.aboutobjects.healthgate.ingest.PatientRoute.REAL
        queue.enqueue(listOf(routed("a", test)))
        val result = queue.enqueue(listOf(routed("a", real)))
        assertEquals(0, result.refiled)
        val due = queue.nextBatch(10, t0).single()
        assertEquals(QueueOp.CREATE, due.op)
        assertEquals(real, due.item.route)
    }

    @Test fun aHeldRouteIsLeftOutOfTheBatchAndCountedAndTheOtherRoutesStillGo() {
        val test = com.aboutobjects.healthgate.ingest.PatientRoute.TEST
        val real = com.aboutobjects.healthgate.ingest.PatientRoute.REAL
        queue.enqueue(listOf(routed("r1", real), routed("t1", test), routed("r2", real)))
        assertEquals(listOf("t1"), queue.nextBatch(10, t0, setOf(real.key)).map { it.item.sample.id })
        assertEquals(listOf("r1", "t1", "r2"), queue.nextBatch(10, t0).map { it.item.sample.id }) // the control: nothing is held by default
        assertEquals(2, queue.pendingCount(real.key))
        assertEquals(1, queue.pendingCount(test.key))
        queue.markSent(listOf(k + "t1"))
        assertEquals(0, queue.pendingCount(test.key))
    }

    @Test fun aStoredRouteComesBackExactlyAndAnOlderRowIsATestRow() {
        val real = routed("a", com.aboutobjects.healthgate.ingest.PatientRoute.REAL)
        queue.enqueue(listOf(real, item("s")))
        assertEquals(listOf(com.aboutobjects.healthgate.ingest.PatientRoute.REAL, com.aboutobjects.healthgate.ingest.PatientRoute.TEST), queue.nextBatch(10, t0).map { it.item.route })
    }
}
