package com.aboutobjects.healthgate.ingest

import com.aboutobjects.healthgate.contract.MetricRegistry
import com.aboutobjects.healthgate.mapping.DeviceDescriptor
import com.aboutobjects.healthgate.mapping.Measurement
import com.aboutobjects.healthgate.mapping.MetricSample
import com.aboutobjects.healthgate.mapping.SampleSource
import java.time.Duration
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.ZonedDateTime
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToLong
import kotlin.math.sin

/** What the synthetic generator produces, fully described by these numbers (no clock, no global randomness). */
data class SyntheticConfig(
    val seed: Long = 1L,
    /** The zone the synthetic person lives in: day boundaries, meal times and the night are local to it. */
    val zone: ZoneId = ZoneId.of("UTC"),
    val heartRateEveryMinutes: Int = 5,
) {
    init {
        require(heartRateEveryMinutes in 1..60 && 60 % heartRateEveryMinutes == 0) { "heartRateEveryMinutes must divide an hour" }
    }
}

/**
 * Synthetic capture data for development, tests and the emulator (root CLAUDE.md: a synthetic source behind the same ingest
 * interface as the real one). It is a PURE FUNCTION of (config, window, issued): no clock, no global randomness, no state between
 * calls, so the same call always gives the same samples with the same ids, and an overlapping window repeats ids instead of
 * duplicating data. Five metrics: heart rate, resting heart rate, HRV (RMSSD), sleep stages and the dietary intakes.
 * It injects no faults (M26); ranges come from the contract.
 */
class SyntheticGenerator(private val registry: MetricRegistry) {

    fun generate(config: SyntheticConfig, from: Instant, to: Instant, issued: Instant): List<IngestItem> {
        require(!to.isBefore(from)) { "the window ends before it starts" }
        val out = ArrayList<IngestItem>()
        val device = DeviceDescriptor.Synthetic
        fun add(sample: MetricSample) = out.add(IngestItem(sample, device))
        fun quantity(metric: String, value: Double, start: Instant, end: Instant, idKey: String, meal: com.aboutobjects.healthgate.contract.Meal? = null) =
            MetricSample(Measurement.Quantity(metric, value), start, end, issued, config.zone, SampleSource.SYNTHETIC, "syn-${config.seed}-$idKey", meal = meal)

        // --- heart rate: one reading on every grid point inside the window, lower in the night, higher by day
        val step = Duration.ofMinutes(config.heartRateEveryMinutes.toLong())
        var t = ceilTo(from, step)
        while (t < to) {
            val local = t.atZone(config.zone)
            val hour = local.hour + local.minute / 60.0
            val base = 64.0 + 11.0 * sin(2 * PI * (hour - 9.0) / 24.0) - if (hour < 6.5) 9.0 else 0.0
            val value = clamp("heartRate", base + 8.0 * (unit(config.seed, "hr", t.epochSecond) - 0.5))
            add(quantity("heartRate", value.roundToLong().toDouble(), t, t, "heartRate-${t.epochSecond}"))
            t = t.plus(step)
        }

        // --- per local day: resting heart rate (the day as a period), HRV after the night, the three meals
        var day: LocalDate = from.atZone(config.zone).toLocalDate().minusDays(1)
        val lastDay = to.atZone(config.zone).toLocalDate()
        while (!day.isAfter(lastDay)) {
            val dayStart = day.atStartOfDay(config.zone).toInstant()
            val dayEnd = day.plusDays(1).atStartOfDay(config.zone).toInstant()
            if (dayStart >= from && dayEnd <= to) {
                val rest = clamp("restingHeartRate", 58.0 + 6.0 * (unit(config.seed, "rest", dayStart.epochSecond) - 0.5))
                add(quantity("restingHeartRate", rest.roundToLong().toDouble(), dayStart, dayEnd, "restingHeartRate-${dayStart.epochSecond}"))
            }
            val hrvAt = zoned(day, 5, 0, config.zone)
            if (hrvAt >= from && hrvAt < to) {
                val rmssd = clamp("hrvRmssd", 52.0 + 18.0 * (unit(config.seed, "hrv", hrvAt.epochSecond) - 0.5))
                add(quantity("hrvRmssd", Math.round(rmssd * 10) / 10.0, hrvAt, hrvAt, "hrvRmssd-${hrvAt.epochSecond}"))
            }
            for ((label, hh, mm) in MEALS) {
                val at = zoned(day, hh, mm, config.zone)
                if (at < from || at >= to) continue
                val meal = registry.meal(label)
                val r = { key: String -> unit(config.seed, "meal-$label-$key", at.epochSecond) }
                val energy = 350.0 + 400.0 * r("energy")
                val nutrients = listOf(
                    "dietaryEnergy" to energy,
                    "dietaryProtein" to energy * (0.12 + 0.08 * r("protein")) / 4.0,
                    "dietaryCarbohydrates" to energy * (0.40 + 0.15 * r("carbs")) / 4.0,
                    "dietaryFat" to energy * (0.25 + 0.10 * r("fat")) / 9.0,
                    "dietaryFiber" to 3.0 + 7.0 * r("fiber"),
                    "dietarySugar" to 5.0 + 20.0 * r("sugar"),
                    "dietarySodium" to 300.0 + 700.0 * r("sodium"),
                    "dietaryWater" to 250.0 + 250.0 * r("water"),
                )
                for ((id, raw) in nutrients) {
                    add(quantity(id, Math.round(clamp(id, raw) * 10) / 10.0, at, at, "$id-${at.epochSecond}", meal))
                }
            }
            day = day.plusDays(1)
        }

        // --- sleep: a night is five 90-minute cycles from 23:00 local on the evening before; each stage is one interval
        var evening: LocalDate = from.atZone(config.zone).toLocalDate().minusDays(1)
        while (!evening.isAfter(lastDay)) {
            var cursor = zoned(evening, 23, 0, config.zone)
            for (cycle in 0 until 5) {
                for ((stage, minutes) in cycleStages(cycle)) {
                    val end = cursor.plus(Duration.ofMinutes(minutes.toLong()))
                    if (cursor >= from && end <= to) {
                        add(MetricSample(Measurement.Sleep(stage), cursor, end, issued, config.zone, SampleSource.SYNTHETIC,
                            "syn-${config.seed}-sleep-$stage-${cursor.epochSecond}"))
                    }
                    cursor = end
                }
            }
            evening = evening.plusDays(1)
        }
        return out
    }

