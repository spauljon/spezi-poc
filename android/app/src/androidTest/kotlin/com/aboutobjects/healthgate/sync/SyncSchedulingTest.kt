package com.aboutobjects.healthgate.sync

import androidx.test.platform.app.InstrumentationRegistry
import androidx.work.NetworkType
import androidx.work.WorkInfo
import androidx.work.WorkManager
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Test

/** The background sync is one periodic job every 15 minutes that needs a network, and scheduling twice does not make two. */
class SyncSchedulingTest {
    private val context = InstrumentationRegistry.getInstrumentation().targetContext
    private val work get() = WorkManager.getInstance(context)

    private fun live(): List<WorkInfo> =
        runBlocking { work.getWorkInfosForUniqueWorkFlow(SyncWorker.UNIQUE_NAME).first() }.filter { !it.state.isFinished }

    @Test fun scheduledOnceEvenWhenAskedTwiceAndCancelledWhenPaused() {
        SyncWorker.cancel(context)
        assertEquals("cancelled: nothing is live", 0, live().size)
        SyncWorker.schedule(context)
        SyncWorker.schedule(context)
        val only = live().single()
        assertEquals(WorkInfo.State.ENQUEUED, only.state)
        assertEquals(TimeUnit.MINUTES.toMillis(15), only.periodicityInfo?.repeatIntervalMillis)
        assertEquals(NetworkType.CONNECTED, only.constraints.requiredNetworkType)
        assertNotNull(only.id)
        // the control for "cancelled means none": pausing removes it
        SyncWorker.cancel(context)
        assertEquals(0, live().size)
        SyncWorker.schedule(context) // leave it as the app would have it
    }
}
