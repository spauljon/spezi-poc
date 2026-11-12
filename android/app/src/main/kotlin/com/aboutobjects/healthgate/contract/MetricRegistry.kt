package com.aboutobjects.healthgate.contract

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

@Serializable
data class Coding(val code: String, val display: String)

@Serializable
data class UnitOfMeasure(val ucum: String, val display: String)

@Serializable
data class PlausibleRange(val min: Double, val max: Double)

/** A code in one of the project's own systems; [system] names a key of `systems`. */
@Serializable
data class CustomCode(val system: String, val code: String, val display: String)

@Serializable
data class Metric(
    val id: String,
    val kind: String,
    val loinc: Coding? = null,
    val customCode: CustomCode? = null,
    val unit: UnitOfMeasure,
    /** An HL7 category key (`categories`); an intake metric has none and uses [domain]. */
    val category: String? = null,
    val domain: String? = null,
    val effective: String,
    val stages: Map<String, Coding>? = null,
    val unmapped: List<String>? = null,
    val plausibleRange: PlausibleRange? = null,
    val zeroAllowed: Boolean? = null,
)

@Serializable
data class Systems(
    val loinc: String,
    val ucum: String,
    val observationCategory: String,
    /** `synthetic`, `healthKit`, `healthConnect`, `healthConnectGroup`, `deviceKey`, `appBundleId`, ... */
    val identifier: Map<String, String>,
    val metaSource: Map<String, String>,
    val dataQualityFlag: String,
    val observationDomain: String,
    val mealType: String,
    val nutrient: String,
    val metric: String,
)

@Serializable
data class Named(val code: String, val display: String)

@Serializable
data class DeviceKey(
    val syntheticValue: String,
    val syntheticManufacturer: String,
    val syntheticName: String,
    val appSourceNameType: String,
)

@Serializable
data class QualityThresholds(val lateArrivalHours: Double)

@Serializable
data class ContractFile(
    val contractVersion: String,
    val systems: Systems,
    val dataQualityFlags: Map<String, String>,
    val qualityThresholds: QualityThresholds,
    val categories: Map<String, Named>,
    val domains: Map<String, Named>,
    val mealTypes: Map<String, Named>,
    val mealTypeAliases: Map<String, String>,
    val deviceKey: DeviceKey,
    val metrics: List<Metric>,
)

/** The contract could not be used. The messages say what is wrong with the file. */
class ContractException(message: String) : Exception(message)

/**
 * The metric registry: what each metric is called in LOINC (or the project's own system), its UCUM unit, category and time
 * rule. It is loaded from `metrics.json`, the app's bundled copy of `contract/metrics.json` (kept byte-identical by
 * `contract/sync.sh` and by tests). Nothing here is hand-copied: no code, unit or category is in the Kotlin source.
 */
class MetricRegistry private constructor(private val file: ContractFile) {
    val contractVersion: String get() = file.contractVersion
    val systems: Systems get() = file.systems
    val deviceKey: DeviceKey get() = file.deviceKey
    val qualityThresholds: QualityThresholds get() = file.qualityThresholds
    val categories: Map<String, Named> get() = file.categories
    val domains: Map<String, Named> get() = file.domains
    val dataQualityFlags: Map<String, String> get() = file.dataQualityFlags
    val metrics: List<Metric> get() = file.metrics

    private val byId = file.metrics.associateBy { it.id }

    fun metric(id: String): Metric? = byId[id]

    /** The sleep metric (kind `sleepStage`), if the contract has one. */
    val sleep: Metric? get() = file.metrics.firstOrNull { it.kind == "sleepStage" }

    /** The URL of one of the project's own code systems, by the name a metric's `customCode.system` uses. */
    fun customSystem(name: String): String? = when (name) {
        "nutrient" -> file.systems.nutrient
        "observationDomain" -> file.systems.observationDomain
        "mealType" -> file.systems.mealType
        "metric" -> file.systems.metric
        else -> null
    }

    /**
     * A meal label as a source wrote it, as a meal (contract rule `mealType`): trimmed, compared case-insensitively with the
     * meal type codes and the aliases; a match is that code, anything else is `other`; no label is no meal.
     */
    fun meal(label: String?): Meal? {
        val text = (label ?: "").trim()
        if (text.isEmpty()) return null
        val key = text.lowercase()
        val code = if (file.mealTypes.containsKey(key)) key else (file.mealTypeAliases[key] ?: "other")
        return Meal(code, text)
    }

    companion object {
        /** The major version of the contract this code understands. */
        const val SUPPORTED_MAJOR = 1

        private val json = Json { ignoreUnknownKeys = true }

        fun parse(text: String): MetricRegistry {
            val file = try {
                json.decodeFromString(ContractFile.serializer(), text)
            } catch (e: Exception) {
                throw ContractException("the contract cannot be read: ${e.message}")
            }
            if (file.contractVersion.substringBefore('.').toIntOrNull() != SUPPORTED_MAJOR) {
                throw ContractException("contract version ${file.contractVersion} is not supported (major $SUPPORTED_MAJOR is)")
            }
            val ids = HashSet<String>()
            for (m in file.metrics) {
                if (!ids.add(m.id)) throw ContractException("duplicate metric id ${m.id}")
                when {
                    m.category != null -> if (file.categories[m.category] == null) throw ContractException("${m.id}: unknown category ${m.category}")
                    m.domain != null -> if (file.domains[m.domain] == null) throw ContractException("${m.id}: unknown domain ${m.domain}")
                    else -> throw ContractException("${m.id}: has neither a category nor a domain")
                }
                if (m.kind != "sleepStage" && (m.loinc == null) == (m.customCode == null)) {
                    throw ContractException("${m.id}: needs exactly one of loinc and customCode")
                }
                m.plausibleRange?.let { if (!(it.min < it.max)) throw ContractException("${m.id}: plausibleRange needs min below max") }
            }
            val registry = MetricRegistry(file)
            for (m in file.metrics) {
                m.customCode?.let { c ->
                    if (registry.customSystem(c.system) == null) throw ContractException("${m.id}: custom code in an unknown system ${c.system}")
                }
            }
            val sleep = registry.sleep ?: throw ContractException("contract has no sleepStage metric")
            if (sleep.stages.isNullOrEmpty()) throw ContractException("sleepStage has no stages")
            for (key in listOf("userEntered", "artifactSuspected", "duplicateResolved", "lateArrival")) {
                if (file.dataQualityFlags[key] == null) throw ContractException("contract has no $key data-quality flag")
            }
            if (file.qualityThresholds.lateArrivalHours <= 0) throw ContractException("lateArrivalHours must be positive")
            return registry
        }
    }
}

/** A meal type code from the contract and the label exactly as the source wrote it (trimmed). */
data class Meal(val code: String, val label: String)
