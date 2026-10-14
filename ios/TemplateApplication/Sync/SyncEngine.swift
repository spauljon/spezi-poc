//
// This source file is part of the Spezi POC capture app, adapted from the Stanford Spezi Template Application
//
// SPDX-FileCopyrightText: 2023 Stanford University and the project authors (see CONTRIBUTORS.md)
//
// SPDX-License-Identifier: MIT
//

import Foundation


/// Why uploading cannot continue until a person does something.
enum SyncBlocker: Equatable, Sendable {
    /// No usable sign-in (never signed in, refresh failed, or the server rejected the token twice).
    case signInRequired
    /// The server refused the request as this user (403). Retrying cannot help; the role or rules must change.
    case forbidden(String)
    /// Something the app was configured with is wrong (for example more than one Patient has the identifier).
    case configuration(String)
}

struct SyncStatus: Equatable, Sendable {
    enum Phase: Equatable, Sendable {
        case idle
        case syncing
        /// A transient failure; the next attempt is due at the given time.
        case waiting(until: Date)
        case blocked(SyncBlocker)
    }
    
    var phase = Phase.idle
    var counts = QueueCounts()
    var lastSuccess: Date?
    var lastError: String?
    /// Observations the server created in this run of the app.
    var created = 0
    /// Observations the server already had (a resend or a duplicate): accepted, nothing changed.
    var alreadyPresent = 0
}


