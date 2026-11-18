package com.aboutobjects.healthgate.healthconnect

import com.aboutobjects.healthgate.Golden
import com.aboutobjects.healthgate.ingest.healthconnect.CollectOutcome
import com.aboutobjects.healthgate.ingest.healthconnect.HcRecord
import com.aboutobjects.healthgate.ingest.healthconnect.HealthConnectCollector
import com.aboutobjects.healthgate.ingest.healthconnect.HealthConnectMapper
import com.aboutobjects.healthgate.queue.InMemorySampleQueue
import com.aboutobjects.healthgate.queue.QueueCounts
import com.aboutobjects.healthgate.sync.SyncEngine
import com.aboutobjects.healthgate.sync.TokenProvider
import java.time.Duration
import java.time.Instant
import java.time.ZoneId
import java.time.ZoneOffset
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The seven scenarios of the brief's section 10 (decision A11), through the whole path: a fake Health Connect, the collector, the queue,
 * the sync engine and a fake HAPI that knows conditional create, update and (soft) delete. Every assertion is about what the SERVER was
 * told, not about what the queue holds.
 */
class HealthConnectScenarioTest {
    private val registry = Golden.registry()
    private val mapper = HealthConnectMapper(registry)
    private val utc = ZoneId.of("UTC")
    private val t0 = Instant.parse("2026-03-10T08:00:00Z")

    private inner class Rig(settings: HealthConnectCollector.Settings = HealthConnectCollector.Settings()) {
        var clock: Instant = Instant.parse("2026-03-10T12:00:00Z")
        val hc = FakeHealthConnect()
        val hapi = FakeHapi()
        val state = InMemoryCollectorState()
        val queue = SpyQueue(InMemorySampleQueue())
        val collector = HealthConnectCollector(hc, queue, state, registry, settings, { clock }, { utc })
        val engine = SyncEngine(
            queue, hapi, TokenProvider { "tok" }, registry,
            SyncEngine.Settings(patientIdentifier = "poc-android-01", patientSystem = registry.systems.identifier.getValue("patient"), realPatientIdentifier = "poc-real-android", batchSize = 100),
            now = { clock }, random = { 0.5 },
        )

        fun collect(): CollectOutcome = runBlocking { collector.collect() }
        fun drain() = runBlocking { engine.drain() }

        /** One collection and one upload, as a background run would do. */
        fun sync(): CollectOutcome = collect().also { drain() }
    }

    private fun hr(id: String, vararg bpm: Double, origin: String = "com.example.watch") = HcRecord.HeartRate(
        id, origin, 2, null, t0, t0.plusSeconds(30L * maxOf(bpm.size - 1, 0)), ZoneOffset.UTC, ZoneOffset.UTC,
        bpm.mapIndexed { i, v -> HcRecord.HeartRateSample(t0.plusSeconds(30L * i), v) },
    )

    private val food = mapOf("energy" to 450.0, "protein" to 31.5, "totalCarbohydrate" to 62.0, "totalFat" to 14.2, "dietaryFiber" to 7.5, "sugar" to 22.0, "sodium" to 620.0)

    private fun meal(id: String, nutrients: Map<String, Double> = food, start: Instant = Instant.parse("2026-03-10T10:00:00Z")) =
        HcRecord.Nutrition(id, "com.example.food", 3, null, start, start.plus(Duration.ofHours(12)), ZoneOffset.UTC, ZoneOffset.UTC, 2, nutrients)

    private fun idOf(record: HcRecord, index: Int = 0, group: String? = null) =
        mapper.items(record, Instant.parse("2026-03-10T12:00:00Z"), utc, group)[index].sample.id

    private fun sampleKey(record: HcRecord, index: Int = 0) = registry.systems.identifier.getValue("healthConnect") + "|" + idOf(record, index)

    // ---- 1 ----
    @Test fun unique_records_are_delivered_once_each() {
        val rig = Rig()
        rig.hc.put(hr("r1", 70.0, 71.0))
        rig.hc.put(hr("r2", 80.0).copy(startTime = t0.plusSeconds(600), samples = listOf(HcRecord.HeartRateSample(t0.plusSeconds(600), 80.0))))
        val first = rig.sync()
        assertEquals(CollectOutcome.Mode.WINDOW, first.mode)
        assertEquals(3, rig.hapi.count("CREATE"))
        assertEquals(0, rig.hapi.count("UPDATE") + rig.hapi.count("DELETE"))
        // the control: nothing new, nothing sent
        rig.sync()
        assertEquals("a second run sends nothing", 3, rig.hapi.ops.size)
        rig.hc.put(hr("r3", 90.0).copy(startTime = t0.plusSeconds(1200), samples = listOf(HcRecord.HeartRateSample(t0.plusSeconds(1200), 90.0))))
        assertEquals(CollectOutcome.Mode.CHANGES, rig.sync().mode)
        assertEquals("only the new record's sample", 4, rig.hapi.ops.size)
    }

