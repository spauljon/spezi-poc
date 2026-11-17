package com.aboutobjects.healthgate.mapping

import com.aboutobjects.healthgate.contract.Meal
import java.time.Instant
import java.time.ZoneId

/** Where a sample came from. The values are keys of the contract's `systems.identifier` and `systems.metaSource`. */
object SampleSource {
    const val SYNTHETIC = "synthetic"

    /** Health Connect records (M27): the sample identity is `id`, the record (or nutrition item) is `group`. */
    const val HEALTH_CONNECT = "healthConnect"

    /** Used by the shared golden fixtures (the iOS source); this app does not produce it. */
    const val HEALTH_KIT = "healthKit"
}

sealed interface Measurement {
    /** A quantity or intake metric, by its contract id (for example `heartRate`, `dietaryEnergy`). */
    data class Quantity(val metricId: String, val value: Double) : Measurement

    /** One sleep stage interval, by the contract's stage id (for example `asleepDeep`, `inBed`). */
    data class Sleep(val stage: String) : Measurement
}

/** What a capture source hands the app, before it becomes FHIR (the Kotlin counterpart of iOS's `MetricSample`). */
data class MetricSample(
    val measurement: Measurement,
    val start: Instant,
    val end: Instant,
    /** When the capture app produced this sample (not when the server received it). */
    val issued: Instant,
    /** The zone the sample was taken in: the offset written is this zone's offset at the sample's own instant. */
    val timeZone: ZoneId,
    val source: String,
    /** A stable id for deduplication: the synthetic sample id (or the source's own id). */
    val id: String,
    /** The source says a person typed this value in. Provenance, not a defect (contract rule `userEntered`). */
    val userEntered: Boolean = false,
    /** Outside the metric's plausible range (rule `artifactSuspected`). Stored as given. */
    val artifactSuspected: Boolean = false,
    /** Issued more than the contract's threshold after the sample ended (rule `lateArrival`). */
    val lateArrival: Boolean = false,
    /** Two deliveries met in the queue before upload (rule `duplicateResolved`). */
    val duplicateResolved: Boolean = false,
    /** The meal an intake belongs to, when the source said. `null` is "no meal", never a guess. */
    val meal: Meal? = null,
    /** The thing that produced this sample (Health Connect: the record id, or a nutrition item's `<content key>#<n>`); the second identifier. */
    val group: String? = null,
    /** The zone of [end] when it differs from [timeZone] (a Health Connect record has a start and an end offset of its own). */
    val endTimeZone: ZoneId? = null,
)

/** What a device is, for the `Device` resource and its key (contract `deviceKey`). */
sealed interface DeviceDescriptor {
    data object Synthetic : DeviceDescriptor

    data class HealthKit(
        val name: String?, val manufacturer: String?, val model: String?, val hardwareVersion: String?, val softwareVersion: String?,
    ) : DeviceDescriptor

    /** A sample with no device: it came from an application, keyed by its bundle identifier when it has one. */
    data class SourceApp(val name: String?, val bundleIdentifier: String?) : DeviceDescriptor

    /** Health Connect `metadata.device`: [type] is the contract's type name (`watch`, `fitness_band`, ...). */
    data class HealthConnectDevice(val manufacturer: String?, val model: String?, val type: String) : DeviceDescriptor

    /** A Health Connect record with no usable device: attributed to the app that wrote it, by package name. */
    data class OriginApp(val packageName: String) : DeviceDescriptor
}
