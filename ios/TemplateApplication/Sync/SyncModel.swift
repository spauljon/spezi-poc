//
// This source file is part of the Spezi POC capture app, adapted from the Stanford Spezi Template Application
//
// SPDX-FileCopyrightText: 2023 Stanford University and the project authors (see CONTRIBUTORS.md)
//
// SPDX-License-Identifier: MIT
//

import Foundation
import Network
import Observation
import UIKit


/// What the sync screen shows, and the one place that decides *when* to drain: after new samples arrive (debounced), when
/// connectivity returns, when a retry comes due, and on "Sync now".
@MainActor
@Observable
final class SyncModel {
    private(set) var status = SyncStatus()
    private(set) var isOnline = true
    private(set) var rejections: [(key: String, reason: String)] = []
    /// Samples refused as already queued (a duplicate delivery, caught before it reached the server).
    private(set) var duplicatesDropped = 0
    /// Apple Health samples that were deleted there and have not been applied to the server (see `SampleQueue`).
    private(set) var deletionsNotApplied = 0
    /// The most recent time the app tried to upload, and how it went: kept across launches, so a background wake-up that
    /// ended in a failure (or never got as far as an attempt) is still readable the next time the app is opened.
    private(set) var lastAttempt: UploadAttempt?
    /// While paused nothing is uploaded; the queue keeps filling. Also how the simulator emulates "offline" on demand.
    var isPaused = false {
        didSet { if !isPaused { kick() } }
    }
    
    @ObservationIgnored private let queue: SampleQueue
    @ObservationIgnored private let engine: SyncEngine?
    @ObservationIgnored private let unavailableReason: String?
    @ObservationIgnored private let debounce: TimeInterval
    @ObservationIgnored private var wake: AsyncStream<Void>.Continuation?
    @ObservationIgnored private var loop: Task<Void, Never>?
    @ObservationIgnored private var timer: Task<Void, Never>?
    @ObservationIgnored private var monitor: NWPathMonitor?
    @ObservationIgnored private var backgroundTask = UIBackgroundTaskIdentifier.invalid
    @ObservationIgnored private let defaults: UserDefaults
    
    
    /// - Parameters:
    ///   - engine: `nil` when the app is not configured (the screen then says why).
    init(queue: SampleQueue, engine: SyncEngine?, unavailableReason: String? = nil, debounce: TimeInterval = 1, monitorNetwork: Bool = true, defaults: UserDefaults = .standard) {
        self.defaults = defaults
        self.lastAttempt = UploadAttempt.load(from: defaults)
        self.queue = queue
        self.engine = engine
        self.unavailableReason = unavailableReason
        self.debounce = debounce
        if let engine {
            start(engine, monitorNetwork: monitorNetwork)
        } else if let unavailableReason {
            status.lastError = unavailableReason
        }
    }
    
    deinit {
        loop?.cancel()
        timer?.cancel()
        monitor?.cancel()
    }
    
    
    /// Called for every sample the source emits.
    func enqueue(_ ingested: IngestedSample, device: DeviceDescriptor) {
        enqueue([ingested], device: device)
    }
    
    func enqueue(_ ingested: [IngestedSample], device: DeviceDescriptor) {
        Task {
            if let result = try? await queue.enqueue(ingested.map { QueuedItem(sample: $0.sample, device: device) }) {
                duplicatesDropped += result.known
            }
            await refreshCounts()
            kick()
        }
    }
    
    /// Stores the batch and returns only when it is committed to the queue (`false` if it could not be). Used where the
    /// caller must not let a source's bookmark advance until the samples are safe (HealthKit).
    func enqueueDurably(_ ingested: [IngestedSample], fallbackDevice: DeviceDescriptor) async -> Bool {
        guard !ingested.isEmpty else { return true }
        // iOS may suspend the app moments after HealthKit's completion handler: keep it running until the upload that
        // follows has finished (ended in the loop below, or by expiry).
        beginBackgroundWork()
        do {
            let result = try await queue.enqueue(ingested.map { QueuedItem(sample: $0.sample, device: $0.device ?? fallbackDevice) })
            duplicatesDropped += result.known
        } catch {
            endBackgroundWork()
            return false
        }
        Task {
            await refreshCounts()
            kick()
        }
        return true
    }
    
