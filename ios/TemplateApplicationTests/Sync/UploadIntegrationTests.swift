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


/// Uploads synthetic samples to the POC's own HAPI over TLS with a real token, and checks what the SERVER holds.
///
/// Skipped (and reported as skipped) unless `POC_CAPTURE_PASSWORD` is in the environment: run
/// `make test-ios-integration`, which reads it from the git-ignored `idp/.env.local` and needs the stack up and the
/// POC CA trusted in the simulator (`scripts/ios-sim-trust.sh`). The password is only ever sent to Keycloak's token
/// endpoint (dev-only `poc-devtest` client) and is never printed.
///
/// Isolation from other data: every sample in a run gets an effective time inside a random hour in the years
/// 2001-2015 and ids carrying a per-run random tag, so counting by `date` window plus subject counts exactly this
/// run's Observations and nothing else, however many times the test has run before.
@Suite("Upload against the live stack", .serialized, .enabled(if: ProcessInfo.processInfo.environment["POC_CAPTURE_PASSWORD"] != nil))
struct UploadIntegrationTests {
    private struct Failure: Error { var message: String }
    
    private struct Server {
        let configuration: ServerConfiguration
        let token: String
        let transport: URLSessionTransport
        let registry: MetricRegistry
        
        /// `Cache-Control: no-cache`: HAPI reuses the result of an identical search for a minute by default, which would
        /// make the "nothing there yet" control and the later counts return the same stale answer.
        func get(_ path: String) async throws -> [String: Any] {
            let response = try await transport.send(FHIRHTTPRequest(method: "GET", path: path, headers: ["Cache-Control": "no-cache"]), token: token)
            guard response.status == 200,
                  let object = try JSONSerialization.jsonObject(with: response.body) as? [String: Any] else {
                throw Failure(message: "GET \(path.prefix(40)) returned HTTP \(response.status)")
            }
            return object
        }
        
        func patientID() async throws -> String {
            let query = FHIRSearch.identifierQuery(system: registry.systems.identifier.patient, value: configuration.patientIdentifier)
            let bundle = try await get("Patient?\(query)&_elements=id")
            let ids = (bundle["entry"] as? [[String: Any]] ?? []).compactMap { ($0["resource"] as? [String: Any])?["id"] as? String }
            guard ids.count == 1 else { throw Failure(message: "expected exactly one Patient, found \(ids.count)") }
            return ids[0]
        }
        
        func count(patient: String, from: Date, to: Date) async throws -> Int {
            let formatter = ISO8601DateFormatter()
            let low = formatter.string(from: from), high = formatter.string(from: to)
            let query = "Observation?subject=Patient/\(patient)&date=ge\(low)&date=lt\(high)&_summary=count"
            return (try await get(query))["total"] as? Int ?? -1
        }
    }
    
    private func connect() async throws -> Server {
        guard case .success(let configuration) = ServerConfiguration.load() else {
            throw Failure(message: "the app is not configured")
        }
        let password = ProcessInfo.processInfo.environment["POC_CAPTURE_PASSWORD"] ?? ""
        var request = URLRequest(url: configuration.issuerURL.appendingPathComponent("protocol/openid-connect/token"))
        request.httpMethod = "POST"
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        var allowed = CharacterSet.alphanumerics
        allowed.insert(charactersIn: "-._~")
        func form(_ pairs: [(String, String)]) -> Data {
            Data(pairs.map { "\($0.0)=\($0.1.addingPercentEncoding(withAllowedCharacters: allowed) ?? "")" }.joined(separator: "&").utf8)
        }
        request.httpBody = form([("grant_type", "password"), ("client_id", "poc-devtest"), ("username", "capture-user"), ("password", password)])
        let (data, response) = try await URLSession.shared.data(for: request)
        guard (response as? HTTPURLResponse)?.statusCode == 200,
              let token = (try JSONSerialization.jsonObject(with: data) as? [String: Any])?["access_token"] as? String else {
            throw Failure(message: "could not get a token for the synthetic capture user (is the stack up?)")
        }
        return Server(configuration: configuration, token: token,
                      transport: URLSessionTransport(baseURL: configuration.fhirBaseURL),
                      registry: try MetricRegistry.load(bundle: .main))
    }
    
    /// A run's samples: `heartRate` ones a minute apart inside the window, plus a few sleep stages (one unmapped).
    private func samples(tag: String, window: Date, heartRates: Int) -> (items: [QueuedItem], uploadable: Int) {
        var items: [QueuedItem] = []
        for index in 0..<heartRates {
            let time = window.addingTimeInterval(Double(index) * 20)
            items.append(QueuedItem(
                sample: MetricSample(
                    measurement: .quantity(.heartRate, 55 + Double(index % 50)), start: time, end: time, issued: .now,
                    timeZone: TimeZone(identifier: "UTC") ?? .gmt, source: .synthetic, id: "syn-it-\(tag)-hr-\(index)"),
                device: .synthetic))
        }
        let stages: [SleepStage] = [.asleepCore, .asleepDeep, .asleepREM, .awake, .inBed]
        for (index, stage) in stages.enumerated() {
            let start = window.addingTimeInterval(1800 + Double(index) * 300)
            items.append(QueuedItem(
                sample: MetricSample(
                    measurement: .sleep(stage), start: start, end: start.addingTimeInterval(240), issued: .now,
                    timeZone: TimeZone(identifier: "UTC") ?? .gmt, source: .synthetic, id: "syn-it-\(tag)-sleep-\(index)"),
                device: .synthetic))
        }
        return (items, heartRates + stages.count - 1) // inBed is never uploaded
    }
    
