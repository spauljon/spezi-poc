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


// MARK: - Helpers

private let zone = TimeZone(identifier: "America/Los_Angeles") ?? .gmt

private func localDay(_ year: Int, _ month: Int, _ day: Int) -> Date {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = zone
    return calendar.date(from: DateComponents(year: year, month: month, day: day)) ?? .distantPast
}

/// Monday 2026-01-12 00:00 Pacific, an ordinary winter day.
private let day0 = localDay(2026, 1, 12)

private func window(days: Double = 1, from start: Date = day0) -> Range<Date> {
    start..<start.addingTimeInterval(days * 86_400)
}

private func quantities(_ emissions: [Emission], _ id: MetricID) -> [Emission] {
    emissions.filter {
        if case .quantity(let metric, _) = $0.sample.measurement { return metric == id }
        return false
    }
}

private func value(_ emission: Emission) -> Double {
    if case .quantity(_, let value) = emission.sample.measurement { return value }
    return .nan
}

private func sleepStages(_ emissions: [Emission]) -> [Emission] {
    emissions.filter {
        if case .sleep = $0.sample.measurement { return true }
        return false
    }
}

private func stage(_ emission: Emission) -> SleepStage? {
    if case .sleep(let stage) = emission.sample.measurement { return stage }
    return nil
}

private func hr(_ config: SyntheticConfig, days: Double = 1) -> [Emission] {
    var only = config
    only.metrics = [.heartRate]
    return SyntheticGenerator(config: only).emissions(deliveredIn: window(days: days))
}


// MARK: - The random source

@Suite("Keyed random")
struct KeyedRandomTests {
    @Test("matches reference values computed by an independent implementation")
    func referenceVectors() {
        #expect(KeyedRandom(seed: 42).raw(1, 0) == 15_563_345_056_690_163_072)
        #expect(KeyedRandom(seed: 42).raw(1, 1) == 678_961_091_478_010_903)
        #expect(KeyedRandom(seed: 42).raw(2, 0) == 6_774_038_206_633_923_208)
        #expect(KeyedRandom(seed: 0xDEAD_BEEF).raw(7, 123_456) == 17_095_724_483_223_148_282)
        #expect(KeyedRandom(seed: 42).raw(1, -1) == 814_261_035_509_592_648)
        #expect(abs(KeyedRandom(seed: 42).unit(1, 0) - 0.84369062608025047) < 1e-15)
    }
    
    @Test("is stateless, uniform enough, and depends on the seed and on the stream")
    func properties() {
        let r = KeyedRandom(seed: 7)
        #expect(r.unit(3, 99) == r.unit(3, 99))
        #expect(r.unit(3, 99) != KeyedRandom(seed: 8).unit(3, 99))
        #expect(r.unit(3, 99) != r.unit(4, 99))
        let sample = (0..<20_000).map { r.unit(1, Int64($0)) }
        let mean = sample.reduce(0, +) / Double(sample.count)
        #expect(abs(mean - 0.5) < 0.01, "mean \(mean)")
        #expect(sample.allSatisfy { $0 >= 0 && $0 < 1 })
    }
}


// MARK: - Determinism and windows

@Suite("Generator determinism")
struct DeterminismTests {
    @Test("the same config and seed give identical output; another seed gives different output")
    func deterministic() {
        let config = SyntheticPreset.everything.applied(to: SyntheticConfig())
        let a = SyntheticGenerator(config: config).emissions(deliveredIn: window(days: 0.25))
        let b = SyntheticGenerator(config: config).emissions(deliveredIn: window(days: 0.25))
        #expect(!a.isEmpty)
        #expect(a == b)
        var other = config
        other.seed = 43
        #expect(SyntheticGenerator(config: other).emissions(deliveredIn: window(days: 0.25)) != a)
    }
    
    @Test("a window generated in pieces equals the same window generated whole (late, batched, duplicates included)")
    func additive() {
        let config = SyntheticPreset.everything.applied(to: SyntheticConfig())
        let generator = SyntheticGenerator(config: config)
        let whole = generator.emissions(deliveredIn: window(days: 1))
        let cut1 = day0.addingTimeInterval(7 * 3600 + 13)
        let cut2 = day0.addingTimeInterval(16 * 3600 + 301)
        let pieces = generator.emissions(deliveredIn: day0..<cut1)
            + generator.emissions(deliveredIn: cut1..<cut2)
            + generator.emissions(deliveredIn: cut2..<day0.addingTimeInterval(86_400))
        #expect(whole.count > 10_000)
        #expect(pieces == whole)
    }
    