    // ---- 2 ----
    @Test fun one_record_delivered_three_times_growing_creates_each_sample_exactly_once() {
        val rig = Rig()
        rig.hc.put(hr("g", 70.0, 71.0))
        rig.sync()
        rig.hc.put(hr("g", 70.0, 71.0, 72.0))
        rig.sync()
        rig.hc.put(hr("g", 70.0, 71.0, 72.0, 73.0))
        rig.sync()
        assertEquals(4, rig.hapi.count("CREATE"))
        assertEquals("no sample was updated, deleted or created twice", 4, rig.hapi.ops.size)
        assertEquals(setOf(70.0, 71.0, 72.0, 73.0), rig.hapi.liveValues().values.toSet())
    }

    // ---- 3 ----
    @Test fun a_sample_whose_value_changes_is_updated_in_place_not_retracted_and_recreated() {
        val rig = Rig()
        rig.hc.put(hr("g", 70.0, 71.0))
        rig.sync()
        val before = rig.hapi.resourceId(sampleKey(hr("g", 70.0, 71.0), 0).substringAfter('|').let { registry.systems.identifier.getValue("healthConnect") + "|" + it })
        rig.hc.put(hr("g", 99.0, 71.0, 72.0))
        rig.sync()
        assertEquals("the changed sample is an update", 1, rig.hapi.count("UPDATE"))
        assertEquals("the new sample is a create", 3, rig.hapi.count("CREATE"))
        assertEquals(0, rig.hapi.count("DELETE"))
        assertEquals(setOf(99.0, 71.0, 72.0), rig.hapi.liveValues().values.toSet())
        assertEquals("the same resource, so its identity is unchanged", before, rig.hapi.resourceId(registry.systems.identifier.getValue("healthConnect") + "|" + idOf(hr("g", 70.0, 71.0), 0)))
    }

    @Test fun a_sample_a_record_no_longer_holds_is_deleted() {
        val rig = Rig()
        rig.hc.put(hr("g", 70.0, 71.0, 72.0))
        rig.sync()
        rig.hc.put(hr("g", 70.0, 72.0).copy(samples = listOf(HcRecord.HeartRateSample(t0, 70.0), HcRecord.HeartRateSample(t0.plusSeconds(60), 72.0))))
        rig.sync()
        assertEquals("only the middle sample (30 s) is gone", 1, rig.hapi.count("DELETE"))
        assertEquals(setOf(70.0, 72.0), rig.hapi.liveValues().values.toSet())
    }

    // ---- 4 ----
    @Test fun a_record_delivered_twice_with_identical_content_changes_nothing() {
        val rig = Rig()
        rig.hc.put(hr("g", 70.0, 71.0))
        rig.sync()
        val ops = rig.hapi.ops.size
        rig.hc.redeliver("g")
        assertEquals(1, rig.sync().recordsUpserted)
        rig.hc.redeliver("g")
        assertEquals("delivered again", 1, rig.sync().recordsUpserted)
        assertEquals("nothing reached the server", ops, rig.hapi.ops.size)
        assertEquals(QueueCounts(sent = 2), rig.queue.counts())
    }

    // ---- 5 ----
    @Test fun a_record_deleted_after_upload_has_all_its_observations_deleted() {
        val rig = Rig()
        rig.hc.put(hr("g", 70.0, 71.0, 72.0))
        rig.hc.put(hr("other", 60.0).copy(startTime = t0.plusSeconds(900), samples = listOf(HcRecord.HeartRateSample(t0.plusSeconds(900), 60.0))))
        rig.sync()
        rig.hc.remove("g")
        rig.sync()
        assertEquals(3, rig.hapi.count("DELETE"))
        assertEquals("the other record is untouched", setOf(60.0), rig.hapi.liveValues().values.toSet())
        // a deletion is repeatable: nothing more happens
        rig.hc.remove("g")
        rig.sync()
        assertEquals(3, rig.hapi.count("DELETE"))
    }

