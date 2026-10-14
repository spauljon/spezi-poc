//
// This source file is part of the Spezi POC capture app, adapted from the Stanford Spezi Template Application
//
// SPDX-FileCopyrightText: 2023 Stanford University and the project authors (see CONTRIBUTORS.md)
//
// SPDX-License-Identifier: MIT
//

import Foundation


/// The metrics that carry a single numeric value. Sleep is separate: its value is derived from the interval.
enum MetricID: String, CaseIterable, Codable, Sendable {
    case heartRate
    case restingHeartRate
    case hrvSdnn
}


/// HealthKit's `HKCategoryValueSleepAnalysis` values, by name.
enum SleepStage: String, CaseIterable, Codable, Sendable {
    case asleepCore
    case asleepDeep
    case asleepREM
    case asleepUnspecified
    case awake
    /// Has no verified LOINC code (assumption A4): produces no Observation.
    case inBed
}


enum SampleSource: String, Codable, Sendable {
    case synthetic
    case healthKit
}


/// What produced a sample, enough to key and describe a `Device`.
enum DeviceDescriptor: Hashable, Codable, Sendable {
    case synthetic
    case healthKit(name: String?, manufacturer: String?, model: String?, hardwareVersion: String?, softwareVersion: String?)
}


/// One measurement in the app's own terms: what both the synthetic source and HealthKit will produce, so everything
/// downstream (mapping, queue, upload) is the same for both. No FHIR, no HealthKit types.
struct MetricSample: Equatable, Codable, Sendable {
    enum Measurement: Equatable, Codable, Sendable {
        case quantity(MetricID, Double)
        case sleep(SleepStage)
    }
    
    var measurement: Measurement
    var start: Date
    var end: Date
    /// When the capture app produced this sample (not when the server received it).
    var issued: Date
    /// The zone the sample was taken in. The offset written to FHIR is this zone's offset at the sample's own instant
    /// (assumption A6); a source with no better information supplies the device's current zone.
    var timeZone: TimeZone
    var source: SampleSource
    /// A stable id for deduplication: the HealthKit sample UUID, or the synthetic sample id.
    var id: String
    /// The source says this value was typed in by hand (HealthKit: `HKMetadataKeyWasUserEntered`). Provenance, not a
    /// defect: it is stored as given and carries a `user-entered` tag (contract rule `userEntered`).
    var userEntered = false
}


extension MetricSample {
    /// Rows already in the upload queue were written before `userEntered` existed: a missing key reads as `false`.
    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        measurement = try c.decode(Measurement.self, forKey: .measurement)
        start = try c.decode(Date.self, forKey: .start)
        end = try c.decode(Date.self, forKey: .end)
        issued = try c.decode(Date.self, forKey: .issued)
        timeZone = try c.decode(TimeZone.self, forKey: .timeZone)
        source = try c.decode(SampleSource.self, forKey: .source)
        id = try c.decode(String.self, forKey: .id)
        userEntered = try c.decodeIfPresent(Bool.self, forKey: .userEntered) ?? false
    }
}
