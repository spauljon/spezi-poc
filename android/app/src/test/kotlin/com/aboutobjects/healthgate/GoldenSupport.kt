package com.aboutobjects.healthgate

import com.aboutobjects.healthgate.contract.MetricRegistry
import com.aboutobjects.healthgate.mapping.DeviceDescriptor
import com.aboutobjects.healthgate.mapping.Measurement
import com.aboutobjects.healthgate.mapping.MetricSample
import com.aboutobjects.healthgate.contract.Meal
import java.io.File
import java.math.BigDecimal
import java.time.Instant
import java.time.ZoneId
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.double
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * Reads the shared golden fixtures (`contract/golden`, written by the independent Python generator) and the app's bundled copy of the
 * contract. Unit tests run with the module directory (`android/app`) as the working directory.
 */
object Golden {
    val contractCopy = File("src/main/assets/metrics.json")
    val contractSource = File("../../contract/metrics.json")
    private val goldenDir = File("../../contract/golden")

    fun registry(): MetricRegistry = MetricRegistry.parse(contractCopy.readText())

    fun cases(file: String): List<JsonObject> {
        val f = File(goldenDir, file)
        check(f.isFile) { "the golden fixture $file was not found at ${f.absolutePath}: a loader that found nothing would pass everything" }
        return Json.parseToJsonElement(f.readText()).jsonObject.getValue("cases").jsonArray.map { it.jsonObject }
    }

    fun string(o: JsonObject, key: String): String? = (o[key] as? JsonPrimitive)?.takeIf { it !is JsonNull }?.content

    /** A `MetricSample` from a fixture's `sample` object (the iOS-shaped input the generator writes). */
    fun sample(o: JsonObject): MetricSample {
        val measurement = if (o.containsKey("stage")) {
            Measurement.Sleep(string(o, "stage")!!)
        } else {
            Measurement.Quantity(string(o, "metric")!!, o.getValue("value").jsonPrimitive.double)
        }
        val meal = (o["meal"] as? JsonObject)?.let { Meal(string(it, "code")!!, string(it, "label")!!) }
        fun flag(key: String) = (o[key] as? JsonPrimitive)?.booleanOrNull ?: false
        return MetricSample(
            measurement = measurement,
            start = Instant.parse(string(o, "start")!!),
            end = Instant.parse(string(o, "end")!!),
            issued = Instant.parse(string(o, "issued")!!),
            timeZone = ZoneId.of(string(o, "timeZone")!!),
            source = string(o, "source")!!,
            id = string(o, "id")!!,
            userEntered = flag("userEntered"),
            artifactSuspected = flag("artifactSuspected"),
            lateArrival = flag("lateArrival"),
            duplicateResolved = flag("duplicateResolved"),
            meal = meal,
        )
    }

    fun descriptor(o: JsonObject): DeviceDescriptor = when (val kind = string(o, "kind")) {
        "synthetic" -> DeviceDescriptor.Synthetic
        "healthKit" -> DeviceDescriptor.HealthKit(string(o, "name"), string(o, "manufacturer"), string(o, "model"), string(o, "hardwareVersion"), string(o, "softwareVersion"))
        "sourceApp" -> DeviceDescriptor.SourceApp(string(o, "name"), string(o, "bundleIdentifier"))
        else -> error("unknown device descriptor kind $kind")
    }

    /** JSON equality that ignores object key order and compares numbers by value (72 equals 72.0), never strings loosely. */
    fun same(a: JsonElement, b: JsonElement): Boolean = when {
        a is JsonObject && b is JsonObject -> a.keys == b.keys && a.keys.all { same(a.getValue(it), b.getValue(it)) }
        a is JsonArray && b is JsonArray -> a.size == b.size && a.indices.all { same(a[it], b[it]) }
        a is JsonPrimitive && b is JsonPrimitive -> when {
            a.isString || b.isString -> a.isString && b.isString && a.content == b.content
            a is JsonNull || b is JsonNull -> a is JsonNull && b is JsonNull
            a.booleanOrNull != null || b.booleanOrNull != null -> a.booleanOrNull == b.booleanOrNull
            else -> BigDecimal(a.content).compareTo(BigDecimal(b.content)) == 0
        }
        else -> false
    }
}
