package com.aboutobjects.healthgate.healthconnect

import com.aboutobjects.healthgate.Golden
import com.aboutobjects.healthgate.debug.Failpoints
import com.aboutobjects.healthgate.debug.SimulatedProcessDeath
import com.aboutobjects.healthgate.ingest.healthconnect.HcRecord
import com.aboutobjects.healthgate.ingest.healthconnect.HealthConnectCollector
import com.aboutobjects.healthgate.queue.InMemorySampleQueue
import com.aboutobjects.healthgate.queue.QueueCounts
import com.aboutobjects.healthgate.settings.PauseStore
import com.aboutobjects.healthgate.sync.AuthException
import com.aboutobjects.healthgate.sync.SyncEngine
import com.aboutobjects.healthgate.sync.SyncPhase
import com.aboutobjects.healthgate.sync.SyncRunner
import com.aboutobjects.healthgate.sync.SyncWorker
import com.aboutobjects.healthgate.sync.TokenProvider
import java.time.Instant
import java.time.ZoneId
import java.time.ZoneOffset
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * M28: the scheduled sync's logic (pause, hold while signed out, resume on sign-in, retry only for what a retry can fix) and, with the
 * failpoints, what a process death at each step of the read-and-upload path costs: nothing. A "death" is an Error thrown at the named
 * place; the "restart" builds a new collector, engine and runner over the SAME queue, token store, Health Connect and server, as a new
 * process would find them.
 */
class BackgroundSyncTest {
    private val registry = Golden.registry()
    private val t0 = Instant.parse("2026-03-10T08:00:00Z")

    @After fun disarm() { Failpoints.hook = null }

    private class MemoryPause(override var paused: Boolean = false) : PauseStore

    /** Everything that survives a process death, and what is rebuilt after it. */
    private inner class World(val chunk: Int = 500) {
        var clock: Instant = Instant.parse("2026-03-10T12:00:00Z")
        val hc = FakeHealthConnect()
        val hapi = FakeHapi()
        val state = InMemoryCollectorState()
        val queue = SpyQueue(InMemorySampleQueue())
        val pause = MemoryPause()
        var signedOut = false

        fun runner(): SyncRunner {
            val collector = HealthConnectCollector(hc, queue, state, registry, HealthConnectCollector.Settings(chunk = chunk), { clock }, { ZoneId.of("UTC") })
            val engine = SyncEngine(
                queue, hapi, TokenProvider { if (signedOut) throw AuthException(AuthException.Kind.SIGNED_OUT, "signed out") else "tok" }, registry,
                SyncEngine.Settings(patientIdentifier = "poc-android-01", patientSystem = registry.systems.identifier.getValue("patient"), realPatientIdentifier = "poc-real-android", batchSize = 100),
                now = { clock }, random = { 0.5 },
            )
            return SyncRunner({ collector.collect() }, engine, pause)
        }

        fun run(runner: SyncRunner = runner()) = runBlocking { runner.run("Test") }
    }

    private fun hr(id: String, vararg bpm: Double) = HcRecord.HeartRate(
        id, "com.example.watch", 2, null, t0, t0.plusSeconds(30L * maxOf(bpm.size - 1, 0)), ZoneOffset.UTC, ZoneOffset.UTC,
        bpm.mapIndexed { i, v -> HcRecord.HeartRateSample(t0.plusSeconds(30L * i), v) },
    )

    // ---- the runner ----
    @Test fun aPausedRunnerDoesNothingAtAll_andResumingDoesTheWork() {
        val w = World()
        w.hc.put(hr("a", 70.0, 71.0))
        w.pause.paused = true
        val paused = w.run()
        assertTrue(paused.paused)
        assertNull("nothing was read", paused.collected)
        assertEquals(0, w.queue.counts().total)
        assertEquals(0, w.hapi.bundles)
        // the control: the same runner, no longer paused, reads and uploads
        w.pause.paused = false
        val ran = w.run()
        assertFalse(ran.paused)
        assertEquals(2, w.hapi.count("CREATE"))
    }

    @Test fun samplesReadWhileSignedOutAreHeldAndGoUpWhenSigningInRuns() {
        val w = World()
        w.hc.put(hr("a", 70.0, 71.0, 72.0))
        w.signedOut = true
        val held = w.run()
        assertEquals("the read happened", 3, held.collected!!.samplesQueued)
        assertEquals(QueueCounts(pending = 3), w.queue.counts())
        assertTrue("the upload is blocked, not retried", held.upload!!.phase is SyncPhase.Blocked)
        assertFalse("a block needs the user: no retry", held.worthRetrying)
        assertEquals(0, w.hapi.bundles)
        // signing in is a run: the held samples go up, and the read position is not lost
        w.signedOut = false
        val resumed = w.run()
        assertEquals(3, w.hapi.count("CREATE"))
        assertEquals(QueueCounts(sent = 3), w.queue.counts())
        assertEquals(SyncPhase.Idle, resumed.upload!!.phase)
    }

    @Test fun aTemporaryProblemIsWorthRetryingAndABlockIsNot() {
        val w = World()
        w.hc.put(hr("a", 70.0))
        w.hapi.offline = true
        val offline = w.run()
        assertTrue(offline.upload!!.phase is SyncPhase.Waiting)
        assertTrue(offline.worthRetrying)
        assertEquals("what WorkManager is told", androidx.work.ListenableWorker.Result.retry(), SyncWorker.resultFor(offline))
        w.signedOut = true
        val blocked = w.run()
        assertEquals(androidx.work.ListenableWorker.Result.success(), SyncWorker.resultFor(blocked))
        assertEquals(androidx.work.ListenableWorker.Result.success(), SyncWorker.resultFor(com.aboutobjects.healthgate.sync.RunResult("x", paused = true)))
    }

