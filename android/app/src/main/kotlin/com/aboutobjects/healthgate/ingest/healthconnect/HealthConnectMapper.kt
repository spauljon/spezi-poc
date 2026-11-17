package com.aboutobjects.healthgate.ingest.healthconnect

import com.aboutobjects.healthgate.contract.Meal
import com.aboutobjects.healthgate.contract.MetricRegistry
import com.aboutobjects.healthgate.ingest.IngestItem
import com.aboutobjects.healthgate.mapping.DeviceDescriptor
import com.aboutobjects.healthgate.mapping.Measurement
import com.aboutobjects.healthgate.mapping.MappingError
import com.aboutobjects.healthgate.mapping.MappingException
import com.aboutobjects.healthgate.mapping.MetricSample
import com.aboutobjects.healthgate.mapping.SampleSource
import java.math.BigDecimal
import java.security.MessageDigest
import java.time.Instant
import java.time.ZoneId
import java.time.ZoneOffset

/**
 * A Health Connect record as [IngestItem]s, by the contract's `healthConnect` rules (contract 1.7.0, decision A11). Pure: no clock, no
 * Android class. Quality flags other than `user-entered` are NOT set here (they are `QualityFlagger`'s, applied before queueing).
 *
 * - Sample identity: SHA-256 over `hc-sample`, the record id, the sample time in ms and the metric id (no value: an edit is an update).
 * - Group: the record id; for a nutrition item `<content key>#<n>`, the ordinal supplied by the caller (it depends on the other live records).
 * - A record that cannot be identified or holds an impossible value is refused as a whole with the contract's error code.
 */
class HealthConnectMapper(private val registry: MetricRegistry) {

    private val sep = "\u001f"
    private val sleep = registry.sleep?.healthConnect ?: throw MappingException(MappingError.CONTRACT_MISSING, "sleepStage.healthConnect")
    private val stageIds: Map<String, String> = sleep.stages.orEmpty().flatMap { (stage, types) -> types.map { it to stage } }.toMap()
    private val nutritionMetrics = registry.metrics.filter { it.kind == "intake" && it.healthConnect?.record == "NutritionRecord" }
    private val hydration = registry.metric("dietaryWater") ?: throw MappingException(MappingError.CONTRACT_MISSING, "dietaryWater")

    init {
        for (key in MEAL_BY_CODE.values + OTHER_MEAL) {
            if (!registry.mealTypes.containsKey(key)) throw MappingException(MappingError.CONTRACT_MISSING, "mealType $key")
        }
    }

    /** The content key of a nutrition record: what makes a re-created record the same item (contract `nutritionContentKey`). */
    fun contentKey(r: HcRecord.Nutrition): String {
        val fields = ArrayList<String>()
        fields += "hc-content"
        fields += r.origin.trim()
        fields += MEAL_BY_CODE[r.mealType] ?: if (r.mealType == 0) "" else OTHER_MEAL
        fields += r.startTime.toEpochMilli().toString()
        fields += r.endTime.toEpochMilli().toString()
        for (m in nutritionMetrics) {
            val v = r.nutrients[m.healthConnect!!.field] ?: continue
            fields += "${m.id}=${canonicalValue(v)}"
        }
        return sha256(fields.joinToString(sep))
    }

    /** The device a record's Observations are attributed to: its own device, else the app that wrote it. */
    fun descriptor(r: HcRecord): DeviceDescriptor {
        val d = r.device
        val manufacturer = (d?.manufacturer ?: "").trim()
        val model = (d?.model ?: "").trim()
        if (d != null && (manufacturer.isNotEmpty() || model.isNotEmpty())) {
            return DeviceDescriptor.HealthConnectDevice(manufacturer.ifEmpty { null }, model.ifEmpty { null }, DEVICE_TYPES[d.type] ?: "unknown")
        }
        if (r.origin.isBlank()) throw MappingException(MappingError.BLANK_PACKAGE_NAME)
        return DeviceDescriptor.OriginApp(r.origin.trim())
    }

