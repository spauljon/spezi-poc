package com.aboutobjects.healthgate.fhir

import java.time.Instant
import java.time.ZoneId
import java.util.Locale

/** FHIR dateTime strings (contract rules.effective and rules.issued). */
object FhirDateTime {
    /** FHIR offsets are whole minutes; a zone whose offset at this instant is not (historical local mean time) is refused. */
    class OffsetNotWholeMinutes : Exception("the offset is not a whole number of minutes")

    /**
     * The instant in [zone], with that zone's numeric offset AT THAT INSTANT (never `Z`). The fraction is omitted when it is
     * zero, unless [alwaysMillis] (`issued` always has three digits).
     */
    fun string(instant: Instant, zone: ZoneId, alwaysMillis: Boolean = false): String {
        // whole milliseconds, so no sub-millisecond noise reaches the string
        val whole = Instant.ofEpochMilli(instant.toEpochMilli())
        val local = whole.atZone(zone)
        val offsetSeconds = local.offset.totalSeconds
        if (offsetSeconds % 60 != 0) throw OffsetNotWholeMinutes()
        val sign = if (offsetSeconds >= 0) "+" else "-"
        val minutes = Math.abs(offsetSeconds) / 60
        val millis = local.nano / 1_000_000
        val fraction = if (millis != 0 || alwaysMillis) ".%03d".format(Locale.ROOT, millis) else ""
        return "%04d-%02d-%02dT%02d:%02d:%02d%s%s%02d:%02d".format(
            Locale.ROOT, local.year, local.monthValue, local.dayOfMonth, local.hour, local.minute, local.second,
            fraction, sign, minutes / 60, minutes % 60,
        )
    }
}
