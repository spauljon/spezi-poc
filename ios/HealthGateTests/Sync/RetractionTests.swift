//
// This source file is part of the Spezi POC capture app, adapted from the Stanford Spezi Template Application
//
// SPDX-FileCopyrightText: 2023 Stanford University and the project authors (see CONTRIBUTORS.md)
//
// SPDX-License-Identifier: MIT
//

import Foundation
import SQLite3
import Testing
@testable import HealthGate


// All identifiers are synthetic. The HealthKit-shaped ids below are made up for these tests; none is a real sample.

private let t0 = Date(timeIntervalSince1970: 1_800_000_000)
private let patientSystem = "http://aboutobjects.com/fhir/identifier/poc-patient"
private let idA = "0A1B2C3D-0000-4000-8000-00000000000A"
private let idB = "0A1B2C3D-0000-4000-8000-00000000000B"
private let idC = "0A1B2C3D-0000-4000-8000-00000000000C"

private func healthKit(_ id: String, at offset: TimeInterval = 0) -> QueuedItem {
    let time = t0.addingTimeInterval(offset)
    return QueuedItem(
        sample: MetricSample(measurement: .quantity(.heartRate, 64), start: time, end: time, issued: time.addingTimeInterval(5),
                             timeZone: .gmt, source: .healthKit, id: id),
        device: .healthKit(name: "Apple Watch", manufacturer: "Apple Inc.", model: "Watch7,1", hardwareVersion: nil, softwareVersion: nil))
}

private func synthetic(_ id: String) -> QueuedItem {
    QueuedItem(
        sample: MetricSample(measurement: .quantity(.heartRate, 70), start: t0, end: t0, issued: t0.addingTimeInterval(5),
                             timeZone: .gmt, source: .synthetic, id: id),
        device: .synthetic)
}


/// A stand-in for HAPI as far as retraction goes: it stores Observations by identifier with a status, and applies a
/// conditional PATCH the way the real server was shown to (hapi/auth.py): only the exact status retraction.
private actor RetractionHAPI: FHIRTransport {
    private(set) var status: [String: String] = [:]     // identifier value -> Observation.status
    private(set) var patches: [FHIRHTTPRequest] = []
    private(set) var posted: [String] = []               // identifier values in uploaded bundles
    private(set) var tokens: [String] = []
    /// Responses for the next PATCHes, in order, before the server behaves.
    var scriptedPatch: [Int] = []
    var failNetworkOnPatch = 0
    private var patientCreated = false
    
    func configure(scriptedPatch: [Int]? = nil, failNetworkOnPatch: Int? = nil) {
        if let scriptedPatch { self.scriptedPatch = scriptedPatch }
        if let failNetworkOnPatch { self.failNetworkOnPatch = failNetworkOnPatch }
    }
    
    func send(_ request: FHIRHTTPRequest, token: String) async throws(TransportFailure) -> FHIRHTTPResponse {
        tokens.append(token)
        if request.method == "GET", request.path.hasPrefix("Patient?") {
            return json(200, ["resourceType": "Bundle", "entry": [["resource": ["resourceType": "Patient", "id": "7"]]]])
        }
        if request.method == "PATCH" {
            patches.append(request)
            if failNetworkOnPatch > 0 {
                failNetworkOnPatch -= 1
                throw TransportFailure(description: "Network: The Internet connection appears to be offline.")
            }
            if !scriptedPatch.isEmpty {
                let code = scriptedPatch.removeFirst()
                return json(code, ["resourceType": "OperationOutcome", "issue": [["diagnostics": "scripted \(code)"]]])
            }
            guard request.headers["Content-Type"] == "application/json-patch+json",
                  request.body == SyncEngine.retraction,
                  request.path.hasPrefix("Observation?identifier="),
                  let query = request.path.dropFirst("Observation?identifier=".count).removingPercentEncoding,
                  let bar = query.firstIndex(of: "|") else {
                return json(403, ["resourceType": "OperationOutcome", "issue": [["diagnostics": "not a retraction"]]])
            }
            let value = String(query[query.index(after: bar)...])
            guard status[value] != nil else {
                return json(404, ["resourceType": "OperationOutcome", "issue": [["diagnostics": "no match"]]])
            }
            status[value] = "entered-in-error"
            return json(200, ["resourceType": "OperationOutcome"])
        }
        guard request.method == "POST", request.path.isEmpty, let body = request.body,
              let bundle = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
              let entries = bundle["entry"] as? [[String: Any]] else {
            return json(400, ["resourceType": "OperationOutcome", "issue": [["diagnostics": "bad request"]]])
        }
        var results: [[String: Any]] = []
        for entry in entries {
            let resource = entry["resource"] as? [String: Any] ?? [:]
            let value = (resource["identifier"] as? [[String: Any]])?.first?["value"] as? String ?? ""
            if resource["resourceType"] as? String == "Observation" {
                posted.append(value)
                if status[value] == nil { status[value] = resource["status"] as? String ?? "final" }
            }
            results.append(["response": ["status": "201 Created"]])
        }
        return json(200, ["resourceType": "Bundle", "type": "transaction-response", "entry": results])
    }
    
    private func json(_ status: Int, _ object: [String: Any]) -> FHIRHTTPResponse {
        FHIRHTTPResponse(status: status, body: (try? JSONSerialization.data(withJSONObject: object)) ?? Data())
    }
}