    private func engine(_ server: Server, queue: SampleQueue, transport: (any FHIRTransport)? = nil,
                        backoff: BackoffPolicy = BackoffPolicy(base: 0.2, cap: 1, jitter: 0)) -> SyncEngine {
        SyncEngine(
            queue: queue, transport: transport ?? server.transport,
            token: { [token = server.token] () async throws(AuthError) -> String in token },
            registry: server.registry,
            settings: .init(batchSize: 25, backoff: backoff,
                            patientIdentifier: server.configuration.patientIdentifier,
                            patientSystem: server.registry.systems.identifier.patient))
    }
    
    /// The generator's injected faults, through the app's own flagger, queue and upload, read back from HAPI: every
    /// stored tag must be exactly what ground truth says. This is the end-to-end check for data-quality flags.
    @Test func injectedFaultsAreFlaggedOnTheServerExactlyAsGroundTruthSays() async throws {
        let server = try await connect()
        let patient = try await server.patientID()
        let tag = String(UUID().uuidString.prefix(8)).lowercased()
        let start = Date(timeIntervalSince1970: Double(Int.random(in: 978_307_200..<1_420_070_400) / 3600 * 3600))
        
        var config = SyntheticConfig()
        config.seed = UInt64.random(in: 1..<UInt64.max)
        config.metrics = [.heartRate, .hrv]
        config.heartRateCadence = 60
        config.artifactFraction = 0.1
        config.duplicateFraction = 0.1
        config.late = .init(fraction: 0.3, minDelay: 3600, maxDelay: 40 * 3600)
        let emissions = SyntheticGenerator(config: config).emissions(deliveredIn: start..<start.addingTimeInterval(2 * 3600))
        #expect(emissions.count > 100)
        
        // ids are made unique to this run, so no other run's data can be mistaken for this one's
        func runID(_ id: String) -> String { "\(id)-\(tag)" }
        var occurrences: [String: Int] = [:]
        for emission in emissions { occurrences[runID(emission.sample.id), default: 0] += 1 }
        
        // a read-back window wide enough for samples measured up to 40 h before delivery; it must be empty to begin with
        let low = start.addingTimeInterval(-3 * 86_400), high = start.addingTimeInterval(3 * 3600)
        #expect(try await server.count(patient: patient, from: low, to: high) == 0, "the window must be free (the control)")
        
        let flagger = QualityFlagger(registry: server.registry)
        let items = emissions.map { emission -> QueuedItem in
            var sample = emission.sample
            sample.id = runID(sample.id)
            return QueuedItem(sample: flagger.applied(to: sample), device: .synthetic)
        }
        let queue = try SampleQueue(path: nil)
        _ = try await queue.enqueue(items)   // one transaction: a duplicate meets its still-pending first copy
        let outcome = await engine(server, queue: queue).drain()
        #expect(outcome.phase == .idle && outcome.counts.pending == 0 && outcome.counts.rejected == 0)
        
        // read back what the server stored: the tags per identifier
        let formatter = ISO8601DateFormatter()
        let search = "Observation?subject=Patient/\(patient)&date=ge\(formatter.string(from: low))&date=lt\(formatter.string(from: high))"
            + "&_elements=identifier,meta&_count=1000"
        let bundle = try await server.get(search)
        var stored: [String: [String]] = [:]
        for entry in bundle["entry"] as? [[String: Any]] ?? [] {
            guard let resource = entry["resource"] as? [String: Any],
                  let identifier = (resource["identifier"] as? [[String: Any]])?.first?["value"] as? String else { continue }
            let tags = ((resource["meta"] as? [String: Any])?["tag"] as? [[String: Any]] ?? [])
                .filter { $0["system"] as? String == server.registry.systems.dataQualityFlag }
                .compactMap { $0["code"] as? String }
            stored[identifier] = tags
        }
        #expect(stored.count == occurrences.count, "one Observation per distinct sample")
        
        let code = { (key: String) in server.registry.dataQualityFlags[key] ?? "?" }
        var artifacts = 0, late = 0, duplicates = 0
        var seen = Set<String>()
        for emission in emissions {
            let id = runID(emission.sample.id)
            guard seen.insert(id).inserted else { continue }
            var expected: [String] = []
            if emission.injected.contains(.artifact) { expected.append(code("artifactSuspected")); artifacts += 1 }
            if (occurrences[id] ?? 0) > 1 { expected.append(code("duplicateResolved")); duplicates += 1 }
            if emission.sample.issued.timeIntervalSince(emission.sample.end) > 24 * 3600 { expected.append(code("lateArrival")); late += 1 }
            #expect(stored[id]?.sorted() == expected.sorted(), "\(emission.sample.id): server has \(stored[id] ?? []), ground truth says \(expected)")
        }
        // the run must have exercised every kind, or "all matched" would be vacuous
        #expect(artifacts > 0 && late > 0 && duplicates > 0, "artifacts \(artifacts), late \(late), duplicates \(duplicates)")
        #expect(stored.values.contains { $0.isEmpty }, "and some samples carry no flag at all (the control)")
    }
    
