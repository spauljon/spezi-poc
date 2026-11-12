@file:OptIn(ExperimentalSerializationApi::class)

package com.aboutobjects.healthgate.mapping

import com.aboutobjects.healthgate.contract.Coding
import com.aboutobjects.healthgate.contract.Metric
import com.aboutobjects.healthgate.contract.MetricRegistry
import com.aboutobjects.healthgate.fhir.FhirDateTime
import java.math.BigDecimal
import java.math.RoundingMode
import java.time.Instant
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.JsonUnquotedLiteral
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

sealed interface MappingOutcome {
    data class Observation(val resource: JsonObject) : MappingOutcome

    /** The stage has no verified LOINC code (assumption A4): stored nowhere. */
    data class Unmapped(val stage: String) : MappingOutcome
}

/**
 * A [MetricSample] as a FHIR R4 `Observation`, by the contract's rules (the Kotlin counterpart of iOS's `ObservationMapper`).
 * The result is a JSON tree, so the golden fixtures can be compared to it exactly.
 */
class ObservationMapper(private val registry: MetricRegistry) {

    /**
     * @param patientId the server-assigned `Patient` id.
     * @param deviceReference a reference to the emitting `Device`, e.g. `Device/123`, or null when not known.
     */
    fun map(sample: MetricSample, patientId: String, deviceReference: String? = null): MappingOutcome {
        if (patientId.isBlank()) throw MappingException(MappingError.EMPTY_PATIENT_ID)
        val sampleId = sample.id.trim()
        if (sampleId.isEmpty()) throw MappingException(MappingError.EMPTY_SAMPLE_ID)
        if (sample.end.isBefore(sample.start)) throw MappingException(MappingError.END_BEFORE_START)

        when (val m = sample.measurement) {
            is Measurement.Quantity -> {
                val metric = registry.metric(m.metricId) ?: throw MappingException(MappingError.CONTRACT_MISSING, m.metricId)
                val code = codeConcept(metric) ?: throw MappingException(MappingError.CONTRACT_MISSING, m.metricId)
                if (!m.value.isFinite()) throw MappingException(MappingError.NON_FINITE_VALUE)
                // contract rules.value: strictly positive, except an intake, where zero is stored as given. Negative: never.
                if (metric.zeroAllowed == true) {
                    if (m.value < 0) throw MappingException(MappingError.NEGATIVE_VALUE)
                } else if (m.value <= 0) {
                    throw MappingException(MappingError.NON_POSITIVE_VALUE)
                }
                val quantity = quantity(decimal(m.value), metric.unit.display, metric.unit.ucum)
                val period = metric.effective == "period" || sample.start != sample.end
                return MappingOutcome.Observation(build(sample, sampleId, metric, code, quantity, period, patientId, deviceReference))
            }

            is Measurement.Sleep -> {
                val sleep = registry.sleep ?: throw MappingException(MappingError.CONTRACT_MISSING, "sleepStage")
                val coding: Coding = sleep.stages?.get(m.stage) ?: return MappingOutcome.Unmapped(m.stage)
                if (!sample.end.isAfter(sample.start)) throw MappingException(MappingError.EMPTY_SLEEP_INTERVAL)
                val quantity = quantity(minutes(sample.start, sample.end), sleep.unit.display, sleep.unit.ucum)
                val code = buildJsonObject {
                    put("coding", buildJsonArray { add(coding(registry.systems.loinc, coding.code, coding.display)) })
                }
                return MappingOutcome.Observation(build(sample, sampleId, sleep, code, quantity, true, patientId, deviceReference))
            }
        }
    }

    /** `Observation.code` of a quantity or intake metric (contract rules.intakeCode): LOINC when it has a code, else the project's own. */
    private fun codeConcept(metric: Metric): JsonObject? {
        metric.loinc?.let { loinc ->
            return buildJsonObject { put("coding", buildJsonArray { add(coding(registry.systems.loinc, loinc.code, loinc.display)) }) }
        }
        val custom = metric.customCode ?: return null
        val system = registry.customSystem(custom.system) ?: return null
        return buildJsonObject {
            put("coding", buildJsonArray { add(coding(system, custom.code, null)) })
            put("text", custom.display)
        }
    }

