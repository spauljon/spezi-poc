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


// MARK: - Fixtures

/// Locations in the repository, from this file's own path (the tests run on the Mac, so the simulator process can
/// read the working tree). This is what lets the contract and the golden fixtures stay in one place, outside `ios/`.
private enum Repo {
    static let root = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent() // Metrics
        .deletingLastPathComponent() // TemplateApplicationTests
        .deletingLastPathComponent() // ios
        .deletingLastPathComponent() // repository root
    static let contract = root.appending(path: "contract/metrics.json")
    static let spec = root.appending(path: "docs/planning/fhir-data-model.md")
    
    static func golden(_ name: String) -> URL {
        root.appending(path: "contract/golden/\(name)")
    }
}

private func jsonObject(_ url: URL) throws -> [String: Any] {
    try #require(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
}

private func goldenCases(_ file: String) -> [[String: Any]] {
    guard let object = try? jsonObject(Repo.golden(file)), let cases = object["cases"] as? [[String: Any]] else {
        return []
    }
    return cases
}

private func registry() throws -> MetricRegistry {
    try MetricRegistry.load(bundle: .main)
}

private func instant(_ string: String) throws -> Date {
    let withFraction = ISO8601DateFormatter()
    withFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    let plain = ISO8601DateFormatter()
    plain.formatOptions = [.withInternetDateTime]
    return try #require(withFraction.date(from: string) ?? plain.date(from: string), "unparseable instant \(string)")
}

/// A required string field of a fixture object (a helper, because `#require` cannot be nested inside `#require`).
private func field(_ key: String, in object: [String: Any]) throws -> String {
    try #require(object[key] as? String, "fixture field \(key) is missing")
}

/// Builds a `MetricSample` from a golden fixture's `sample` object.
private func sample(from object: [String: Any]) throws -> MetricSample {
    let measurement: MetricSample.Measurement
    let metric = try field("metric", in: object)
    if metric == "sleepStage" {
        let stage = try field("stage", in: object)
        measurement = .sleep(try #require(SleepStage(rawValue: stage), "unknown stage \(stage)"))
    } else {
        let id = try #require(MetricID(rawValue: metric), "unknown metric \(metric)")
        let value = try #require((object["value"] as? NSNumber)?.doubleValue, "fixture value is missing")
        measurement = .quantity(id, value)
    }
    let zoneName = try field("timeZone", in: object)
    let sourceName = try field("source", in: object)
    return MetricSample(
        measurement: measurement,
        start: try instant(try field("start", in: object)),
        end: try instant(try field("end", in: object)),
        issued: try instant(try field("issued", in: object)),
        timeZone: try #require(TimeZone(identifier: zoneName), "unknown time zone \(zoneName)"),
        source: try #require(SampleSource(rawValue: sourceName), "unknown source \(sourceName)"),
        id: try field("id", in: object)
    )
}

/// The produced resource as a JSON object, for comparison independent of key order.
private func object(from resource: some Encodable) throws -> [String: Any] {
    let data = try JSONEncoder.fhir.encode(resource)
    return try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
}

private func sorted(_ object: [String: Any]) -> String {
    let data = (try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys, .prettyPrinted])) ?? Data()
    return String(decoding: data, as: UTF8.self)
}

private func expectEqual(_ produced: [String: Any], _ expected: [String: Any], _ name: String) {
    #expect(NSDictionary(dictionary: produced).isEqual(to: expected), "\(name)\nproduced:\n\(sorted(produced))\nexpected:\n\(sorted(expected))")
}

private let patient = "example-patient"


// MARK: - The contract and the registry

@Suite("Metric contract")
struct MetricContractTests {
    @Test("the bundled copy is byte-identical to contract/metrics.json (fails if either is edited alone)")
    func bundledCopyMatches() throws {
        let bundledURL = try #require(Bundle.main.url(forResource: "metrics", withExtension: "json"))
        let bundled = try Data(contentsOf: bundledURL)
        let source = try Data(contentsOf: Repo.contract)
        #expect(bundled == source, "run contract/sync.sh: the app's copy of the contract differs from contract/metrics.json")
    }
    
    @Test("the bundled contract loads and covers every metric this code can emit")
    func loads() throws {
        let registry = try registry()
        #expect(registry.contractVersion.hasPrefix("\(MetricRegistry.supportedMajorVersion)."))
        for id in MetricID.allCases {
            #expect(registry.metric(id)?.loinc != nil, "\(id.rawValue)")
        }
        #expect(registry.sleep?.stages?.count == 5)
        #expect(registry.sleep?.unmapped == ["inBed"])
    }
    
