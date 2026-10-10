//
// This source file is part of the Spezi POC capture app, adapted from the Stanford Spezi Template Application
//
// SPDX-FileCopyrightText: 2023 Stanford University and the project authors (see CONTRIBUTORS.md)
//
// SPDX-License-Identifier: MIT
//

import Foundation
import Observation


/// State behind the simulator screen: the controls, whether the simulated device is running, and what it has emitted.
///
/// It consumes an ``IngestSource`` stream exactly as the upload queue will (M8), and counts what it sees by metric and
/// by injected anomaly, so the screen can show that the faults it asked for are actually in the stream.
@MainActor
@Observable
final class SimulatorModel {
    struct Counts: Equatable {
        var total = 0
        var heartRate = 0
        var restingHeartRate = 0
        var hrv = 0
        var sleepIntervals = 0
        var late = 0
        var batched = 0
        var artifacts = 0
        var duplicates = 0
    }
    
    struct Recent: Equatable, Identifiable {
        let id: Int
        let metric: String
        let value: String
        let measured: String
        let badges: [String]
    }
    
    static let recentLimit = 30
    
    var config = SyntheticPreset.cleanDay.applied(to: SyntheticConfig())
    var preset: SyntheticPreset? = .cleanDay
    /// Virtual seconds per real second.
    var speed = 60.0
    /// Start the virtual clock this many days in the past (history), or 0 for now.
    var startDaysAgo = 0
    
    private(set) var isRunning = false
    private(set) var counts = Counts()
    private(set) var recent: [Recent] = []
    private(set) var lastDelivery: Date?
    
    @ObservationIgnored private var task: Task<Void, Never>?
    @ObservationIgnored private var sequence = 0
    @ObservationIgnored private let clock: RunnerClock
    @ObservationIgnored private let nowProvider: @Sendable () -> Date
    
    
    init(clock: RunnerClock = .system, now: @escaping @Sendable () -> Date = { .now }) {
        self.clock = clock
        self.nowProvider = now
    }
    
    
    func apply(_ preset: SyntheticPreset) {
        self.preset = preset
        config = preset.applied(to: config)
    }
    
    /// Editing a control by hand means the config is no longer exactly a preset.
    func configChanged() {
        preset = nil
    }
    
    func start() {
        guard !isRunning else {
            return
        }
        isRunning = true
        let origin = nowProvider().addingTimeInterval(-Double(startDaysAgo) * 86_400)
        let source = SyntheticIngestSource(config: config, virtualStart: origin, speed: speed, clock: clock)
        let formatter = Self.formatter(for: config.timeZone)
        task = Task { [weak self] in
            for await ingested in source.stream() {
                guard let self else { return }
                self.record(ingested, formatter: formatter)
            }
        }
    }
    
    func stop() {
        task?.cancel()
        task = nil
        isRunning = false
    }
    
    func resetCounters() {
        counts = Counts()
        recent = []
        lastDelivery = nil
        sequence = 0
    }
    
    
    private func record(_ ingested: IngestedSample, formatter: DateFormatter) {
        let sample = ingested.sample
        counts.total += 1
        let metric: String
        let value: String
        switch sample.measurement {
        case .quantity(let id, let number):
            switch id {
            case .heartRate:
                counts.heartRate += 1
                metric = "Heart rate"
                value = "\(Self.number(number)) /min"
            case .restingHeartRate:
                counts.restingHeartRate += 1
                metric = "Resting heart rate"
                value = "\(Self.number(number)) /min"
            case .hrvSdnn:
                counts.hrv += 1
                metric = "HRV (SDNN)"
                value = "\(Self.number(number)) ms"
            }
        case .sleep(let stage):
            counts.sleepIntervals += 1
            metric = "Sleep: \(stage.rawValue)"
            value = "\(Int((sample.end.timeIntervalSince(sample.start) / 60).rounded())) min"
        }
        if ingested.injected.contains(.late) { counts.late += 1 }
        if ingested.injected.contains(.batched) { counts.batched += 1 }
        if ingested.injected.contains(.artifact) { counts.artifacts += 1 }
        if ingested.injected.contains(.duplicate) { counts.duplicates += 1 }
        lastDelivery = sample.issued
        
        sequence += 1
        recent.insert(Recent(id: sequence, metric: metric, value: value, measured: formatter.string(from: sample.start), badges: ingested.injected.labels), at: 0)
        if recent.count > Self.recentLimit {
            recent.removeLast(recent.count - Self.recentLimit)
        }
    }
    
    private static func number(_ value: Double) -> String {
        value == value.rounded() ? String(Int(value)) : String(format: "%.1f", value)
    }
    
    private static func formatter(for zone: TimeZone) -> DateFormatter {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = zone
        formatter.dateFormat = "yyyy-MM-dd HH:mm:ss ZZZZZ"
        return formatter
    }
}
