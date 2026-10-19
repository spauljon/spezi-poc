//
// This source file is part of the Spezi POC capture app, adapted from the Stanford Spezi Template Application
//
// SPDX-FileCopyrightText: 2023 Stanford University and the project authors (see CONTRIBUTORS.md)
//
// SPDX-License-Identifier: MIT
//

import Foundation
import Testing
@testable import TemplateApplication


private let repositoryRoot = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent() // Metrics
    .deletingLastPathComponent() // TemplateApplicationTests
    .deletingLastPathComponent() // ios
    .deletingLastPathComponent() // repository root

private func registry() throws -> MetricRegistry {
    try MetricRegistry.load(bundle: .main)
}

private func contractObject() throws -> [String: Any] {
    let data = try Data(contentsOf: repositoryRoot.appending(path: "contract/metrics.json"))
    return try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
}

private func instant(_ string: String) throws -> Date {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime]
    return try #require(formatter.date(from: string), "unparseable instant \(string)")
}

/// The flag codes the flagger would put on a sample, in the contract's ascending order.
private func codes(_ flagger: QualityFlagger, _ sample: MetricSample, _ registry: MetricRegistry) throws -> [String] {
    var out: [String] = []
    if flagger.isArtifact(sample) { out.append(try #require(registry.dataQualityFlags["artifactSuspected"])) }
    if flagger.isLate(sample) { out.append(try #require(registry.dataQualityFlags["lateArrival"])) }
    return out.sorted()
}


@Suite("Quality flags against the independent implementation")
struct QualityFlagContractTests {
    @Test("every golden evaluation case gets exactly the flags the Python implementation computed")
    func golden() throws {
        let registry = try registry()
        let flagger = QualityFlagger(registry: registry)
        let data = try Data(contentsOf: repositoryRoot.appending(path: "contract/golden/flags.json"))
        let file = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let cases = try #require(file["cases"] as? [[String: Any]])
        #expect(cases.count >= 20)
        
        var sawFlagged = false
        var sawClean = false
        for item in cases {
            let name = try #require(item["name"] as? String)
            let input = try #require(item["input"] as? [String: Any])
            let expected = try #require(item["expectedFlags"] as? [String])
            let end = try instant(try #require(input["end"] as? String))
            let issued = try instant(try #require(input["issued"] as? String))
            let metric = try #require(input["metric"] as? String)
            let measurement: MetricSample.Measurement
            if metric == "sleepStage" {
                measurement = .sleep(.asleepCore)
            } else {
                let id = try #require(MetricID(rawValue: metric))
                measurement = .quantity(id, try #require((input["value"] as? NSNumber)?.doubleValue))
            }
            let sample = MetricSample(measurement: measurement, start: end, end: end, issued: issued, timeZone: .gmt, source: .synthetic, id: name)
            #expect(try codes(flagger, sample, registry) == expected, "\(name)")
            sawFlagged = sawFlagged || !expected.isEmpty
            sawClean = sawClean || expected.isEmpty
        }
        // the cases prove both outcomes exist, so an always-empty or always-flagged flagger cannot pass
        #expect(sawFlagged && sawClean)
    }
    
    @Test("the registry exposes the contract's ranges and threshold, read independently from the file")
    func registryMatchesFile() throws {
        let registry = try registry()
        let object = try contractObject()
        let metrics = try #require(object["metrics"] as? [[String: Any]])
        for id in MetricID.allCases {
            let raw = try #require(metrics.first { $0["id"] as? String == id.rawValue })
            let range = try #require(raw["plausibleRange"] as? [String: Double])
            let loaded = try #require(registry.metric(id)?.plausibleRange)
            #expect(loaded.lower == range["min"] && loaded.upper == range["max"], "\(id.rawValue)")
        }
        let thresholds = try #require(object["qualityThresholds"] as? [String: Double])
        #expect(registry.qualityThresholds.lateArrivalHours == thresholds["lateArrivalHours"])
    }
    
    @Test("a contract with an inverted range, a missing flag or no threshold is refused (the real one loads)")
    func malformedContractsAreRefused() throws {
        _ = try registry() // the control: the same file, unchanged, loads
        
        var inverted = try contractObject()
        var metrics = try #require(inverted["metrics"] as? [[String: Any]])
        metrics[0]["plausibleRange"] = ["min": 220, "max": 30]
        inverted["metrics"] = metrics
        #expect(throws: MetricRegistry.LoadError.self) {
            try MetricRegistry(data: JSONSerialization.data(withJSONObject: inverted))
        }
        
        var noFlag = try contractObject()
        var flags = try #require(noFlag["dataQualityFlags"] as? [String: String])
        flags["artifactSuspected"] = nil
        noFlag["dataQualityFlags"] = flags
        #expect(throws: MetricRegistry.LoadError.self) {
            try MetricRegistry(data: JSONSerialization.data(withJSONObject: noFlag))
        }
        
        var noThreshold = try contractObject()
        noThreshold["qualityThresholds"] = nil
        #expect(throws: MetricRegistry.LoadError.self) {
            try MetricRegistry(data: JSONSerialization.data(withJSONObject: noThreshold))
        }
    }
    
    @Test("flags are set and never cleared; the value is never touched")
    func appliedKeepsTheValue() throws {
        let flagger = QualityFlagger(registry: try registry())
        let end = Date(timeIntervalSince1970: 1_800_000_000)
        var sample = MetricSample(measurement: .quantity(.heartRate, 281.5), start: end, end: end, issued: end.addingTimeInterval(3 * 86_400),
                                  timeZone: .gmt, source: .synthetic, id: "x", userEntered: true)
        sample.duplicateResolved = true
        let flagged = flagger.applied(to: sample)
        #expect(flagged.artifactSuspected && flagged.lateArrival && flagged.userEntered && flagged.duplicateResolved)
        #expect(flagged.measurement == sample.measurement, "a flag never alters the value")
        
        let clean = MetricSample(measurement: .quantity(.heartRate, 72), start: end, end: end, issued: end.addingTimeInterval(60), timeZone: .gmt, source: .synthetic, id: "y")
        #expect(flagger.applied(to: clean) == clean, "a plausible, timely sample is left exactly as it was")
    }
}


@Suite("Quality flags against the synthetic source's ground truth")
struct QualityFlagGroundTruthTests {
    private let zone = TimeZone(identifier: "America/Los_Angeles") ?? .gmt
    
    private func window(days: Double) -> Range<Date> {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = zone
        let start = calendar.date(from: DateComponents(year: 2026, month: 1, day: 12)) ?? .distantPast
        return start..<start.addingTimeInterval(days * 86_400)
    }
    
    @Test("every injected artifact is flagged and nothing else is, across all metrics")
    func artifacts() throws {
        let flagger = QualityFlagger(registry: try registry())
        var config = SyntheticConfig()
        config.artifactFraction = 0.05
        config.heartRateCadence = 30
        let emissions = SyntheticGenerator(config: config).emissions(deliveredIn: window(days: 3))
        let injected = emissions.filter { $0.injected.contains(.artifact) }
        #expect(injected.count >= 20, "the test needs artifacts to mean anything")
        for emission in emissions {
            #expect(flagger.isArtifact(emission.sample) == emission.injected.contains(.artifact), "\(emission.sample.id)")
        }
    }
    
    @Test("a clean stream has no flagged value (no false positives), the control for the test above")
    func noFalsePositives() throws {
        let flagger = QualityFlagger(registry: try registry())
        var config = SyntheticConfig()
        config.heartRateCadence = 10
        let emissions = SyntheticGenerator(config: config).emissions(deliveredIn: window(days: 3))
        #expect(emissions.count > 1_000)
        #expect(emissions.allSatisfy { !flagger.isArtifact($0.sample) })
    }
    
    @Test("late delivery beyond 24 hours is flagged, shorter delay is not")
    func late() throws {
        let flagger = QualityFlagger(registry: try registry())
        var config = SyntheticConfig()
        config.metrics = [.heartRate]
        config.heartRateCadence = 120
        config.late = .init(fraction: 0.3, minDelay: 3600, maxDelay: 40 * 3600)
        let emissions = SyntheticGenerator(config: config).emissions(deliveredIn: window(days: 2))
        let delayed = emissions.filter { $0.injected.contains(.late) }
        #expect(delayed.count > 50)
        
        var beyond = 0
        var within = 0
        for emission in delayed {
            let lag = emission.sample.issued.timeIntervalSince(emission.sample.end)
            #expect(flagger.isLate(emission.sample) == (lag > 24 * 3600), "\(emission.sample.id)")
            if lag > 24 * 3600 { beyond += 1 } else { within += 1 }
        }
        // both sides of the threshold are exercised, so a threshold that is ignored cannot pass
        #expect(beyond > 0 && within > 0)
        // an on-time sample is never late
        #expect(emissions.filter { !$0.injected.contains(.late) }.allSatisfy { !flagger.isLate($0.sample) })
    }
}


@Suite("Quality tags in the FHIR resource")
struct QualityTagMappingTests {
    @Test("a flagged sample is tagged in ascending code order with its value untouched; a plain one has no tag")
    func tags() throws {
        let registry = try registry()
        let mapper = ObservationMapper(registry: registry)
        let end = Date(timeIntervalSince1970: 1_800_000_000)
        var sample = MetricSample(measurement: .quantity(.heartRate, 281.5), start: end, end: end, issued: end, timeZone: .gmt, source: .synthetic, id: "tag-1", userEntered: true)
        sample.artifactSuspected = true
        sample.lateArrival = true
        sample.duplicateResolved = true
        guard case .observation(let observation) = try mapper.map(sample, patientID: "p") else {
            Issue.record("a heart-rate sample must map to an Observation")
            return
        }
        let tags = try #require(observation.meta.tag)
        #expect(tags.map(\.code) == ["artifact-suspected", "duplicate-resolved", "late-arrival", "user-entered"])
        #expect(tags.allSatisfy { $0.system == registry.systems.dataQualityFlag })
        #expect(observation.valueQuantity.value == 281.5)
        
        let plain = MetricSample(measurement: .quantity(.heartRate, 72), start: end, end: end, issued: end, timeZone: .gmt, source: .synthetic, id: "tag-2")
        guard case .observation(let untagged) = try mapper.map(plain, patientID: "p") else {
            Issue.record("a heart-rate sample must map to an Observation")
            return
        }
        #expect(untagged.meta.tag == nil)
    }
}
