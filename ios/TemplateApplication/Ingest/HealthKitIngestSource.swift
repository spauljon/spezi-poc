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


/// Between the HealthKit module's callbacks and the ingest source: maps records, and decides whether to let them
/// through. Samples that arrive while Apple Health is not the selected, allowed source are DROPPED (and counted), not
/// queued: the app never holds real data it is not allowed to send.
actor HealthKitBridge {
    static let shared = HealthKitBridge()
    
    struct Counters: Equatable, Sendable {
        /// Records handed to the pipeline.
        var accepted = 0
        /// Records that arrived while Apple Health was not enabled (dropped).
        var droppedWhileOff = 0
        /// Records of a type or shape the mapper does not read.
        var ignored = 0
        /// Deletions HealthKit reported (recorded locally; the server is not changed: see `SampleQueue`).
        var deletionsSeen = 0
        var lastReceivedAt: Date?
    }
    
    private var mapper: HealthKitMapper?
    private var emit: (@Sendable (IngestedSample) -> Void)?
    private var record: (@Sendable ([String]) async -> Void)?
    private var enabled = false
    private(set) var counters = Counters()
    
    
    func configure(
        mapper: HealthKitMapper?,
        emit: @escaping @Sendable (IngestedSample) -> Void,
        recordDeletions: @escaping @Sendable ([String]) async -> Void
    ) {
        self.mapper = mapper
        self.emit = emit
        self.record = recordDeletions
    }
    
    func setEnabled(_ on: Bool) {
        enabled = on
    }
    
    var isEnabled: Bool { enabled }
    
    func receive(_ records: [HealthKitRecord], now: Date = .now, fallbackTimeZone: TimeZone = .current) {
        guard enabled, let mapper, let emit else {
            counters.droppedWhileOff += records.count
            return
        }
        for record in records {
            guard let mapped = mapper.map(record, issued: now, fallbackTimeZone: fallbackTimeZone) else {
                counters.ignored += 1
                continue
            }
            counters.accepted += 1
            emit(IngestedSample(sample: mapped.sample, injected: [], device: mapped.device))
        }
        counters.lastReceivedAt = now
    }
    
    func receiveDeleted(_ uuids: [String]) async {
        guard enabled, !uuids.isEmpty else { return }
        counters.deletionsSeen += uuids.count
        await record?(uuids.map { $0.lowercased() })
    }
}
