//
// This source file is part of the Spezi POC capture app, adapted from the Stanford Spezi Template Application
//
// SPDX-FileCopyrightText: 2023 Stanford University and the project authors (see CONTRIBUTORS.md)
//
// SPDX-License-Identifier: MIT
//

import Foundation


/// The metric registry: what each metric is called in LOINC, its UCUM unit, category and time rule.
///
/// It is loaded from `metrics.json`, the app's bundled copy of `contract/metrics.json` (the single source of truth,
/// kept byte-identical by `contract/sync.sh` and by tests). Nothing here is hand-copied: no LOINC code, unit or
/// category appears in Swift source.
struct MetricRegistry: Sendable {
    /// The major version of the contract this code understands.
    static let supportedMajorVersion = 1
    
    enum LoadError: Error, Equatable {
        case notFound
        case undecodable(String)
        case unsupportedVersion(String)
        case inconsistent(String)
    }
    
    struct Coding: Decodable, Equatable, Sendable {
        let code: String
        let display: String
    }
    
    struct Unit: Decodable, Equatable, Sendable {
        let ucum: String
        let display: String
    }
    
    struct Metric: Decodable, Equatable, Sendable {
        let id: String
        let kind: String
        let loinc: Coding?
        let unit: Unit
        /// An HL7 category key (`categories`); an intake metric has none and uses `domain`.
        let category: String?
        let effective: String
        let stages: [String: Coding]?
        let unmapped: [String]?
        /// The HealthKit identifier this metric is read from (for example `HKQuantityTypeIdentifierHeartRate`).
        let healthKit: String?
        /// Values strictly outside this range are flagged `artifact-suspected` (never dropped). Sleep has none.
        let plausibleRange: PlausibleRange?
        /// An intake metric without a LOINC code is coded in one of the project's own systems.
        let customCode: CustomCode?
        /// An intake metric's category is a domain (contract `domains`), not an HL7 category.
        let domain: String?
        /// Zero is a valid value (an intake: a food can contain none of a nutrient).
        let zeroAllowed: Bool?
    }
    
    /// A code in one of the project's own systems (contract `customCode`: `system` names a key of `systems`).
    struct CustomCode: Decodable, Equatable, Sendable {
        let system: String
        let code: String
        let display: String
    }
    
    /// The bounds of a plausible value for a metric (contract `plausibleRange`; a clinical judgment, assumption A32).
    struct PlausibleRange: Decodable, Equatable, Sendable {
        let lower: Double
        let upper: Double
        
        private enum CodingKeys: String, CodingKey {
            case lower = "min"
            case upper = "max"
        }
    }
    
    struct QualityThresholds: Decodable, Equatable, Sendable {
        /// A sample issued more than this many hours after it ended is `late-arrival`.
        let lateArrivalHours: Double
    }
    
    struct Systems: Decodable, Equatable, Sendable {
        struct Identifier: Decodable, Equatable, Sendable {
            let patient: String
            let synthetic: String
            let healthKit: String
            let deviceKey: String
            let appBundleId: String
        }
        
        struct MetaSource: Decodable, Equatable, Sendable {
            let synthetic: String
            let healthKit: String
        }
        
        let loinc: String
        let ucum: String
        let observationCategory: String
        let identifier: Identifier
        let metaSource: MetaSource
        /// The project's data-quality flag system (an `Observation.meta.tag` coding system), contract 1.2.0 and later.
        let dataQualityFlag: String
        /// The project's own code systems (contract 1.5.0 and later).
        let observationDomain: String
        let mealType: String
        let nutrient: String
    }
    
    struct DeviceKey: Decodable, Equatable, Sendable {
        let syntheticValue: String
        let syntheticManufacturer: String
        let syntheticName: String
        /// The `deviceName` type for a source application's display name (D6: `other`).
        let appSourceNameType: String
    }
    
