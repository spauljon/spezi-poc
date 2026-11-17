package com.aboutobjects.healthgate.ingest.healthconnect

import android.content.Context
import android.content.SharedPreferences
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.changes.DeletionChange
import androidx.health.connect.client.changes.UpsertionChange
import androidx.health.connect.client.permission.HealthPermission
import androidx.health.connect.client.records.HeartRateRecord
import androidx.health.connect.client.records.HeartRateVariabilityRmssdRecord
import androidx.health.connect.client.records.HydrationRecord
import androidx.health.connect.client.records.NutritionRecord
import androidx.health.connect.client.records.Record
import androidx.health.connect.client.records.RestingHeartRateRecord
import androidx.health.connect.client.records.SleepSessionRecord
import androidx.health.connect.client.request.ChangesTokenRequest
import androidx.health.connect.client.request.ReadRecordsRequest
import androidx.health.connect.client.time.TimeRangeFilter
import java.time.Instant
import kotlin.reflect.KClass

/** The record classes and permissions the app reads: read only, nothing else is ever asked for. */
object HealthConnectAccess {
    val recordClasses: Set<KClass<out Record>> = setOf(
        HeartRateRecord::class, RestingHeartRateRecord::class, HeartRateVariabilityRmssdRecord::class,
        SleepSessionRecord::class, NutritionRecord::class, HydrationRecord::class,
    )

    val readPermissions: Set<String> = recordClasses.map { HealthPermission.getReadPermission(it) }.toSet()

    /** The `NutritionRecord` fields the contract reads (`metrics[].healthConnect.field`), in the contract's unit; a missing nutrient is null. */
    val nutrientReaders: Map<String, (NutritionRecord) -> Double?> = mapOf(
        "energy" to { r -> r.energy?.inKilocalories },
        "protein" to { r -> r.protein?.inGrams },
        "totalCarbohydrate" to { r -> r.totalCarbohydrate?.inGrams },
        "totalFat" to { r -> r.totalFat?.inGrams },
        "dietaryFiber" to { r -> r.dietaryFiber?.inGrams },
        "sugar" to { r -> r.sugar?.inGrams },
        "sodium" to { r -> r.sodium?.inMilligrams },
    )

    /**
     * `SleepSessionRecord.STAGE_TYPE_*` as the contract names them (`healthConnect.stages` and `unmapped`). The library's own
     * `STAGE_TYPE_INT_TO_STRING_MAP` says `deep` and `light`, which the contract does not know: it would drop every stage.
     */
    val stageNames: Map<Int, String> = mapOf(
        SleepSessionRecord.STAGE_TYPE_UNKNOWN to "STAGE_TYPE_UNKNOWN",
        SleepSessionRecord.STAGE_TYPE_AWAKE to "STAGE_TYPE_AWAKE",
        SleepSessionRecord.STAGE_TYPE_SLEEPING to "STAGE_TYPE_SLEEPING",
        SleepSessionRecord.STAGE_TYPE_OUT_OF_BED to "STAGE_TYPE_OUT_OF_BED",
        SleepSessionRecord.STAGE_TYPE_LIGHT to "STAGE_TYPE_LIGHT",
        SleepSessionRecord.STAGE_TYPE_DEEP to "STAGE_TYPE_DEEP",
        SleepSessionRecord.STAGE_TYPE_REM to "STAGE_TYPE_REM",
        SleepSessionRecord.STAGE_TYPE_AWAKE_IN_BED to "STAGE_TYPE_AWAKE_IN_BED",
    )

    fun stageName(stage: Int): String = stageNames[stage] ?: "STAGE_TYPE_UNKNOWN"

    /** `Available`, or why Health Connect cannot be used on this phone. */
    fun status(context: Context): Status = when (HealthConnectClient.getSdkStatus(context)) {
        HealthConnectClient.SDK_AVAILABLE -> Status.AVAILABLE
        HealthConnectClient.SDK_UNAVAILABLE_PROVIDER_UPDATE_REQUIRED -> Status.UPDATE_REQUIRED
        else -> Status.UNAVAILABLE
    }

    enum class Status { AVAILABLE, UPDATE_REQUIRED, UNAVAILABLE }
}

