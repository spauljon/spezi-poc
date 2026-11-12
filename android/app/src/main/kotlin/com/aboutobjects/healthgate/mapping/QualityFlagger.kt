package com.aboutobjects.healthgate.mapping

import com.aboutobjects.healthgate.contract.MetricRegistry
import com.aboutobjects.healthgate.contract.PlausibleRange
import java.time.Duration

/**
 * Sets the quality flags of a sample in ONE place (contract rules `artifactSuspected` and `lateArrival`), never in a source or the
 * mapper. A flag never drops or alters a value; an existing flag is never cleared. Ranges and the late threshold are the contract's.
 */
class QualityFlagger(registry: MetricRegistry) {
    private val ranges: Map<String, PlausibleRange> = registry.metrics.mapNotNull { m -> m.plausibleRange?.let { m.id to it } }.toMap()
    private val lateAfter: Duration = Duration.ofMillis((registry.qualityThresholds.lateArrivalHours * 3_600_000).toLong())

    /** Strictly outside the range (a value on a bound is plausible); sleep has no range. */
    fun isArtifact(sample: MetricSample): Boolean {
        val m = sample.measurement as? Measurement.Quantity ?: return false
        val range = ranges[m.metricId] ?: return false
        return m.value < range.min || m.value > range.max
    }

    /** Issued strictly more than the threshold after the sample ended. */
    fun isLate(sample: MetricSample): Boolean = Duration.between(sample.end, sample.issued) > lateAfter

    fun applied(sample: MetricSample): MetricSample =
        sample.copy(artifactSuspected = sample.artifactSuspected || isArtifact(sample), lateArrival = sample.lateArrival || isLate(sample))
}
