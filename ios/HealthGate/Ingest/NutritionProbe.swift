//
// This source file is part of the Spezi POC capture app, adapted from the Stanford Spezi Template Application
//
// SPDX-FileCopyrightText: 2023 Stanford University and the project authors (see CONTRIBUTORS.md)
//
// SPDX-License-Identifier: MIT
//

import Foundation
import HealthKit


/// One nutrition sample reduced to its STRUCTURE: when it happened, which metadata key names it carries, whether it sits
/// in a food correlation. It has no field for a quantity, a food name or any metadata value except the meal label, so
/// nothing a person ate can reach the summary. (M21 structure probe; the file is real data once it holds a sample, so it is
/// never logged or printed.)
struct ProbeSample: Equatable, Sendable {
    var typeName: String
    var start: Date
    var end: Date
    var timeZoneWritten: Bool
    var userEntered: Bool
    /// The names (never the values) of every metadata key on the sample.
    var metadataKeys: [String]
    /// The values under the keys named `meal` in any case: the one text value the probe reports, because the meal-type
    /// labels' shape is what it is for.
    var mealLabels: [String]
    var sourceBundleIdentifier: String?
    var inFoodCorrelation: Bool
}


/// What the probe tells the developer: counts and key names. Decides N5 (samples per entry), N6 (a per-entry id) and N7
/// (how a source names meals) before the daily totals build on them.
struct NutritionStructure: Equatable, Sendable {
    var total = 0
    var perType: [String: Int] = [:]
    var correlations = 0
    var inFoodCorrelation = 0
    /// Samples that share a start instant, by group size: `[8: 40]` means 40 instants carry 8 samples each.
    var groupSizes: [Int: Int] = [:]
    var distinctInstants = 0
    var distinctDays = 0
    var instantsPerDayRange: ClosedRange<Int>?
    var metadataKeys: [String: Int] = [:]
    var withBothMealKeys = 0
    var withAnyMealKey = 0
    /// Meal label as written (trimmed, shortened) to how many samples carry it.
    var mealLabels: [String: Int] = [:]
    var timeZoneWritten = 0
    var userEntered = 0
    var sources: [String: Int] = [:]
    
    static let maxLabels = 12
    static let maxLabelLength = 24
    
    static func summarize(_ samples: [ProbeSample], correlations: Int = 0, calendar: Calendar = .current) -> NutritionStructure {
        var out = NutritionStructure()
        out.total = samples.count
        out.correlations = correlations
        var instants: [Date: Int] = [:]
        var perDay: [DateComponents: Set<Date>] = [:]
        for sample in samples {
            out.perType[sample.typeName, default: 0] += 1
            instants[sample.start, default: 0] += 1
            let day = calendar.dateComponents([.year, .month, .day], from: sample.start)
            perDay[day, default: []].insert(sample.start)
            for key in Set(sample.metadataKeys) {
                out.metadataKeys[key, default: 0] += 1
            }
            let mealKeys = Set(sample.metadataKeys.filter { $0.lowercased() == "meal" })
            if mealKeys.count > 1 { out.withBothMealKeys += 1 }
            if !mealKeys.isEmpty { out.withAnyMealKey += 1 }
            for label in Set(sample.mealLabels.map { Self.shape($0) }) where !label.isEmpty {
                out.mealLabels[label, default: 0] += 1
            }
            if sample.timeZoneWritten { out.timeZoneWritten += 1 }
            if sample.userEntered { out.userEntered += 1 }
            if sample.inFoodCorrelation { out.inFoodCorrelation += 1 }
            out.sources[sample.sourceBundleIdentifier ?? "(none)", default: 0] += 1
        }
        out.distinctInstants = instants.count
        for size in instants.values {
            out.groupSizes[size, default: 0] += 1
        }
        out.distinctDays = perDay.count
        let counts = perDay.values.map(\.count)
        if let low = counts.min(), let high = counts.max() {
            out.instantsPerDayRange = low...high
        }
        return out
    }
    
    /// A label as it will be shown: trimmed and cut short, so a free-text value cannot run on.
    static func shape(_ label: String) -> String {
        String(label.trimmingCharacters(in: .whitespacesAndNewlines).prefix(maxLabelLength))
    }
    
