package com.aboutobjects.healthgate.settings

import android.content.Context
import com.aboutobjects.healthgate.sync.Attempt
import com.aboutobjects.healthgate.sync.AttemptStore
import java.time.Instant
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json

/** Whether the user paused syncing. Kept across the app being killed, because a background run must honour it too. */
interface PauseStore {
    var paused: Boolean
}

class PrefsPauseStore(context: Context) : PauseStore {
    private val prefs = context.getSharedPreferences("sync_settings", Context.MODE_PRIVATE)

    override var paused: Boolean
        get() = prefs.getBoolean("paused", false)
        set(value) { prefs.edit().putBoolean("paused", value).commit() }
}

@Serializable
private data class StoredAttempt(val atMs: Long, val summary: String)

/** The attempt history in app-private preferences: a few lines of words (never a value, a name or a token), so it survives a kill. */
class PrefsAttemptStore(context: Context) : AttemptStore {
    private val prefs = context.getSharedPreferences("sync_attempts", Context.MODE_PRIVATE)
    private val json = Json { ignoreUnknownKeys = true }
    private val serializer = ListSerializer(StoredAttempt.serializer())

    override fun load(): List<Attempt> = try {
        prefs.getString("history", null)?.let { json.decodeFromString(serializer, it) }?.map { Attempt(Instant.ofEpochMilli(it.atMs), it.summary) } ?: emptyList()
    } catch (e: Exception) {
        emptyList() // an unreadable history is lost, never a reason to stop syncing
    }

    override fun save(history: List<Attempt>) {
        prefs.edit().putString("history", json.encodeToString(serializer, history.map { StoredAttempt(it.at.toEpochMilli(), it.summary) })).commit()
    }
}
