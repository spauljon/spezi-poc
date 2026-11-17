package com.aboutobjects.healthgate.healthconnect

import com.aboutobjects.healthgate.Golden
import com.aboutobjects.healthgate.ingest.healthconnect.HcDevice
import com.aboutobjects.healthgate.ingest.healthconnect.HcRecord
import java.time.Instant
import java.time.ZoneOffset
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.double
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/** A golden fixture's `record` object (the shape the independent generator writes) as an [HcRecord]. */
object HcGolden {
    private fun s(o: JsonObject, k: String): String? = Golden.string(o, k)
    private fun instant(o: JsonObject, k: String) = Instant.parse(s(o, k)!!)
    private fun offset(o: JsonObject, k: String): ZoneOffset? = s(o, k)?.let { ZoneOffset.of(it) }
    private fun device(o: JsonObject): HcDevice? = (o["device"] as? JsonObject)?.let {
        HcDevice(s(it, "manufacturer"), s(it, "model"), (it["type"] as? JsonPrimitive)?.int ?: 0)
    }

    fun record(o: JsonObject): HcRecord {
        val id = s(o, "id") ?: ""
        val origin = s(o, "origin") ?: ""
        val method = o.getValue("recordingMethod").jsonPrimitive.int
        val dev = device(o)
        return when (val cls = s(o, "class")) {
            "HeartRateRecord" -> HcRecord.HeartRate(
                id, origin, method, dev, instant(o, "startTime"), instant(o, "endTime"), offset(o, "startZoneOffset"), offset(o, "endZoneOffset"),
                o.getValue("samples").jsonArray.map { e -> e.jsonObject.let { HcRecord.HeartRateSample(instant(it, "time"), it.getValue("beatsPerMinute").jsonPrimitive.double) } },
            )
            "RestingHeartRateRecord" -> HcRecord.Instantaneous(id, origin, method, dev, HcRecord.Instantaneous.Kind.RESTING_HEART_RATE, instant(o, "time"), offset(o, "zoneOffset"), o.getValue("beatsPerMinute").jsonPrimitive.double)
            "HeartRateVariabilityRmssdRecord" -> HcRecord.Instantaneous(id, origin, method, dev, HcRecord.Instantaneous.Kind.HRV_RMSSD, instant(o, "time"), offset(o, "zoneOffset"), o.getValue("heartRateVariabilityMillis").jsonPrimitive.double)
            "SleepSessionRecord" -> HcRecord.Sleep(
                id, origin, method, dev, instant(o, "startTime"), instant(o, "endTime"), offset(o, "startZoneOffset"), offset(o, "endZoneOffset"),
                o.getValue("stages").jsonArray.map { e -> e.jsonObject.let { HcRecord.SleepStage(s(it, "stageType")!!, instant(it, "startTime"), instant(it, "endTime")) } },
            )
            "HydrationRecord" -> HcRecord.Hydration(id, origin, method, dev, instant(o, "startTime"), instant(o, "endTime"), offset(o, "startZoneOffset"), offset(o, "endZoneOffset"), o.getValue("volume").jsonPrimitive.double)
            "NutritionRecord" -> HcRecord.Nutrition(
                id, origin, method, dev, instant(o, "startTime"), instant(o, "endTime"), offset(o, "startZoneOffset"), offset(o, "endZoneOffset"),
                (o["mealType"] as? JsonPrimitive)?.takeIf { it !is JsonNull }?.int ?: 0,
                o.getValue("nutrients").jsonObject.mapValues { it.value.jsonPrimitive.double },
            )
            else -> error("unknown record class $cls")
        }
    }
}