    /// The text the screen shows. Counts and key names; no values.
    var lines: [String] {
        guard total > 0 else { return ["No nutrition samples in the window (or access was not granted)."] }
        var out: [String] = []
        out.append("Samples: \(total) in \(distinctInstants) distinct start times on \(distinctDays) days")
        if let range = instantsPerDayRange {
            out.append("Distinct start times per day: \(range.lowerBound) to \(range.upperBound)")
        }
        out.append("Per type: " + perType.sorted { $0.key < $1.key }.map { "\($0.key) \($0.value)" }.joined(separator: ", "))
        out.append("Samples sharing a start time (size: how many times): " + groupSizes.sorted { $0.key < $1.key }.map { "\($0.key): \($0.value)" }.joined(separator: ", "))
        out.append("In a food correlation: \(inFoodCorrelation) samples; correlations found: \(correlations)")
        out.append("Time zone written: \(timeZoneWritten); user entered: \(userEntered)")
        out.append("Meal key present: \(withAnyMealKey); both meal keys present: \(withBothMealKeys)")
        if !mealLabels.isEmpty {
            out.append("Meal labels (as written): " + mealLabels.sorted { $0.value > $1.value || ($0.value == $1.value && $0.key < $1.key) }
                .prefix(Self.maxLabels).map { "\($0.key) \($0.value)" }.joined(separator: ", "))
        }
        out.append("Metadata key names (samples carrying each): " + metadataKeys.sorted { $0.key < $1.key }.map { "\($0.key) \($0.value)" }.joined(separator: ", "))
        out.append("Sources: " + sources.sorted { $0.key < $1.key }.map { "\($0.key) \($0.value)" }.joined(separator: ", "))
        return out
    }
}


/// Reads the nutrition samples of the last days from Apple Health (read-only) and reduces them to `ProbeSample`s.
enum NutritionProbe {
    static let types: [HKQuantityTypeIdentifier] = [
        .dietaryEnergyConsumed, .dietaryProtein, .dietaryCarbohydrates, .dietaryFatTotal,
        .dietaryFiber, .dietarySugar, .dietarySodium, .dietaryWater
    ]
    static let limitPerType = 5_000
    
    static func run(store: HKHealthStore = HKHealthStore(), since: Date) async -> NutritionStructure {
        guard HKHealthStore.isHealthDataAvailable() else { return NutritionStructure() }
        let predicate = HKQuery.predicateForSamples(withStart: since, end: nil, options: [])
        let correlated = await correlatedUUIDs(store: store, predicate: predicate)
        var probes: [ProbeSample] = []
        for identifier in types {
            guard let type = HKQuantityType.quantityType(forIdentifier: identifier) else { continue }
            for sample in await samples(store: store, type: type, predicate: predicate) {
                let metadata = sample.metadata ?? [:]
                let labels = metadata.filter { $0.key.lowercased() == "meal" }.compactMap { $0.value as? String }
                probes.append(ProbeSample(
                    typeName: identifier.rawValue.replacingOccurrences(of: "HKQuantityTypeIdentifier", with: ""),
                    start: sample.startDate, end: sample.endDate,
                    timeZoneWritten: metadata[HKMetadataKeyTimeZone] != nil,
                    userEntered: (metadata[HKMetadataKeyWasUserEntered] as? NSNumber)?.boolValue ?? false,
                    metadataKeys: Array(metadata.keys),
                    mealLabels: labels,
                    sourceBundleIdentifier: sample.sourceRevision.source.bundleIdentifier,
                    inFoodCorrelation: correlated.members.contains(sample.uuid)))
            }
        }
        return NutritionStructure.summarize(probes, correlations: correlated.count)
    }
    
    private static func samples(store: HKHealthStore, type: HKSampleType, predicate: NSPredicate) async -> [HKSample] {
        await withCheckedContinuation { continuation in
            let query = HKSampleQuery(sampleType: type, predicate: predicate, limit: limitPerType, sortDescriptors: nil) { _, results, _ in
                continuation.resume(returning: results ?? [])
            }
            store.execute(query)
        }
    }
    
    private static func correlatedUUIDs(store: HKHealthStore, predicate: NSPredicate) async -> (members: Set<UUID>, count: Int) {
        guard let food = HKCorrelationType.correlationType(forIdentifier: .food) else { return ([], 0) }
        return await withCheckedContinuation { continuation in
            let query = HKCorrelationQuery(type: food, predicate: predicate, samplePredicates: nil) { _, correlations, _ in
                let found = correlations ?? []
                continuation.resume(returning: (Set(found.flatMap { $0.objects.map(\.uuid) }), found.count))
            }
            store.execute(query)
        }
    }
}
