package com.aboutobjects.healthgate.debug

/** Raised by a failpoint to stand in for the process dying: it is an Error, so no `catch (e: Exception)` in the app swallows it. */
class SimulatedProcessDeath(val name: String) : Error("simulated process death at $name")

/**
 * DEBUG BUILDS ONLY (the release build has an empty twin of this object). A failpoint is a named place in the sync path where a test can
 * stop the process: the unit tests set [hook] to throw [SimulatedProcessDeath], and the debug receiver (adb) sets it to kill the real
 * process. Names: `collector.afterCommit` (after a queue commit), `collector.beforeToken` (a page is committed, its token not yet stored),
 * `engine.afterSend` (the server accepted a batch, the queue not yet told).
 */
object Failpoints {
    @Volatile var hook: ((String) -> Unit)? = null

    fun hit(name: String) { hook?.invoke(name) }
}