    // ---- 6 ----
    @Test fun a_record_deleted_before_upload_sends_nothing_and_no_deletion() {
        val rig = Rig()
        rig.hc.put(hr("g", 70.0, 71.0))
        rig.collect()
        rig.hc.remove("g")
        rig.collect()
        rig.drain()
        assertEquals("no create and no delete", emptyList<Any>(), rig.hapi.ops)
        assertEquals(0, rig.hapi.bundles)
        assertEquals(0, rig.queue.counts().total)
        // a record that was created and deleted between two reads was never seen: nothing at all
        rig.hc.put(hr("ghost", 50.0))
        rig.hc.remove("ghost")
        rig.sync()
        assertEquals(emptyList<Any>(), rig.hapi.ops)
    }

    // ---- 7 ----
    @Test fun a_failure_partway_through_a_record_does_not_advance_the_token_and_the_retry_converges() {
        val rig = Rig(HealthConnectCollector.Settings(chunk = 2))
        rig.hc.put(hr("seed", 60.0).copy(startTime = t0.minusSeconds(3600), samples = listOf(HcRecord.HeartRateSample(t0.minusSeconds(3600), 60.0))))
        rig.sync() // takes the first token
        val token = rig.state.token
        rig.hc.put(hr("big", 1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0))
        rig.queue.failOnApplyNumber = rig.queue.applied.size + 2 // the second chunk of the record
        val failed = rig.collect()
        assertEquals("IllegalStateException", failed.failure)
        assertEquals("the token did not advance", token, rig.state.token)
        assertTrue("part of the record is queued", rig.queue.counts().pending in 1..6)
        rig.queue.failOnApplyNumber = null
        val retry = rig.collect()
        assertTrue(retry.succeeded)
        assertNotEquals(token, rig.state.token)
        rig.drain()
        assertEquals("each sample exactly once", 8, rig.hapi.count("CREATE"))
        assertEquals(1 + 7, rig.hapi.liveValues().size)
        assertEquals(emptyList<Any>(), rig.hapi.ops.filter { it.kind != "CREATE" })
    }

    // ---- more: the rules behind the seven ----
    @Test fun a_nutrition_record_re_created_with_a_new_id_by_the_writing_app_changes_nothing() {
        val rig = Rig()
        rig.hc.put(meal("mfp-1"))
        rig.sync()
        assertEquals(7, rig.hapi.count("CREATE"))
        // MyFitnessPal's sync: a delete and a new record, same content, new id, in one change page
        rig.hc.remove("mfp-1")
        rig.hc.put(meal("mfp-2"))
        rig.sync()
        assertEquals("the delete and the re-creation cancel out", 7, rig.hapi.ops.size)
        assertEquals(7, rig.hapi.liveValues().size)
        // the control: after the grace period a delete that really is a delete does go out
        rig.hc.remove("mfp-2")
        rig.collect()
        rig.drain()
        assertEquals("a nutrition delete waits out its grace period", 0, rig.hapi.count("DELETE"))
        rig.clock = rig.clock.plus(Duration.ofMinutes(6))
        rig.drain()
        assertEquals(7, rig.hapi.count("DELETE"))
        assertTrue(rig.hapi.liveValues().isEmpty())
    }

    @Test fun the_delete_and_the_re_created_twin_arriving_apart_still_cancel_out_inside_the_grace_period() {
        val rig = Rig()
        rig.hc.put(meal("mfp-1"))
        rig.sync()
        rig.hc.remove("mfp-1")
        rig.sync() // the delete is queued but held
        rig.clock = rig.clock.plus(Duration.ofMinutes(2))
        rig.hc.put(meal("mfp-2"))
        rig.sync()
        rig.clock = rig.clock.plus(Duration.ofMinutes(10))
        rig.drain()
        assertEquals("nothing was ever deleted", 0, rig.hapi.count("DELETE"))
        assertEquals(7, rig.hapi.liveValues().size)
    }