    @Test fun aSecondRunWhileOneIsGoingReturnsAtOnce() {
        val w = World()
        w.hc.put(hr("a", 70.0))
        val runner = w.runner()
        val results = runBlocking {
            val first = async { runner.run("one") }
            val second = async { runner.run("two") }
            listOf(first.await(), second.await())
        }
        assertEquals("exactly one of the two did the work", 1, results.count { !it.busy })
        assertEquals(1, w.hapi.count("CREATE"))
    }

    @Test fun theAttemptHistoryKeepsAReadLineAndAnUploadLine() {
        val w = World()
        w.hc.put(hr("a", 70.0, 71.0))
        val runner = w.runner()
        val result = runBlocking { runner.run("Background") }
        val lines = result.upload!!.history.map { it.summary }
        assertTrue(lines.toString(), lines.any { it.startsWith("Background: read the last 30 days: 1 records, 2 samples queued") })
        assertTrue(lines.toString(), lines.any { it.startsWith("Sent 2 (2 created") })
    }

    // ---- process death ----
    private fun dieAt(name: String, afterHits: Int = 0) {
        var hits = 0
        Failpoints.hook = { n -> if (n == name && hits++ == afterHits) throw SimulatedProcessDeath(n) }
    }

    private fun runUntilDeath(w: World): SimulatedProcessDeath {
        try {
            w.run()
        } catch (e: SimulatedProcessDeath) {
            return e
        }
        fail("the process did not die")
        throw IllegalStateException()
    }

    @Test fun diesBetweenTwoCommitsOfOneRecord_theRetryConverges() {
        val w = World(chunk = 2)
        w.hc.put(hr("big", 1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0))
        dieAt("collector.afterCommit")
        assertEquals("collector.afterCommit", runUntilDeath(w).name)
        assertNull("the token did not advance", w.state.token)
        val partial = w.queue.counts().pending
        assertTrue("part of the record is queued: $partial", partial in 1..6)
        Failpoints.hook = null
        w.run() // the restarted process
        assertEquals("each sample exactly once", 7, w.hapi.count("CREATE"))
        assertEquals(QueueCounts(sent = 7), w.queue.counts())
        assertEquals(emptyList<Any>(), w.hapi.ops.filter { it.kind != "CREATE" })
    }

    @Test fun diesAfterAPageIsCommittedButBeforeItsTokenIsStored_theRetryRepeatsThePageHarmlessly() {
        val w = World()
        w.hc.put(hr("seed", 60.0))
        w.run() // takes the first token and uploads
        val token = w.state.token
        w.hc.put(hr("seed", 60.0, 61.0)) // grows
        w.hc.put(hr("new", 80.0).copy(startTime = t0.plusSeconds(900), samples = listOf(HcRecord.HeartRateSample(t0.plusSeconds(900), 80.0))))
        dieAt("collector.beforeToken")
        runUntilDeath(w)
        assertEquals("the page was committed, its token was not stored", token, w.state.token)
        assertTrue("its samples are in the queue", w.queue.counts().pending >= 2)
        Failpoints.hook = null
        w.run() // the same page again, then the upload
        assertEquals("seed 1 + one more of seed + new", 3, w.hapi.count("CREATE"))
        assertEquals(0, w.hapi.count("UPDATE") + w.hapi.count("DELETE"))
        assertNotEquals(token, w.state.token)
        assertEquals(QueueCounts(sent = 3), w.queue.counts())
    }

    @Test fun diesAfterTheServerAcceptedAUpload_theRetrySendsItAgainAndNothingDoubles() {
        val w = World()
        w.hc.put(hr("a", 70.0, 71.0, 72.0))
        dieAt("engine.afterSend")
        runUntilDeath(w)
        assertEquals("the server has them", 3, w.hapi.count("CREATE"))
        assertEquals("the queue was not told", QueueCounts(pending = 3), w.queue.counts())
        Failpoints.hook = null
        w.run()
        assertEquals("a conditional create is a no-op the second time", 3, w.hapi.count("CREATE"))
        assertEquals(QueueCounts(sent = 3), w.queue.counts())
        assertEquals(3, w.hapi.liveValues().size)
    }

    @Test fun diesAfterTheServerAcceptedAnUpdateAndADelete_theRetryConverges() {
        val w = World()
        w.hc.put(hr("a", 70.0, 71.0))
        w.hc.put(hr("gone", 50.0).copy(startTime = t0.plusSeconds(900), samples = listOf(HcRecord.HeartRateSample(t0.plusSeconds(900), 50.0))))
        w.run()
        w.hc.put(hr("a", 99.0, 71.0)) // the first sample changes
        w.hc.remove("gone")
        dieAt("engine.afterSend")
        runUntilDeath(w)
        assertEquals("applied by the server", 1, w.hapi.count("UPDATE"))
        assertEquals(1, w.hapi.count("DELETE"))
        Failpoints.hook = null
        w.run()
        assertEquals("an update is replayed as an update of the same value, a delete of nothing is a no-op", 1, w.hapi.count("DELETE"))
        assertEquals(setOf(99.0, 71.0), w.hapi.liveValues().values.toSet())
        assertEquals(0, w.queue.counts().pending)
    }

    @Test fun aFailpointThatIsNotArmedAndOneForAnotherPlaceDoNothing() {
        val w = World()
        w.hc.put(hr("a", 70.0))
        Failpoints.hook = { n -> if (n == "somewhere.else") throw SimulatedProcessDeath(n) } // armed, but not for a place this run passes
        assertNotNull(w.run().collected)
        assertEquals(1, w.hapi.count("CREATE"))
    }
}