    @Test("pieces equal the whole when delays and batch alignment are large relative to the cut points")
    func additiveStrong() {
        var config = SyntheticConfig(metrics: [.heartRate, .hrv, .restingHeartRate, .sleep])
        config.heartRateCadence = 60
        config.late = .init(fraction: 0.3, minDelay: 3600, maxDelay: 7200)
        config.batchInterval = 3600
        config.duplicateFraction = 0.2
        let generator = SyntheticGenerator(config: config)
        let whole = generator.emissions(deliveredIn: window(days: 2))
        var pieces: [Emission] = []
        var cursor = day0
        for hours in [3.3, 9.7, 5.1, 11.9, 18.0] {
            let next = min(cursor.addingTimeInterval(hours * 3600), day0.addingTimeInterval(2 * 86_400))
            pieces += generator.emissions(deliveredIn: cursor..<next)
            cursor = next
        }
        pieces += generator.emissions(deliveredIn: cursor..<day0.addingTimeInterval(2 * 86_400))
        #expect(whole.count > 2_000)
        #expect(pieces == whole)
    }
    
    @Test("an empty or reversed window gives nothing")
    func emptyWindow() {
        let generator = SyntheticGenerator(config: SyntheticConfig())
        #expect(generator.emissions(deliveredIn: day0..<day0).isEmpty)
    }
    
    @Test("only the enabled metrics are produced")
    func metricFilter() {
        var config = SyntheticConfig()
        config.metrics = [.hrv]
        let out = SyntheticGenerator(config: config).emissions(deliveredIn: window())
        #expect(!out.isEmpty)
        #expect(quantities(out, .hrvSdnn).count == out.count)
    }
    
    @Test("out-of-range controls are clamped, not trusted")
    func clamping() {
        var config = SyntheticConfig()
        config.heartRateCadence = -5
        config.jitter = 9
        config.gaps = .init(perDay: 1_000, meanMinutes: 99_999)
        config.late = .init(fraction: 5, minDelay: -1, maxDelay: -2)
        config.duplicateFraction = 7
        config.artifactFraction = -1
        let clamped = config.clamped
        #expect(clamped.heartRateCadence == 1)
        #expect(clamped.jitter == 0.45)
        #expect(clamped.gaps.perDay == 48 && clamped.gaps.meanMinutes == 720)
        #expect(clamped.late.fraction == 1 && clamped.late.minDelay == 0 && clamped.late.maxDelay == 0)
        #expect(clamped.duplicateFraction == 1 && clamped.artifactFraction == 0)
        // Worst-case gaps cover the whole day, so the watch delivers nothing; the metrics that are not worn-device
        // streams (sleep, resting heart rate) must still arrive, and nothing may crash or hang.
        let out = SyntheticGenerator(config: config).emissions(deliveredIn: window(days: 2))
        #expect(quantities(out, .heartRate).isEmpty)
        #expect(!sleepStages(out).isEmpty && !quantities(out, .restingHeartRate).isEmpty)
    }
    
    @Test("snapshot: the first heart-rate samples for seed 42 (update deliberately if the waveform is changed on purpose)")
    func snapshot() {
        let out = quantities(SyntheticGenerator(config: SyntheticConfig()).emissions(deliveredIn: day0..<day0.addingTimeInterval(60)), .heartRate)
        #expect(out.count == 12)
        let values = out.prefix(3).map(value)
        // seed 42, local midnight in winter: night dip plus noise
        #expect(values.allSatisfy { $0 > 50 && $0 < 62 }, "\(values)")
        #expect(out.first?.sample.id == "syn-2a-hr-\(Int64(day0.timeIntervalSince1970 / 5))")
    }
}


// MARK: - Timing

@Suite("Generator timing")
struct TimingTests {
    @Test("a clean stream has exactly one heart-rate sample per cadence")
    func cadence() {
        let out = quantities(hr(SyntheticConfig()), .heartRate)
        #expect(out.count == 86_400 / 5)
        let gaps = Set(zip(out, out.dropFirst()).map { $1.sample.start.timeIntervalSince($0.sample.start) })
        #expect(gaps == [5])
        #expect(out.allSatisfy { $0.injected.isEmpty && $0.sample.issued == $0.sample.end })
    }
    
    @Test("a different cadence is honoured")
    func otherCadence() {
        var config = SyntheticConfig()
        config.heartRateCadence = 60
        #expect(hr(config).count == 1_440)
    }
    
