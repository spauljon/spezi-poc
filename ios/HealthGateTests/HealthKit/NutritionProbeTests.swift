//
// This source file is part of the Spezi POC capture app, adapted from the Stanford Spezi Template Application
//
// SPDX-FileCopyrightText: 2023 Stanford University and the project authors (see CONTRIBUTORS.md)
//
// SPDX-License-Identifier: MIT
//

import Foundation
import Testing
@testable import HealthGate


/// The structure probe's summary, on synthetic structure only (no HealthKit, no real sample).
@Suite("Nutrition structure probe")
struct NutritionProbeTests {
    private let utc: Calendar = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = .gmt
        return calendar
    }()
    private let day0 = Date(timeIntervalSince1970: 1_800_000_000) // a fixed instant; days are built from it
    
    private func sample(_ type: String, at offset: TimeInterval, keys: [String] = ["HKMetadataKeyTimeZone", "meal", "Meal"],
                        labels: [String] = ["Lunch", "lunch"], source: String? = "com.example.food", correlated: Bool = false) -> ProbeSample {
        let time = day0.addingTimeInterval(offset)
        return ProbeSample(typeName: type, start: time, end: time, timeZoneWritten: keys.contains("HKMetadataKeyTimeZone"), userEntered: false,
                           metadataKeys: keys, mealLabels: labels, sourceBundleIdentifier: source, inFoodCorrelation: correlated)
    }
    
    private let eight = ["DietaryEnergyConsumed", "DietaryProtein", "DietaryCarbohydrates", "DietaryFatTotal",
                         "DietaryFiber", "DietarySugar", "DietarySodium", "DietaryWater"]
    
    @Test("an entry written as eight samples at one instant is seen as a group of eight; separate instants are groups of one (the control)")
    func groups() {
        let entry = eight.map { sample($0, at: 0) }
        let structure = NutritionStructure.summarize(entry, calendar: utc)
        #expect(structure.total == 8 && structure.distinctInstants == 1)
        #expect(structure.groupSizes == [8: 1])
        
        let spread = eight.enumerated().map { sample($0.element, at: Double($0.offset) * 60) }
        let apart = NutritionStructure.summarize(spread, calendar: utc)
        #expect(apart.groupSizes == [1: 8] && apart.distinctInstants == 8, "the same eight samples at eight instants are not one entry")
    }
    
    @Test("distinct days and the number of distinct times per day")
    func days() {
        let morning = eight.map { sample($0, at: 0) }
        let evening = [sample("DietaryEnergyConsumed", at: 6 * 3600)]
        let nextDay = [sample("DietaryEnergyConsumed", at: 30 * 3600)]
        let structure = NutritionStructure.summarize(morning + evening + nextDay, calendar: utc)
        #expect(structure.distinctDays == 2)
        #expect(structure.instantsPerDayRange == 1...2)
    }
    
    @Test("meal keys: both present, one present, none; labels are shown as written, trimmed and shortened")
    func meals() {
        let both = sample("DietaryProtein", at: 0)
        let one = sample("DietaryProtein", at: 60, keys: ["meal"], labels: [" Snacks "])
        let none = sample("DietaryProtein", at: 120, keys: [], labels: [])
        let long = sample("DietaryProtein", at: 180, keys: ["Meal"], labels: [String(repeating: "x", count: 100)])
        let structure = NutritionStructure.summarize([both, one, none, long], calendar: utc)
        #expect(structure.withBothMealKeys == 1)
        #expect(structure.withAnyMealKey == 3)
        #expect(structure.mealLabels["Snacks"] == 1)
        #expect(structure.mealLabels["Lunch"] == 1 && structure.mealLabels["lunch"] == 1, "the case it was written in is kept")
        #expect(structure.mealLabels.keys.allSatisfy { $0.count <= NutritionStructure.maxLabelLength })
    }
    
    @Test("key names, time zone, correlation and source counts")
    func counts() {
        let a = sample("DietaryEnergyConsumed", at: 0, keys: ["HKExternalUUID", "HKMetadataKeyTimeZone"], labels: [], correlated: true)
        let b = sample("DietaryEnergyConsumed", at: 60, keys: ["HKExternalUUID"], labels: [], source: nil)
        let structure = NutritionStructure.summarize([a, b], correlations: 1, calendar: utc)
        #expect(structure.metadataKeys == ["HKExternalUUID": 2, "HKMetadataKeyTimeZone": 1])
        #expect(structure.timeZoneWritten == 1)
        #expect(structure.inFoodCorrelation == 1 && structure.correlations == 1)
        #expect(structure.sources == ["com.example.food": 1, "(none)": 1])
    }
    
    @Test("the text carries counts and key names and nothing else; an empty window says so")
    func text() {
        let structure = NutritionStructure.summarize(eight.map { sample($0, at: 0) }, calendar: utc)
        let text = structure.lines.joined(separator: "\n")
        #expect(text.contains("Samples: 8 in 1 distinct start times on 1 days"))
        #expect(text.contains("8: 1"))
        #expect(text.contains("HKMetadataKeyTimeZone 8"))
        #expect(NutritionStructure.summarize([], calendar: utc).lines.count == 1)
        // ProbeSample has no member that could hold a quantity or a food name
        let members = Mirror(reflecting: sample("DietaryProtein", at: 0)).children.compactMap(\.label)
        #expect(Set(members) == ["typeName", "start", "end", "timeZoneWritten", "userEntered", "metadataKeys", "mealLabels", "sourceBundleIdentifier", "inFoodCorrelation"])
    }
}
