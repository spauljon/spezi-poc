package com.aboutobjects.healthgate.healthconnect

import com.aboutobjects.healthgate.Golden
import com.aboutobjects.healthgate.ingest.PatientRoute
import com.aboutobjects.healthgate.ingest.TestOrigins
import com.aboutobjects.healthgate.ingest.healthconnect.HcRecord
import com.aboutobjects.healthgate.ingest.healthconnect.HealthConnectCollector
import com.aboutobjects.healthgate.ingest.healthconnect.HealthConnectMapper
import com.aboutobjects.healthgate.queue.InMemorySampleQueue
import com.aboutobjects.healthgate.settings.PauseStore
import com.aboutobjects.healthgate.sync.SyncEngine
import com.aboutobjects.healthgate.sync.SyncRunner
import com.aboutobjects.healthgate.sync.TokenProvider
import java.time.Instant
import java.time.ZoneId
import java.time.ZoneOffset
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * M30: the developer's own Health Connect data and test data are never filed under the same patient. A record written by the test tool
 * goes to the test patient; any other app's record goes to the real patient; with no real patient configured the real samples are HELD
 * (never sent, in particular never filed under the test patient); and a sample that was already filed under the wrong patient is moved
 * by a delete and a create. Every assertion is about what the SERVER was told.
 */
class PatientRoutingTest {
    private val registry = Golden.registry()
    private val t0 = Instant.parse("2026-03-10T08:00:00Z")
    private val clock = Instant.parse("2026-03-10T12:00:00Z")
    private val test = "Patient/p-poc-android-01"
    private val real = "Patient/p-poc-real-android"

    private class MemoryPause(override var paused: Boolean = false) : PauseStore

    private inner class World(val realPatient: String? = "poc-real-android", val epoch: Int = HealthConnectCollector.ROUTING_EPOCH) {
        val hc = FakeHealthConnect()
        val hapi = FakeHapi()
        val state = InMemoryCollectorState(routingEpoch = epoch)
        val queue = SpyQueue(InMemorySampleQueue())

        fun runner(testOrigins: Set<String> = TestOrigins.all): SyncRunner {
            val collector = HealthConnectCollector(hc, queue, state, registry, HealthConnectCollector.Settings(), { clock }, { ZoneId.of("UTC") }, testOrigins)
            val engine = SyncEngine(
                queue, hapi, TokenProvider { "tok" }, registry,
                SyncEngine.Settings(patientIdentifier = "poc-android-01", patientSystem = registry.systems.identifier.getValue("patient"), realPatientIdentifier = realPatient, batchSize = 100),
                now = { clock }, random = { 0.5 },
            )
            return SyncRunner({ collector.collect() }, engine, MemoryPause())
        }

        fun run(runner: SyncRunner = runner()) = runBlocking { runner.run("Test") }
    }

    private fun hr(id: String, origin: String, bpm: Double) = HcRecord.HeartRate(
        id, origin, 2, null, t0, t0, ZoneOffset.UTC, ZoneOffset.UTC, listOf(HcRecord.HeartRateSample(t0, bpm)),
    )

    private fun identity(record: HcRecord) = registry.systems.identifier.getValue("healthConnect") + "|" +
        HealthConnectMapper(registry).items(record, clock, ZoneId.of("UTC"))[0].sample.id

    @Test fun aTestToolRecordGoesToTheTestPatientAndAnyOtherAppsRecordToTheRealOne() {
        val w = World()
        val mine = hr("r-real", "com.myfitnesspal.android", 70.0)
        val writer = hr("r-test", TestOrigins.WRITER, 80.0)
        w.hc.put(mine); w.hc.put(writer)
        w.run()
        val subjects = w.hapi.liveSubjects()
        assertEquals(real, subjects[identity(mine)])
        assertEquals(test, subjects[identity(writer)])
        assertEquals(2, subjects.size)
        // the control: the route is a property of the item the mapper made, not of the engine's mood
        assertEquals(PatientRoute.REAL, HealthConnectMapper(registry).items(mine, clock, ZoneId.of("UTC")).single().route)
        assertEquals(PatientRoute.TEST, HealthConnectMapper(registry).items(writer, clock, ZoneId.of("UTC")).single().route)
    }

