@file:OptIn(ExperimentalSerializationApi::class)

package com.aboutobjects.healthgate.mapping

import com.aboutobjects.healthgate.contract.MetricRegistry
import java.security.MessageDigest
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** A [DeviceDescriptor] as a `Device` resource and its key (contract `deviceKey`). */
class DeviceMapper(private val registry: MetricRegistry) {
    private val separator = "\u001f"

    /**
     * The key that identifies this device across uploads: a fixed value for the synthetic simulator, otherwise the SHA-256
     * (lowercase hex) of the trimmed fields joined by U+001F.
     */
    fun key(descriptor: DeviceDescriptor): String = when (descriptor) {
        DeviceDescriptor.Synthetic -> registry.deviceKey.syntheticValue
        is DeviceDescriptor.HealthKit -> {
            val fields = listOf(descriptor.name, descriptor.manufacturer, descriptor.model, descriptor.hardwareVersion, descriptor.softwareVersion)
                .map { (it ?: "").trim() }
            if (fields.none { it.isNotEmpty() }) throw MappingException(MappingError.EMPTY_DEVICE_DESCRIPTOR)
            sha256(fields.joinToString(separator))
        }
        is DeviceDescriptor.SourceApp -> {
            // the bundle identifier is the identity, so one app is one Device under any display name
            val bundle = (descriptor.bundleIdentifier ?: "").trim()
            if (bundle.isNotEmpty()) {
                sha256("app$separator$bundle")
            } else {
                val name = (descriptor.name ?: "").trim()
                if (name.isEmpty()) throw MappingException(MappingError.EMPTY_DEVICE_DESCRIPTOR)
                // no bundle identifier: the five-field rule over the name alone
                sha256(listOf(name, "", "", "", "").joinToString(separator))
            }
        }
    }

    fun map(descriptor: DeviceDescriptor, patientId: String): JsonObject {
        if (patientId.isBlank()) throw MappingException(MappingError.EMPTY_PATIENT_ID)
        val deviceKeyIdentifier = buildJsonObject { put("system", registry.systems.identifier.getValue("deviceKey")); put("value", key(descriptor)) }
        val patient = buildJsonObject { put("reference", "Patient/$patientId") }

        return when (descriptor) {
            DeviceDescriptor.Synthetic -> buildJsonObject {
                put("resourceType", "Device")
                put("identifier", buildJsonArray { add(deviceKeyIdentifier) })
                put("status", "active")
                put("manufacturer", registry.deviceKey.syntheticManufacturer)
                put("deviceName", buildJsonArray { add(buildJsonObject { put("name", registry.deviceKey.syntheticName); put("type", "model-name") }) })
                put("patient", patient)
            }

            is DeviceDescriptor.HealthKit -> {
                fun clean(v: String?): String? = (v ?: "").trim().ifEmpty { null }
                buildJsonObject {
                    put("resourceType", "Device")
                    put("identifier", buildJsonArray { add(deviceKeyIdentifier) })
                    put("status", "active")
                    clean(descriptor.manufacturer)?.let { put("manufacturer", it) }
                    clean(descriptor.name)?.let { n ->
                        put("deviceName", buildJsonArray { add(buildJsonObject { put("name", n); put("type", "model-name") }) })
                    }
                    clean(descriptor.model)?.let { put("modelNumber", it) }
                    val versions = listOfNotNull(clean(descriptor.hardwareVersion)?.let { "hardware" to it }, clean(descriptor.softwareVersion)?.let { "software" to it })
                    if (versions.isNotEmpty()) {
                        put("version", buildJsonArray {
                            for ((kind, value) in versions) add(buildJsonObject { put("type", buildJsonObject { put("text", kind) }); put("value", value) })
                        })
                    }
                    put("patient", patient)
                }
            }

            is DeviceDescriptor.SourceApp -> {
                val bundle = (descriptor.bundleIdentifier ?: "").trim()
                val displayName = (descriptor.name ?: "").trim()
                buildJsonObject {
                    put("resourceType", "Device")
                    put("identifier", buildJsonArray {
                        add(deviceKeyIdentifier)
                        if (bundle.isNotEmpty()) add(buildJsonObject { put("system", registry.systems.identifier.getValue("appBundleId")); put("value", bundle) })
                    })
                    put("status", "active")
                    if (displayName.isNotEmpty()) {
                        put("deviceName", buildJsonArray { add(buildJsonObject { put("name", displayName); put("type", registry.deviceKey.appSourceNameType) }) })
                    }
                    put("patient", patient)
                }
            }
        }
    }

    private fun sha256(text: String): String =
        MessageDigest.getInstance("SHA-256").digest(text.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
}
