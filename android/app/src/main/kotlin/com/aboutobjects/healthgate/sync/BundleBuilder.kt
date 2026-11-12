@file:OptIn(ExperimentalSerializationApi::class)

package com.aboutobjects.healthgate.sync

import com.aboutobjects.healthgate.contract.MetricRegistry
import com.aboutobjects.healthgate.ingest.IngestItem
import com.aboutobjects.healthgate.mapping.DeviceDescriptor
import com.aboutobjects.healthgate.mapping.DeviceMapper
import com.aboutobjects.healthgate.mapping.MappingError
import com.aboutobjects.healthgate.mapping.MappingException
import com.aboutobjects.healthgate.mapping.MappingOutcome
import com.aboutobjects.healthgate.mapping.ObservationMapper
import java.security.MessageDigest
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

/** One entry of a transaction Bundle: its resource, and whether it is a Device or an Observation. */
data class BundleEntry(val fullUrl: String, val resource: JsonObject, val isObservation: Boolean, val key: String? = null) {
    fun toJson(registryIdentifier: JsonObject): JsonObject = buildJsonObject {
        put("fullUrl", fullUrl)
        put("resource", resource)
        put("request", buildJsonObject {
            put("method", "POST")
            put("url", if (isObservation) "Observation" else "Device")
            put("ifNoneExist", FhirSearch.identifierQuery(registryIdentifier.getValue("system").jsonPrimitive.content, registryIdentifier.getValue("value").jsonPrimitive.content))
        })
    }
}

data class BuildResult(
    val entries: List<BundleEntry>,
    /** Queue keys of the Observation entries, in entry order (after the Device entries). */
    val observationKeys: List<String>,
    /** Valid samples that deliberately produce no resource (`inBed`): nothing to upload. */
    val unmappedKeys: List<String>,
    /** Samples the mapper refused, with the reason (they can never upload as they are). */
    val invalid: List<Pair<String, MappingError>>,
) {
    val observationEntries: List<BundleEntry> get() = entries.filter { it.isObservation }
    val deviceEntries: List<BundleEntry> get() = entries.filter { !it.isObservation }
}

/**
 * Turns queued samples into one FHIR transaction Bundle of conditional creates: a Device first (only if an Observation uses it),
 * then each Observation. `If-None-Exist` on the sample identifier makes a resend a no-op, so uploading is idempotent.
 */
class BundleBuilder(private val registry: MetricRegistry) {
    private val observations = ObservationMapper(registry)
    private val devices = DeviceMapper(registry)

    fun build(items: List<Pair<String, IngestItem>>, patientId: String): BuildResult {
        val deviceEntries = ArrayList<BundleEntry>()
        val deviceUrls = HashMap<DeviceDescriptor, String>()
        val observationEntries = ArrayList<BundleEntry>()
        val keys = ArrayList<String>()
        val unmapped = ArrayList<String>()
        val invalid = ArrayList<Pair<String, MappingError>>()

        for ((key, item) in items) {
            val deviceUrl = deviceUrls[item.device] ?: try {
                val device = devices.map(item.device, patientId)
                val identifier = device.getValue("identifier").jsonArray.first().jsonObject
                val url = fullUrl(identifier.getValue("system").jsonPrimitive.content, identifier.getValue("value").jsonPrimitive.content)
                deviceUrls[item.device] = url
                deviceEntries.add(BundleEntry(url, device, false))
                url
            } catch (e: MappingException) {
                invalid.add(key to e.error)
                continue
            }
            try {
                when (val outcome = observations.map(item.sample, patientId, deviceUrl)) {
                    is MappingOutcome.Unmapped -> unmapped.add(key)
                    is MappingOutcome.Observation -> {
                        val identifier = outcome.resource.getValue("identifier").jsonArray.first().jsonObject
                        val url = fullUrl(identifier.getValue("system").jsonPrimitive.content, identifier.getValue("value").jsonPrimitive.content)
                        observationEntries.add(BundleEntry(url, outcome.resource, true, key))
                        keys.add(key)
                    }
                }
            } catch (e: MappingException) {
                invalid.add(key to e.error)
            }
        }
        // a Device entry is only worth sending if some Observation uses it
        val used = observationEntries.mapNotNull { it.resource["device"]?.jsonObject?.get("reference")?.jsonPrimitive?.content }.toSet()
        return BuildResult(deviceEntries.filter { it.fullUrl in used } + observationEntries, keys, unmapped, invalid)
    }

    /** The Bundle as JSON text. */
    fun bundle(entries: List<BundleEntry>): String {
        val array: JsonArray = buildJsonArray {
            for (e in entries) add(e.toJson(e.resource.getValue("identifier").jsonArray.first().jsonObject))
        }
        return buildJsonObject {
            put("resourceType", "Bundle")
            put("type", "transaction")
            put("entry", array)
        }.toString()
    }

    companion object {
        /** A deterministic `urn:uuid:` for an entry, derived from its identifier, so the same batch always produces the same Bundle bytes. */
        fun fullUrl(system: String, value: String): String {
            val digest = MessageDigest.getInstance("SHA-256").digest("$system|$value".toByteArray(Charsets.UTF_8)).copyOf(16)
            digest[6] = ((digest[6].toInt() and 0x0F) or 0x50).toByte() // version 5 style
            digest[8] = ((digest[8].toInt() and 0x3F) or 0x80).toByte() // RFC 4122 variant
            val hex = digest.joinToString("") { "%02x".format(it) }
            return "urn:uuid:${hex.substring(0, 8)}-${hex.substring(8, 12)}-${hex.substring(12, 16)}-${hex.substring(16, 20)}-${hex.substring(20, 32)}"
        }
    }
}