    /** One 90-minute sleep cycle: deep sleep early in the night, REM late, a short awakening in the last two cycles. */
    private fun cycleStages(cycle: Int): List<Pair<String, Int>> = listOf(
        "asleepCore" to 35,
        "asleepDeep" to max(5, 30 - 6 * cycle),
        "asleepREM" to 15 + 6 * cycle,
        "awake" to if (cycle >= 3) 5 else 0,
    ).filter { it.second > 0 }.let { stages ->
        // pad the cycle to exactly 90 minutes with core sleep, so the night is five equal cycles
        val used = stages.sumOf { it.second }
        if (used < 90) stages + ("asleepCore" to (90 - used)) else stages
    }

    private fun clamp(metricId: String, value: Double): Double {
        val range = registry.metric(metricId)?.plausibleRange ?: return value
        // a hair inside the range: the generator never produces an artifact (it injects no faults)
        return min(max(value, range.min + 1e-6), range.max - 1e-6)
    }

    private fun ceilTo(instant: Instant, step: Duration): Instant {
        val s = step.seconds
        val e = instant.epochSecond + if (instant.nano > 0) 1 else 0
        return Instant.ofEpochSecond(Math.floorDiv(e + s - 1, s) * s)
    }

    private fun zoned(day: LocalDate, hour: Int, minute: Int, zone: ZoneId): Instant =
        ZonedDateTime.of(day, java.time.LocalTime.of(hour, minute), zone).toInstant()

    /** A stable pseudo-random number in [0, 1) from (seed, key, n): SplitMix64, with String.hashCode (specified, so stable everywhere). */
    private fun unit(seed: Long, key: String, n: Long): Double {
        var z = seed * -0x61c8864680b583ebL + key.hashCode().toLong() * 0x632BE59BD9B4E019L + n * -0x4b47c9a8d8c6a5e5L
        z = (z xor (z ushr 30)) * -0x40a7b892e31b1a47L
        z = (z xor (z ushr 27)) * -0x6b2fb644ecceee15L
        z = z xor (z ushr 31)
        return (z ushr 11).toDouble() / (1L shl 53).toDouble()
    }

    private companion object {
        /** The three meals of a day, by the label a food app would write, with their local time. */
        val MEALS = listOf(Triple("Breakfast", 8, 0), Triple("Lunch", 12, 30), Triple("Dinner", 19, 0))
    }
}

/** The synthetic generator behind the ingest interface. Holds no state: every call is a function of its arguments. */
class SyntheticSource(private val generator: SyntheticGenerator, private val config: SyntheticConfig) : IngestSource {
    override val name: String get() = "Synthetic"
    override fun samples(from: Instant, to: Instant, issued: Instant): List<IngestItem> = generator.generate(config, from, to, issued)
}
