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


private let t0 = Date(timeIntervalSince1970: 1_800_000_000)
private let patientSystem = "http://blueysoft.com/fhir/identifier/poc-patient"

private func synthetic(_ id: String, at offset: TimeInterval = 0) -> QueuedItem {
    let time = t0.addingTimeInterval(offset)
    return QueuedItem(
        sample: MetricSample(measurement: .quantity(.heartRate, 70), start: time, end: time, issued: time.addingTimeInterval(5),
                             timeZone: .gmt, source: .synthetic, id: id),
        device: .synthetic)
}

private func realOne(_ id: String, at offset: TimeInterval = 0, userEntered: Bool = false) -> QueuedItem {
    let time = t0.addingTimeInterval(offset)
    return QueuedItem(
        sample: MetricSample(measurement: .quantity(.heartRate, 64), start: time, end: time, issued: time.addingTimeInterval(5),
                             timeZone: .gmt, source: .healthKit, id: id, userEntered: userEntered),
        device: .healthKit(name: "Apple Watch", manufacturer: "Apple Inc.", model: "Watch7,1", hardwareVersion: nil, softwareVersion: nil))
}


/// A stand-in server with TWO patients, keyed by business identifier, that records which patient each bundle names and
/// which identifier values were looked up.
private actor TwoPatientHAPI: FHIRTransport {
    static let ids = ["poc-0001": "1", "poc-real": "2"]
    private(set) var lookedUp: [String] = []
    private(set) var bundles: [[String]] = []   // the subject reference of every Observation, per transaction
    private(set) var identifierSystems: [[String]] = []
    
    func send(_ request: FHIRHTTPRequest, token: String) async throws(TransportFailure) -> FHIRHTTPResponse {
        if request.method == "GET", request.path.hasPrefix("Patient?") {
            let decoded = request.path.removingPercentEncoding ?? request.path
            let value = decoded.split(separator: "|").last.map { String($0).components(separatedBy: "&").first ?? "" } ?? ""
            lookedUp.append(value)
            guard let id = Self.ids[value] else { return json(200, ["resourceType": "Bundle", "total": 0]) }
            return json(200, ["resourceType": "Bundle", "entry": [["resource": ["resourceType": "Patient", "id": id]]]])
        }
        guard request.method == "POST", request.path.isEmpty, let body = request.body,
              let bundle = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
              let entries = bundle["entry"] as? [[String: Any]] else {
            return json(400, ["resourceType": "OperationOutcome", "issue": [["diagnostics": "bad request"]]])
        }
        let observations = entries.compactMap { $0["resource"] as? [String: Any] }.filter { $0["resourceType"] as? String == "Observation" }
        bundles.append(observations.compactMap { ($0["subject"] as? [String: Any])?["reference"] as? String })
        identifierSystems.append(observations.compactMap { (($0["identifier"] as? [[String: Any]])?.first)?["system"] as? String })
        return json(200, ["resourceType": "Bundle", "type": "transaction-response", "entry": entries.map { _ in ["response": ["status": "201 Created"]] }])
    }
    
    private func json(_ status: Int, _ object: [String: Any]) -> FHIRHTTPResponse {
        FHIRHTTPResponse(status: status, body: (try? JSONSerialization.data(withJSONObject: object)) ?? Data())
    }
}


@Suite("Real data goes to its own patient")
struct PerSourcePatientTests {
    private func engine(real: String?, queue: SampleQueue, server: TwoPatientHAPI) throws -> SyncEngine {
        SyncEngine(
            queue: queue, transport: server, token: { "token" }, registry: try MetricRegistry.load(bundle: .main),
            settings: .init(batchSize: 100, backoff: BackoffPolicy(base: 10, cap: 600, jitter: 0),
                            patientIdentifier: "poc-0001", patientSystem: patientSystem, healthKitPatientIdentifier: real),
            now: { t0 }, random: { 0.5 })
    }
    
    @Test("synthetic and real samples in one queue are filed under their own patients, in separate bundles")
    func separatePatients() async throws {
        let queue = try SampleQueue(path: nil)
        let server = TwoPatientHAPI()
        _ = try await queue.enqueue([synthetic("s1"), realOne("A1"), synthetic("s2", at: 60), realOne("B2", at: 60)])
        let status = await (try engine(real: "poc-real", queue: queue, server: server)).drain()
        #expect(status.counts.sent == 4)
        #expect(status.counts.pending == 0)
        
        let bundles = await server.bundles
        #expect(bundles.count == 2, "one bundle per patient")
        for refs in bundles {
            #expect(Set(refs).count == 1, "a bundle names one patient")
        }
        #expect(Set(bundles.flatMap { $0 }) == ["Patient/1", "Patient/2"])
        #expect(Set(await server.lookedUp) == ["poc-0001", "poc-real"])
        
        // each bundle holds one source's samples, with that source's identifier system
        let registry = try MetricRegistry.load(bundle: .main)
        let systems = await server.identifierSystems
        for (refs, ids) in zip(bundles, systems) {
            let expected = refs.first == "Patient/2" ? registry.systems.identifier.healthKit : registry.systems.identifier.synthetic
            #expect(Set(ids) == [expected])
        }
    }
    
