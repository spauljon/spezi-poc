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
    // Dietary intake (contract kind `intake`): amounts a food entry carries, one sample per nutrient.
    case dietaryEnergy
    case dietaryProtein
    case dietaryCarbohydrates
    case dietaryFat
    case dietaryFiber
    case dietarySugar
    case dietarySodium
    case dietaryWater
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
    /// A sample with no `HKDevice`: it came from an application. Keyed by its bundle identifier when it has one, so one
    /// app is one `Device` under any display name (contract `deviceKey.appSource*`, decision D6).
    case sourceApp(name: String?, bundleIdentifier: String?)
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
    /// The value is outside the metric's plausible range (contract rule `artifactSuspected`). Stored as given.
    var artifactSuspected = false
    /// Issued more than the contract's threshold after the sample ended (contract rule `lateArrival`).
    var lateArrival = false
    /// Two deliveries of this sample met in the queue before upload (contract rule `duplicateResolved`).
    var duplicateResolved = false
    /// The meal this intake belongs to, when the source said (contract rule `mealType`). `nil` is "no meal", never a guess.
    var meal: Meal?
    
    /// A meal type code from the contract and the label exactly as the source wrote it (trimmed).
    struct Meal: Codable, Hashable, Sendable {
        var code: String
        var label: String
    }
}


extension MetricSample {
    /// Rows already in the upload queue were written before the flags existed: a missing key reads as `false`.
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
        artifactSuspected = try c.decodeIfPresent(Bool.self, forKey: .artifactSuspected) ?? false
        lateArrival = try c.decodeIfPresent(Bool.self, forKey: .lateArrival) ?? false
        duplicateResolved = try c.decodeIfPresent(Bool.self, forKey: .duplicateResolved) ?? false
        meal = try c.decodeIfPresent(Meal.self, forKey: .meal)
    }
}
