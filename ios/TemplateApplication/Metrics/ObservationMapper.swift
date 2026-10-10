//
// This source file is part of the Spezi POC capture app, adapted from the Stanford Spezi Template Application
//
// SPDX-FileCopyrightText: 2023 Stanford University and the project authors (see CONTRIBUTORS.md)
//
// SPDX-License-Identifier: MIT
//

import Foundation


/// Why a sample was refused. Each case is a violation of a rule in the contract, not a transport problem.
enum MappingError: Error, Equatable {
    case emptyPatientID
    case emptySampleID
    case nonFiniteValue
    case nonPositiveValue
    case endBeforeStart
    case emptySleepInterval
    case offsetNotWholeMinutes
    case emptyDeviceDescriptor
    /// The registry has no entry for something the mapper needs (it would have failed to load; this is a backstop).
    case contractMissing(String)
}


extension MappingError {
    /// A stable short name, for logs and for the golden fixtures' `expectedError`.
    var code: String {
        switch self {
        case .emptyPatientID: "emptyPatientID"
        case .emptySampleID: "emptySampleID"
        case .nonFiniteValue: "nonFiniteValue"
        case .nonPositiveValue: "nonPositiveValue"
        case .endBeforeStart: "endBeforeStart"
        case .emptySleepInterval: "emptySleepInterval"
        case .offsetNotWholeMinutes: "offsetNotWholeMinutes"
        case .emptyDeviceDescriptor: "emptyDeviceDescriptor"
        case .contractMissing: "contractMissing"
        }
    }
}


/// A sample that is valid but deliberately produces nothing.
enum UnmappedReason: Equatable, Sendable {
    /// The stage has no verified LOINC code (assumption A4); stored nowhere in v1.
    case sleepStageHasNoCode(String)
}


enum MappingOutcome: Equatable, Sendable {
    case observation(FHIRObservation)
    case unmapped(UnmappedReason)
}


/// Maps abstract samples to FHIR R4 Observations exactly as `contract/metrics.json` and
/// `docs/planning/fhir-data-model.md` say. Pure: no network, no HealthKit, no clock, no randomness: the same input
/// always gives byte-identical output (identifiers included), which is what makes conditional create safe.
struct ObservationMapper: Sendable {
    let registry: MetricRegistry
    
    
    /// - Parameters:
    ///   - patientID: the server-assigned `Patient` id.
    ///   - deviceReference: a reference to the emitting `Device`, e.g. `Device/123`, or nil when not known.
    func map(_ sample: MetricSample, patientID: String, deviceReference: String? = nil) throws(MappingError) -> MappingOutcome {
        guard !patientID.trimmingCharacters(in: .whitespaces).isEmpty else {
            throw .emptyPatientID
        }
        let sampleID = sample.id.trimmingCharacters(in: .whitespaces)
        guard !sampleID.isEmpty else {
            throw .emptySampleID
        }
        guard sample.end >= sample.start else {
            throw .endBeforeStart
        }
        
        switch sample.measurement {
        case .quantity(let id, let value):
            guard let metric = registry.metric(id), let loinc = metric.loinc else {
                throw .contractMissing(id.rawValue)
            }
            guard value.isFinite else {
                throw .nonFiniteValue
            }
            guard value > 0 else {
                throw .nonPositiveValue
            }
            let quantity = FHIRQuantity(value: Self.decimal(value), unit: metric.unit.display, system: registry.systems.ucum, code: metric.unit.ucum)
            return .observation(try build(sample, sampleID: sampleID, metric: metric, coding: loinc, value: quantity,
                                          period: metric.effective == "period" || sample.start != sample.end,
                                          patientID: patientID, deviceReference: deviceReference))
            
        case .sleep(let stage):
            guard let sleep = registry.sleep else {
                throw .contractMissing("sleepStage")
            }
            guard let coding = sleep.stages?[stage.rawValue] else {
                return .unmapped(.sleepStageHasNoCode(stage.rawValue))
            }
            guard sample.end > sample.start else {
                throw .emptySleepInterval
            }
            let minutes = Self.minutes(from: sample.start, to: sample.end)
            let quantity = FHIRQuantity(value: minutes, unit: sleep.unit.display, system: registry.systems.ucum, code: sleep.unit.ucum)
            return .observation(try build(sample, sampleID: sampleID, metric: sleep, coding: coding, value: quantity, period: true,
                                          patientID: patientID, deviceReference: deviceReference))
        }
    }
    
    
    private func build(_ sample: MetricSample, sampleID: String, metric: MetricRegistry.Metric, coding: MetricRegistry.Coding,
                       value: FHIRQuantity, period: Bool, patientID: String, deviceReference: String?) throws(MappingError) -> FHIRObservation {
        guard let category = registry.categories[metric.category] else {
            throw .contractMissing("category \(metric.category)")
        }
        let identifierSystem: String
        let identifierValue: String
        let metaSource: String
        switch sample.source {
        case .synthetic:
            identifierSystem = registry.systems.identifier.synthetic
            identifierValue = sampleID
            metaSource = registry.systems.metaSource.synthetic
        case .healthKit:
            identifierSystem = registry.systems.identifier.healthKit
            identifierValue = sampleID.lowercased() // A16
            metaSource = registry.systems.metaSource.healthKit
        }
        
        var effectiveDateTime: String?
        var effectivePeriod: FHIRPeriod?
        if period {
            effectivePeriod = FHIRPeriod(start: try format(sample.start, in: sample.timeZone), end: try format(sample.end, in: sample.timeZone))
        } else {
            effectiveDateTime = try format(sample.start, in: sample.timeZone)
        }
        let issued = try format(sample.issued, in: sample.timeZone, alwaysMillis: true)
        
        return FHIRObservation(
            meta: FHIRMeta(source: metaSource),
            identifier: [FHIRIdentifier(system: identifierSystem, value: identifierValue)],
            status: "final",
            category: [FHIRCodeableConcept(coding: [FHIRCoding(system: registry.systems.observationCategory, code: category.code, display: category.display)])],
            code: FHIRCodeableConcept(coding: [FHIRCoding(system: registry.systems.loinc, code: coding.code, display: coding.display)]),
            subject: FHIRReference(reference: "Patient/\(patientID)"),
            effectiveDateTime: effectiveDateTime,
            effectivePeriod: effectivePeriod,
            issued: issued,
            valueQuantity: value,
            device: deviceReference.map { FHIRReference(reference: $0) }
        )
    }
    
    private func format(_ date: Date, in timeZone: TimeZone, alwaysMillis: Bool = false) throws(MappingError) -> String {
        do {
            return try FHIRDateTime.string(from: date, in: timeZone, alwaysMillis: alwaysMillis)
        } catch {
            throw .offsetNotWholeMinutes
        }
    }
    
    /// A `Double` as the shortest decimal that round-trips, so 72.0 is 72 and 48.3 is 48.3 (not 48.2999999...).
    private static func decimal(_ value: Double) -> Decimal {
        Decimal(string: "\(value)") ?? Decimal(value)
    }
    
    /// Minutes between two instants, from whole milliseconds, rounded half-up to 2 decimals (`rules.sleepDuration`).
    private static func minutes(from start: Date, to end: Date) -> Decimal {
        let millis = Int64((end.timeIntervalSince1970 * 1000).rounded()) - Int64((start.timeIntervalSince1970 * 1000).rounded())
        let exact = Decimal(millis) / Decimal(60_000)
        var rounded = Decimal()
        var input = exact
        NSDecimalRound(&rounded, &input, 2, .plain) // .plain rounds half away from zero: half-up for positive values
        return rounded
    }
}