    @Test("with no real-data patient configured, real samples are NOT uploaded under the synthetic patient")
    func neverFallsBack() async throws {
        let queue = try SampleQueue(path: nil)
        let server = TwoPatientHAPI()
        // the real sample is first in the queue: it must not starve the synthetic one behind it
        _ = try await queue.enqueue([realOne("A1"), realOne("B2", at: 60), synthetic("s1", at: 120)])
        let status = await (try engine(real: nil, queue: queue, server: server)).drain()
        
        #expect(status.counts.sent == 1, "the synthetic sample goes out")
        #expect(status.counts.pending == 2, "the real ones stay on the device, not uploaded")
        #expect(status.lastError?.contains("separate patient") == true)
        let bundles = await server.bundles
        #expect(bundles == [["Patient/1"]])
        let registry = try MetricRegistry.load(bundle: .main)
        #expect(await server.identifierSystems.flatMap { $0 }.contains(registry.systems.identifier.healthKit) == false)
        #expect(await server.lookedUp == ["poc-0001"])
    }
}


@Suite("Queue: deletions and storage")
struct QueueStorageTests {
    private func temporaryPath() -> String {
        FileManager.default.temporaryDirectory.appendingPathComponent("queue-\(UUID().uuidString).sqlite").path
    }
    
    @Test("a deletion is recorded once, survives reopening, and changes nothing else in the queue")
    func deletions() async throws {
        let path = temporaryPath()
        defer { for suffix in ["", "-wal", "-shm"] { try? FileManager.default.removeItem(atPath: path + suffix) } }
        do {
            let queue = try SampleQueue(path: path)
            _ = try await queue.enqueue([realOne("A1")])
            #expect(try await queue.recordDeletions(["a1", "b2"]) == 2)
            #expect(try await queue.recordDeletions(["b2", "c3"]) == 1, "a repeated report is one record")
            #expect(try await queue.deletionCount() == 3)
            #expect(try await queue.counts().pending == 1, "the queued upload is untouched")
        }
        let reopened = try SampleQueue(path: path)
        #expect(try await reopened.deletionCount() == 3)
    }
    
    @Test("the queue file is kept out of backups and stays encrypted at rest")
    func protection() throws {
        let path = temporaryPath()
        defer { for suffix in ["", "-wal", "-shm"] { try? FileManager.default.removeItem(atPath: path + suffix) } }
        _ = try SampleQueue(path: path)
        let url = URL(fileURLWithPath: path)
        #expect(try url.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup == true)
        // Where the platform reports a protection class it must be the one chosen (not weaker, and not "complete",
        // which would break background delivery with the phone locked). The simulator may report none.
        let attributes = try FileManager.default.attributesOfItem(atPath: path)
        if let reported = attributes[.protectionKey] as? FileProtectionType {
            #expect(reported == .completeUntilFirstUserAuthentication)
        }
    }
}


// MARK: - no real value can reach a log

@Suite("No logging in the real-data path")
struct NoLoggingTests {
    /// What would write a value somewhere it can be read.
    static let forbidden = ["print(", "debugPrint(", "dump(", "NSLog(", "os_log(", "Logger(", "OSLog", ".log(", "fputs(", "FileHandle.standardError"]
    
    static func offences(in text: String) -> [String] {
        text.split(separator: "\n", omittingEmptySubsequences: false).enumerated().compactMap { index, line in
            let code = line.split(separator: "/", maxSplits: 1, omittingEmptySubsequences: false).first.map(String.init) ?? String(line)
            let hit = forbidden.first { line.hasPrefix("//") ? false : code.contains($0) || line.contains($0) && !line.trimmingCharacters(in: .whitespaces).hasPrefix("//") }
            return hit.map { "line \(index + 1): \($0)" }
        }
    }
    
    @Test("the scanner sees a logging call (the control for the scan below)")
    func scannerWorks() {
        #expect(Self.offences(in: "let x = 1\nprint(record)\n").count == 1)
        #expect(Self.offences(in: "// print(record) is forbidden\nlet x = 1\n").isEmpty)
        #expect(Self.offences(in: "Logger(subsystem: \"a\", category: \"b\")").count == 1)
    }
    
    @Test("none of the files that handle real samples can log or print")
    func realDataFilesAreSilent() throws {
        // #filePath is the test file on the host: the app sources are its sibling directory.
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let files = [
            "TemplateApplication/Ingest/HealthKitRecord.swift",
            "TemplateApplication/Ingest/HealthKitMapper.swift",
            "TemplateApplication/Ingest/HealthKitIngestSource.swift",
            "TemplateApplication/TemplateApplicationStandard.swift",
            "TemplateApplication/SharedContext/HealthKitGate.swift",
            "TemplateApplication/SharedContext/SourceModel.swift",
        ]
        for file in files {
            let text = try String(contentsOf: root.appendingPathComponent(file), encoding: .utf8)
            #expect(Self.offences(in: text).isEmpty, "\(file): \(Self.offences(in: text))")
        }
    }
}