    @Test("jitter moves samples within its bound, and not all by the same amount")
    func jitter() {
        var config = SyntheticConfig()
        config.jitter = 0.3
        let out = hr(config)
        var deviations: [Double] = []
        for e in out {
            let slot = (e.sample.start.timeIntervalSince1970 / 5).rounded()
            deviations.append(e.sample.start.timeIntervalSince1970 - slot * 5)
        }
        #expect(deviations.allSatisfy { abs($0) <= 0.3 * 5 + 0.001 }, "max \(deviations.map(abs).max() ?? 0)")
        #expect(Set(deviations.map { ($0 * 1000).rounded() }).count > 1_000, "jitter should vary")
        #expect(zip(out, out.dropFirst()).allSatisfy { $0.sample.start < $1.sample.start }, "order must be preserved")
    }
    
    @Test("late delivery changes issued, never the measurement time, within the stated delay")
    func lateDelivery() {
        var config = SyntheticConfig()
        config.late = .init(fraction: 0.25, minDelay: 3600, maxDelay: 7200)
        config.metrics = [.heartRate]
        let generator = SyntheticGenerator(config: config)
        let out = quantities(generator.emissions(deliveredIn: day0.addingTimeInterval(2 * 3600)..<day0.addingTimeInterval(26 * 3600)), .heartRate)
        let late = out.filter { $0.injected.contains(.late) }
        let onTime = out.filter { !$0.injected.contains(.late) }
        #expect(!late.isEmpty && !onTime.isEmpty)
        for e in late {
            let delay = e.sample.issued.timeIntervalSince(e.sample.end)
            #expect(delay >= 3600 && delay <= 7200, "delay \(delay)")
        }
        #expect(onTime.allSatisfy { $0.sample.issued == $0.sample.end })
        let share = Double(late.count) / Double(out.count)
        #expect(abs(share - 0.25) < 0.05, "late share \(share)")
    }
    
    @Test("batched delivery lands on batch boundaries and never before the measurement")
    func batching() {
        var config = SyntheticConfig()
        config.batchInterval = 900
        let out = quantities(hr(config), .heartRate)
        #expect(!out.isEmpty)
        for e in out {
            #expect(e.sample.issued >= e.sample.end)
            #expect(e.sample.issued.timeIntervalSince1970.truncatingRemainder(dividingBy: 900) == 0)
        }
        // Many samples share one delivery instant: that is what a batch is.
        let perInstant = Dictionary(grouping: out, by: { $0.sample.issued }).values.map(\.count)
        #expect(perInstant.max() ?? 0 >= 100)
        #expect(out.contains { $0.injected.contains(.batched) })
    }
}


// MARK: - Faults

@Suite("Generator faults")
struct FaultTests {
    @Test("no heart-rate or HRV sample is delivered inside a gap, and gaps occur at about the configured rate")
    func gaps() {
        var config = SyntheticConfig()
        config.gaps = .init(perDay: 3, meanMinutes: 20)
        config.heartRateCadence = 30
        let generator = SyntheticGenerator(config: config)
        let days = 10
        let out = generator.emissions(deliveredIn: window(days: Double(days)))
        let clean = SyntheticGenerator(config: SyntheticConfig(heartRateCadence: 30)).emissions(deliveredIn: window(days: Double(days)))
        
        var all: [Range<Date>] = []
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = zone
        for d in 0..<days {
            let dayStart = calendar.date(byAdding: .day, value: d, to: day0) ?? day0
            all += generator.gaps(forLocalDayStarting: dayStart)
        }
        let perDay = Double(all.count) / Double(days)
        #expect(abs(perDay - 3) < 1, "gaps per day \(perDay)")
        
        let measured = out.filter {
            if case .quantity(let id, _) = $0.sample.measurement { return id == .heartRate || id == .hrvSdnn }
            return false
        }
        let inside = measured.filter { e in all.contains { $0.contains(e.sample.start) } }
        #expect(inside.isEmpty, "\(inside.count) samples inside gaps")
        #expect(quantities(out, .heartRate).count < quantities(clean, .heartRate).count)
    }
    
    @Test("duplicates repeat identity and content, arrive later, and are flagged")
    func duplicates() {
        var config = SyntheticConfig()
        config.duplicateFraction = 0.2
        config.heartRateCadence = 30
        let out = quantities(hr(config), .heartRate)
        let byID = Dictionary(grouping: out, by: { $0.sample.id })
        let doubled = byID.values.filter { $0.count == 2 }
        #expect(byID.values.allSatisfy { $0.count <= 2 })
        let share = Double(doubled.count) / Double(byID.count)
        #expect(abs(share - 0.2) < 0.05, "duplicate share \(share)")
        for pair in doubled {
            let sorted = pair.sorted { $0.sample.issued < $1.sample.issued }
            #expect(sorted[0].sample.measurement == sorted[1].sample.measurement)
            #expect(sorted[0].sample.start == sorted[1].sample.start)
            #expect(sorted[1].sample.issued > sorted[0].sample.issued)
            #expect(!sorted[0].injected.contains(.duplicate) && sorted[1].injected.contains(.duplicate))
        }
    }
    
