//
// This source file is part of the Spezi POC capture app, adapted from the Stanford Spezi Template Application
//
// SPDX-FileCopyrightText: 2023 Stanford University and the project authors (see CONTRIBUTORS.md)
//
// SPDX-License-Identifier: MIT
//

@testable import TemplateApplication
import Foundation
import Testing


/// The synthetic meal log: measured against what it claims, with a control for every fault (the same check with the
/// fault switched off finds nothing). Synthetic data only.
@Suite("Synthetic meals")
struct MealGeneratorTests {
    private let zone = TimeZone(identifier: "America/Los_Angeles") ?? .gmt
    
    private func registry() throws -> MetricRegistry {
        try MetricRegistry.load(bundle: .main)
    }
    
    private func localDay(_ year: Int, _ month: Int, _ day: Int) -> Date {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = zone
        return calendar.date(from: DateComponents(year: year, month: month, day: day)) ?? .distantPast
    }
    
    private func config(skip: Double = 0, edit: Double = 0, delete: Double = 0, artifact: Double = 0, seed: UInt64 = 42) -> SyntheticConfig {
        var c = SyntheticConfig()
        c.seed = seed
        c.metrics = [.nutrition]
        c.meals = SyntheticConfig.Meals(skipDayFraction: skip, editFraction: edit, deleteFraction: delete)
        c.artifactFraction = artifact
        return c
    }
    
    /// Every emission delivered in `days` local days from 12 Jan 2026.
    private func run(_ config: SyntheticConfig, days: Int = 30) throws -> [Emission] {
        let start = localDay(2026, 1, 12)
        return SyntheticGenerator(config: config, registry: try registry())
            .emissions(deliveredIn: start..<start.addingTimeInterval(Double(days) * 86_400))
    }
    
    // "syn-<seed>-food-<day>-<slot>-<item>-<metric>-v<version>"
    private func parts(_ emission: Emission) -> [Substring] {
        emission.sample.id.split(separator: "-")
    }
    
    /// One food entry (one version of it): the id without the nutrient.
    private func foodKey(_ emission: Emission) -> String {
        let p = parts(emission)
        return (p[0..<6] + [p[7]]).joined(separator: "-")
    }
    
    private func foods(_ emissions: [Emission]) -> [String: [Emission]] {
        Dictionary(grouping: emissions, by: foodKey)
    }
    
    private func version(_ emission: Emission) -> String {
        String(parts(emission)[7])
    }
    
    private func value(_ emission: Emission) -> Double {
        if case .quantity(_, let value) = emission.sample.measurement { return value }
        return .nan
    }
    
    private func metric(_ emission: Emission) -> MetricID? {
        if case .quantity(let id, _) = emission.sample.measurement { return id }
        return nil
    }
    
    private func localHour(_ date: Date) -> Double {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = zone
        let c = calendar.dateComponents([.hour, .minute], from: date)
        return Double(c.hour ?? 0) + Double(c.minute ?? 0) / 60
    }
    
    private func localDayKey(_ date: Date) -> String {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = zone
        let c = calendar.dateComponents([.year, .month, .day], from: date)
        return "\(c.year ?? 0)-\(c.month ?? 0)-\(c.day ?? 0)"
    }
    
    
    @Test("nutrition is off unless asked for; the Meal log preset asks for it, with its faults")
    func offByDefault() throws {
        #expect(!SyntheticConfig().metrics.contains(.nutrition))
        let plain = SyntheticGenerator(config: SyntheticConfig(), registry: try registry())
            .emissions(deliveredIn: localDay(2026, 1, 12)..<localDay(2026, 1, 13))
        #expect(plain.allSatisfy { metric($0).map { id in !MetricID.allCases.filter { $0.rawValue.hasPrefix("dietary") }.contains(id) } ?? true })
        let preset = SyntheticPreset.meals.applied(to: SyntheticConfig())
        #expect(preset.metrics.contains(.nutrition) && preset.meals.editFraction > 0 && preset.meals.skipDayFraction > 0)
        // other presets switch the faults back off
        #expect(SyntheticPreset.cleanDay.applied(to: preset).meals == SyntheticConfig.Meals())
    }
    
