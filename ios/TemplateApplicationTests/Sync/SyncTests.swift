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


// MARK: - Fixtures

private let patientSystem = "http://blueysoft.com/fhir/identifier/poc-patient"
private let t0 = Date(timeIntervalSince1970: 1_800_000_000)

private func registry() throws -> MetricRegistry {
    try MetricRegistry.load(bundle: .main)
}

private func heartRate(_ id: String, value: Double = 72, at offset: TimeInterval = 0) -> QueuedItem {
    let time = t0.addingTimeInterval(offset)
    return QueuedItem(
        sample: MetricSample(
            measurement: .quantity(.heartRate, value), start: time, end: time, issued: time.addingTimeInterval(5),
            timeZone: TimeZone(identifier: "UTC") ?? .gmt, source: .synthetic, id: id),
        device: .synthetic)
}

private func sleep(_ id: String, stage: SleepStage, at offset: TimeInterval = 0) -> QueuedItem {
    let time = t0.addingTimeInterval(offset)
    return QueuedItem(
        sample: MetricSample(
            measurement: .sleep(stage), start: time, end: time.addingTimeInterval(1800), issued: time.addingTimeInterval(1805),
            timeZone: TimeZone(identifier: "UTC") ?? .gmt, source: .synthetic, id: id),
        device: .synthetic)
}

private func items(_ count: Int) -> [QueuedItem] {
    (0..<count).map { heartRate("syn-test-\($0)", value: 60 + Double($0 % 40), at: Double($0) * 60) }
}