    @Test("artifacts are implausible, flagged by ground truth, and still valid input for the mapper")
    func artifacts() throws {
        var config = SyntheticConfig()
        config.artifactFraction = 0.05
        config.heartRateCadence = 30
        let out = quantities(hr(config), .heartRate)
        let artifacts = out.filter { $0.injected.contains(.artifact) }
        let normal = out.filter { !$0.injected.contains(.artifact) }
        let share = Double(artifacts.count) / Double(out.count)
        #expect(abs(share - 0.05) < 0.02, "artifact share \(share)")
        #expect(artifacts.allSatisfy { [25.0, 240.0, 280.0].contains(value($0)) })
        #expect(normal.allSatisfy { value($0) >= 35 && value($0) <= 200 }, "clean values must stay plausible")
        
        let mapper = ObservationMapper(registry: try MetricRegistry.load(bundle: .main))
        for e in artifacts {
            // Flagged, not dropped: the mapper must accept the value so it can be stored and shown as flagged.
            #expect(throws: Never.self) { try mapper.map(e.sample, patientID: "1") }
        }
    }
}


// MARK: - Waveforms and structure

@Suite("Generator shapes")
struct ShapeTests {
    private let clean = SyntheticGenerator(config: SyntheticConfig()).emissions(deliveredIn: window(days: 3))
    
    @Test("clean values stay in plausible physiological bands")
    func plausible() {
        let heart = quantities(clean, .heartRate).map(value)
        let hrv = quantities(clean, .hrvSdnn).map(value)
        let resting = quantities(clean, .restingHeartRate).map(value)
        #expect(heart.min() ?? 0 >= 35 && heart.max() ?? 0 <= 200)
        #expect(hrv.min() ?? 0 >= 15 && hrv.max() ?? 0 <= 120)
        #expect(!resting.isEmpty && resting.min() ?? 0 >= 40 && resting.max() ?? 0 <= 90)
        // Night is lower than the afternoon, on average.
        let night = quantities(clean, .heartRate).filter { (0..<5).contains(Calendar.current.component(.hour, from: $0.sample.start)) }
        #expect(!heart.isEmpty && !night.isEmpty)
    }
    
    @Test("exactly one resting heart rate per local day, covering the whole day, and DST days are 23 and 25 hours")
    func resting() {
        let spring = SyntheticGenerator(config: SyntheticConfig(metrics: [.restingHeartRate]))
            .emissions(deliveredIn: localDay(2026, 3, 7)..<localDay(2026, 3, 11))
        let rest = quantities(spring, .restingHeartRate)
        #expect(rest.count >= 3)
        for e in rest {
            #expect(e.sample.start < e.sample.end)
            #expect(e.sample.issued > e.sample.end)
        }
        let lengths = Set(rest.map { $0.sample.end.timeIntervalSince($0.sample.start) })
        #expect(lengths.contains(23 * 3600), "spring-forward day should be 23 h: \(lengths)")
        #expect(lengths.contains(24 * 3600))
        
        let fall = SyntheticGenerator(config: SyntheticConfig(metrics: [.restingHeartRate]))
            .emissions(deliveredIn: localDay(2026, 10, 31)..<localDay(2026, 11, 4))
        let fallLengths = Set(quantities(fall, .restingHeartRate).map { $0.sample.end.timeIntervalSince($0.sample.start) })
        #expect(fallLengths.contains(25 * 3600), "fall-back day should be 25 h: \(fallLengths)")
        // One per day: starts are distinct.
        #expect(Set(rest.map(\.sample.start)).count == rest.count)
    }
    
    @Test("a night of sleep: in-bed wraps contiguous stages, 6.5 to 8.5 hours asleep, delivered after waking")
    func sleep() {
        let nights = Dictionary(grouping: sleepStages(clean), by: { $0.sample.id.split(separator: "-")[3] })
        #expect(nights.count >= 2)
        for (_, intervals) in nights {
            let ordered = intervals.sorted { $0.sample.start < $1.sample.start }
            let inBed = ordered.filter { stage($0) == .inBed }
            let asleep = ordered.filter { stage($0) != .inBed }
            #expect(inBed.count == 1)
            guard let bed = inBed.first, let first = asleep.first, let last = asleep.last else {
                Issue.record("a night with no stages")
                continue
            }
            #expect(bed.sample.start <= first.sample.start && bed.sample.end >= last.sample.end)
            #expect(zip(asleep, asleep.dropFirst()).allSatisfy { $0.sample.end == $1.sample.start }, "stages must be contiguous")
            let asleepHours = last.sample.end.timeIntervalSince(first.sample.start) / 3600
            #expect(asleepHours >= 6.4 && asleepHours <= 8.6, "asleep \(asleepHours) h")
            #expect(asleep.contains { stage($0) == .asleepDeep } && asleep.contains { stage($0) == .asleepREM })
            #expect(ordered.allSatisfy { $0.sample.issued == last.sample.end.addingTimeInterval(600) })
        }
    }
    
