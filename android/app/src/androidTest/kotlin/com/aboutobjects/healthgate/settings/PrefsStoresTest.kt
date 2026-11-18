package com.aboutobjects.healthgate.settings

import androidx.test.platform.app.InstrumentationRegistry
import com.aboutobjects.healthgate.sync.Attempt
import java.time.Instant
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/** Pause and the attempt history must outlive the process: a new instance (a restarted app) reads what the old one wrote. */
class PrefsStoresTest {
    private val context = InstrumentationRegistry.getInstrumentation().targetContext

    private fun wipe() {
        context.getSharedPreferences("sync_settings", android.content.Context.MODE_PRIVATE).edit().clear().commit()
        context.getSharedPreferences("sync_attempts", android.content.Context.MODE_PRIVATE).edit().clear().commit()
    }

    @Before fun before() = wipe()

    @After fun after() = wipe()

    @Test fun pauseIsRememberedByAFreshInstance() {
        assertFalse(PrefsPauseStore(context).paused)
        PrefsPauseStore(context).paused = true
        assertTrue("a restarted app is still paused", PrefsPauseStore(context).paused)
        PrefsPauseStore(context).paused = false
        assertFalse(PrefsPauseStore(context).paused)
    }

    @Test fun theAttemptHistoryRoundTripsInOrder() {
        assertEquals(emptyList<Attempt>(), PrefsAttemptStore(context).load())
        val history = listOf(
            Attempt(Instant.parse("2026-03-10T12:05:00Z"), "Background: read the changes: 1 records, 3 samples queued, 0 deleted"),
            Attempt(Instant.parse("2026-03-10T12:00:00Z"), "Sent 3 (3 created, 0 updated, 0 deleted, 0 already there)"),
        )
        PrefsAttemptStore(context).save(history)
        assertEquals(history, PrefsAttemptStore(context).load())
    }

    @Test fun anUnreadableHistoryIsEmptyAndNeverStopsAnything() {
        context.getSharedPreferences("sync_attempts", android.content.Context.MODE_PRIVATE).edit().putString("history", "{not json").commit()
        assertEquals(emptyList<Attempt>(), PrefsAttemptStore(context).load())
    }
}