    /// "Sync now": retry everything immediately, including items waiting out a backoff.
    func syncNow() {
        Task {
            try? await queue.makeAllDue()
            kick()
        }
    }
    
    func kick() {
        wake?.yield()
    }
    
    func recordDeletions(_ uuids: [String]) async {
        _ = try? await queue.recordDeletions(uuids)
        deletionsNotApplied = (try? await queue.deletionCount()) ?? deletionsNotApplied
    }
    
    func refreshCounts() async {
        deletionsNotApplied = (try? await queue.deletionCount()) ?? 0
        if let engine {
            let latest = await engine.refresh()
            status.counts = latest.counts
        } else if let counts = try? await queue.counts() {
            status.counts = counts
        }
        rejections = (try? await queue.rejections(limit: 5)) ?? []
    }
    
    
    private func start(_ engine: SyncEngine, monitorNetwork: Bool) {
        let (stream, continuation) = AsyncStream<Void>.makeStream(bufferingPolicy: .bufferingNewest(1))
        wake = continuation
        loop = Task { [weak self] in
            for await _ in stream {
                guard let self else { return }
                if self.debounce > 0 {
                    try? await Task.sleep(for: .seconds(self.debounce))
                }
                if self.isPaused || !self.isOnline {
                    self.record(outcome: self.isPaused ? "not attempted: paused" : "not attempted: offline", sent: 0)
                    await self.refreshCounts()
                    self.endBackgroundWork()
                    continue
                }
                let before = self.status.counts.sent
                let result = await engine.drain()
                await self.apply(result)
                self.record(outcome: result.lastError ?? "ok", sent: max(result.counts.sent - before, 0))
                self.endBackgroundWork()
            }
        }
        if monitorNetwork {
            let monitor = NWPathMonitor()
            monitor.pathUpdateHandler = { [weak self] path in
                let online = path.status == .satisfied
                Task { @MainActor in
                    guard let self else { return }
                    let was = self.isOnline
                    self.isOnline = online
                    if online && !was {
                        try? await self.queue.makeAllDue()
                        self.kick()
                    }
                }
            }
            monitor.start(queue: DispatchQueue(label: "sync.path"))
            self.monitor = monitor
        }
        kick() // deliver whatever a previous run left behind
    }
    
    private func beginBackgroundWork() {
        guard backgroundTask == .invalid else { return }
        backgroundTask = UIApplication.shared.beginBackgroundTask(withName: "poc-upload") { [weak self] in
            // Out of time: the queue is durable, the next attempt resumes from it.
            Task { @MainActor in
                self?.record(outcome: "background time ran out", sent: 0)
                self?.endBackgroundWork()
            }
        }
    }
    
    private func endBackgroundWork() {
        guard backgroundTask != .invalid else { return }
        UIApplication.shared.endBackgroundTask(backgroundTask)
        backgroundTask = .invalid
    }
    
    private func record(outcome: String, sent: Int) {
        let attempt = UploadAttempt(at: .now, outcome: outcome, sent: sent, inBackground: UIApplication.shared.applicationState != .active)
        lastAttempt = attempt
        attempt.save(to: defaults)
    }
    
    private func apply(_ result: SyncStatus) async {
        status = result
        rejections = (try? await queue.rejections(limit: 5)) ?? []
        timer?.cancel()
        if case .waiting(let until) = result.phase {
            let wait = max(until.timeIntervalSinceNow, 1)
            timer = Task { [weak self] in
                try? await Task.sleep(for: .seconds(wait))
                if !Task.isCancelled { self?.kick() }
            }
        }
    }
}


/// One upload attempt: when, what came of it, and whether the app was in the background. No sample value is in here.
struct UploadAttempt: Codable, Equatable, Sendable {
    var at: Date
    var outcome: String
    var sent: Int
    var inBackground: Bool
    
    private static let key = "sync.lastAttempt"
    
    static func load(from defaults: UserDefaults) -> UploadAttempt? {
        defaults.data(forKey: key).flatMap { try? JSONDecoder().decode(UploadAttempt.self, from: $0) }
    }
    
    func save(to defaults: UserDefaults) {
        if let data = try? JSONEncoder().encode(self) {
            defaults.set(data, forKey: Self.key)
        }
    }
}
