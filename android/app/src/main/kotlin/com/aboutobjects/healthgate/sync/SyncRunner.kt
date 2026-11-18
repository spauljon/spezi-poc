package com.aboutobjects.healthgate.sync

import com.aboutobjects.healthgate.ingest.healthconnect.CollectOutcome
import com.aboutobjects.healthgate.settings.PauseStore
import kotlinx.coroutines.sync.Mutex

/** What one run did, for the caller (the screen, or the background worker deciding whether to ask for a retry). */
data class RunResult(
    val reason: String,
    /** Nothing was done because syncing is paused. */
    val paused: Boolean = false,
    /** Another run was already going. */
    val busy: Boolean = false,
    val collected: CollectOutcome? = null,
    val upload: SyncStatus? = null,
) {
    /** A temporary problem (no network, a 5xx): worth trying again soon. A block (signed out, refused, no permission) is not: it needs the user. */
    val worthRetrying: Boolean get() = upload?.phase is SyncPhase.Waiting
}

/**
 * One sync: read Health Connect into the queue, then upload. The screen's buttons, a sign-in and the scheduled background worker all go
 * through here, so they behave the same. It honours the pause switch; reads even while signed out (the queue holds the samples, and the
 * sign-in then triggers a run that uploads them); and never overlaps itself.
 */
class SyncRunner(
    private val collect: (suspend () -> CollectOutcome)?,
    private val engine: SyncEngine,
    private val pause: PauseStore,
) {
    private val gate = Mutex()

    suspend fun run(reason: String): RunResult {
        if (pause.paused) return RunResult(reason, paused = true)
        if (!gate.tryLock()) return RunResult(reason, busy = true)
        try {
            var outcome = collect?.invoke()
            if (outcome != null && outcome.mode != CollectOutcome.Mode.BUSY) engine.record(describe(reason, outcome))
            engine.refresh()
            var upload = engine.drain()
            // samples on the server under the wrong patient: their deletes have just gone out; read the window again so they are created under the right one
            var passes = 0
            while (collect != null && outcome != null && outcome.samplesRefiled > 0 && passes++ < MAX_REFILE_PASSES) {
                val again = collect.invoke()
                engine.record(describe(reason, again))
                outcome = again.copy(samplesQueued = again.samplesQueued + outcome.samplesQueued, samplesRefiled = again.samplesRefiled)
                engine.refresh()
                upload = engine.drain()
            }
            return RunResult(reason, collected = outcome, upload = upload)
        } finally {
            gate.unlock()
        }
    }

    private companion object {
        const val MAX_REFILE_PASSES = 2
    }

    private fun describe(reason: String, o: CollectOutcome): String {
        val head = "$reason: " + if (o.mode == CollectOutcome.Mode.WINDOW) "read the last 30 days" else "read the changes"
        return if (o.failure == "SecurityException") "$head, stopped: Health Connect did not allow the read (allow reading in the background, or open the app)"
        else if (o.failure != null) "$head, stopped (${o.failure})"
        else "$head: ${o.recordsUpserted} records, ${o.samplesQueued} samples queued, ${o.recordsDeleted} deleted" + (if (o.recordsRefused > 0) ", ${o.recordsRefused} refused" else "") + (if (o.samplesRefiled > 0) ", ${o.samplesRefiled} moved to the right patient" else "")
    }
}