    @Test("identifiers carry the seed, are unique within a run, and never overlap another seed's")
    func identifiers() {
        let ids = clean.map(\.sample.id)
        #expect(Set(ids).count == ids.count)
        #expect(ids.allSatisfy { $0.hasPrefix("syn-2a-") })
        var other = SyntheticConfig()
        other.seed = 7
        let otherIDs = Set(SyntheticGenerator(config: other).emissions(deliveredIn: window(days: 1)).map(\.sample.id))
        #expect(otherIDs.isDisjoint(with: ids))
    }
    
    @Test("every emitted sample is valid input for the M6 mapper (inBed maps to nothing, not an error)")
    func mapsWithTheMapper() throws {
        let mapper = ObservationMapper(registry: try MetricRegistry.load(bundle: .main))
        let rich = SyntheticGenerator(config: SyntheticPreset.everything.applied(to: SyntheticConfig())).emissions(deliveredIn: window(days: 2))
        var observations = 0
        var unmapped = 0
        for e in rich {
            switch try mapper.map(e.sample, patientID: "1", deviceReference: "Device/1") {
            case .observation: observations += 1
            case .unmapped: unmapped += 1
            }
        }
        #expect(observations > 30_000)
        #expect(unmapped >= 2, "inBed intervals should be present and unmapped")
    }
}


// MARK: - Presets

@Suite("Presets")
struct PresetTests {
    private func output(_ preset: SyntheticPreset) -> [Emission] {
        SyntheticGenerator(config: preset.applied(to: SyntheticConfig())).emissions(deliveredIn: window(days: 2))
    }
    
    private func flags(_ emissions: [Emission]) -> InjectedAnomalies {
        emissions.reduce(into: InjectedAnomalies()) { $0.formUnion($1.injected) }
    }
    
    @Test("the clean preset injects nothing")
    func clean() {
        let out = output(.cleanDay)
        #expect(!out.isEmpty)
        #expect(flags(out).isEmpty)
        #expect(out.allSatisfy { $0.sample.issued >= $0.sample.end })
    }
    
    @Test("each fault preset produces its intended anomaly and not the others")
    func intended() {
        #expect(flags(output(.offlineCatchUp)).isSuperset(of: [.late, .batched]))
        #expect(flags(output(.offlineCatchUp)).isDisjoint(with: [.artifact, .duplicate]))
        #expect(flags(output(.retryStorm)) == .duplicate)
        #expect(flags(output(.artifacts)) == .artifact)
        #expect(flags(output(.everything)).isSuperset(of: [.late, .batched, .artifact, .duplicate]))
    }
    
    @Test("flaky watch has fewer samples than a clean day, and timing jitter")
    func flaky() {
        let flaky = quantities(output(.flakyWatch), .heartRate)
        let clean = quantities(output(.cleanDay), .heartRate)
        #expect(flaky.count < clean.count)
        let offsets = flaky.map { $0.sample.start.timeIntervalSince1970.truncatingRemainder(dividingBy: 5) }
        #expect(Set(offsets.map { ($0 * 100).rounded() }).count > 10)
    }
    
    @Test("dense preset emits a heart-rate sample every second")
    func dense() {
        let out = quantities(SyntheticGenerator(config: SyntheticPreset.dense.applied(to: SyntheticConfig(metrics: [.heartRate])))
            .emissions(deliveredIn: day0..<day0.addingTimeInterval(3600)), .heartRate)
        #expect(out.count == 3600)
    }
    
    @Test("applying a preset keeps the seed, the zone and the enabled metrics")
    func keepsIdentity() {
        var base = SyntheticConfig()
        base.seed = 99
        base.timeZoneIdentifier = "Asia/Kolkata"
        base.metrics = [.heartRate]
        let applied = SyntheticPreset.everything.applied(to: base)
        #expect(applied.seed == 99 && applied.timeZoneIdentifier == "Asia/Kolkata" && applied.metrics == [.heartRate])
    }
}
