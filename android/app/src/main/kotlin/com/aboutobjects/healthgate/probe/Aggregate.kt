package com.aboutobjects.healthgate.probe

/**
 * What the probe keeps about one Health Connect record. There is deliberately no field for a measured
 * value, a food name, a title or a note: only structure (when, which app, which optional fields exist).
 */
data class RecordSummary(
    val origin: String,
    val startMs: Long,
    val endMs: Long,
    val hasClientRecordId: Boolean,
    val hasStartOffset: Boolean,
    val hasEndOffset: Boolean,
    val hasDevice: Boolean,
    val updatedAfterEnd: Boolean,
    val recordingMethod: Int,
    /** Samples in a series, stages in a session, or nutrient fields present: a count, never a value. */
    val samples: Int,
    /** Names of optional fields that are present (never their contents). */
    val fields: Set<String>,
    /** First 8 bytes of SHA-256 of the record id, as hex: enough to ask "seen before?", useless as an id. */
    val idHash: String,
    /** Health Connect's meal type code (0 unknown, 1 breakfast, 2 lunch, 3 dinner, 4 snack), or -1 when the type has none. */
    val mealType: Int,
    /** Hour of day (0..23) of the start, in the record's own zone offset (the phone's zone if the offset is null). */
    val startHour: Int,
)

data class Stats(val min: Long, val median: Long, val max: Long)

data class TypeReport(
    val label: String,
    val permitted: Boolean,
    val count: Int,
    val capped: Boolean,
    val origins: Map<String, Int>,
    val recordingMethods: Map<String, Int>,
    val withClientRecordId: Int,
    val withStartOffset: Int,
    val withEndOffset: Int,
    val withDevice: Int,
    val updatedAfterEnd: Int,
    val samples: Stats?,
    val spanMinutes: Stats?,
    val fieldCounts: Map<String, Int>,
    val overlappingOriginPairs: Int,
    /** Records whose id hash was in the previous read of this type, or null when there was no previous read. */
    val idsSeenBefore: Int?,
    val mealTypes: Map<String, Int>,
    val startHours: Map<Int, Int>,
)

object Aggregate {
    /** Health Connect stamps a modification a few milliseconds after a writer's own end time; only more than this counts as an edit. */
    const val EDIT_TOLERANCE_MS = 60_000L

    fun updatedAfterEnd(lastModifiedMs: Long, endMs: Long): Boolean = lastModifiedMs > endMs + EDIT_TOLERANCE_MS

    private val methodNames = mapOf(
        0 to "UNKNOWN",
        1 to "ACTIVELY_RECORDED",
        2 to "AUTOMATICALLY_RECORDED",
        3 to "MANUAL_ENTRY",
    )

    private val mealNames = mapOf(0 to "UNKNOWN", 1 to "BREAKFAST", 2 to "LUNCH", 3 to "DINNER", 4 to "SNACK")

    fun mealName(code: Int): String = mealNames[code] ?: "OTHER($code)"

    fun idHash(id: String): String =
        java.security.MessageDigest.getInstance("SHA-256").digest(id.toByteArray()).take(8).joinToString("") { "%02x".format(it) }

    fun methodName(code: Int): String = methodNames[code] ?: "OTHER($code)"

    fun stats(values: List<Long>): Stats? {
        if (values.isEmpty()) return null
        val sorted = values.sorted()
        return Stats(sorted.first(), sorted[sorted.size / 2], sorted.last())
    }

    /**
     * Pairs of records from different apps whose intervals intersect (inclusive). Instant records have
     * start == end, so they only overlap at the same millisecond. A sweep over records sorted by start.
     */
    fun overlappingOriginPairs(records: List<RecordSummary>): Int {
        val sorted = records.sortedBy { it.startMs }
        val active = ArrayList<RecordSummary>()
        var pairs = 0
        for (r in sorted) {
            active.removeAll { it.endMs < r.startMs }
            pairs += active.count { it.origin != r.origin }
            active.add(r)
        }
        return pairs
    }

    fun report(
        label: String,
        permitted: Boolean,
        records: List<RecordSummary>,
        capped: Boolean,
        previousIds: Set<String>? = null,
    ): TypeReport {
        val fieldCounts = HashMap<String, Int>()
        records.forEach { r -> r.fields.forEach { fieldCounts.merge(it, 1, Int::plus) } }
        return TypeReport(
            label = label,
            permitted = permitted,
            count = records.size,
            capped = capped,
            origins = records.groupingBy { it.origin }.eachCount().toSortedMap(),
            recordingMethods = records.groupingBy { methodName(it.recordingMethod) }.eachCount().toSortedMap(),
            withClientRecordId = records.count { it.hasClientRecordId },
            withStartOffset = records.count { it.hasStartOffset },
            withEndOffset = records.count { it.hasEndOffset },
            withDevice = records.count { it.hasDevice },
            updatedAfterEnd = records.count { it.updatedAfterEnd },
            samples = stats(records.map { it.samples.toLong() }),
            spanMinutes = stats(records.map { (it.endMs - it.startMs) / 60_000 }),
            fieldCounts = fieldCounts.toSortedMap(),
            overlappingOriginPairs = overlappingOriginPairs(records),
            idsSeenBefore = previousIds?.let { prev -> records.count { it.idHash in prev } },
            mealTypes = records.filter { it.mealType >= 0 }.groupingBy { mealName(it.mealType) }.eachCount().toSortedMap(),
            startHours = records.groupingBy { it.startHour }.eachCount().toSortedMap(),
        )
    }
}