    @Test fun an_edited_nutrition_record_replaces_the_item_and_twins_never_collide() {
        val rig = Rig()
        rig.hc.put(meal("m1"))
        rig.sync()
        rig.hc.put(meal("m1", food + ("protein" to 40.0)))
        rig.clock = rig.clock.plus(Duration.ofMinutes(6))
        rig.sync()
        rig.drain()
        assertEquals("a different content key: the old item goes, the new one is created", 7, rig.hapi.count("DELETE"))
        assertEquals(14, rig.hapi.count("CREATE"))
        assertEquals(7, rig.hapi.liveValues().size)
        // two of the same food are two items, and deleting the first leaves the second alone
        val twins = Rig()
        twins.hc.put(meal("a")); twins.hc.put(meal("b"))
        twins.sync()
        assertEquals(14, twins.hapi.liveValues().size)
        twins.hc.remove("a")
        twins.collect()
        twins.clock = twins.clock.plus(Duration.ofMinutes(6))
        twins.drain()
        assertEquals(7, twins.hapi.liveValues().size)
        twins.hc.put(meal("c")) // a third twin takes the freed ordinal, not the one b holds
        twins.sync()
        assertEquals(14, twins.hapi.liveValues().size)
    }

    @Test fun an_expired_token_falls_back_to_the_window_and_notices_what_was_deleted_meanwhile() {
        val rig = Rig()
        rig.hc.put(hr("keep", 60.0))
        rig.hc.put(hr("gone", 70.0).copy(startTime = t0.plusSeconds(600), samples = listOf(HcRecord.HeartRateSample(t0.plusSeconds(600), 70.0))))
        rig.sync()
        rig.hc.vanish("gone") // deleted while the token was unusable: no change was logged
        rig.hc.tokensExpired = true
        val outcome = rig.sync()
        assertEquals(CollectOutcome.Mode.WINDOW, outcome.mode)
        assertEquals(1, rig.hapi.count("DELETE"))
        assertEquals(setOf(60.0), rig.hapi.liveValues().values.toSet())
        rig.hc.tokensExpired = false
        assertEquals("with a good token again, changes are followed", CollectOutcome.Mode.CHANGES, rig.sync().mode)
    }

    @Test fun a_refused_record_is_counted_and_never_stops_the_others() {
        val rig = Rig()
        rig.hc.put(hr("   ", 70.0)) // no usable id
        rig.hc.put(hr("ok", 71.0))
        val outcome = rig.sync()
        assertEquals(1, outcome.recordsRefused)
        assertEquals(1, outcome.recordsUpserted)
        assertEquals(setOf(71.0), rig.hapi.liveValues().values.toSet())
    }

    @Test fun a_huge_record_is_queued_in_bounded_chunks() {
        val rig = Rig(HealthConnectCollector.Settings(chunk = 500))
        val values = DoubleArray(20_000) { 60.0 + it % 40 }
        val big = HcRecord.HeartRate("big", "com.example.watch", 2, null, t0, t0.plusSeconds(20_000), ZoneOffset.UTC, ZoneOffset.UTC,
            values.mapIndexed { i, v -> HcRecord.HeartRateSample(t0.plusSeconds(i.toLong()), v) })
        rig.hc.put(big)
        val outcome = rig.collect()
        assertEquals(20_000, outcome.samplesQueued)
        assertTrue("no hand-off carried more than the chunk: ${rig.queue.applied.maxOf { it.upserts.size }}", rig.queue.applied.maxOf { it.upserts.size } <= 500)
        assertEquals(20_000, rig.queue.counts().pending)
        // the control: a smaller chunk makes more, smaller hand-offs
        val small = Rig(HealthConnectCollector.Settings(chunk = 100))
        small.hc.put(big)
        small.collect()
        assertTrue(small.queue.applied.size > rig.queue.applied.size)
    }

    @Test fun pages_of_changes_and_pages_of_records_are_followed_to_the_end() {
        val rig = Rig(HealthConnectCollector.Settings(pageSize = 2))
        for (i in 1..5) rig.hc.put(hr("w$i", 60.0 + i).copy(startTime = t0.plusSeconds(100L * i), samples = listOf(HcRecord.HeartRateSample(t0.plusSeconds(100L * i), 60.0 + i))))
        rig.sync()
        assertEquals(5, rig.hapi.liveValues().size)
        assertTrue("the window read paged (page size 2): ${rig.hc.readPageCalls}", rig.hc.readPageCalls.count { it.startsWith("HEART_RATE") } >= 3)
        rig.hc.changePageSize = 2
        for (i in 6..10) rig.hc.put(hr("w$i", 60.0 + i).copy(startTime = t0.plusSeconds(100L * i), samples = listOf(HcRecord.HeartRateSample(t0.plusSeconds(100L * i), 60.0 + i))))
        rig.sync()
        assertEquals(10, rig.hapi.liveValues().size)
    }
}
