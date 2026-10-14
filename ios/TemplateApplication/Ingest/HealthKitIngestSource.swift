//
// This source file is part of the Spezi POC capture app, adapted from the Stanford Spezi Template Application
//
// SPDX-FileCopyrightText: 2023 Stanford University and the project authors (see CONTRIBUTORS.md)
//
// SPDX-License-Identifier: MIT
//

import Foundation


/// The HealthKit side of the ingest seam: the same `IngestSource` protocol the synthetic source implements, so mapping,
/// queue and upload are shared. HealthKit pushes batches at us (through the module's `Standard` constraint); this
/// object turns that into the pull `AsyncStream` the rest of the app consumes.
final class HealthKitIngestSource: IngestSource, @unchecked Sendable {
    private let stream_: AsyncStream<IngestedSample>
    private let continuation: AsyncStream<IngestedSample>.Continuation
    
    init() {
        (stream_, continuation) = AsyncStream<IngestedSample>.makeStream(bufferingPolicy: .unbounded)
    }
    
    var kind: SampleSource { .healthKit }
    
    /// Only used for a sample that carries no device of its own (every real sample does, see `HealthKitMapper`).
    var device: DeviceDescriptor {
        .healthKit(name: "Apple Health", manufacturer: nil, model: nil, hardwareVersion: nil, softwareVersion: nil)
    }
    
    /// A single consumer: the app's wiring from this source into the upload queue.
    func stream() -> AsyncStream<IngestedSample> {
        stream_
    }
    
    func emit(_ sample: IngestedSample) {
        continuation.yield(sample)
    }
}


/// Between the HealthKit module's callbacks and the upload queue: maps records, and decides whether to let them through.
///
/// **Delivery is acknowledged.** SpeziHealthKit saves its query anchor as soon as `handleNewSamples` returns, so a
/// sample must be in the durable queue before `receive` returns, or a kill (or a failed write) between the two loses it
/// for good. `deliver` therefore returns whether the batch is stored; a batch that could not be stored is kept in
/// memory and offered again with the next arrival (and by `flush()`), and is counted as `unsaved` until it is.
///
/// Samples that arrive while Apple Health is not accepted at all (never chosen, or no longer allowed) are DROPPED and
/// counted: the app never holds real data it was not asked to collect.
actor HealthKitBridge {
    static let shared = HealthKitBridge()
    
    struct Counters: Equatable, Sendable {
        /// Records stored in the queue since the app started.
        var accepted = 0
        /// Records stored in the queue, ever (kept across launches: a count, never a value).
        var lifetimeAccepted = 0
        /// Records that arrived while Apple Health was not accepted (dropped).
        var droppedWhileOff = 0
        /// Records of a type or shape the mapper does not read.
        var ignored = 0
        /// Deletions HealthKit reported (recorded locally; the server is not changed: see `SampleQueue`).
        var deletionsSeen = 0
        /// Mapped records that could not be stored yet and are being retried (lost if the app is killed first).
        var unsaved = 0
        var lastReceivedAt: Date?
    }
    
    private var mapper: HealthKitMapper?
    private var deliver: (@Sendable ([IngestedSample]) async -> Bool)?
    private var record: (@Sendable ([String]) async -> Void)?
    private var enabled = false
    private var configured = false
    /// Records that arrived before the app finished wiring this bridge (a background launch is quick): they are
    /// processed when `configure` runs, not dropped, because the library has already moved its anchor past them.
    private var waiting: [HealthKitRecord] = []
    private var unflushed: [IngestedSample] = []
    private(set) var counters = Counters()
    private let defaults: UserDefaults
    private static let lifetimeKey = "healthKit.lifetimeAccepted"
    private static let lastKey = "healthKit.lastReceivedAt"
    
    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        counters.lifetimeAccepted = defaults.integer(forKey: Self.lifetimeKey)
        if let last = defaults.object(forKey: Self.lastKey) as? Double {
            counters.lastReceivedAt = Date(timeIntervalSince1970: last)
        }
    }
    
    
    func configure(
        mapper: HealthKitMapper?,
        deliver: @escaping @Sendable ([IngestedSample]) async -> Bool,
        recordDeletions: @escaping @Sendable ([String]) async -> Void
    ) async {
        self.mapper = mapper
        self.deliver = deliver
        self.record = recordDeletions
        configured = true
        if !waiting.isEmpty {
            let early = waiting
            waiting = []
            await receive(early)
        }
    }
    
    func setEnabled(_ on: Bool) {
        enabled = on
    }
    
    var isEnabled: Bool { enabled }
    
    func receive(_ records: [HealthKitRecord], now: Date = .now, fallbackTimeZone: TimeZone = .current) async {
        guard enabled else {
            counters.droppedWhileOff += records.count
            return
        }
        guard configured else {
            waiting += records
            return
        }
        guard let mapper else {
            counters.ignored += records.count
            return
        }
        var mapped: [IngestedSample] = []
        for record in records {
            guard let result = mapper.map(record, issued: now, fallbackTimeZone: fallbackTimeZone) else {
                counters.ignored += 1
                continue
            }
            mapped.append(IngestedSample(sample: result.sample, injected: [], device: result.device))
        }
        counters.lastReceivedAt = now
        defaults.set(now.timeIntervalSince1970, forKey: Self.lastKey)
        await store(mapped)
    }
    
    /// Offer anything that could not be stored earlier again (cheap when there is nothing).
    func flush() async {
        guard enabled, !unflushed.isEmpty else { return }
        await store([])
    }
    
    private func store(_ fresh: [IngestedSample]) async {
        guard let deliver else { return }
        let batch = unflushed + fresh
        unflushed = []
        guard !batch.isEmpty else { return }
        if await deliver(batch) {
            counters.accepted += batch.count
            counters.lifetimeAccepted += batch.count
            defaults.set(counters.lifetimeAccepted, forKey: Self.lifetimeKey)
        } else {
            unflushed = batch + unflushed
        }
        counters.unsaved = unflushed.count
    }
    
    func receiveDeleted(_ uuids: [String]) async {
        guard enabled, !uuids.isEmpty else { return }
        counters.deletionsSeen += uuids.count
        await record?(uuids.map { $0.lowercased() })
    }
}