    private struct File: Decodable {
        let contractVersion: String
        let systems: Systems
        let categories: [String: Coding]
        let deviceKey: DeviceKey
        let dataQualityFlags: [String: String]
        let qualityThresholds: QualityThresholds
        let domains: [String: Coding]
        let mealTypes: [String: Coding]
        let mealTypeAliases: [String: String]
        let metrics: [Metric]
    }
    
    
    let contractVersion: String
    let systems: Systems
    let categories: [String: Coding]
    let deviceKey: DeviceKey
    /// The flag codes by name (`artifactSuspected`, `userEntered`, ...).
    let dataQualityFlags: [String: String]
    let qualityThresholds: QualityThresholds
    let domains: [String: Coding]
    let mealTypes: [String: Coding]
    let mealTypeAliases: [String: String]
    private let metricsByID: [String: Metric]
    
    
    init(data: Data) throws(LoadError) {
        let file: File
        do {
            file = try JSONDecoder().decode(File.self, from: data)
        } catch {
            throw .undecodable(String(describing: error))
        }
        guard Int(file.contractVersion.split(separator: ".").first ?? "") == Self.supportedMajorVersion else {
            throw .unsupportedVersion(file.contractVersion)
        }
        var byID: [String: Metric] = [:]
        for metric in file.metrics {
            guard byID.updateValue(metric, forKey: metric.id) == nil else {
                throw .inconsistent("duplicate metric id \(metric.id)")
            }
            if let category = metric.category {
                guard file.categories[category] != nil else {
                    throw .inconsistent("\(metric.id): unknown category \(category)")
                }
            } else if let domain = metric.domain {
                guard file.domains[domain] != nil else {
                    throw .inconsistent("\(metric.id): unknown domain \(domain)")
                }
            } else {
                throw .inconsistent("\(metric.id): has neither a category nor a domain")
            }
            if let custom = metric.customCode, Self.customSystem(custom.system, in: file.systems) == nil {
                throw .inconsistent("\(metric.id): custom code in an unknown system \(custom.system)")
            }
        }
        // Every metric this code can emit must be in the contract, and the sleep stages must be accounted for.
        for id in MetricID.allCases where byID[id.rawValue]?.loinc == nil && byID[id.rawValue]?.customCode == nil {
            throw .inconsistent("contract has no code for \(id.rawValue)")
        }
        for key in ["breakfast", "lunch", "dinner", "snack", "other"] where file.mealTypes[key] == nil {
            throw .inconsistent("contract has no meal type \(key) (contract 1.5.0 or later is required)")
        }
        for (alias, code) in file.mealTypeAliases where file.mealTypes[code] == nil || alias != alias.lowercased() {
            throw .inconsistent("meal type alias \(alias) must be lowercase and point at a defined meal type")
        }
        guard let sleep = byID["sleepStage"], let stages = sleep.stages else {
            throw .inconsistent("contract has no sleepStage metric")
        }
        let known = Set(stages.keys).union(sleep.unmapped ?? [])
        guard known == Set(SleepStage.allCases.map(\.rawValue)) else {
            throw .inconsistent("sleepStage must map or list as unmapped exactly the HealthKit stages")
        }
        contractVersion = file.contractVersion
        systems = file.systems
        categories = file.categories
        deviceKey = file.deviceKey
        for key in ["userEntered", "artifactSuspected", "duplicateResolved", "lateArrival"] where file.dataQualityFlags[key] == nil {
            throw .inconsistent("contract has no \(key) data-quality flag (contract 1.4.0 or later is required)")
        }
        guard file.qualityThresholds.lateArrivalHours > 0 else {
            throw .inconsistent("lateArrivalHours must be positive")
        }
        for id in MetricID.allCases {
            if let range = byID[id.rawValue]?.plausibleRange, !(range.lower < range.upper) {
                throw .inconsistent("\(id.rawValue): plausibleRange must have min below max")
            }
        }
        dataQualityFlags = file.dataQualityFlags
        qualityThresholds = file.qualityThresholds
        domains = file.domains
        mealTypes = file.mealTypes
        mealTypeAliases = file.mealTypeAliases
        metricsByID = byID
    }
    
    /// Loads the bundled copy of the contract.
    static func load(bundle: Bundle = .main) throws(LoadError) -> MetricRegistry {
        guard let url = bundle.url(forResource: "metrics", withExtension: "json"), let data = try? Data(contentsOf: url) else {
            throw .notFound
        }
        return try MetricRegistry(data: data)
    }
    
    
    func metric(_ id: MetricID) -> Metric? {
        metricsByID[id.rawValue]
    }
    
    /// The URL of one of the project's own code systems by the name the contract uses for it in `customCode.system`.
    func customSystem(_ name: String) -> String? {
        Self.customSystem(name, in: systems)
    }
    
    private static func customSystem(_ name: String, in systems: Systems) -> String? {
        switch name {
        case "nutrient": systems.nutrient
        case "observationDomain": systems.observationDomain
        case "mealType": systems.mealType
        default: nil
        }
    }
    
    /// A meal label as a source wrote it, as a meal (contract rule `mealType`): trimmed, compared case-insensitively
    /// with the meal type codes and the aliases; a match is that code, anything else is `other`; no label is no meal.
    func meal(forLabel label: String?) -> MetricSample.Meal? {
        let text = (label ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }
        let key = text.lowercased()
        let code = mealTypes[key] != nil ? key : (mealTypeAliases[key] ?? "other")
        return MetricSample.Meal(code: code, label: text)
    }
    
    var sleep: Metric? {
        metricsByID["sleepStage"]
    }
}