    @Test func uploadsResendsAndSurvivesAnOutageWithoutDuplicates() async throws {
        let server = try await connect()
        let patient = try await server.patientID()
        let tag = String(UUID().uuidString.prefix(8)).lowercased()
        // A random hour between 2001 and 2015: clear of every other run and of anything real.
        let window = Date(timeIntervalSince1970: Double(Int.random(in: 978_307_200..<1_420_070_400) / 3600 * 3600))
        let (items, uploadable) = samples(tag: tag, window: window, heartRates: 60)
        // The outage batch is offset by 30 min and its sleep stages run past the hour: count over a 2 h window.
        let from = window, to = window.addingTimeInterval(7200)
        
        // Nothing of this run on the server yet (a negative control for the count query itself).
        #expect(try await server.count(patient: patient, from: from, to: to) == 0)
        
        // 1. First upload: the server holds exactly what was emitted.
        let queue = try SampleQueue(path: nil)
        _ = try await queue.enqueue(items)
        let first = await engine(server, queue: queue).drain()
        #expect(first.phase == .idle)
        #expect(first.counts.sent == uploadable && first.counts.skipped == 1 && first.counts.pending == 0 && first.counts.rejected == 0)
        #expect(first.created == uploadable)
        let held = try await server.count(patient: patient, from: from, to: to)
        #expect(held == uploadable, "server holds \(held), uploaded \(uploadable)")
        
        // The content, not just the count: one Observation fetched back by its identifier.
        let system = server.registry.systems.identifier.synthetic
        let one = try await server.get("Observation?\(FHIRSearch.identifierQuery(system: system, value: "syn-it-\(tag)-hr-7"))")
        let entry = (one["entry"] as? [[String: Any]])?.first?["resource"] as? [String: Any]
        #expect(one["total"] as? Int == 1)
        #expect((entry?["subject"] as? [String: Any])?["reference"] as? String == "Patient/\(patient)")
        #expect(((entry?["device"] as? [String: Any])?["reference"] as? String)?.hasPrefix("Device/") == true)
        #expect(((entry?["valueQuantity"] as? [String: Any])?["value"] as? Double) == 62)
        
        // 2. The same samples again, from a queue with no memory of the first upload: nothing changes.
        let again = try SampleQueue(path: nil)
        _ = try await again.enqueue(items)
        let second = await engine(server, queue: again).drain()
        #expect(second.created == 0 && second.alreadyPresent == uploadable)
        #expect(try await server.count(patient: patient, from: from, to: to) == uploadable)
        
        // 3. An outage: the first three requests fail at the network level, then the connection returns. A fresh
        //    set of samples (new tag) must arrive exactly once.
        let (more, moreUploadable) = samples(tag: tag + "b", window: window.addingTimeInterval(1800), heartRates: 40)
        let flaky = FlakyTransport(wrapping: server.transport, failures: 3)
        let outage = try SampleQueue(path: nil)
        _ = try await outage.enqueue(more)
        let backlogEngine = engine(server, queue: outage, transport: flaky)
        var rounds = 0
        var status = await backlogEngine.drain()
        while status.counts.pending > 0 && rounds < 20 {
            if case .waiting(let until) = status.phase {
                try await Task.sleep(for: .seconds(max(until.timeIntervalSinceNow, 0) + 0.05))
            }
            status = await backlogEngine.drain()
            rounds += 1
        }
        #expect(await flaky.failed == 3)
        #expect(status.counts.sent == moreUploadable && status.counts.pending == 0)
        #expect(status.created == moreUploadable)
        #expect(try await server.count(patient: patient, from: from, to: to) == uploadable + moreUploadable)
    }
}


/// Fails the first `failures` requests as the network would (offline), then passes everything through.
private actor FlakyTransport: FHIRTransport {
    private let inner: any FHIRTransport
    private var remaining: Int
    private(set) var failed = 0
    
    init(wrapping inner: any FHIRTransport, failures: Int) {
        self.inner = inner
        remaining = failures
    }
    
    func send(_ request: FHIRHTTPRequest, token: String) async throws(TransportFailure) -> FHIRHTTPResponse {
        if remaining > 0 {
            remaining -= 1
            failed += 1
            throw TransportFailure(description: "Network: The Internet connection appears to be offline.")
        }
        return try await inner.send(request, token: token)
    }
}