    @Test("every food entry is the eight nutrients at one instant, with its meal, and no value is negative or non-finite")
    func foodEntries() throws {
        let emissions = try run(config())
        #expect(emissions.count > 500)
        let all = Set(MetricID.allCases.filter { $0.rawValue.hasPrefix("dietary") })
        #expect(all.count == 8)
        for (key, items) in foods(emissions) {
            #expect(Set(items.compactMap(metric)) == all && items.count == 8, "\(key)")
            #expect(Set(items.map { $0.sample.start }).count == 1 && items.allSatisfy { $0.sample.start == $0.sample.end }, "\(key): one instant")
            #expect(Set(items.compactMap { $0.sample.meal }).count == 1, "\(key): one meal")
        }
        #expect(emissions.allSatisfy { value($0).isFinite && value($0) >= 0 })
        #expect(emissions.allSatisfy { $0.sample.source == .synthetic })
    }
    
    @Test("meals have fixed roles at plausible times, with labels and codes that come from the contract and agree")
    func meals() throws {
        let registry = try registry()
        let emissions = try run(config())
        for emission in emissions {
            let meal = try #require(emission.sample.meal)
            #expect(registry.mealTypes[meal.code] != nil, "\(meal.code) is a contract meal type")
            #expect(registry.meal(forLabel: meal.label)?.code == meal.code, "the label \(meal.label) normalizes to its own code")
        }
        #expect(Set(emissions.compactMap { $0.sample.meal?.code }) == ["breakfast", "lunch", "snack", "dinner"])
        #expect(emissions.contains { $0.sample.meal == MetricSample.Meal(code: "snack", label: "Snacks") }, "the snack label is the plural alias")
        let lunchHours = emissions.filter { $0.sample.meal?.code == "lunch" }.map { localHour($0.sample.start) }
        #expect((lunchHours.min() ?? 0) >= 11.9 && (lunchHours.max() ?? 24) <= 13.2, "lunch is logged around half past twelve")
        let breakfastHours = emissions.filter { $0.sample.meal?.code == "breakfast" }.map { localHour($0.sample.start) }
        #expect((breakfastHours.max() ?? 24) < (lunchHours.min() ?? 0), "breakfast precedes lunch")
    }
    
    @Test("a day with nothing logged has NO samples (no data, not zero); with the fault off every day has entries")
    func daysWithNothing() throws {
        let days = 120
        func daysWithEntries(_ c: SyntheticConfig) throws -> Int {
            Set(try run(c, days: days).map { localDayKey($0.sample.start) }).count
        }
        // the control: no fault, every day (the first and last may be cut by the delivery window)
        #expect(try daysWithEntries(config()) >= days - 1)
        let skipped = try daysWithEntries(config(skip: 0.3))
        let share = 1 - Double(skipped) / Double(days)
        #expect(share > 0.2 && share < 0.4, "about 30% of days are empty, got \(share)")
    }
    
    @Test("zero is a real intake and appears; nothing is negative; energy is never zero")
    func zeros() throws {
        let emissions = try run(config())
        let zeros = emissions.filter { value($0) == 0 }
        #expect(!zeros.isEmpty)
        #expect(Set(zeros.compactMap(metric)).isSubset(of: [.dietaryFiber, .dietarySugar, .dietarySodium, .dietaryWater]))
        #expect(emissions.filter { metric($0) == .dietaryEnergy }.allSatisfy { value($0) > 0 })
    }
    
    @Test("an edited entry is replaced by a corrected one with new ids, other amounts and a later delivery")
    func edits() throws {
        let emissions = try run(config(edit: 0.25), days: 60)
        let byFood = foods(emissions)
        let originals = byFood.filter { $0.key.hasSuffix("-v1") }
        let edited = originals.filter { $0.value.allSatisfy { $0.injected.contains(.edited) } }
        let share = Double(edited.count) / Double(originals.count)
        #expect(share > 0.15 && share < 0.35, "about 25% of entries are edited, got \(share)")
        
        var checked = 0
        for (key, original) in edited {
            let replacement = try #require(byFood[String(key.dropLast(2)) + "v2"], "\(key) has a corrected entry")
            checked += 1
            #expect(replacement.count == 8 && Set(replacement.map { $0.sample.id }).isDisjoint(with: original.map { $0.sample.id }), "new ids")
            #expect(replacement[0].sample.start == original[0].sample.start, "the same instant: it is the same entry, corrected")
            #expect(replacement[0].sample.meal == original[0].sample.meal)
            let lag = replacement[0].sample.issued.timeIntervalSince(original[0].sample.issued)
            #expect(lag >= 300 && lag <= 3600, "delivered 5 to 60 minutes later, got \(lag)")
            let energy = { (items: [Emission]) in items.first { metric($0) == .dietaryEnergy }.map(value) ?? .nan }
            #expect(energy(replacement) != energy(original), "the amounts differ")
            #expect(replacement.allSatisfy { !$0.injected.contains(.edited) }, "the replacement is an ordinary entry")
        }
        #expect(checked > 10)
        // no replacement without an edited original
        for key in byFood.keys where key.hasSuffix("-v2") {
            #expect(edited[String(key.dropLast(2)) + "v1"] != nil, "\(key) replaces nothing")
        }
        // the control: no faults, no replacements and no marks
        let clean = try run(config(), days: 60)
        #expect(clean.allSatisfy { version($0) == "v1" && !$0.injected.contains(.edited) })
    }
    