    private func mutated(_ change: (inout [String: Any]) -> Void) throws -> Data {
        var json = try jsonObject(Repo.contract)
        change(&json)
        return try JSONSerialization.data(withJSONObject: json)
    }
    
    @Test("an unchanged contract is accepted (the control for the three refusals below)")
    func control() throws {
        _ = try MetricRegistry(data: try mutated { _ in })
    }
    
    @Test("a newer major version is refused")
    func newerMajor() throws {
        let data = try mutated { $0["contractVersion"] = "2.0.0" }
        #expect(throws: MetricRegistry.LoadError.unsupportedVersion("2.0.0")) { try MetricRegistry(data: data) }
    }
    
    @Test("a contract that drops a metric is refused")
    func missingMetric() throws {
        let data = try mutated { json in
            json["metrics"] = (json["metrics"] as? [[String: Any]] ?? []).filter { $0["id"] as? String != "hrvSdnn" }
        }
        #expect(throws: MetricRegistry.LoadError.self) { try MetricRegistry(data: data) }
    }
    
    @Test("a sleep stage that is neither mapped nor listed as unmapped is refused")
    func unaccountedStage() throws {
        let data = try mutated { json in
            var metrics = json["metrics"] as? [[String: Any]] ?? []
            for index in metrics.indices where metrics[index]["id"] as? String == "sleepStage" {
                metrics[index]["unmapped"] = [String]()
            }
            json["metrics"] = metrics
        }
        #expect(throws: MetricRegistry.LoadError.self) { try MetricRegistry(data: data) }
    }
}


// MARK: - Golden mapping

@Suite("Golden mapping")
struct GoldenMappingTests {
    static let quantity = goldenCases("observations-quantity.json").compactMap { $0["name"] as? String }
    static let sleep = goldenCases("observations-sleep.json").compactMap { $0["name"] as? String }
    static let errors = goldenCases("errors.json").compactMap { $0["name"] as? String }
    
    @Test("the fixtures were actually found (a loader that found nothing would pass everything below)")
    func fixturesFound() {
        #expect(Self.quantity.count >= 14, "quantity fixtures: \(Self.quantity.count)")
        #expect(Self.sleep.count >= 10, "sleep fixtures: \(Self.sleep.count)")
        #expect(Self.errors.count >= 5, "error fixtures: \(Self.errors.count)")
    }
    
