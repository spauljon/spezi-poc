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
    /// A negative intake: always refused, even though zero is allowed for an intake.
    case negativeValue
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
        case .negativeValue: "negativeValue"
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
            guard let metric = registry.metric(id), let code = codeConcept(for: metric) else {
                throw .contractMissing(id.rawValue)
            }
            guard value.isFinite else {
                throw .nonFiniteValue
            }
            // Contract rules.value: strictly positive, except an intake, where zero is stored as given. Negative: never.
            if metric.zeroAllowed == true {
                guard value >= 0 else { throw .negativeValue }
            } else {
                guard value > 0 else { throw .nonPositiveValue }
            }
            let quantity = FHIRQuantity(value: Self.decimal(value), unit: metric.unit.display, system: registry.systems.ucum, code: metric.unit.ucum)
            return .observation(try build(sample, sampleID: sampleID, metric: metric, code: code, value: quantity,
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
            let code = FHIRCodeableConcept(coding: [FHIRCoding(system: registry.systems.loinc, code: coding.code, display: coding.display)])
            return .observation(try build(sample, sampleID: sampleID, metric: sleep, code: code, value: quantity, period: true,
                                          patientID: patientID, deviceReference: deviceReference))
        }
    }
    
    
    /// `Observation.code` of a quantity or intake metric (contract rules.intakeCode): the LOINC coding when it has one,
    /// otherwise the coding in the project's own system with the contract's display as `text`.
    private func codeConcept(for metric: MetricRegistry.Metric) -> FHIRCodeableConcept? {
        if let loinc = metric.loinc {
            return FHIRCodeableConcept(coding: [FHIRCoding(system: registry.systems.loinc, code: loinc.code, display: loinc.display)])
        }
        guard let custom = metric.customCode, let system = registry.customSystem(custom.system) else {
            return nil
        }
        return FHIRCodeableConcept(coding: [FHIRCoding(system: system, code: custom.code, display: nil)], text: custom.display)
    }
    
    /// `Observation.category` (contract rules.domain and rules.mealType): an intake is classified by its domain, and by
    /// its meal as a SEPARATE entry (a CodeableConcept's codings are translations of one concept, so the two never share
    /// one). Every other metric keeps its single HL7 category.
    private func categories(for metric: MetricRegistry.Metric, sample: MetricSample) throws(MappingError) -> [FHIRCodeableConcept] {
        if let domainKey = metric.domain {
            guard let domain = registry.domains[domainKey] else {
                throw .contractMissing("domain \(domainKey)")
            }
            var out = [FHIRCodeableConcept(coding: [FHIRCoding(system: registry.systems.observationDomain, code: domain.code, display: domain.display)])]
            if let meal = sample.meal {
                out.append(FHIRCodeableConcept(coding: [FHIRCoding(system: registry.systems.mealType, code: meal.code, display: nil)], text: meal.label))
            }
            return out
        }
        guard let key = metric.category, let category = registry.categories[key] else {
            throw .contractMissing("category \(metric.category ?? "?")")
        }
        return [FHIRCodeableConcept(coding: [FHIRCoding(system: registry.systems.observationCategory, code: category.code, display: category.display)])]
    }
    
    private func build(_ sample: MetricSample, sampleID: String, metric: MetricRegistry.Metric, code: FHIRCodeableConcept,
                       value: FHIRQuantity, period: Bool, patientID: String, deviceReference: String?) throws(MappingError) -> FHIRObservation {
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
            meta: FHIRMeta(source: metaSource, tag: qualityTags(for: sample)),
            identifier: [FHIRIdentifier(system: identifierSystem, value: identifierValue)],
            status: "final",
            category: try categories(for: metric, sample: sample),
            code: code,
            subject: FHIRReference(reference: "Patient/\(patientID)"),
            effectiveDateTime: effectiveDateTime,
            effectivePeriod: effectivePeriod,
            issued: issued,
            valueQuantity: value,
            device: deviceReference.map { FHIRReference(reference: $0) }
        )
    }
    
    /// The flags a sample carries (contract rules `userEntered`, `artifactSuspected`, `lateArrival`, `duplicateResolved`),
    /// listed in ascending order of code (rule `tagOrder`). A flag sits beside the value; it never replaces or alters it.
    private func qualityTags(for sample: MetricSample) -> [FHIRTag]? {
        let present: [(Bool, String)] = [
            (sample.userEntered, "userEntered"), (sample.artifactSuspected, "artifactSuspected"),
            (sample.duplicateResolved, "duplicateResolved"), (sample.lateArrival, "lateArrival"),
        ]
        let codes = present.compactMap { flag, key in flag ? registry.dataQualityFlags[key] : nil }.sorted()
        guard !codes.isEmpty else {
            return nil
        }
        return codes.map { FHIRTag(system: registry.systems.dataQualityFlag, code: $0) }
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