/// A stand-in for HAPI that behaves like the real thing in the ways the engine depends on: conditional create by
/// identifier (201 the first time, 200 after), a transaction that is all-or-nothing, and a Patient lookup/create.
private actor FakeHAPI: FHIRTransport {
    private(set) var observations: Set<String> = []
    private(set) var devices: Set<String> = []
    private(set) var requests: [FHIRHTTPRequest] = []
    private(set) var tokens: [String] = []
    private var patientCreated = false
    
    /// Network failures to produce before behaving.
    var failNetwork = 0
    /// Status codes returned (without applying anything) for the next transactions.
    var scriptedStatuses: [Int] = []
    /// A transaction containing any of these identifier values is refused with 422.
    var poison: Set<String> = []
    /// Answer 2xx but with an empty response Bundle.
    var emptySuccess = false
    
    func configure(failNetwork: Int? = nil, scriptedStatuses: [Int]? = nil, poison: Set<String>? = nil, emptySuccess: Bool? = nil) {
        if let failNetwork { self.failNetwork = failNetwork }
        if let scriptedStatuses { self.scriptedStatuses = scriptedStatuses }
        if let poison { self.poison = poison }
        if let emptySuccess { self.emptySuccess = emptySuccess }
    }
    
    func send(_ request: FHIRHTTPRequest, token: String) async throws(TransportFailure) -> FHIRHTTPResponse {
        requests.append(request)
        tokens.append(token)
        if failNetwork > 0 {
            failNetwork -= 1
            throw TransportFailure(description: "Network: The Internet connection appears to be offline.")
        }
        if request.method == "GET", request.path.hasPrefix("Patient?") {
            return json(200, patientCreated
                ? ["resourceType": "Bundle", "entry": [["resource": ["resourceType": "Patient", "id": "42"]]]]
                : ["resourceType": "Bundle", "total": 0])
        }
        if request.method == "POST", request.path == "Patient" {
            patientCreated = true
            return json(201, ["resourceType": "Patient", "id": "42"])
        }
        guard request.method == "POST", request.path.isEmpty, let body = request.body,
              let bundle = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
              let entries = bundle["entry"] as? [[String: Any]] else {
            return json(400, ["resourceType": "OperationOutcome", "issue": [["diagnostics": "bad request"]]])
        }
        if !scriptedStatuses.isEmpty {
            let status = scriptedStatuses.removeFirst()
            return json(status, ["resourceType": "OperationOutcome", "issue": [["diagnostics": "scripted \(status)"]]])
        }
        let values = entries.compactMap { entry -> String? in
            ((entry["resource"] as? [String: Any])?["identifier"] as? [[String: Any]])?.first?["value"] as? String
        }
        if !poison.isDisjoint(with: values) {
            return json(422, ["resourceType": "OperationOutcome", "issue": [["diagnostics": "HAPI-0000: refused"]]])
        }
        if emptySuccess {
            return json(200, ["resourceType": "Bundle", "type": "transaction-response", "entry": []])
        }
        var results: [[String: Any]] = []
        for entry in entries {
            let resource = entry["resource"] as? [String: Any] ?? [:]
            let value = (resource["identifier"] as? [[String: Any]])?.first?["value"] as? String ?? ""
            var seen = resource["resourceType"] as? String == "Device" ? devices : observations
            let created = seen.insert(value).inserted
            if resource["resourceType"] as? String == "Device" { devices = seen } else { observations = seen }
            results.append(["response": ["status": created ? "201 Created" : "200 OK"]])
        }
        return json(200, ["resourceType": "Bundle", "type": "transaction-response", "entry": results])
    }
    
    func transactionCount() -> Int {
        requests.filter { $0.method == "POST" && $0.path.isEmpty }.count
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

private struct Harness {
    let queue: SampleQueue
    let server: FakeHAPI
    let engine: SyncEngine
    let clock: Clock
}

private func harness(batch: Int = 100, token: @escaping @Sendable () async throws(AuthError) -> String = { "synthetic-token" },
                     queue: SampleQueue? = nil, server: FakeHAPI = FakeHAPI()) async throws -> Harness {
    let queue = try queue ?? SampleQueue(path: nil)
    let clock = Clock()
    let engine = SyncEngine(
        queue: queue, transport: server, token: token, registry: try registry(),
        settings: .init(batchSize: batch, backoff: BackoffPolicy(base: 10, cap: 600, jitter: 0), patientIdentifier: "poc-test", patientSystem: patientSystem),
        now: { clock.now }, random: { 0.5 })
    return Harness(queue: queue, server: server, engine: engine, clock: clock)
}


// MARK: - Backoff and search escaping

@Suite("Backoff")
struct BackoffTests {
    @Test func growsExponentiallyAndStopsAtTheCap() {
        let policy = BackoffPolicy(base: 5, cap: 100, jitter: 0)
        #expect([1, 2, 3, 4, 5, 6, 50].map { policy.delay(forAttempt: $0, random: 0.5) } == [5, 10, 20, 40, 80, 100, 100])
    }
    
    @Test func jitterStaysInsideItsBandAndNeverExceedsTheCap() {
        let policy = BackoffPolicy(base: 10, cap: 60, jitter: 0.2)
        #expect(policy.delay(forAttempt: 1, random: 0) == 8)
        #expect(policy.delay(forAttempt: 1, random: 1) == 12)
        #expect(policy.delay(forAttempt: 20, random: 1) == 60)
    }
}

@Suite("Search escaping")
struct FHIRSearchTests {
    @Test func escapesTokenAndURLSpecialCharacters() {
        #expect(FHIRSearch.identifierQuery(system: "http://x/y", value: "a1") == "identifier=http%3A%2F%2Fx%2Fy%7Ca1")
        // value with FHIR token specials (| , $ \) and URL specials (& = space #)
        let query = FHIRSearch.identifierQuery(system: "s", value: "a|b,c$d\\e&f=g h#i")
        #expect(query == "identifier=s%7Ca%5C%7Cb%5C%2Cc%5C%24d%5C%5Ce%26f%3Dg%20h%23i")
        #expect(!query.dropFirst("identifier=".count).contains("&"))
    }
}


// MARK: - Bundle shape

@Suite("Bundle builder")
struct BundleBuilderTests {
    @Test func buildsOneDeviceThenConditionalObservationCreates() throws {
        let built = try BundleBuilder(registry: registry()).build(
            items(3).map { ($0.key, $0.sample, $0.device) }, patientID: "42")
        #expect(built.bundle.type == "transaction")
        #expect(built.bundle.entry.count == 4)
        guard case .device = built.bundle.entry[0].resource else { Issue.record("Device first"); return }
        #expect(built.bundle.entry[0].request.url == "Device")
        #expect(built.bundle.entry[0].request.ifNoneExist.hasPrefix("identifier=http%3A%2F%2Fblueysoft.com%2Ffhir%2Fidentifier%2Fdevice-key%7C"))
        let deviceURL = built.bundle.entry[0].fullUrl
        for entry in built.bundle.entry.dropFirst() {
            #expect(entry.request.method == "POST")
            #expect(entry.request.url == "Observation")
            #expect(entry.request.ifNoneExist.hasPrefix("identifier=http%3A%2F%2Fblueysoft.com%2Ffhir%2Fidentifier%2Fsynthetic-sample%7Csyn-test-"))
            guard case .observation(let observation) = entry.resource else { Issue.record("Observation"); continue }
            #expect(observation.device?.reference == deviceURL)
            // The condition must name the entry's OWN identifier, or a resend would not be recognised.
            let own = try #require(observation.identifier.first)
            #expect(entry.request.ifNoneExist == FHIRSearch.identifierQuery(system: own.system, value: own.value))
            #expect(observation.subject.reference == "Patient/42")
        }
        #expect(built.observationKeys == ["synthetic|syn-test-0", "synthetic|syn-test-1", "synthetic|syn-test-2"])
    }
    
    @Test func theSameBatchIsByteIdentical() throws {
        let builder = try BundleBuilder(registry: registry())
        let input = items(5).map { ($0.key, $0.sample, $0.device) }
        let a = try JSONEncoder.fhir.encode(builder.build(input, patientID: "42").bundle)
        let b = try JSONEncoder.fhir.encode(builder.build(input, patientID: "42").bundle)
        #expect(a == b)
    }
    
    @Test func unmappedAndInvalidSamplesProduceNoEntryAndAreReported() throws {
        let good = heartRate("syn-good")
        let inBed = sleep("syn-inbed", stage: .inBed)
        let bad = heartRate("syn-bad", value: -1)
        let built = try BundleBuilder(registry: registry()).build(
            [good, inBed, bad].map { ($0.key, $0.sample, $0.device) }, patientID: "42")
        #expect(built.observationKeys == [good.key])
        #expect(built.unmappedKeys == [inBed.key])
        #expect(built.invalid.map(\.key) == [bad.key])
        #expect(built.invalid.first?.error == .nonPositiveValue)
        #expect(built.bundle.entry.count == 2) // Device + one Observation
    }
    
    @Test func noDeviceEntryWhenNothingUsesIt() throws {
        let built = try BundleBuilder(registry: registry()).build(
            [sleep("syn-inbed", stage: .inBed)].map { ($0.key, $0.sample, $0.device) }, patientID: "42")
        #expect(built.bundle.entry.isEmpty)
    }
}


// MARK: - Queue

@Suite("Upload queue")
struct SampleQueueTests {
    @Test func anItemAlreadyKnownIsNotAddedTwice() async throws {
        let queue = try SampleQueue(path: nil)
        let first = try await queue.enqueue(items(3))
        let second = try await queue.enqueue(items(3) + [heartRate("syn-new")])
        #expect(first.added == 3 && first.known == 0)
        #expect(second.added == 1 && second.known == 3)
        #expect(try await queue.counts().pending == 4)
    }
    
    @Test func survivesReopening() async throws {
        let path = FileManager.default.temporaryDirectory.appendingPathComponent("queue-\(UUID().uuidString).sqlite").path
        defer { for suffix in ["", "-wal", "-shm"] { try? FileManager.default.removeItem(atPath: path + suffix) } }
        do {
            let queue = try SampleQueue(path: path)
            _ = try await queue.enqueue(items(5))
            try await queue.markSent(["synthetic|syn-test-0"])
        }
        let reopened = try SampleQueue(path: path)
        let counts = try await reopened.counts()
        #expect(counts.pending == 4 && counts.sent == 1)
        let due = try await reopened.nextBatch(limit: 10, now: t0)
        #expect(due.map(\.item.sample.id) == ["syn-test-1", "syn-test-2", "syn-test-3", "syn-test-4"])
        #expect(due.first?.item == items(5)[1]) // the sample round-trips exactly
    }
    
    @Test func aFailedItemIsNotDueUntilItsRetryTime() async throws {
        let queue = try SampleQueue(path: nil)
        _ = try await queue.enqueue(items(2))
        try await queue.recordFailure(["synthetic|syn-test-0"], error: "offline", retryAt: t0.addingTimeInterval(60))
        #expect(try await queue.nextBatch(limit: 10, now: t0).map(\.item.sample.id) == ["syn-test-1"])
        #expect(try await queue.nextBatch(limit: 10, now: t0.addingTimeInterval(61)).count == 2)
        #expect(try await queue.attempts(for: "synthetic|syn-test-0") == 1)
        #expect(try await queue.earliestDue() == Date(timeIntervalSince1970: 0)) // syn-test-1 is due now
        try await queue.makeAllDue()
        #expect(try await queue.nextBatch(limit: 10, now: t0).count == 2)
    }
}


// MARK: - Engine

@Suite("Sync engine")
struct SyncEngineTests {
    @Test func deliversEverythingOnceAndCreatesThePatient() async throws {
        let h = try await harness(batch: 40)
        _ = try await h.queue.enqueue(items(100))
        let status = await h.engine.drain()
        #expect(status.phase == .idle)
        #expect(status.counts.sent == 100 && status.counts.pending == 0)
        #expect(status.created == 100)
        #expect(await h.server.observations.count == 100)
        #expect(await h.server.devices.count == 1)
        #expect(await h.server.transactionCount() == 3) // 40 + 40 + 20
        // Patient was looked up, created (conditional), and not looked up again
        let requests = await h.server.requests
        #expect(requests.filter { $0.path == "Patient" }.count == 1)
        #expect(requests.first { $0.path == "Patient" }?.headers["If-None-Exist"]?.hasPrefix("identifier=") == true)
    }
    
    @Test func resendingTheSameSamplesChangesNothingOnTheServer() async throws {
        let server = FakeHAPI()
        let first = try await harness(server: server)
        _ = try await first.queue.enqueue(items(30))
        _ = await first.engine.drain()
        let before = await server.observations
        
        // A fresh install (empty queue, no memory of what was sent) sends the same samples again.
        let second = try await harness(server: server)
        _ = try await second.queue.enqueue(items(30))
        let status = await second.engine.drain()
        #expect(status.counts.sent == 30)
        #expect(status.created == 0)
        #expect(status.alreadyPresent == 30)
        #expect(await server.observations == before)
        #expect(await server.devices.count == 1)
    }
    
    @Test func offlineKeepsTheBacklogAndReconnectingDeliversItOnce() async throws {
        let h = try await harness()
        _ = try await h.queue.enqueue(items(20))
        await h.server.configure(failNetwork: 3)
        
        var status = await h.engine.drain()
        guard case .waiting(let until) = status.phase else { Issue.record("expected waiting, got \(status.phase)"); return }
        #expect(until == t0.addingTimeInterval(10)) // first retry: base 10 s, no jitter
        #expect(status.counts.pending == 20 && status.counts.sent == 0)
        #expect(await h.server.observations.isEmpty)
        
        // Not due yet: nothing is sent.
        let requestsWhileWaiting = await h.server.requests.count
        status = await h.engine.drain()
        #expect(status.phase == .idle) // queue has nothing due; backlog still pending
        #expect(await h.server.requests.count == requestsWhileWaiting)
        #expect(status.counts.pending == 20)
        
        // Second failure (the engine retried after the delay), delay doubles.
        h.clock.advance(11)
        status = await h.engine.drain()
        guard case .waiting(let second) = status.phase else { Issue.record("expected waiting"); return }
        #expect(second == t0.addingTimeInterval(11 + 20))
        
        h.clock.advance(21)
        status = await h.engine.drain() // third (last scripted) failure
        h.clock.advance(100)
        status = await h.engine.drain() // online
        #expect(status.phase == .idle)
        #expect(status.counts.sent == 20 && status.counts.pending == 0)
        #expect(await h.server.observations.count == 20)
        #expect(status.created == 20)
    }
    
    @Test func oneRefusedSampleIsIsolatedAndTheRestStillUpload() async throws {
        let h = try await harness(batch: 50)
        await h.server.configure(poison: ["syn-test-17"])
        _ = try await h.queue.enqueue(items(30))
        let status = await h.engine.drain()
        #expect(status.phase == .idle)
        #expect(status.counts.sent == 29 && status.counts.rejected == 1 && status.counts.pending == 0)
        #expect(await h.server.observations.count == 29)
        #expect(await h.server.observations.contains("syn-test-17") == false)
        let rejected = try await h.queue.rejections(limit: 5)
        #expect(rejected.map(\.key) == ["synthetic|syn-test-17"])
        #expect(rejected.first?.reason.contains("422") == true)
    }
    
    @Test func aRefusedBatchIsNotSplitBelowASingleSampleOrRetriedForever() async throws {
        let h = try await harness()
        await h.server.configure(poison: Set(items(4).map(\.sample.id)))
        _ = try await h.queue.enqueue(items(4))
        let status = await h.engine.drain()
        #expect(status.counts.rejected == 4 && status.counts.pending == 0 && status.phase == .idle)
    }
    
    @Test func serverErrorsBackOffAndKeepTheData() async throws {
        let h = try await harness()
        _ = try await h.queue.enqueue(items(5))
        for code in [500, 503, 429, 408] {
            await h.server.configure(scriptedStatuses: [code])
            let status = await h.engine.drain()
            guard case .waiting = status.phase else { Issue.record("\(code) should wait, got \(status.phase)"); return }
            #expect(status.counts.pending == 5 && status.counts.rejected == 0)
            h.clock.advance(10_000)
        }
        let status = await h.engine.drain()
        #expect(status.counts.sent == 5)
    }
    
    @Test func a401IsRetriedOnceWithAFreshTokenThenAsksForSignIn() async throws {
        let counter = Counter()
        let h = try await harness(token: { () async throws(AuthError) -> String in await counter.next() })
        _ = try await h.queue.enqueue(items(3))
        await h.server.configure(scriptedStatuses: [401])
        var status = await h.engine.drain()
        #expect(status.phase == .idle && status.counts.sent == 3) // second try, new token, accepted
        let tokens = await h.server.tokens
        #expect(Set(tokens).count > 1)
        
        await h.server.configure(scriptedStatuses: [401, 401])
        _ = try await h.queue.enqueue([heartRate("syn-more")])
        status = await h.engine.drain()
        #expect(status.phase == .blocked(.signInRequired))
        #expect(status.counts.pending == 1)
    }
    
    @Test func signedOutBlocksWithoutTouchingTheNetwork() async throws {
        let h = try await harness(token: { () async throws(AuthError) -> String in throw .signedOut })
        _ = try await h.queue.enqueue(items(3))
        let status = await h.engine.drain()
        #expect(status.phase == .blocked(.signInRequired))
        #expect(await h.server.requests.isEmpty)
        #expect(status.counts.pending == 3)
    }
    
    @Test func a403BlocksAndKeepsTheData() async throws {
        let h = try await harness()
        _ = try await h.queue.enqueue(items(3))
        await h.server.configure(scriptedStatuses: [403])
        let status = await h.engine.drain()
        guard case .blocked(.forbidden) = status.phase else { Issue.record("expected forbidden, got \(status.phase)"); return }
        #expect(status.counts.pending == 3 && status.counts.rejected == 0)
    }
    
    @Test func aSuccessThatDoesNotAccountForEveryEntryIsNotTrusted() async throws {
        let h = try await harness()
        await h.server.configure(emptySuccess: true)
        _ = try await h.queue.enqueue(items(3))
        let status = await h.engine.drain()
        guard case .waiting = status.phase else { Issue.record("expected waiting, got \(status.phase)"); return }
        #expect(status.counts.sent == 0 && status.counts.pending == 3)
    }
    
    @Test func unmappedSamplesAreSkippedNotSent() async throws {
        let h = try await harness()
        _ = try await h.queue.enqueue([heartRate("syn-a"), sleep("syn-inbed", stage: .inBed), sleep("syn-deep", stage: .asleepDeep)])
        let status = await h.engine.drain()
        #expect(status.counts.sent == 2 && status.counts.skipped == 1)
        #expect(await h.server.observations == ["syn-a", "syn-deep"])
    }
    
    @Test func theBearerTokenIsNeverPartOfAPersistedOrReportedError() async throws {
        let h = try await harness(token: { () async throws(AuthError) -> String in "SECRET-TOKEN-VALUE" })
        await h.server.configure(failNetwork: 1)
        _ = try await h.queue.enqueue(items(1))
        let status = await h.engine.drain()
        #expect(status.lastError?.contains("SECRET-TOKEN-VALUE") != true)
        #expect(try await h.queue.rejections(limit: 5).isEmpty)
    }
}

private actor Counter {
    private var n = 0
    func next() -> String {
        n += 1
        return "synthetic-token-\(n)"
    }
}


// MARK: - duplicates that meet in the queue

@Suite("Queue: a duplicate is flagged on the copy that is still waiting")
struct QueueDuplicateFlagTests {
    private func pendingItem(_ queue: SampleQueue) async throws -> QueuedItem {
        let batch = try await queue.nextBatch(limit: 10, now: .distantFuture)
        return try #require(batch.first?.item)
    }
    
    @Test("a second delivery while the first is pending marks the surviving copy duplicate-resolved, once")
    func flagsPendingCopy() async throws {
        let queue = try SampleQueue(path: nil)
        let first = try await queue.enqueue([heartRate("dup-1")])
        #expect(first.added == 1 && first.known == 0)
        #expect(try await pendingItem(queue).sample.duplicateResolved == false, "the control: one delivery is not a duplicate")
        
        let second = try await queue.enqueue([heartRate("dup-1")])
        #expect(second.added == 0 && second.known == 1, "still one row")
        #expect(try await pendingItem(queue).sample.duplicateResolved)
        
        // a third delivery changes nothing more
        _ = try await queue.enqueue([heartRate("dup-1")])
        let batch = try await queue.nextBatch(limit: 10, now: .distantFuture)
        #expect(batch.count == 1 && batch[0].item.sample.duplicateResolved)
    }
    
    @Test("a duplicate that arrives after the first copy was uploaded changes nothing (it cannot be flagged)")
    func afterUploadNothingChanges() async throws {
        let queue = try SampleQueue(path: nil)
        let item = heartRate("dup-2")
        _ = try await queue.enqueue([item])
        try await queue.markSent([item.key])
        let again = try await queue.enqueue([heartRate("dup-2")])
        #expect(again.added == 0 && again.known == 1)
        #expect(try await queue.nextBatch(limit: 10, now: .distantFuture).isEmpty, "the sent row stays sent")
    }
    
    @Test("only the duplicated sample is flagged, not its neighbours")
    func neighboursUntouched() async throws {
        let queue = try SampleQueue(path: nil)
        _ = try await queue.enqueue([heartRate("a", at: 0), heartRate("b", at: 5)])
        _ = try await queue.enqueue([heartRate("b", at: 5)])
        let batch = try await queue.nextBatch(limit: 10, now: .distantFuture)
        let flags = Dictionary(uniqueKeysWithValues: batch.map { ($0.item.sample.id, $0.item.sample.duplicateResolved) })
        #expect(flags == ["a": false, "b": true])
    }
    
    @Test("a queued row written before the flags existed still decodes, with every flag false")
    func oldRowsDecode() throws {
        let old = #"{"measurement":{"quantity":{"_0":"heartRate","_1":72}},"start":0,"end":0,"issued":0,"timeZone":{"identifier":"UTC"},"source":"synthetic","id":"old"}"#
        let decoded = try JSONDecoder().decode(MetricSample.self, from: Data(old.utf8))
        #expect(!decoded.artifactSuspected && !decoded.lateArrival && !decoded.duplicateResolved && !decoded.userEntered)
    }
}



// MARK: - signing in resumes a blocked upload

/// A token source whose answer the test changes: signed out until told otherwise.
private final class SignInSwitch: @unchecked Sendable {
    private let lock = NSLock()
    private var on = false
    var isSignedIn: Bool {
        get { lock.withLock { on } }
        set { lock.withLock { on = newValue } }
    }
}

@Suite("Signing in resumes the upload")
@MainActor
struct SignInResumeTests {
    private func eventually(_ condition: () -> Bool) async throws {
        for _ in 0..<150 where !condition() {
            try await Task.sleep(for: .milliseconds(20))
        }
    }
    
    private func isolatedDefaults() -> UserDefaults {
        let name = "signin-tests-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: name)!
        defaults.removePersistentDomain(forName: name)
        return defaults
    }
    
    @Test("blocked on sign-in, the queue stays put when only the token appears, and uploads once the sign-in is announced")
    func resumes() async throws {
        let session = SignInSwitch()
        let h = try await harness(token: { () async throws(AuthError) -> String in
            guard session.isSignedIn else { throw .signedOut }
            return "tok"
        })
        _ = try await h.queue.enqueue(items(5))
        let model = SyncModel(queue: h.queue, engine: h.engine, debounce: 0, monitorNetwork: false, defaults: isolatedDefaults())
        
        try await eventually { model.status.phase == .blocked(.signInRequired) }
        #expect(model.status.phase == .blocked(.signInRequired))
        #expect(model.status.counts.pending == 5 && model.status.counts.sent == 0)
        
        // the control: a token that merely becomes available wakes nothing (this is the defect being fixed)
        session.isSignedIn = true
        try await Task.sleep(for: .milliseconds(400))
        #expect(model.status.counts.sent == 0 && model.status.phase == .blocked(.signInRequired), "nothing wakes the engine by itself")
        
        model.userSignedIn()
        try await eventually { model.status.counts.sent == 5 }
        #expect(model.status.counts.sent == 5 && model.status.counts.pending == 0)
        #expect(model.status.phase == .idle)
    }
    
    @Test("signing in also clears a backoff that was running")
    func clearsBackoff() async throws {
        let session = SignInSwitch()
        session.isSignedIn = true
        let h = try await harness(token: { () async throws(AuthError) -> String in "tok" })
        await h.server.configure(failNetwork: 1)
        _ = try await h.queue.enqueue(items(3))
        let model = SyncModel(queue: h.queue, engine: h.engine, debounce: 0, monitorNetwork: false, defaults: isolatedDefaults())
        try await eventually {
            if case .waiting = model.status.phase { return true }
            return false
        }
        guard case .waiting = model.status.phase else {
            Issue.record("expected the engine to be backing off after a network failure")
            return
        }
        model.userSignedIn()
        try await eventually { model.status.counts.sent == 3 }
        #expect(model.status.counts.sent == 3, "the retry happened now, not after the backoff")
    }
}
