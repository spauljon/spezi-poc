//
// This source file is part of the Spezi POC capture app, adapted from the Stanford Spezi Template Application
//
// SPDX-FileCopyrightText: 2023 Stanford University and the project authors (see CONTRIBUTORS.md)
//
// SPDX-License-Identifier: MIT
//

import Foundation
import HealthKit


/// The device fields HealthKit gives for a sample (`HKDevice`), as plain strings.
struct HealthKitDevice: Equatable, Sendable {
    var name: String?
    var manufacturer: String?
    var model: String?
    var hardwareVersion: String?
    var softwareVersion: String?
}


/// One HealthKit sample reduced to plain, `Sendable` values, so the rest of the pipeline neither imports HealthKit nor
/// holds an `HKSample`. Only what the contract needs is kept: nothing else about the person is read.
///
/// A record is REAL DATA once it holds a sample from a phone. It must never be logged or printed (see the guard test
/// that scans the sources for logging calls).
struct HealthKitRecord: Equatable, Sendable {
    /// The HealthKit type identifier, for example `HKQuantityTypeIdentifierHeartRate`.
    var typeIdentifier: String
    /// A quantity, already converted to the unit the contract states for the metric (`/min`, `ms`).
    var value: Double?
    /// A category sample's raw value (`HKCategoryValueSleepAnalysis`).
    var categoryValue: Int?
    var start: Date
    var end: Date
    /// The sample's UUID: its identity (lowercased by the mapper, contract A16).
    var uuid: String
    /// `HKMetadataKeyTimeZone`, when the source recorded one.
    var timeZoneIdentifier: String?
    /// `HKMetadataKeyWasUserEntered`.
    var userEntered: Bool
    var device: HealthKitDevice?
    /// The app or device the sample came from (`HKSource.name`); used to describe a sample that has no `HKDevice`.
    var sourceName: String
    /// The source's bundle identifier (`HKSource.bundleIdentifier`, a reverse-DNS app id): the identity of a source
    /// application (contract `deviceKey.appSource*`). An app id, not personal data.
    var sourceBundleIdentifier: String?
    /// The meal label a source wrote into the sample's metadata (keys `meal` and `Meal`, see `resolveMealLabel`).
    var mealLabel: String?
    /// The two meal keys were both present and disagreed: no label is used and the case is counted.
    var mealConflict = false
}


extension HealthKitRecord {
    /// The unit a quantity type is read in. This is the one place a HealthKit unit is named; the metric's unit in the
    /// contract is checked against it by a test (`/min` is count per minute, `ms` is milliseconds).
    static func unit(forQuantityIdentifier identifier: String) -> HKUnit? {
        switch identifier {
        case HKQuantityTypeIdentifier.heartRate.rawValue, HKQuantityTypeIdentifier.restingHeartRate.rawValue:
            HKUnit.count().unitDivided(by: .minute())
        case HKQuantityTypeIdentifier.heartRateVariabilitySDNN.rawValue:
            HKUnit.secondUnit(with: .milli)
        // Dietary intake (contract kind `intake`): explicit units, so the value never depends on a locale.
        case HKQuantityTypeIdentifier.dietaryEnergyConsumed.rawValue:
            HKUnit.kilocalorie()
        case HKQuantityTypeIdentifier.dietaryProtein.rawValue, HKQuantityTypeIdentifier.dietaryCarbohydrates.rawValue,
             HKQuantityTypeIdentifier.dietaryFatTotal.rawValue, HKQuantityTypeIdentifier.dietaryFiber.rawValue,
             HKQuantityTypeIdentifier.dietarySugar.rawValue:
            HKUnit.gram()
        case HKQuantityTypeIdentifier.dietarySodium.rawValue:
            HKUnit.gramUnit(with: .milli)
        case HKQuantityTypeIdentifier.dietaryWater.rawValue:
            HKUnit.literUnit(with: .milli)
        default:
            nil
        }
    }
    
    /// The meal label from the two metadata keys a source is known to use (`meal` and `Meal`, contract A38). One key is
    /// the label. Two keys that agree (ignoring case and surrounding whitespace) are the first one as written. Two that
    /// disagree are NO label and a conflict: a guess would file the entry under the wrong meal. Blank is absent.
    static func resolveMealLabel(_ values: [String?]) -> (label: String?, conflict: Bool) {
        let present = values.compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
        guard let first = present.first else { return (nil, false) }
        let agree = present.allSatisfy { $0.caseInsensitiveCompare(first) == .orderedSame }
        return agree ? (first, false) : (nil, true)
    }
    
    /// `nil` for a sample this app does not read (another type, or a quantity in an incompatible unit).
    init?(sample: HKSample) {
        var value: Double?
        var category: Int?
        switch sample {
        case let quantity as HKQuantitySample:
            let identifier = quantity.quantityType.identifier
            guard let unit = Self.unit(forQuantityIdentifier: identifier), quantity.quantity.is(compatibleWith: unit) else {
                return nil
            }
            value = quantity.quantity.doubleValue(for: unit)
        case let sample as HKCategorySample:
            category = sample.value
        default:
            return nil
        }
        let metadata = sample.metadata ?? [:]
        let meal = Self.resolveMealLabel([metadata["meal"] as? String, metadata["Meal"] as? String])
        let device = sample.device.map {
            HealthKitDevice(name: $0.name, manufacturer: $0.manufacturer, model: $0.model, hardwareVersion: $0.hardwareVersion, softwareVersion: $0.softwareVersion)
        }
        self.init(
            typeIdentifier: sample.sampleType.identifier,
            value: value,
            categoryValue: category,
            start: sample.startDate,
            end: sample.endDate,
            uuid: sample.uuid.uuidString,
            timeZoneIdentifier: metadata[HKMetadataKeyTimeZone] as? String,
            userEntered: (metadata[HKMetadataKeyWasUserEntered] as? NSNumber)?.boolValue ?? false,
            device: device,
            sourceName: sample.sourceRevision.source.name,
            sourceBundleIdentifier: sample.sourceRevision.source.bundleIdentifier,
            mealLabel: meal.label,
            mealConflict: meal.conflict
        )
    }
}