    @Test fun withNoRealPatientConfiguredRealSamplesAreHeldAndNeverFiledUnderTheTestPatient() {
        val w = World(realPatient = null)
        w.hc.put(hr("r-real", "com.myfitnesspal.android", 70.0))
        w.hc.put(hr("r-test", TestOrigins.WRITER, 80.0))
        val result = w.run()
        assertEquals("only the test sample went anywhere", setOf(test), w.hapi.liveSubjects().values.toSet())
        assertEquals(1, w.hapi.liveSubjects().size)
        assertEquals("the real sample waits in the queue", 1, w.queue.pendingCount(PatientRoute.REAL.key))
        assertEquals(1, result.upload!!.held)
        assertEquals("the control: the test sample is not held", 0, w.queue.pendingCount(PatientRoute.TEST.key))
        // configuring the patient releases them, to the real patient
        val configured = World(realPatient = "poc-real-android")
        configured.hc.put(hr("r-real", "com.myfitnesspal.android", 70.0))
        configured.run()
        assertEquals(setOf(real), configured.hapi.liveSubjects().values.toSet())
    }

    @Test fun aSampleAlreadyFiledUnderTheTestPatientIsMovedByADeleteAndACreate() {
        val w = World(epoch = 0)
        val record = hr("r-real", "com.myfitnesspal.android", 70.0)
        w.hc.put(record)
        // the old rules (before M30): nothing was a test-tool record only by origin, everything went to the test patient
        w.run(w.runner(testOrigins = setOf("com.myfitnesspal.android")))
        assertEquals("filed under the test patient", mapOf(identity(record) to test), w.hapi.liveSubjects())
        assertEquals(0, w.hapi.count("DELETE"))

        // the new rules, on a phone that has not read under them yet: the window is read again, once
        w.state.routingEpoch = 0
        val outcome = w.run()
        assertEquals("filed under the real patient now", mapOf(identity(record) to real), w.hapi.liveSubjects())
        assertEquals("deleted from the test patient, then created under the real one", listOf("CREATE", "DELETE", "CREATE"), w.hapi.ops.map { it.kind })
        assertTrue("the read said it moved the sample", outcome.collected!!.samplesQueued >= 1)
        assertEquals(HealthConnectCollector.ROUTING_EPOCH, w.state.routingEpoch)

        // a further run changes nothing (the move is done, and the epoch is current)
        val ops = w.hapi.ops.size
        w.run()
        assertEquals(ops, w.hapi.ops.size)
    }

    @Test fun nothingMovesWhenTheEpochIsCurrentAndEveryRouteIsRight() {
        val w = World()
        w.hc.put(hr("r-real", "com.myfitnesspal.android", 70.0))
        w.run()
        val ops = w.hapi.ops.map { it.kind }
        assertEquals(listOf("CREATE"), ops)
        assertFalse(w.hapi.ops.any { it.kind == "DELETE" })
        w.run()
        assertEquals(ops, w.hapi.ops.map { it.kind })
    }

    @Test fun aBatchNeverMixesRoutes() {
        val w = World()
        for (i in 1..5) {
            w.hc.put(hr("real-$i", "com.myfitnesspal.android", 60.0 + i).copy(startTime = t0.plusSeconds(60L * i), samples = listOf(HcRecord.HeartRateSample(t0.plusSeconds(60L * i), 60.0 + i))))
            w.hc.put(hr("test-$i", TestOrigins.WRITER, 80.0 + i).copy(startTime = t0.plusSeconds(60L * i), samples = listOf(HcRecord.HeartRateSample(t0.plusSeconds(60L * i), 80.0 + i))))
        }
        w.run()
        assertEquals(10, w.hapi.liveSubjects().size)
        assertEquals(5, w.hapi.liveSubjects().values.count { it == real })
        assertEquals(5, w.hapi.liveSubjects().values.count { it == test })
        assertTrue("two transactions at least: one per patient (${w.hapi.bundles})", w.hapi.bundles >= 2)
    }
}