/// Drains the queue into HAPI as transaction Bundles.
///
/// Rules of the road:
/// - Every entry is a conditional create (`ifNoneExist` on `identifier`), so a resend (after a timeout, a crash, or a
///   duplicate delivery) changes nothing on the server.
/// - A whole batch succeeds or fails together (transaction). Failure kinds are handled differently:
///   transient (offline, 5xx, 408, 429) backs off and keeps the data; 401 refreshes once and then asks for sign-in;
///   403 blocks (retrying cannot help); 4xx on content bisects the batch until the one sample the server will not
///   take is isolated and quarantined as rejected, so one poison sample never blocks the rest.
actor SyncEngine {
    struct Settings: Sendable {
        var batchSize = 100
        var backoff = BackoffPolicy()
        var patientIdentifier: String
        var patientSystem: String
        /// The patient for real Apple Health data. When `nil`, such samples are NOT uploaded: they are never filed under
        /// `patientIdentifier` (the synthetic patient), so a rollup or a night can never blend real and synthetic data.
        var healthKitPatientIdentifier: String?
        
        func identifier(for source: SampleSource) -> String? {
            switch source {
            case .synthetic: patientIdentifier
            case .healthKit: healthKitPatientIdentifier
            }
        }
    }
    
    private let queue: SampleQueue
    private let transport: any FHIRTransport
    private let token: @Sendable () async throws(AuthError) -> String
    private let builder: BundleBuilder
    private let settings: Settings
    private let now: @Sendable () -> Date
    private let random: @Sendable () -> Double
    
    private var patientIDs: [SampleSource: String] = [:]
    private(set) var status = SyncStatus()
    private var draining = false
    
    
    init(
        queue: SampleQueue,
        transport: any FHIRTransport,
        token: @escaping @Sendable () async throws(AuthError) -> String,
        registry: MetricRegistry,
        settings: Settings,
        now: @escaping @Sendable () -> Date = { .now },
        random: @escaping @Sendable () -> Double = { .random(in: 0..<1) }
    ) {
        self.queue = queue
        self.transport = transport
        self.token = token
        self.builder = BundleBuilder(registry: registry)
        self.settings = settings
        self.now = now
        self.random = random
    }
    
    
    /// Refreshes the counts shown to the user without sending anything.
    func refresh() async -> SyncStatus {
        if let counts = try? await queue.counts() {
            status.counts = counts
        }
        return status
    }
    
    /// Uploads everything that is due. Safe to call at any time and from anywhere: a second call while one is running
    /// returns the current status.
    @discardableResult
    func drain() async -> SyncStatus {
        guard !draining else {
            return status
        }
        draining = true
        defer { draining = false }
        status.phase = .syncing
        status.lastError = nil
        
        do {
            while true {
                let due = try await queue.nextBatch(limit: settings.batchSize, now: now())
                guard !due.isEmpty else {
                    break
                }
                // One source per bundle: each source has its own patient, and a bundle carries one patient.
                let source = due[0].item.sample.source
                let batch = due.filter { $0.item.sample.source == source }
                let batchAttempts = batch.map(\.attempts).max() ?? 0
                guard let identifier = settings.identifier(for: source) else {
                    // Never fall back to another source's patient. Park these items (so the others still go out).
                    let message = "No separate patient is configured for Apple Health data, so it was not uploaded."
                    try await queue.recordFailure(batch.map(\.item.key), error: message, retryAt: now().addingTimeInterval(3600))
                    status.lastError = message
                    status.counts = try await queue.counts()
                    continue
                }
                let pid: String
                switch await resolvePatient(source: source, identifier: identifier) {
                case .success(let id): pid = id
                case .failure(let stop):
                    try await finish(stop, keys: batch.map(\.item.key), attempts: batchAttempts)
                    return status
                }
                switch try await upload(batch.map(\.item), attempts: batchAttempts, patientID: pid) {
                case .done: continue
                case .stop(let stop): // nothing more to do right now
                    status.phase = stop
                    status.counts = try await queue.counts()
                    return status
                }
            }
            status.phase = .idle
            status.lastSuccess = now()
        } catch {
            status.phase = .blocked(.configuration("The local queue failed: \(error)"))
            status.lastError = "The local queue failed: \(error)"
        }
        status.counts = (try? await queue.counts()) ?? status.counts
        return status
    }
    
    
    // MARK: - Internals
    
    private enum Step {
        case done
        case stop(SyncStatus.Phase)
    }
    
    private enum Stop: Error {
        case transient(String)
        case blocked(SyncBlocker, String)
    }
    
    /// Records a stop that applies to a whole batch (patient resolution failed).
    private func finish(_ stop: Stop, keys: [String], attempts: Int) async throws(QueueError) {
        switch stop {
        case .transient(let message):
            let due = now().addingTimeInterval(settings.backoff.delay(forAttempt: attempts + 1, random: random()))
            try await queue.recordFailure(keys, error: message, retryAt: due)
            status.phase = .waiting(until: due)
            status.lastError = message
        case .blocked(let blocker, let message):
            status.phase = .blocked(blocker)
            status.lastError = message
        }
        status.counts = try await queue.counts()
    }
    
    private func upload(_ items: [QueuedItem], attempts: Int, patientID: String) async throws(QueueError) -> Step {
        let built: BuildResult
        do {
            built = try builder.build(items.map { ($0.key, $0.sample, $0.device) }, patientID: patientID)
        } catch {
            // The patient id itself is unusable (empty); nothing can be built.
            status.phase = .blocked(.configuration("Cannot build a Bundle: \(error.code)"))
            status.lastError = "Cannot build a Bundle: \(error.code)"
            return .stop(status.phase)
        }
        for bad in built.invalid {
            try await queue.markRejected(bad.key, reason: "Not mappable: \(bad.error.code)")
        }
        if !built.unmappedKeys.isEmpty {
            try await queue.markSkipped(built.unmappedKeys)
        }
        guard !built.observationKeys.isEmpty else {
            return .done
        }
        return try await send(built, attempts: attempts, patientID: patientID, mayRefresh: true)
    }
    
    private func send(_ built: BuildResult, attempts: Int, patientID: String, mayRefresh: Bool) async throws(QueueError) -> Step {
        let bearer: String
        do {
            bearer = try await token()
        } catch {
            status.phase = error == .signedOut ? .blocked(.signInRequired) : .waiting(until: now().addingTimeInterval(settings.backoff.delay(forAttempt: attempts + 1, random: random())))
            status.lastError = error == .signedOut ? "Sign in to upload." : "Could not get an access token."
            return .stop(status.phase)
        }
        
        let body: Data
        do {
            body = try JSONEncoder.fhir.encode(built.bundle)
        } catch {
            status.phase = .blocked(.configuration("A Bundle could not be encoded."))
            return .stop(status.phase)
        }
        let request = FHIRHTTPRequest(method: "POST", path: "", headers: [:], body: body)
        
        let response: FHIRHTTPResponse
        do {
            response = try await transport.send(request, token: bearer)
        } catch {
            return try await transient(built.observationKeys, message: error.description, attempts: attempts)
        }
        
        switch response.status {
        case 200..<300:
            let deviceEntries = built.bundle.entry.count - built.observationKeys.count
            let tally = Self.tally(response.body, skipping: deviceEntries)
            guard tally.total == built.bundle.entry.count else {
                // A success that does not account for every entry is not trusted: keep the data, try again.
                return try await transient(built.observationKeys, message: "The server's response did not match the request.", attempts: attempts)
            }
            try await queue.markSent(built.observationKeys)
            status.created += tally.created
            status.alreadyPresent += max(0, built.observationKeys.count - tally.created)
            status.lastSuccess = now()
            status.counts = try await queue.counts()
            return .done
        case 401:
            if mayRefresh {
                return try await send(built, attempts: attempts, patientID: patientID, mayRefresh: false)
            }
            status.phase = .blocked(.signInRequired)
            status.lastError = "The server did not accept the sign-in. Sign in again."
            return .stop(status.phase)
        case 403:
            let reason = Self.diagnostics(response.body) ?? "Forbidden"
            status.phase = .blocked(.forbidden(reason))
            status.lastError = "The server refused this user: \(reason)"
            return .stop(status.phase)
        case 408, 429, 500..<600:
            return try await transient(built.observationKeys, message: "Server returned HTTP \(response.status).", attempts: attempts)
        default:
            // Content the server will not take (400, 409, 412, 422 ...): isolate the offender.
            let reason = Self.diagnostics(response.body) ?? "HTTP \(response.status)"
            if built.observationKeys.count == 1, let key = built.observationKeys.first {
                try await queue.markRejected(key, reason: "HTTP \(response.status): \(reason)")
                status.counts = try await queue.counts()
                return .done
            }
            return try await bisect(built, attempts: attempts, patientID: patientID)
        }
    }
    
    /// Splits a refused batch in two and sends each half; recursion ends at single samples.
    private func bisect(_ built: BuildResult, attempts: Int, patientID: String) async throws(QueueError) -> Step {
        let observationEntries = built.bundle.entry.filter { if case .observation = $0.resource { true } else { false } }
        let deviceEntries = built.bundle.entry.filter { if case .device = $0.resource { true } else { false } }
        let middle = observationEntries.count / 2
        let halves = [(0..<middle), (middle..<observationEntries.count)]
        for range in halves where !range.isEmpty {
            let slice = Array(observationEntries[range])
            let used = Set(slice.compactMap { entry -> String? in
                if case .observation(let o) = entry.resource { return o.device?.reference }
                return nil
            })
            let part = BuildResult(
                bundle: FHIRBundle(entry: deviceEntries.filter { used.contains($0.fullUrl) } + slice),
                observationKeys: Array(built.observationKeys[range]), unmappedKeys: [], invalid: [])
            switch try await send(part, attempts: attempts, patientID: patientID, mayRefresh: true) {
            case .done: continue
            case .stop(let phase): return .stop(phase)
            }
        }
        return .done
    }
    
    private func transient(_ keys: [String], message: String, attempts: Int) async throws(QueueError) -> Step {
        let due = now().addingTimeInterval(settings.backoff.delay(forAttempt: attempts + 1, random: random()))
        try await queue.recordFailure(keys, error: message, retryAt: due)
        status.phase = .waiting(until: due)
        status.lastError = message
        status.counts = try await queue.counts()
        return .stop(status.phase)
    }
    
    
    // MARK: Patient
    
    private func resolvePatient(source: SampleSource, identifier: String) async -> Result<String, Stop> {
        if let known = patientIDs[source] {
            return .success(known)
        }
        let bearer: String
        do {
            bearer = try await token()
        } catch {
            return .failure(error == .signedOut ? .blocked(.signInRequired, "Sign in to upload.") : .transient("Could not get an access token."))
        }
        let query = FHIRSearch.identifierQuery(system: settings.patientSystem, value: identifier)
        do throws(TransportFailure) {
            let found = try await transport.send(FHIRHTTPRequest(method: "GET", path: "Patient?\(query)&_elements=id"), token: bearer)
            switch found.status {
            case 200:
                let ids = Self.patientIDs(found.body)
                if ids.count == 1 {
                    patientIDs[source] = ids[0]
                    return .success(ids[0])
                }
                if ids.count > 1 {
                    return .failure(.blocked(.configuration("More than one Patient has this identifier."), "More than one Patient has this identifier."))
                }
            case 401:
                return .failure(.blocked(.signInRequired, "The server did not accept the sign-in. Sign in again."))
            case 403:
                return .failure(.blocked(.forbidden("Forbidden"), "The server refused this user."))
            default:
                return .failure(.transient("Patient lookup returned HTTP \(found.status)."))
            }
            
            // Not there yet: conditional create (a concurrent creator or a retry cannot make a second one).
            let patient: [String: Any] = [
                "resourceType": "Patient",
                "identifier": [["system": settings.patientSystem, "value": identifier]]
            ]
            let body = try? JSONSerialization.data(withJSONObject: patient, options: [.sortedKeys])
            let created = try await transport.send(FHIRHTTPRequest(
                method: "POST", path: "Patient",
                headers: ["If-None-Exist": query, "Prefer": "return=representation"], body: body), token: bearer)
            switch created.status {
            case 200, 201:
                if let id = Self.resourceID(created.body) {
                    patientIDs[source] = id
                    return .success(id)
                }
                return .failure(.transient("The server did not return the Patient id."))
            case 403:
                return .failure(.blocked(.forbidden("Forbidden"), "The server refused this user."))
            default:
                return .failure(.transient("Patient create returned HTTP \(created.status)."))
            }
        } catch {
            return .failure(.transient(error.description))
        }
    }
    
    
    // MARK: Response parsing (minimal, tolerant)
    
    private struct Response: Decodable {
        struct Entry: Decodable {
            struct Resource: Decodable { var id: String? }
            struct Result: Decodable { var status: String? }
            var resource: Resource?
            var response: Result?
        }
        var resourceType: String?
        var id: String?
        var entry: [Entry]?
        var issue: [Issue]?
        
        struct Issue: Decodable {
            var diagnostics: String?
            var details: Details?
            struct Details: Decodable { var text: String? }
        }
    }
    
    /// `skipping`: leading response entries that belong to Device entries (the builder puts Devices first), so only
    /// Observations are counted as created.
    private static func tally(_ body: Data, skipping: Int) -> (total: Int, created: Int) {
        guard let parsed = try? JSONDecoder().decode(Response.self, from: body), parsed.resourceType == "Bundle" else {
            return (-1, 0)
        }
        let entries = parsed.entry ?? []
        let created = entries.dropFirst(skipping).filter { $0.response?.status?.hasPrefix("201") == true }.count
        return (entries.count, created)
    }
    
    private static func patientIDs(_ body: Data) -> [String] {
        let parsed = try? JSONDecoder().decode(Response.self, from: body)
        return (parsed?.entry ?? []).compactMap { $0.resource?.id }
    }
    
    private static func resourceID(_ body: Data) -> String? {
        try? JSONDecoder().decode(Response.self, from: body).id
    }
    
    /// The first OperationOutcome message, shortened; never the request body.
    private static func diagnostics(_ body: Data) -> String? {
        guard let parsed = try? JSONDecoder().decode(Response.self, from: body), let issue = parsed.issue?.first else {
            return nil
        }
        let text = issue.diagnostics ?? issue.details?.text
        return text.map { String($0.prefix(200)) }
    }
}
