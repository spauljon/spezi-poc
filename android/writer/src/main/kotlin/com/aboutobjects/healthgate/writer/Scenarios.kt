package com.aboutobjects.healthgate.writer

import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.records.HeartRateRecord
import androidx.health.connect.client.records.HeartRateVariabilityRmssdRecord
import androidx.health.connect.client.records.HydrationRecord
import androidx.health.connect.client.records.MealType
import androidx.health.connect.client.records.NutritionRecord
import androidx.health.connect.client.records.Record
import androidx.health.connect.client.records.RestingHeartRateRecord
import androidx.health.connect.client.records.SleepSessionRecord
import androidx.health.connect.client.records.metadata.Device
import androidx.health.connect.client.records.metadata.Metadata
import androidx.health.connect.client.units.Energy
import androidx.health.connect.client.units.Mass
import androidx.health.connect.client.units.Volume
import java.time.Duration
import java.time.Instant
import java.time.ZoneOffset
import java.time.temporal.ChronoUnit
import kotlin.reflect.KClass

/** Where the writer remembers the ids Health Connect gave the records it wrote (an app may only change its own records). */
interface IdBook {
    fun get(name: String): String?
    fun put(name: String, id: String)
    fun remove(name: String)
    fun names(): Set<String>
}

/**
 * The synthetic records the writer can create, edit and delete. Every value is invented and deterministic; nothing is read. Each
 * function answers with a short plain sentence of COUNTS (never a value) for the screen.
 */
class Scenarios(private val client: HealthConnectClient, private val ids: IdBook, private val now: () -> Instant = { Instant.now() }) {
    private val zone = ZoneOffset.UTC
    private val watch = Device(Device.TYPE_WATCH, "Synthetic", "Writer")

    /** A fixed anchor 30 minutes back, on the minute, so the samples of one scenario line up from one tap to the next. */
    private val base: Instant get() = now().truncatedTo(ChronoUnit.HOURS).minus(Duration.ofMinutes(30))

    private fun samples(count: Int, bump: Int = 0) = (0 until count).map { HeartRateRecord.Sample(base.plusSeconds(30L * it), (60 + it % 30 + (if (it == 0) bump else 0)).toLong()) }

    private fun heartRate(count: Int, bump: Int, metadata: Metadata) =
        HeartRateRecord(base, zone, base.plusSeconds(30L * maxOf(count - 1, 0) + 1), zone, samples(count, bump), metadata)

    private suspend fun insert(name: String, record: Record) {
        ids.put(name, client.insertRecords(listOf(record)).recordIdsList.single())
    }

    private suspend fun need(name: String): String = ids.get(name) ?: throw IllegalStateException("Nothing named $name has been written yet")

    private suspend fun deleteById(name: String, type: KClass<out Record>): String {
        val id = ids.get(name) ?: return "Nothing to delete."
        client.deleteRecords(type, listOf(id), emptyList())
        ids.remove(name)
        return "Deleted."
    }

    // ---- heart rate: pattern (b), one record that grows ----
    suspend fun heartRateWrite(): String { insert("hr", heartRate(3, 0, Metadata.autoRecorded(watch))); return "Wrote one heart-rate record with 3 samples." }

    suspend fun heartRateGrow(): String {
        val id = need("hr")
        val n = (ids.get("hr.n")?.toInt() ?: 3) + 2
        client.updateRecords(listOf(heartRate(n, ids.get("hr.bump")?.toInt() ?: 0, Metadata.autoRecordedWithId(id, watch))))
        ids.put("hr.n", n.toString())
        return "The heart-rate record now has $n samples (same record, more samples)."
    }

    suspend fun heartRateChangeFirst(): String {
        val id = need("hr")
        val n = ids.get("hr.n")?.toInt() ?: 3
        val bump = (ids.get("hr.bump")?.toInt() ?: 0) + 10
        client.updateRecords(listOf(heartRate(n, bump, Metadata.autoRecordedWithId(id, watch))))
        ids.put("hr.bump", bump.toString())
        return "The first sample's value was changed (the record has $n samples)."
    }

    suspend fun heartRateDelete(): String { ids.remove("hr.n"); ids.remove("hr.bump"); return deleteById("hr", HeartRateRecord::class) }

    suspend fun heartRateLarge(): String {
        val n = 5_000
        insert("hr.large", HeartRateRecord(base.minus(Duration.ofHours(2)), zone, base.minus(Duration.ofHours(2)).plusSeconds(n.toLong()), zone,
            (0 until n).map { HeartRateRecord.Sample(base.minus(Duration.ofHours(2)).plusSeconds(it.toLong()), (60 + it % 40).toLong()) }, Metadata.autoRecorded(watch)))
        return "Wrote one heart-rate record with $n samples."
    }

