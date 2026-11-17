package com.aboutobjects.healthgate.ingest.healthconnect

import java.time.Instant
import java.time.ZoneOffset

/** `metadata.device` as Health Connect gives it: [type] is `Device.TYPE_*` (0 unknown, 1 watch, ... 8 smart display). */
data class HcDevice(val manufacturer: String?, val model: String?, val type: Int)

/**
 * A Health Connect record reduced to what the contract reads, as plain values (no Android class), so the mapper and the collector run
 * on the JVM and are tested against the golden fixtures. The Android adapter ([AndroidHealthConnectGateway]) builds these from the
 * library's records; the units are already the contract's (kilocalories, grams, milligrams, milliliters).
 */
sealed interface HcRecord {
    val id: String

    /** The package name of the app that wrote the record. */
    val origin: String

    /** `metadata.recordingMethod`: 0 unknown, 1 actively recorded, 2 automatically recorded, 3 manual entry. */
    val recordingMethod: Int
    val device: HcDevice?

    data class HeartRateSample(val time: Instant, val beatsPerMinute: Double)

    data class HeartRate(
        override val id: String, override val origin: String, override val recordingMethod: Int, override val device: HcDevice?,
        val startTime: Instant, val endTime: Instant, val startOffset: ZoneOffset?, val endOffset: ZoneOffset?,
        val samples: List<HeartRateSample>,
    ) : HcRecord

    /** A record of one reading at one instant: resting heart rate (beats per minute) or heart-rate variability (RMSSD milliseconds). */
    data class Instantaneous(
        override val id: String, override val origin: String, override val recordingMethod: Int, override val device: HcDevice?,
        val kind: Kind, val time: Instant, val offset: ZoneOffset?, val value: Double,
    ) : HcRecord {
        enum class Kind(val metricId: String) { RESTING_HEART_RATE("restingHeartRate"), HRV_RMSSD("hrvRmssd") }
    }

    data class SleepStage(val stageType: String, val startTime: Instant, val endTime: Instant)

    data class Sleep(
        override val id: String, override val origin: String, override val recordingMethod: Int, override val device: HcDevice?,
        val startTime: Instant, val endTime: Instant, val startOffset: ZoneOffset?, val endOffset: ZoneOffset?,
        val stages: List<SleepStage>,
    ) : HcRecord

    data class Hydration(
        override val id: String, override val origin: String, override val recordingMethod: Int, override val device: HcDevice?,
        val startTime: Instant, val endTime: Instant, val startOffset: ZoneOffset?, val endOffset: ZoneOffset?,
        val milliliters: Double,
    ) : HcRecord

    /** One food item. [nutrients] is keyed by the contract's `healthConnect.field` (`energy`, `protein`, ...); a nutrient the record lacks is absent, not zero. */
    data class Nutrition(
        override val id: String, override val origin: String, override val recordingMethod: Int, override val device: HcDevice?,
        val startTime: Instant, val endTime: Instant, val startOffset: ZoneOffset?, val endOffset: ZoneOffset?,
        val mealType: Int, val nutrients: Map<String, Double>,
    ) : HcRecord
}
