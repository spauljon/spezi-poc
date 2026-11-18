package com.aboutobjects.healthgate.debug

import android.content.BroadcastReceiver
import android.content.ContentProvider
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.database.Cursor
import android.net.Uri
import android.os.Process
import android.util.Log
import com.aboutobjects.healthgate.HealthGateApplication
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

private const val TAG = "HGDebug"
private const val PREFS = "debug_failpoint"

/**
 * DEBUG BUILDS ONLY. Installs the failpoint hook when the app process starts, so a failpoint armed before a kill is still armed (or has
 * been used up) in the new process. Armed state lives in preferences: `name` and `skip` (how many hits to let pass before dying).
 */
class DebugInstaller : ContentProvider() {
    override fun onCreate(): Boolean {
        val prefs = context!!.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        Failpoints.hook = { hit ->
            if (prefs.getString("name", null) == hit) {
                val skip = prefs.getInt("skip", 0)
                if (skip > 0) {
                    prefs.edit().putInt("skip", skip - 1).commit()
                } else {
                    prefs.edit().clear().commit() // used up: the next process runs normally
                    Log.i(TAG, "failpoint $hit: killing the process")
                    Process.killProcess(Process.myPid())
                }
            }
        }
        return true
    }

    override fun query(uri: Uri, p: Array<String>?, s: String?, a: Array<String>?, o: String?): Cursor? = null
    override fun getType(uri: Uri): String? = null
    override fun insert(uri: Uri, values: ContentValues?): Uri? = null
    override fun delete(uri: Uri, s: String?, a: Array<String>?): Int = 0
    override fun update(uri: Uri, values: ContentValues?, s: String?, a: Array<String>?): Int = 0
}

/**
 * DEBUG BUILDS ONLY: drives the app from `adb shell am broadcast -n com.aboutobjects.healthgate/.debug.DebugControlReceiver -a <action>`.
 * ARM (`--es name <failpoint> --ei skip <n>`), DISARM, RUN (one sync, as the background worker would), RESET_TOKEN (the next read takes the
 * window again), STATUS. Answers go to logcat under the tag HGDebug and are counts and words only.
 */
class DebugControlReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val app = context.applicationContext as HealthGateApplication
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        when (intent.action) {
            "com.aboutobjects.healthgate.debug.ARM" -> {
                prefs.edit().putString("name", intent.getStringExtra("name")).putInt("skip", intent.getIntExtra("skip", 0)).commit()
                Log.i(TAG, "armed ${intent.getStringExtra("name")} skip ${intent.getIntExtra("skip", 0)}")
            }
            "com.aboutobjects.healthgate.debug.DISARM" -> { prefs.edit().clear().commit(); Log.i(TAG, "disarmed") }
            "com.aboutobjects.healthgate.debug.RESET_TOKEN" -> { app.container.collectorState.token = null; Log.i(TAG, "token cleared") }
            "com.aboutobjects.healthgate.debug.ENQUEUE_WORKER" -> {
                // the same worker the periodic schedule runs, now, as a one-time job (WorkManager will not run a periodic job early, even when forced)
                androidx.work.WorkManager.getInstance(context).enqueue(androidx.work.OneTimeWorkRequestBuilder<com.aboutobjects.healthgate.sync.SyncWorker>().build())
                Log.i(TAG, "one-time SyncWorker enqueued")
            }
            "com.aboutobjects.healthgate.debug.STATUS" -> {
                val c = app.container.queue.counts()
                Log.i(TAG, "queue pending ${c.pending} sent ${c.sent} rejected ${c.rejected} skipped ${c.skipped} deleted ${c.deleted}; token ${if (app.container.collectorState.token == null) "none" else "set"}")
            }
            "com.aboutobjects.healthgate.debug.RUN" -> {
                val pending = goAsync()
                CoroutineScope(Dispatchers.Default).launch {
                    try {
                        // a sampler every 20 ms around the run: the peak is what matters on a 4 GB phone, and dumpsys is too slow to see it
                        var peakPssKb = 0
                        var peakHeapKb = 0L
                        var samples = 0
                        val begun = System.nanoTime()
                        val sampler = launch {
                            val info = android.os.Debug.MemoryInfo()
                            val rt = Runtime.getRuntime()
                            while (true) {
                                android.os.Debug.getMemoryInfo(info)
                                peakPssKb = maxOf(peakPssKb, info.totalPss)
                                peakHeapKb = maxOf(peakHeapKb, (rt.totalMemory() - rt.freeMemory()) / 1024)
                                samples++
                                kotlinx.coroutines.delay(20)
                            }
                        }
                        val r = app.container.runner.run("Debug")
                        sampler.cancel()
                        Log.i(TAG, "memory: peak total PSS ${peakPssKb / 1024} MB, peak Java heap in use ${peakHeapKb / 1024} MB, ${samples} samples in ${(System.nanoTime() - begun) / 1_000_000} ms")
                        val q = app.container.queue.counts()
                        Log.i(TAG, "run done: paused ${r.paused} busy ${r.busy} records ${r.collected?.recordsUpserted} deleted ${r.collected?.recordsDeleted} " +
                            "queued ${r.collected?.samplesQueued} failure ${r.collected?.failure} phase ${r.upload?.phase?.javaClass?.simpleName}; " +
                            "queue pending ${q.pending} sent ${q.sent} deleted ${q.deleted}")
                    } finally {
                        pending.finish()
                    }
                }
            }
        }
    }
}