    suspend fun heartRateLargeDelete(): String = deleteById("hr.large", HeartRateRecord::class)

    // ---- the other metrics ----
    suspend fun restingWrite(): String { insert("rest", RestingHeartRateRecord(base, zone, 58, Metadata.autoRecorded(watch))); return "Wrote one resting heart-rate record." }

    suspend fun restingDelete(): String = deleteById("rest", RestingHeartRateRecord::class)

    suspend fun hrvWrite(): String { insert("hrv", HeartRateVariabilityRmssdRecord(base, zone, 48.3, Metadata.autoRecorded(watch))); return "Wrote one heart-rate variability (RMSSD) record." }

    suspend fun hrvDelete(): String = deleteById("hrv", HeartRateVariabilityRmssdRecord::class)

    suspend fun hydrationWrite(): String {
        insert("water", HydrationRecord(base, zone, base.plusSeconds(60), zone, Volume.milliliters(250.0), Metadata.manualEntry()))
        return "Wrote one hydration record of 250 mL."
    }

    suspend fun hydrationDelete(): String = deleteById("water", HydrationRecord::class)

    suspend fun sleepWrite(): String {
        val start = base.minus(Duration.ofHours(9))
        fun stage(minutes: Long, startMin: Long, type: Int) = SleepSessionRecord.Stage(start.plus(Duration.ofMinutes(startMin)), start.plus(Duration.ofMinutes(startMin + minutes)), type)
        insert("sleep", SleepSessionRecord(start, zone, start.plus(Duration.ofMinutes(135)), zone, Metadata.autoRecorded(watch), null, null, listOf(
            stage(10, 0, SleepSessionRecord.STAGE_TYPE_AWAKE), stage(50, 10, SleepSessionRecord.STAGE_TYPE_LIGHT), stage(45, 60, SleepSessionRecord.STAGE_TYPE_DEEP),
            stage(30, 105, SleepSessionRecord.STAGE_TYPE_REM),
        )))
        return "Wrote one sleep session with 4 stages."
    }

    suspend fun sleepDelete(): String = deleteById("sleep", SleepSessionRecord::class)

    // ---- nutrition: a food item that the writing app re-creates, edits and deletes (the MyFitnessPal pattern) ----
    private fun meal(protein: Double, metadata: Metadata): NutritionRecord {
        val start = base.truncatedTo(ChronoUnit.DAYS).plus(Duration.ofHours(10))
        return NutritionRecord(
            startTime = start, startZoneOffset = zone, endTime = start.plus(Duration.ofHours(12)), endZoneOffset = zone, metadata = metadata,
            energy = Energy.kilocalories(450.0), protein = Mass.grams(protein), totalCarbohydrate = Mass.grams(62.0), totalFat = Mass.grams(14.2),
            dietaryFiber = Mass.grams(7.5), sugar = Mass.grams(22.0), sodium = Mass.milligrams(620.0), mealType = MealType.MEAL_TYPE_LUNCH,
        )
    }

    suspend fun mealWrite(): String { insert("meal", meal(31.5, Metadata.manualEntry())); ids.put("meal.protein", "31.5"); return "Wrote one lunch with 7 nutrients." }

    /** What MyFitnessPal does on every sync: the record is deleted and written again with the same content and a new id. */
    suspend fun mealRecreate(): String {
        val protein = ids.get("meal.protein")?.toDouble() ?: 31.5
        deleteById("meal", NutritionRecord::class)
        insert("meal", meal(protein, Metadata.manualEntry()))
        return "Deleted the lunch and wrote it again, same content, new record id."
    }

    suspend fun mealEdit(): String {
        val protein = (ids.get("meal.protein")?.toDouble() ?: 31.5) + 10.0
        deleteById("meal", NutritionRecord::class)
        insert("meal", meal(protein, Metadata.manualEntry()))
        ids.put("meal.protein", protein.toString())
        return "Deleted the lunch and wrote it again with a different protein amount."
    }

    suspend fun mealDelete(): String { ids.remove("meal.protein"); return deleteById("meal", NutritionRecord::class) }

    /** Removes every record this tool wrote (it can only touch its own). */
    suspend fun deleteAll(): String {
        var removed = 0
        val types = mapOf(
            "hr" to HeartRateRecord::class, "hr.large" to HeartRateRecord::class, "rest" to RestingHeartRateRecord::class, "hrv" to HeartRateVariabilityRmssdRecord::class,
            "water" to HydrationRecord::class, "sleep" to SleepSessionRecord::class, "meal" to NutritionRecord::class,
        )
        for ((name, type) in types) {
            val id = ids.get(name) ?: continue
            client.deleteRecords(type, listOf(id), emptyList())
            removed++
        }
        ids.names().toList().forEach { ids.remove(it) }
        return "Deleted $removed records this tool wrote."
    }
}
