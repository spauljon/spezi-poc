//
// This source file is part of the Spezi POC capture app, adapted from the Stanford Spezi Template Application
//
// SPDX-FileCopyrightText: 2023 Stanford University and the project authors (see CONTRIBUTORS.md)
//
// SPDX-License-Identifier: MIT
//

import Foundation
import HealthKit


/// What a HealthKit record becomes in the app's own terms, plus the device that produced it.
struct MappedHealthKitSample: Equatable, Sendable {
    var sample: MetricSample
    var device: DeviceDescriptor
}


/// HealthKit record to `MetricSample`: pure, with the metric table read from the contract (never hand-copied).
///
/// Decisions, each with a test:
///  - a record whose type the contract does not list is ignored (`nil`), not guessed at;
///  - the time zone is the sample's own (`HKMetadataKeyTimeZone`), else the device's zone at ingest (A6);
///  - a sample with no `HKDevice` is described by the name of its `HKSource` (for example "Health" for a hand entry), so
///    that it still has a stable `Device`;
///  - `inBed` is mapped to `SleepStage.inBed`, which downstream produces no Observation (contract A4);
///  - nothing is filtered by value here: implausible values are stored as given (the contract's A17).
struct HealthKitMapper: Sendable {
    private let registry: MetricRegistry
    private let metricByIdentifier: [String: MetricID]
    private let sleepIdentifier: String?
    
    init(registry: MetricRegistry) {
        self.registry = registry
        var table: [String: MetricID] = [:]
        for id in MetricID.allCases {
            if let identifier = registry.metric(id)?.healthKit {
                table[identifier] = id
            }
        }
        metricByIdentifier = table
        sleepIdentifier = registry.sleep?.healthKit
    }
    
    /// The HealthKit type identifiers this mapper reads (the collectors and the authorization request use the same set).
    var identifiers: Set<String> {
        Set(metricByIdentifier.keys).union(sleepIdentifier.map { [$0] } ?? [])
    }
    
    func map(_ record: HealthKitRecord, issued: Date, fallbackTimeZone: TimeZone) -> MappedHealthKitSample? {
        let measurement: MetricSample.Measurement
        if let id = metricByIdentifier[record.typeIdentifier] {
            guard let value = record.value else { return nil }
            measurement = .quantity(id, value)
        } else if record.typeIdentifier == sleepIdentifier {
            guard let raw = record.categoryValue, let stage = Self.stage(for: raw) else { return nil }
            measurement = .sleep(stage)
        } else {
            return nil
        }
        let zone = record.timeZoneIdentifier.flatMap { TimeZone(identifier: $0) } ?? fallbackTimeZone
        var sample = MetricSample(
            measurement: measurement, start: record.start, end: record.end, issued: issued, timeZone: zone,
            source: .healthKit, id: record.uuid, userEntered: record.userEntered)
        // A meal only belongs to an intake (contract rule mealType); a heart-rate sample never carries one.
        if case .quantity(let id, _) = measurement, registry.metric(id)?.domain != nil {
            sample.meal = registry.meal(forLabel: record.mealLabel)
        }
        return MappedHealthKitSample(sample: sample, device: Self.descriptor(for: record))
    }
    
    static func stage(for rawValue: Int) -> SleepStage? {
        switch HKCategoryValueSleepAnalysis(rawValue: rawValue) {
        case .inBed: .inBed
        case .asleepUnspecified: .asleepUnspecified
        case .awake: .awake
        case .asleepCore: .asleepCore
        case .asleepDeep: .asleepDeep
        case .asleepREM: .asleepREM
        default: nil
        }
    }
    
    static func descriptor(for record: HealthKitRecord) -> DeviceDescriptor {
        guard let device = record.device else {
            // No HKDevice: the sample came from an application (decision D6). Its bundle identifier is its identity, and its
            // display name is the Device's name. A descriptor needs at least one of the two (contract deviceKey): a source
            // with neither gets a constant name rather than an empty descriptor, which the mapper would refuse.
            let name = record.sourceName.trimmingCharacters(in: .whitespacesAndNewlines)
            let bundle = (record.sourceBundleIdentifier ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            return .sourceApp(name: name.isEmpty ? (bundle.isEmpty ? "Apple Health" : nil) : name,
                              bundleIdentifier: bundle.isEmpty ? nil : bundle)
        }
        return .healthKit(
            name: device.name, manufacturer: device.manufacturer, model: device.model,
            hardwareVersion: device.hardwareVersion, softwareVersion: device.softwareVersion)
    }
}