/** [HcRecord]s built from the library's records. Nothing here is logged or kept; the units are the contract's. */
internal object HcConversion {
    fun convert(record: Record): HcRecord? = when (record) {
        is HeartRateRecord -> HcRecord.HeartRate(
            record.metadata.id, record.metadata.dataOrigin.packageName, record.metadata.recordingMethod, device(record),
            record.startTime, record.endTime, record.startZoneOffset, record.endZoneOffset,
            record.samples.map { HcRecord.HeartRateSample(it.time, it.beatsPerMinute.toDouble()) },
        )
        is RestingHeartRateRecord -> HcRecord.Instantaneous(
            record.metadata.id, record.metadata.dataOrigin.packageName, record.metadata.recordingMethod, device(record),
            HcRecord.Instantaneous.Kind.RESTING_HEART_RATE, record.time, record.zoneOffset, record.beatsPerMinute.toDouble(),
        )
        is HeartRateVariabilityRmssdRecord -> HcRecord.Instantaneous(
            record.metadata.id, record.metadata.dataOrigin.packageName, record.metadata.recordingMethod, device(record),
            HcRecord.Instantaneous.Kind.HRV_RMSSD, record.time, record.zoneOffset, record.heartRateVariabilityMillis,
        )
        is SleepSessionRecord -> HcRecord.Sleep(
            record.metadata.id, record.metadata.dataOrigin.packageName, record.metadata.recordingMethod, device(record),
            record.startTime, record.endTime, record.startZoneOffset, record.endZoneOffset,
            record.stages.map { HcRecord.SleepStage(HealthConnectAccess.stageName(it.stage), it.startTime, it.endTime) },
        )
        is HydrationRecord -> HcRecord.Hydration(
            record.metadata.id, record.metadata.dataOrigin.packageName, record.metadata.recordingMethod, device(record),
            record.startTime, record.endTime, record.startZoneOffset, record.endZoneOffset, record.volume.inMilliliters,
        )
        is NutritionRecord -> HcRecord.Nutrition(
            record.metadata.id, record.metadata.dataOrigin.packageName, record.metadata.recordingMethod, device(record),
            record.startTime, record.endTime, record.startZoneOffset, record.endZoneOffset, record.mealType,
            HealthConnectAccess.nutrientReaders.mapNotNull { (field, read) -> read(record)?.let { field to it } }.toMap(),
        )
        else -> null
    }

    private fun device(record: Record): HcDevice? = record.metadata.device?.let { HcDevice(it.manufacturer, it.model, it.type) }
}

/** Health Connect through its Android client: the only class that talks to it (apart from the writer test tool). */
class AndroidHealthConnectGateway(private val client: HealthConnectClient) : HealthConnectGateway {

    override suspend fun changesToken(): String = client.getChangesToken(ChangesTokenRequest(HealthConnectAccess.recordClasses))

    override suspend fun changes(token: String): HcChanges {
        val response = client.getChanges(token)
        val changes = response.changes.mapNotNull { change ->
            when (change) {
                is UpsertionChange -> HcConversion.convert(change.record)?.let { HcChange.Upsert(it) }
                is DeletionChange -> HcChange.Delete(change.recordId)
                else -> null
            }
        }
        return HcChanges(changes, response.nextChangesToken, response.hasMore, response.changesTokenExpired)
    }

    override suspend fun readPage(type: HcType, from: Instant, to: Instant, pageToken: String?, pageSize: Int): HcPage = when (type) {
        HcType.HEART_RATE -> read(HeartRateRecord::class, from, to, pageToken, pageSize)
        HcType.RESTING_HEART_RATE -> read(RestingHeartRateRecord::class, from, to, pageToken, pageSize)
        HcType.HRV_RMSSD -> read(HeartRateVariabilityRmssdRecord::class, from, to, pageToken, pageSize)
        HcType.SLEEP -> read(SleepSessionRecord::class, from, to, pageToken, pageSize)
        HcType.NUTRITION -> read(NutritionRecord::class, from, to, pageToken, pageSize)
        HcType.HYDRATION -> read(HydrationRecord::class, from, to, pageToken, pageSize)
    }

    private suspend fun <T : Record> read(kClass: KClass<T>, from: Instant, to: Instant, pageToken: String?, pageSize: Int): HcPage {
        val response = client.readRecords(ReadRecordsRequest(kClass, TimeRangeFilter.between(from, to), emptySet(), true, pageSize, pageToken))
        return HcPage(response.records.mapNotNull { HcConversion.convert(it) }, response.pageToken)
    }
}

/** The changes token, kept in app-private preferences; a write is synchronous (`commit`), so it is durable before the collector moves on. */
class PrefsCollectorState(context: Context) : CollectorStateStore {
    private val prefs: SharedPreferences = context.getSharedPreferences("healthconnect_collector", Context.MODE_PRIVATE)

    override var token: String?
        get() = prefs.getString(KEY, null)
        set(value) { prefs.edit().apply { if (value == null) remove(KEY) else putString(KEY, value) }.commit() }

    private companion object {
        const val KEY = "changes_token"
    }
}