private final class Clock: @unchecked Sendable {
    private let lock = NSLock()
    private var current = t0
    var now: Date { lock.withLock { current } }
    func advance(_ seconds: TimeInterval) { lock.withLock { current = current.addingTimeInterval(seconds) } }
}

private struct Rig {
    let queue: SampleQueue
    let server: RetractionHAPI
    let engine: SyncEngine
    let clock: Clock
}

private func rig(token: @escaping @Sendable () async throws(AuthError) -> String = { "token" }, queue: SampleQueue? = nil) throws -> Rig {
    let queue = try queue ?? SampleQueue(path: nil)
    let server = RetractionHAPI()
    let clock = Clock()
    let engine = SyncEngine(
        queue: queue, transport: server, token: token, registry: try MetricRegistry.load(bundle: .main),
        settings: .init(batchSize: 100, backoff: BackoffPolicy(base: 10, cap: 600, jitter: 0), patientIdentifier: "poc-0001",
                        patientSystem: patientSystem, healthKitPatientIdentifier: "poc-real"),
        now: { clock.now }, random: { 0.5 })
    return Rig(queue: queue, server: server, engine: engine, clock: clock)
}


@Suite("Retraction of samples deleted in Apple Health")
struct RetractionTests {
    @Test("an uploaded sample that HealthKit deletes is retracted with exactly one narrow PATCH; the others stay final")
    func retractsUploaded() async throws {
        let r = try rig()
        _ = try await r.queue.enqueue([healthKit(idA), healthKit(idB, at: 60)])
        #expect(await r.engine.drain().counts.sent == 2)
        #expect(await r.server.patches.isEmpty, "nothing is retracted until HealthKit reports a deletion (the control)")
        
        _ = try await r.queue.recordDeletions([idA.lowercased()])
        let status = await r.engine.drain()
        
        let patches = await r.server.patches
        #expect(patches.count == 1)
        let request = try #require(patches.first)
        #expect(request.method == "PATCH")
        let system = try MetricRegistry.load(bundle: .main).systems.identifier.healthKit
        #expect(request.path == FHIRSearch.identifierQuery(system: system, value: idA.lowercased()).replacingOccurrences(of: "identifier=", with: "Observation?identifier="))
        #expect(request.headers["Content-Type"] == "application/json-patch+json")
        #expect(request.body == SyncEngine.retraction)
        #expect(String(decoding: SyncEngine.retraction, as: UTF8.self) == #"[{"op":"replace","path":"/status","value":"entered-in-error"}]"#)
        
        let states = await r.server.status
        #expect(states[idA.lowercased()] == "entered-in-error")
        #expect(states[idB.lowercased()] == "final", "a sample that was not deleted is untouched")
        #expect(status.deletions.retracted == 1 && status.deletions.pending == 0)
        
        // applied once: another run sends nothing more
        _ = await r.engine.drain()
        #expect(await r.server.patches.count == 1)
    }
    
    @Test("a sample deleted while it is still queued is withdrawn: never uploaded, never retracted")
    func withdrawsQueued() async throws {
        let r = try rig()
        _ = try await r.queue.enqueue([healthKit(idA), healthKit(idB, at: 60)])
        _ = try await r.queue.recordDeletions([idA.lowercased()])   // the queue key holds the UUID as HealthKit wrote it (upper case)
        let status = await r.engine.drain()
        
        let posted = await r.server.posted
        #expect(posted == [idB.lowercased()], "only the other sample was uploaded")
        #expect(await r.server.patches.isEmpty)
        #expect(status.counts.sent == 1 && status.counts.skipped == 1 && status.counts.pending == 0)
        #expect(status.deletions.notOnServer == 1 && status.deletions.pending == 0)
    }
    
    @Test("a sample delivered after its deletion was reported is never uploaded")
    func deliveredAfterDeletion() async throws {
        let r = try rig()
        _ = try await r.queue.recordDeletions([idA.lowercased()])
        _ = try await r.queue.enqueue([healthKit(idA), healthKit(idB, at: 60)])
        _ = await r.engine.drain()
        #expect(await r.server.posted == [idB.lowercased()])
        #expect(await r.server.patches.isEmpty)
    }
    
    @Test("only HealthKit samples are withdrawn by a HealthKit deletion; a synthetic sample with the same id is not")
    func sourceMatters() async throws {
        let r = try rig()
        _ = try await r.queue.enqueue([synthetic("same-id"), healthKit("same-id")])
        _ = try await r.queue.recordDeletions(["same-id"])
        _ = await r.engine.drain()
        let registry = try MetricRegistry.load(bundle: .main)
        #expect(registry.systems.identifier.healthKit != registry.systems.identifier.synthetic)
        #expect(await r.server.posted == ["same-id"], "the synthetic one went up; the HealthKit one was withdrawn")
    }
    