    @Test("a deleted entry is marked by ground truth, never also edited; with the fault off none is marked")
    func deletions() throws {
        let emissions = try run(config(edit: 0.2, delete: 0.2), days: 60)
        let originals = foods(emissions).filter { $0.key.hasSuffix("-v1") }
        let deleted = originals.filter { $0.value.allSatisfy { $0.injected.contains(.deleted) } }
        let share = Double(deleted.count) / Double(originals.count)
        #expect(share > 0.1 && share < 0.3, "about 20% of entries are deleted, got \(share)")
        #expect(originals.allSatisfy { !($0.value[0].injected.contains(.deleted) && $0.value[0].injected.contains(.edited)) })
        #expect(try run(config(edit: 0.2), days: 30).allSatisfy { !$0.injected.contains(.deleted) })
    }
    
    @Test("implausible energy figures are injected, and the contract's flagger flags exactly those (and nothing in a clean log)")
    func artifacts() throws {
        let registry = try registry()
        let flagger = QualityFlagger(registry: registry)
        let noisy = try run(config(artifact: 0.2), days: 30)
        let injected = noisy.filter { $0.injected.contains(.artifact) }
        #expect(injected.count > 20)
        #expect(injected.allSatisfy { metric($0) == .dietaryEnergy }, "only the energy figure carries an artifact")
        for emission in noisy {
            #expect(flagger.isArtifact(emission.sample) == emission.injected.contains(.artifact), "\(emission.sample.id)")
        }
        // the control: a clean log has no flagged value, so the plausible ranges do not catch ordinary food
        #expect(try run(config(), days: 30).allSatisfy { !flagger.isArtifact($0.sample) })
    }
    
    @Test("every emission maps to a FHIR Observation, with the domain and the meal as separate category entries")
    func mapsToFHIR() throws {
        let registry = try registry()
        let mapper = ObservationMapper(registry: registry)
        let emissions = try run(config(skip: 0.1, edit: 0.2, delete: 0.1, artifact: 0.1), days: 14)
        for emission in emissions {
            guard case .observation(let observation) = try mapper.map(emission.sample, patientID: "p") else {
                Issue.record("\(emission.sample.id) did not map")
                continue
            }
            #expect(observation.category.count == 2)
            #expect(observation.category[0].coding?.first?.system == registry.systems.observationDomain)
            #expect(observation.category[1].coding?.first?.system == registry.systems.mealType)
            #expect(observation.category[1].text == emission.sample.meal?.label)
        }
        #expect(!emissions.isEmpty)
    }
    
    @Test("the same config and seed give the same meals, a window in pieces equals the whole, and another seed differs")
    func determinism() throws {
        let c = config(skip: 0.1, edit: 0.2, delete: 0.1, artifact: 0.1)
        let registry = try registry()
        let generator = SyntheticGenerator(config: c, registry: registry)
        let start = localDay(2026, 1, 12)
        let middle = start.addingTimeInterval(10 * 86_400), end = start.addingTimeInterval(20 * 86_400)
        let whole = generator.emissions(deliveredIn: start..<end)
        #expect(whole == generator.emissions(deliveredIn: start..<end))
        let pieces = generator.emissions(deliveredIn: start..<middle) + generator.emissions(deliveredIn: middle..<end)
        #expect(Set(whole.map { $0.sample.id }) == Set(pieces.map { $0.sample.id }), "a window generated in pieces equals the whole")
        let other = SyntheticGenerator(config: config(skip: 0.1, edit: 0.2, delete: 0.1, artifact: 0.1, seed: 7), registry: registry)
            .emissions(deliveredIn: start..<end)
        #expect(Set(whole.map { $0.sample.id }).isDisjoint(with: other.map { $0.sample.id }), "ids carry the seed")
    }
}
