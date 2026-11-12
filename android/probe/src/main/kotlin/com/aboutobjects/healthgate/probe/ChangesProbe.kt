package com.aboutobjects.healthgate.probe

import android.content.Context
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.changes.DeletionChange
import androidx.health.connect.client.changes.UpsertionChange
import androidx.health.connect.client.request.ChangesTokenRequest

/**
 * Measures how Health Connect reports changes: how many upserts per type, how many deletions, and how often a
 * record that was already delivered in an earlier run arrives again (a record that grows or is edited).
 * Only a hash prefix of each record id is stored, never an id, a value or a record.
 */
class ChangesProbe(private val context: Context) {
    private val prefs get() = context.getSharedPreferences("changes-probe", Context.MODE_PRIVATE)

    suspend fun takeToken(client: HealthConnectClient): String {
        val token = client.getChangesToken(ChangesTokenRequest(recordTypes = ProbeTypes.all.map { it.kClass }.toSet()))
        prefs.edit().putString("token", token).putStringSet("seen", emptySet()).apply()
        return "Changes token taken. Add or change data, then read changes."
    }

    suspend fun readChanges(client: HealthConnectClient): String {
        var token = prefs.getString("token", null) ?: return "No token yet: take one first."
        val seen = (prefs.getStringSet("seen", emptySet()) ?: emptySet()).toMutableSet()
        val upserts = sortedMapOf<String, Int>()
        val repeats = sortedMapOf<String, Int>()
        var deletions = 0
        var expired = false
        var batches = 0
        do {
            val r = client.getChanges(token)
            batches++
            if (r.changesTokenExpired) { expired = true; break }
            for (c in r.changes) {
                when (c) {
                    is UpsertionChange -> {
                        val type = c.record::class.java.simpleName
                        upserts.merge(type, 1, Int::plus)
                        if (!seen.add(Aggregate.idHash(c.record.metadata.id))) repeats.merge(type, 1, Int::plus)
                    }
                    is DeletionChange -> deletions++
                }
            }
            token = r.nextChangesToken
        } while (r.hasMore && batches < 100)
        if (!expired) prefs.edit().putString("token", token).putStringSet("seen", seen.take(50_000).toSet()).apply()
        return buildString {
            appendLine("== Changes since the last token ($batches batch(es))")
            if (expired) appendLine("  token expired: take a new one")
            appendLine("  upserts per type: ${if (upserts.isEmpty()) "none" else upserts.entries.joinToString { "${it.key}: ${it.value}" }}")
            appendLine("  of which already delivered before: ${if (repeats.isEmpty()) "none" else repeats.entries.joinToString { "${it.key}: ${it.value}" }}")
            appendLine("  deletions (ids only): $deletions")
        }
    }
}