    @Test("the server having no such Observation (404) is done, not an error, and is not tried again")
    func notOnServer() async throws {
        let r = try rig()
        _ = try await r.queue.recordDeletions([idC.lowercased()])
        let status = await r.engine.drain()
        #expect(await r.server.patches.count == 1)
        #expect(status.deletions.notOnServer == 1 && status.deletions.pending == 0)
        #expect(status.lastError == nil)
        _ = await r.engine.drain()
        #expect(await r.server.patches.count == 1)
    }
    
    @Test("offline or a server error leaves the deletion pending, backs off, and a later run applies it")
    func transient() async throws {
        let r = try rig()
        _ = try await r.queue.enqueue([healthKit(idA)])
        _ = await r.engine.drain()
        _ = try await r.queue.recordDeletions([idA.lowercased()])
        
        await r.server.configure(failNetworkOnPatch: 1)
        var status = await r.engine.drain()
        guard case .waiting(let until) = status.phase else { Issue.record("expected waiting, got \(status.phase)"); return }
        #expect(until > r.clock.now)
        #expect(status.deletions.pending == 1 && status.deletions.retracted == 0)
        
        let patchesBefore = await r.server.patches.count
        _ = await r.engine.drain()   // the clock has not moved: not due yet
        #expect(await r.server.patches.count == patchesBefore, "backoff is respected")
        
        await r.server.configure(scriptedPatch: [503])
        r.clock.advance(60)
        status = await r.engine.drain()
        #expect(status.deletions.pending == 1, "a 503 is transient too")
        
        r.clock.advance(600)
        status = await r.engine.drain()
        #expect(status.deletions.retracted == 1 && status.deletions.pending == 0)
        #expect(await r.server.status[idA.lowercased()] == "entered-in-error")
    }
    
    @Test("a 403 keeps the deletion pending with the reason, and does not stop uploads")
    func forbidden() async throws {
        let r = try rig()
        _ = try await r.queue.enqueue([healthKit(idA)])
        _ = await r.engine.drain()
        _ = try await r.queue.recordDeletions([idA.lowercased()])
        await r.server.configure(scriptedPatch: [403])
        _ = try await r.queue.enqueue([healthKit(idB, at: 60)])
        let status = await r.engine.drain()
        #expect(status.deletions.pending == 1)
        #expect(status.lastError?.contains("refused") == true)
        #expect(status.counts.sent == 2, "the new sample was uploaded in the same run")
        #expect(status.phase == .idle)
    }
    
    @Test("a request the server will never take is recorded as refused and the rest still go")
    func refused() async throws {
        let r = try rig()
        _ = try await r.queue.enqueue([healthKit(idA), healthKit(idB, at: 60)])
        _ = await r.engine.drain()
        _ = try await r.queue.recordDeletions([idA.lowercased(), idB.lowercased()])
        await r.server.configure(scriptedPatch: [422])
        let status = await r.engine.drain()
        #expect(status.deletions.refused == 1 && status.deletions.retracted == 1 && status.deletions.pending == 0)
    }
    
    @Test("signed out: nothing is sent, the sign-in is asked for, and the deletion waits")
    func signedOut() async throws {
        let r = try rig(token: { () async throws(AuthError) -> String in throw .signedOut })
        _ = try await r.queue.recordDeletions([idA.lowercased()])
        let status = await r.engine.drain()
        #expect(status.phase == .blocked(.signInRequired))
        #expect(status.deletions.pending == 1)
        #expect(await r.server.patches.isEmpty)
    }
    
    @Test("deletions recorded before this milestone's queue format are kept and applied after the upgrade")
    func migration() async throws {
        let path = FileManager.default.temporaryDirectory.appendingPathComponent("queue-\(UUID().uuidString).sqlite").path
        defer { for suffix in ["", "-wal", "-shm"] { try? FileManager.default.removeItem(atPath: path + suffix) } }
        var handle: OpaquePointer?
        #expect(sqlite3_open(path, &handle) == SQLITE_OK)
        let old = "CREATE TABLE pending_deletions (uuid TEXT PRIMARY KEY, seen REAL NOT NULL); INSERT INTO pending_deletions VALUES ('\(idA.lowercased())', 1.0);"
        #expect(sqlite3_exec(handle, old, nil, nil, nil) == SQLITE_OK)
        sqlite3_close(handle)
        
        let queue = try SampleQueue(path: path)
        #expect(try await queue.deletionCounts().pending == 1)
        let r = try rig(queue: queue)
        let status = await r.engine.drain()
        #expect(status.deletions.notOnServer == 1 || status.deletions.retracted == 1, "the old deletion was applied")
        #expect(await r.server.patches.count == 1)
    }
}
