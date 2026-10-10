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
        let category: String
        let effective: String
        let stages: [String: Coding]?
        let unmapped: [String]?
    }
    
    struct Systems: Decodable, Equatable, Sendable {
        struct Identifier: Decodable, Equatable, Sendable {
            let synthetic: String
            let healthKit: String
            let deviceKey: String
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
    }
    
    struct DeviceKey: Decodable, Equatable, Sendable {
        let syntheticValue: String
        let syntheticManufacturer: String
        let syntheticName: String
    }
    
    private struct File: Decodable {
        let contractVersion: String
        let systems: Systems
        let categories: [String: Coding]
        let deviceKey: DeviceKey
        let metrics: [Metric]
    }
    
    
    let contractVersion: String
    let systems: Systems
    let categories: [String: Coding]
    let deviceKey: DeviceKey
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
            guard file.categories[metric.category] != nil else {
                throw .inconsistent("\(metric.id): unknown category \(metric.category)")
            }
        }
        // Every metric this code can emit must be in the contract, and the sleep stages must be accounted for.
        for id in MetricID.allCases where byID[id.rawValue]?.loinc == nil {
            throw .inconsistent("contract has no LOINC mapping for \(id.rawValue)")
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
    
    var sleep: Metric? {
        metricsByID["sleepStage"]
    }
}