    private func run(_ file: String, _ name: String) throws -> (case: [String: Any], outcome: MappingOutcome) {
        let all = goldenCases(file)
        let golden = try #require(all.first { $0["name"] as? String == name })
        let mapper = ObservationMapper(registry: try registry())
        let outcome = try mapper.map(try sample(from: try #require(golden["sample"] as? [String: Any])),
                                     patientID: try #require(golden["patientId"] as? String),
                                     deviceReference: golden["deviceReference"] as? String)
        return (golden, outcome)
    }
    
    @Test("quantity metrics map to exactly the independent generator's JSON", arguments: GoldenMappingTests.quantity)
    func quantityGolden(_ name: String) throws {
        let (golden, outcome) = try run("observations-quantity.json", name)
        guard case .observation(let observation) = outcome else {
            Issue.record("\(name): expected an observation, got \(outcome)")
            return
        }
        expectEqual(try object(from: observation), try #require(golden["expected"] as? [String: Any]), name)
    }
    
    @Test("sleep stages map to exactly the independent generator's JSON, and inBed to nothing", arguments: GoldenMappingTests.sleep)
    func sleepGolden(_ name: String) throws {
        let (golden, outcome) = try run("observations-sleep.json", name)
        if golden["expectedOutcome"] as? String == "unmapped" {
            #expect(outcome == .unmapped(.sleepStageHasNoCode("inBed")), "\(name)")
            return
        }
        guard case .observation(let observation) = outcome else {
            Issue.record("\(name): expected an observation, got \(outcome)")
            return
        }
        expectEqual(try object(from: observation), try #require(golden["expected"] as? [String: Any]), name)
    }
    
    @Test("refused samples fail with the stated reason", arguments: GoldenMappingTests.errors)
    func errorGolden(_ name: String) throws {
        let golden = try #require(goldenCases("errors.json").first { $0["name"] as? String == name })
        let mapper = ObservationMapper(registry: try registry())
        let input = try sample(from: try #require(golden["sample"] as? [String: Any]))
        let expected = try #require(golden["expectedError"] as? String)
        do {
            _ = try mapper.map(input, patientID: patient)
            Issue.record("\(name): expected \(expected) but the sample was accepted")
        } catch {
            #expect(error.code == expected, "\(name): got \(error.code), expected \(expected)")
        }
    }
    
    @Test("non-finite values are refused as such")
    func nonFinite() throws {
        let mapper = ObservationMapper(registry: try registry())
        let now = Date(timeIntervalSince1970: 1_768_494_605)
        for value in [Double.nan, .infinity, -.infinity] {
            let bad = MetricSample(measurement: .quantity(.heartRate, value), start: now, end: now, issued: now, timeZone: .gmt, source: .synthetic, id: "x")
            #expect(throws: MappingError.nonFiniteValue) { try mapper.map(bad, patientID: patient) }
        }
        // control: the same sample with a normal value is accepted
        let good = MetricSample(measurement: .quantity(.heartRate, 72), start: now, end: now, issued: now, timeZone: .gmt, source: .synthetic, id: "x")
        #expect(throws: Never.self) { try mapper.map(good, patientID: patient) }
    }
    
    @Test("an empty patient id is refused")
    func emptyPatient() throws {
        let mapper = ObservationMapper(registry: try registry())
        let now = Date(timeIntervalSince1970: 1_768_494_605)
        let s = MetricSample(measurement: .quantity(.heartRate, 72), start: now, end: now, issued: now, timeZone: .gmt, source: .synthetic, id: "x")
        #expect(throws: MappingError.emptyPatientID) { try mapper.map(s, patientID: " ") }
    }
    
    @Test("an offset that is not a whole number of minutes is refused, not silently rounded")
    func oddOffset() throws {
        // A zone fixed at +01:00:01. (Historical local mean time, e.g. Amsterdam before 1937, would be the real-world
        // case, but this platform's zone data does not return sub-minute offsets for it, so build the case directly.)
        let zone = try #require(TimeZone(secondsFromGMT: 3601))
        let moment = Date(timeIntervalSince1970: 1_768_494_605)
        let mapper = ObservationMapper(registry: try registry())
        let odd = MetricSample(measurement: .quantity(.heartRate, 72), start: moment, end: moment, issued: moment, timeZone: zone, source: .synthetic, id: "x")
        #expect(throws: MappingError.offsetNotWholeMinutes) { try mapper.map(odd, patientID: patient) }
        // control: a whole-minute offset in the same place is accepted
        let fine = MetricSample(measurement: .quantity(.heartRate, 72), start: moment, end: moment, issued: moment,
                                timeZone: try #require(TimeZone(secondsFromGMT: 3600)), source: .synthetic, id: "x")
        #expect(throws: Never.self) { try mapper.map(fine, patientID: patient) }
    }
    
    @Test("output never uses Z, and every dateTime carries a numeric offset")
    func noZulu() throws {
        let pattern = #"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?[+-]\d{2}:\d{2}$"#
        var checked = 0
        for (file, key) in [("observations-quantity.json", "quantity"), ("observations-sleep.json", "sleep")] {
            for golden in goldenCases(file) {
                guard let expected = golden["expected"] as? [String: Any], golden["name"] != nil else { continue }
                _ = key
                let (_, outcome) = try run(file, try #require(golden["name"] as? String))
                guard case .observation(let produced) = outcome else { continue }
                var strings = [produced.issued]
                strings += [produced.effectiveDateTime].compactMap { $0 }
                if let period = produced.effectivePeriod { strings += [period.start, period.end] }
                for string in strings {
                    #expect(string.range(of: pattern, options: .regularExpression) != nil, "\(string) in \(golden["name"] ?? "")")
                    checked += 1
                }
                _ = expected
            }
        }
        #expect(checked >= 24, "only \(checked) date strings were examined")
    }
    
    @Test("the same input always gives byte-identical output, and identifiers do not depend on anything else")
    func deterministic() throws {
        let mapper = ObservationMapper(registry: try registry())
        let golden = try #require(goldenCases("observations-quantity.json").first)
        let input = try sample(from: try #require(golden["sample"] as? [String: Any]))
        func bytes() throws -> Data {
            guard case .observation(let o) = try mapper.map(input, patientID: patient, deviceReference: "Device/d") else {
                throw MappingError.contractMissing("expected an observation")
            }
            return try JSONEncoder.fhir.encode(o)
        }
        #expect(try bytes() == bytes())
        // A different issued time changes issued, never the identifier (conditional create keys on the identifier).
        var later = input
        later.issued = input.issued.addingTimeInterval(3600)
        guard case .observation(let a) = try mapper.map(input, patientID: patient), case .observation(let b) = try mapper.map(later, patientID: patient) else {
            Issue.record("expected observations")
            return
        }
        #expect(a.identifier == b.identifier)
        #expect(a.issued != b.issued)
    }
}


// MARK: - The spec's own samples are the oracle for two of them

@Suite("Spec samples")
struct SpecSampleTests {
    /// Every ```json block in the data-model document that is an Observation.
    private static func specObservations() throws -> [[String: Any]] {
        let text = try String(contentsOf: Repo.spec, encoding: .utf8)
        var blocks: [[String: Any]] = []
        var rest = Substring(text)
        while let open = rest.range(of: "```json\n") {
            rest = rest[open.upperBound...]
            guard let close = rest.range(of: "```") else { break }
            let body = rest[..<close.lowerBound]
            if let data = body.data(using: .utf8), let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               parsed["resourceType"] as? String == "Observation" {
                blocks.append(parsed)
            }
            rest = rest[close.upperBound...]
        }
        return blocks
    }
    
    @Test("the heart-rate and sleep samples printed in fhir-data-model.md are reproduced exactly (apart from meta.source, which the spec's A9 adds)")
    func specSamples() throws {
        let specs = try Self.specObservations()
        #expect(specs.count == 2, "expected the spec's two Observation samples, found \(specs.count)")
        let mapper = ObservationMapper(registry: try registry())
        let all = goldenCases("observations-quantity.json") + goldenCases("observations-sleep.json")
        for spec in specs {
            let identifiers = try #require(spec["identifier"] as? [[String: Any]])
        let id = try #require(identifiers.first?["value"] as? String)
            let golden = try #require(all.first { (($0["sample"] as? [String: Any])?["id"] as? String) == id }, "no fixture for spec sample \(id)")
            guard case .observation(let produced) = try mapper.map(
                try sample(from: try #require(golden["sample"] as? [String: Any])), patientID: patient,
                deviceReference: golden["deviceReference"] as? String) else {
                Issue.record("\(id): not an observation")
                continue
            }
            var json = try object(from: produced)
            json.removeValue(forKey: "meta")
            expectEqual(json, spec, "spec sample \(id)")
        }
    }
}


// MARK: - Devices

@Suite("Device mapping")
struct DeviceMappingTests {
    static let names = goldenCases("devices.json").compactMap { $0["name"] as? String }
    
    private func descriptor(_ raw: [String: Any]) throws -> DeviceDescriptor {
        switch try #require(raw["kind"] as? String) {
        case "synthetic":
            return .synthetic
        default:
            return .healthKit(name: raw["name"] as? String, manufacturer: raw["manufacturer"] as? String, model: raw["model"] as? String,
                              hardwareVersion: raw["hardwareVersion"] as? String, softwareVersion: raw["softwareVersion"] as? String)
        }
    }
    
    @Test("device fixtures were found")
    func found() {
        #expect(Self.names.count >= 5)
    }
    
    @Test("devices map to the independent generator's JSON, with its key", arguments: DeviceMappingTests.names)
    func deviceGolden(_ name: String) throws {
        let golden = try #require(goldenCases("devices.json").first { $0["name"] as? String == name })
        let mapper = DeviceMapper(registry: try registry())
        let input = try descriptor(try #require(golden["descriptor"] as? [String: Any]))
        let patientID = try #require(golden["patientId"] as? String)
        
        if let expectedError = golden["expectedError"] as? String {
            do {
                _ = try mapper.map(input, patientID: patientID)
                Issue.record("\(name): expected \(expectedError)")
            } catch {
                #expect(error.code == expectedError)
            }
            return
        }
        let device = try mapper.map(input, patientID: patientID)
        expectEqual(try object(from: device), try #require(golden["expected"] as? [String: Any]), name)
        if let key = golden["expectedKey"] as? String {
            #expect(try mapper.key(for: input) == key)
        }
    }
}
