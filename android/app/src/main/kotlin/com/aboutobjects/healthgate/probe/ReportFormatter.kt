package com.aboutobjects.healthgate.probe

/** Turns aggregates into text. It receives only [TypeReport] and numbers: nothing here can see a value. */
object ReportFormatter {
    private fun Stats?.text(): String = if (this == null) "-" else "min $min / median $median / max $max"

    fun format(r: TypeReport): String = buildString {
        appendLine("== ${r.label}")
        if (!r.permitted) {
            appendLine("  read permission not granted")
            return@buildString
        }
        appendLine("  records: ${r.count}${if (r.capped) " (capped: more exist)" else ""}")
        if (r.count == 0) return@buildString
        appendLine("  apps (package: records): ${r.origins.entries.joinToString { "${it.key}: ${it.value}" }}")
        appendLine("  recording method: ${r.recordingMethods.entries.joinToString { "${it.key}: ${it.value}" }}")
        appendLine("  with client record id: ${r.withClientRecordId}; with start offset: ${r.withStartOffset}; with end offset: ${r.withEndOffset}; with device: ${r.withDevice}")
        appendLine("  last modified after end: ${r.updatedAfterEnd}")
        appendLine("  samples per record: ${r.samples.text()}")
        appendLine("  span minutes: ${r.spanMinutes.text()}")
        if (r.fieldCounts.isNotEmpty()) {
            appendLine("  optional fields present (name: records): ${r.fieldCounts.entries.joinToString { "${it.key}: ${it.value}" }}")
        }
        appendLine("  overlapping record pairs from different apps: ${r.overlappingOriginPairs}")
        appendLine("  record ids seen in the previous read: ${r.idsSeenBefore?.let { "$it of ${r.count}" } ?: "no previous read"}")
        if (r.mealTypes.isNotEmpty()) appendLine("  meal types: ${r.mealTypes.entries.joinToString { "${it.key}: ${it.value}" }}")
        appendLine("  start hour of day (record's own offset): ${r.startHours.entries.joinToString { "${it.key}h: ${it.value}" }}")
    }

    fun format(reports: List<TypeReport>, header: String): String =
        header + "\n" + reports.joinToString("\n") { format(it) }
}
