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
