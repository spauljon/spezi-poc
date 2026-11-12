package com.aboutobjects.healthgate.queue

import com.aboutobjects.healthgate.contract.Meal
import com.aboutobjects.healthgate.ingest.IngestItem
import com.aboutobjects.healthgate.mapping.DeviceDescriptor
import com.aboutobjects.healthgate.mapping.Measurement
import com.aboutobjects.healthgate.mapping.MetricSample
import java.time.Instant
import java.time.ZoneId
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/**
 * An [IngestItem] as stored: plain values only (milliseconds, zone id, strings), so a row written by an older build can still be read
 * after the app changes, and a missing flag reads as false.
 */
@Serializable
data class StoredItem(
    val metricId: String? = null,
    val value: Double? = null,
    val stage: String? = null,
    val startMs: Long,
    val endMs: Long,
    val issuedMs: Long,
    val zone: String,
    val source: String,
    val id: String,
    val userEntered: Boolean = false,
    val artifactSuspected: Boolean = false,
    val lateArrival: Boolean = false,
    val duplicateResolved: Boolean = false,
    val mealCode: String? = null,
    val mealLabel: String? = null,
    val deviceKind: String,
    val deviceName: String? = null,
    val deviceManufacturer: String? = null,
    val deviceModel: String? = null,
    val deviceHardware: String? = null,
    val deviceSoftware: String? = null,
    val deviceBundle: String? = null,
) {
    fun toItem(): IngestItem {
        val s = MetricSample(
            measurement = if (stage != null) Measurement.Sleep(stage) else Measurement.Quantity(metricId!!, value!!),
            start = Instant.ofEpochMilli(startMs), end = Instant.ofEpochMilli(endMs), issued = Instant.ofEpochMilli(issuedMs),
            timeZone = ZoneId.of(zone), source = source, id = id,
            userEntered = userEntered, artifactSuspected = artifactSuspected, lateArrival = lateArrival, duplicateResolved = duplicateResolved,
            meal = if (mealCode != null && mealLabel != null) Meal(mealCode, mealLabel) else null,
        )
        val device = when (deviceKind) {
            "synthetic" -> DeviceDescriptor.Synthetic
            "healthKit" -> DeviceDescriptor.HealthKit(deviceName, deviceManufacturer, deviceModel, deviceHardware, deviceSoftware)
            else -> DeviceDescriptor.SourceApp(deviceName, deviceBundle)
        }
        return IngestItem(s, device)
    }

    fun encode(): String = json.encodeToString(serializer(), this)

    companion object {
        private val json = Json { ignoreUnknownKeys = true }

        fun decode(text: String): StoredItem = json.decodeFromString(serializer(), text)

        fun of(item: IngestItem): StoredItem {
            val s = item.sample
            val q = s.measurement as? Measurement.Quantity
            val sl = s.measurement as? Measurement.Sleep
            val d = item.device
            return StoredItem(
                metricId = q?.metricId, value = q?.value, stage = sl?.stage,
                startMs = s.start.toEpochMilli(), endMs = s.end.toEpochMilli(), issuedMs = s.issued.toEpochMilli(),
                zone = s.timeZone.id, source = s.source, id = s.id,
                userEntered = s.userEntered, artifactSuspected = s.artifactSuspected, lateArrival = s.lateArrival, duplicateResolved = s.duplicateResolved,
                mealCode = s.meal?.code, mealLabel = s.meal?.label,
                deviceKind = when (d) { DeviceDescriptor.Synthetic -> "synthetic"; is DeviceDescriptor.HealthKit -> "healthKit"; is DeviceDescriptor.SourceApp -> "sourceApp" },
                deviceName = when (d) { is DeviceDescriptor.HealthKit -> d.name; is DeviceDescriptor.SourceApp -> d.name; else -> null },
                deviceManufacturer = (d as? DeviceDescriptor.HealthKit)?.manufacturer,
                deviceModel = (d as? DeviceDescriptor.HealthKit)?.model,
                deviceHardware = (d as? DeviceDescriptor.HealthKit)?.hardwareVersion,
                deviceSoftware = (d as? DeviceDescriptor.HealthKit)?.softwareVersion,
                deviceBundle = (d as? DeviceDescriptor.SourceApp)?.bundleIdentifier,
            )
        }
    }
}
