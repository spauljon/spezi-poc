package com.aboutobjects.healthgate.probe

import android.content.Context

/** Remembers, per type, the hash prefixes of the record ids seen in the previous read. It stores no id, no record and no value. */
class IdLedger(context: Context) {
    private val prefs = context.getSharedPreferences("id-ledger", Context.MODE_PRIVATE)

    /** The hashes from the previous read of [label], or null if there was none. */
    fun previous(label: String): Set<String>? = prefs.getStringSet(label, null)

    fun remember(label: String, hashes: Collection<String>) {
        prefs.edit().putStringSet(label, hashes.take(CAP).toSet()).apply()
    }

    private companion object {
        const val CAP = 50_000
    }
}