    /**
     * The samples of one record. [phoneZone] stands in for a missing offset (assumption A45); [issued] is the caller's clock;
     * [nutritionGroup] is required for a nutrition record (`<content key>#<n>`).
     */
    fun items(record: HcRecord, issued: Instant, phoneZone: ZoneId, nutritionGroup: String? = null): List<IngestItem> {
        if (record.id.isBlank()) throw MappingException(MappingError.EMPTY_RECORD_ID)
        val device = descriptor(record)
        val userEntered = record.recordingMethod == MANUAL_ENTRY
        fun zone(o: ZoneOffset?): ZoneId = o ?: phoneZone

        fun sample(m: Measurement, start: Instant, end: Instant, startZone: ZoneId, endZone: ZoneId, id: String, group: String, meal: Meal? = null) =
            IngestItem(
                MetricSample(
                    measurement = m, start = start, end = end, issued = issued, timeZone = startZone, endTimeZone = endZone.takeIf { it != startZone },
                    source = SampleSource.HEALTH_CONNECT, id = id, userEntered = userEntered, meal = meal, group = group,
                ),
                device,
            )

        return when (record) {
            is HcRecord.HeartRate -> record.samples.map { s ->
                if (s.beatsPerMinute <= 0) throw MappingException(MappingError.NON_POSITIVE_VALUE)
                val z = zone(record.startOffset)
                sample(Measurement.Quantity("heartRate", s.beatsPerMinute), s.time, s.time, z, z, identity(record.id, s.time, "heartRate"), record.id)
            }

            is HcRecord.Instantaneous -> {
                if (record.value <= 0) throw MappingException(MappingError.NON_POSITIVE_VALUE)
                val z = zone(record.offset)
                listOf(sample(Measurement.Quantity(record.kind.metricId, record.value), record.time, record.time, z, z, identity(record.id, record.time, record.kind.metricId), record.id))
            }

            is HcRecord.Sleep -> record.stages.mapNotNull { st ->
                val stage = stageIds[st.stageType] ?: return@mapNotNull null // out of bed, unknown or anything the contract does not map: no Observation
                if (!st.endTime.isAfter(st.startTime)) throw MappingException(MappingError.EMPTY_SLEEP_INTERVAL)
                sample(Measurement.Sleep(stage), st.startTime, st.endTime, zone(record.startOffset), zone(record.endOffset), identity(record.id, st.startTime, "sleepStage"), record.id)
            }

            is HcRecord.Hydration -> {
                if (record.milliliters < 0) throw MappingException(MappingError.NEGATIVE_VALUE)
                listOf(sample(Measurement.Quantity(hydration.id, record.milliliters), record.startTime, record.endTime, zone(record.startOffset), zone(record.endOffset),
                    identity(record.id, record.startTime, hydration.id), record.id))
            }

            is HcRecord.Nutrition -> {
                val group = nutritionGroup ?: throw MappingException(MappingError.EMPTY_SAMPLE_ID, "nutrition group")
                val code = MEAL_BY_CODE[record.mealType] ?: if (record.mealType == 0) null else OTHER_MEAL
                val meal = code?.let { Meal(it, registry.mealTypes.getValue(it).display) }
                nutritionMetrics.mapNotNull { m ->
                    val v = record.nutrients[m.healthConnect!!.field] ?: return@mapNotNull null
                    if (v < 0) throw MappingException(MappingError.NEGATIVE_VALUE)
                    sample(Measurement.Quantity(m.id, v), record.startTime, record.endTime, zone(record.startOffset), zone(record.endOffset),
                        sha256(listOf("hc-nutrient", group, m.id).joinToString(sep)), group, meal)
                }
            }
        }
    }

    private fun identity(recordId: String, time: Instant, metricId: String): String =
        sha256(listOf("hc-sample", recordId, time.toEpochMilli().toString(), metricId).joinToString(sep))

    companion object {
        /** `metadata.recordingMethod` of a value a person typed in. */
        const val MANUAL_ENTRY = 3

        private const val OTHER_MEAL = "other"

        /** `NutritionRecord.MEAL_TYPE_*` to the contract's meal-type code; 0 (unknown) is no meal, any other number is `other`. */
        private val MEAL_BY_CODE = mapOf(1 to "breakfast", 2 to "lunch", 3 to "dinner", 4 to "snack")

        /** `Device.TYPE_*` to the contract's type name (healthConnect.device). */
        private val DEVICE_TYPES = mapOf(
            0 to "unknown", 1 to "watch", 2 to "phone", 3 to "scale", 4 to "ring", 5 to "head_mounted", 6 to "fitness_band", 7 to "chest_strap", 8 to "smart_display",
        )

        /** contract `healthConnect.canonicalValue`: the shortest decimal that reads back as the same double, plain notation, no trailing zeros. */
        fun canonicalValue(value: Double): String {
            val d = BigDecimal(value.toString())
            return (if (d.signum() == 0) BigDecimal.ZERO else d.stripTrailingZeros()).toPlainString()
        }

        fun sha256(text: String): String =
            MessageDigest.getInstance("SHA-256").digest(text.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
    }
}
