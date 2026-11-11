package com.aboutobjects.healthgate.probe

import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.permission.HealthPermission
import androidx.health.connect.client.records.HeartRateRecord
import androidx.health.connect.client.records.HeartRateVariabilityRmssdRecord
import androidx.health.connect.client.records.HydrationRecord
import androidx.health.connect.client.records.NutritionRecord
import androidx.health.connect.client.records.Record
import androidx.health.connect.client.records.RestingHeartRateRecord
import androidx.health.connect.client.records.SleepSessionRecord
import androidx.health.connect.client.records.StepsRecord
import androidx.health.connect.client.records.metadata.Metadata
import androidx.health.connect.client.request.ReadRecordsRequest
import androidx.health.connect.client.time.TimeRangeFilter
import java.time.Instant
import java.time.ZoneId
import java.time.ZoneOffset
import kotlin.reflect.KClass

/**
 * The only file that reads Health Connect records. It maps each one to a [RecordSummary] (structure only)
 * and never logs, prints or stores a record: see ProbeSourceTest, which scans for that.
 */
class ProbeType<T : Record>(
    val label: String,
    val kClass: KClass<T>,
    val summarize: (T) -> RecordSummary,
) {
    val readPermission: String get() = HealthPermission.getReadPermission(kClass)
}

object ProbeTypes {
    private const val PAGE = 500

    /** Upper bound per type, so a 4 GB phone is never asked to hold an unbounded list. */
    const val CAP = 20_000

    private fun base(
        m: Metadata,
        start: Instant,
        end: Instant,
        startOffset: ZoneOffset?,
        endOffset: ZoneOffset?,
        samples: Int,
        fields: Set<String>,
        mealType: Int = -1,
    ) = RecordSummary(
        origin = m.dataOrigin.packageName,
        startMs = start.toEpochMilli(),
        endMs = end.toEpochMilli(),
        hasClientRecordId = m.clientRecordId != null,
        hasStartOffset = startOffset != null,
        hasEndOffset = endOffset != null,
        hasDevice = m.device != null,
        updatedAfterEnd = Aggregate.updatedAfterEnd(m.lastModifiedTime.toEpochMilli(), end.toEpochMilli()),
        recordingMethod = m.recordingMethod,
        samples = samples,
        fields = fields,
        idHash = Aggregate.idHash(m.id),
        mealType = mealType,
        startHour = start.atOffset(startOffset ?: ZoneId.systemDefault().rules.getOffset(start)).hour,
    )

    private fun nutrientFields(n: NutritionRecord): Set<String> = buildSet {
        if (n.energy != null) add("energy")
        if (n.protein != null) add("protein")
        if (n.totalFat != null) add("totalFat")
        if (n.saturatedFat != null) add("saturatedFat")
        if (n.unsaturatedFat != null) add("unsaturatedFat")
        if (n.monounsaturatedFat != null) add("monounsaturatedFat")
        if (n.polyunsaturatedFat != null) add("polyunsaturatedFat")
        if (n.transFat != null) add("transFat")
        if (n.totalCarbohydrate != null) add("totalCarbohydrate")
        if (n.dietaryFiber != null) add("dietaryFiber")
        if (n.sugar != null) add("sugar")
        if (n.cholesterol != null) add("cholesterol")
        if (n.sodium != null) add("sodium")
        if (n.potassium != null) add("potassium")
        if (n.calcium != null) add("calcium")
        if (n.iron != null) add("iron")
        if (n.vitaminC != null) add("vitaminC")
        if (n.vitaminA != null) add("vitaminA")
        if (n.caffeine != null) add("caffeine")
        // Presence only: the meal type is a code and the name is free text, so only "exists" is kept.
        if (n.mealType != 0) add("mealType")
        if (n.name != null) add("name")
    }

    val all: List<ProbeType<*>> = listOf(
        ProbeType("HeartRate", HeartRateRecord::class) { r ->
            base(r.metadata, r.startTime, r.endTime, r.startZoneOffset, r.endZoneOffset, r.samples.size, emptySet())
        },
        ProbeType("RestingHeartRate", RestingHeartRateRecord::class) { r ->
            base(r.metadata, r.time, r.time, r.zoneOffset, r.zoneOffset, 1, emptySet())
        },
        ProbeType("HeartRateVariabilityRmssd", HeartRateVariabilityRmssdRecord::class) { r ->
            base(r.metadata, r.time, r.time, r.zoneOffset, r.zoneOffset, 1, emptySet())
        },
        ProbeType("SleepSession", SleepSessionRecord::class) { r ->
            val f = buildSet {
                if (r.title != null) add("title")
                if (r.notes != null) add("notes")
            }
            base(r.metadata, r.startTime, r.endTime, r.startZoneOffset, r.endZoneOffset, r.stages.size, f)
        },
        ProbeType("Nutrition", NutritionRecord::class) { r ->
            val f = nutrientFields(r)
            val nutrients = f.size - (if ("mealType" in f) 1 else 0) - (if ("name" in f) 1 else 0)
            base(r.metadata, r.startTime, r.endTime, r.startZoneOffset, r.endZoneOffset, nutrients, f, mealType = r.mealType)
        },
        ProbeType("Hydration", HydrationRecord::class) { r ->
            base(r.metadata, r.startTime, r.endTime, r.startZoneOffset, r.endZoneOffset, 1, emptySet())
        },
        ProbeType("Steps", StepsRecord::class) { r ->
            base(r.metadata, r.startTime, r.endTime, r.startZoneOffset, r.endZoneOffset, 1, emptySet())
        },
    )

    val readPermissions: Set<String> get() = all.map { it.readPermission }.toSet()

    /** Reads one type over [since]..now in pages, keeping only summaries. Returns the summaries and whether [CAP] stopped it. */
    suspend fun <T : Record> read(client: HealthConnectClient, type: ProbeType<T>, since: Instant): Pair<List<RecordSummary>, Boolean> {
        val out = ArrayList<RecordSummary>()
        var token: String? = null
        val range = TimeRangeFilter.between(since, Instant.now())
        do {
            val response = client.readRecords(
                ReadRecordsRequest(
                    recordType = type.kClass,
                    timeRangeFilter = range,
                    pageSize = PAGE,
                    pageToken = token,
                ),
            )
            response.records.forEach { out.add(type.summarize(it)) }
            token = response.pageToken
            if (out.size >= CAP) return out to (token != null)
        } while (!token.isNullOrEmpty())
        return out to false
    }
}
