package com.aboutobjects.healthgate.ingest

/**
 * Which patient a sample is filed under (M30, the Android counterpart of iOS's per-source patient). Real data and test data are
 * never filed under the same patient, so a rollup or a night can never blend them. A route with no patient configured is HELD:
 * its samples stay in the queue and are never sent anywhere else.
 */
enum class PatientRoute(val key: String) {
    /** Synthetic and test records: the synthetic generator, and records written by the `:writer` test tool. */
    TEST("test"),

    /** Records written by any other app on the phone (the developer's own data). */
    REAL("real");

    companion object {
        fun fromKey(key: String?): PatientRoute = entries.firstOrNull { it.key == key } ?: TEST
    }
}

/** The data origins (package names) whose Health Connect records are test records, whatever their content. */
object TestOrigins {
    const val WRITER = "com.aboutobjects.healthgate.writer"
    val all: Set<String> = setOf(WRITER)
}
