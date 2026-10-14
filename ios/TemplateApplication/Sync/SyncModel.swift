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
    
    
    /// - Parameters:
    ///   - engine: `nil` when the app is not configured (the screen then says why).
    init(queue: SampleQueue, engine: SyncEngine?, unavailableReason: String? = nil, debounce: TimeInterval = 1, monitorNetwork: Bool = true) {
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
                    await self.refreshCounts()
                    continue
                }
                let result = await engine.drain()
                await self.apply(result)
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