    /**
     * `Observation.category` (contract rules.domain and rules.mealType): an intake is classified by its domain, and by its meal as
     * a SEPARATE entry; every other metric keeps its single HL7 category.
     */
    private fun categories(metric: Metric, sample: MetricSample): JsonArray = buildJsonArray {
        val domainKey = metric.domain
        if (domainKey != null) {
            val domain = registry.domains[domainKey] ?: throw MappingException(MappingError.CONTRACT_MISSING, "domain $domainKey")
            add(buildJsonObject { put("coding", buildJsonArray { add(coding(registry.systems.observationDomain, domain.code, domain.display)) }) })
            sample.meal?.let { meal ->
                add(buildJsonObject {
                    put("coding", buildJsonArray { add(coding(registry.systems.mealType, meal.code, null)) })
                    put("text", meal.label)
                })
            }
            return@buildJsonArray
        }
        val key = metric.category
        val category = key?.let { registry.categories[it] } ?: throw MappingException(MappingError.CONTRACT_MISSING, "category ${key ?: "?"}")
        add(buildJsonObject { put("coding", buildJsonArray { add(coding(registry.systems.observationCategory, category.code, category.display)) }) })
    }

    private fun build(
        sample: MetricSample, sampleId: String, metric: Metric, code: JsonObject, value: JsonObject, period: Boolean,
        patientId: String, deviceReference: String?,
    ): JsonObject {
        val identifierSystem = registry.systems.identifier[sample.source] ?: throw MappingException(MappingError.CONTRACT_MISSING, "identifier ${sample.source}")
        val metaSource = registry.systems.metaSource[sample.source] ?: throw MappingException(MappingError.CONTRACT_MISSING, "metaSource ${sample.source}")
        // HealthKit UUIDs are lowercased so identity does not depend on which API produced the string (assumption A16)
        val identifierValue = if (sample.source == SampleSource.HEALTH_KIT) sampleId.lowercase() else sampleId

        val effective: Pair<String, JsonElement> = if (period) {
            "effectivePeriod" to buildJsonObject {
                put("start", format(sample.start, sample))
                put("end", format(sample.end, sample))
            }
        } else {
            "effectiveDateTime" to JsonPrimitive(format(sample.start, sample))
        }
        val issued = format(sample.issued, sample, alwaysMillis = true)
        val tags = qualityTags(sample)

        return buildJsonObject {
            put("resourceType", "Observation")
            put("meta", buildJsonObject {
                put("source", metaSource)
                if (tags.isNotEmpty()) put("tag", tags)
            })
            put("identifier", buildJsonArray {
                add(buildJsonObject { put("system", identifierSystem); put("value", identifierValue) })
            })
            put("status", "final")
            put("category", categories(metric, sample))
            put("code", code)
            put("subject", buildJsonObject { put("reference", "Patient/$patientId") })
            put(effective.first, effective.second)
            put("issued", issued)
            put("valueQuantity", value)
            if (deviceReference != null) put("device", buildJsonObject { put("reference", deviceReference) })
        }
    }

    /** The flags a sample carries, in ascending order of code (rule `tagOrder`). A flag sits beside the value; it never alters it. */
    private fun qualityTags(sample: MetricSample): JsonArray {
        val present = listOf(
            sample.userEntered to "userEntered", sample.artifactSuspected to "artifactSuspected",
            sample.duplicateResolved to "duplicateResolved", sample.lateArrival to "lateArrival",
        )
        val codes = present.mapNotNull { (flag, key) -> if (flag) registry.dataQualityFlags[key] else null }.sorted()
        return buildJsonArray {
            for (c in codes) add(buildJsonObject { put("system", registry.systems.dataQualityFlag); put("code", c) })
        }
    }

    private fun format(instant: Instant, sample: MetricSample, alwaysMillis: Boolean = false): String = try {
        FhirDateTime.string(instant, sample.timeZone, alwaysMillis)
    } catch (e: FhirDateTime.OffsetNotWholeMinutes) {
        throw MappingException(MappingError.OFFSET_NOT_WHOLE_MINUTES)
    }

    private fun quantity(value: BigDecimal, unit: String, ucum: String): JsonObject = buildJsonObject {
        put("value", JsonUnquotedLiteral(plain(value)))
        put("unit", unit)
        put("system", registry.systems.ucum)
        put("code", ucum)
    }

    private fun coding(system: String, code: String, display: String?): JsonObject = buildJsonObject {
        put("system", system)
        put("code", code)
        if (display != null) put("display", display)
    }

    private companion object {
        /** A double as the shortest decimal that round-trips, so 72.0 is 72 and 48.3 is 48.3 (not 48.2999999...). */
        fun decimal(value: Double): BigDecimal = BigDecimal(value.toString())

        /** A number in plain notation: no exponent and no trailing zeros ("450", "72.5", "0"). */
        fun plain(value: BigDecimal): String = (if (value.signum() == 0) BigDecimal.ZERO else value.stripTrailingZeros()).toPlainString()

        /** Minutes between two instants from whole milliseconds, rounded half-up to 2 decimals (rules.sleepDuration). */
        fun minutes(start: Instant, end: Instant): BigDecimal {
            val millis = end.toEpochMilli() - start.toEpochMilli()
            return BigDecimal(millis).divide(BigDecimal(60_000), 2, RoundingMode.HALF_UP)
        }
    }
}
