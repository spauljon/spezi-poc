//
// This source file is part of the Spezi POC capture app, adapted from the Stanford Spezi Template Application
//
// SPDX-FileCopyrightText: 2023 Stanford University and the project authors (see CONTRIBUTORS.md)
//
// SPDX-License-Identifier: MIT
//

import Foundation


enum SyntheticMetric: String, CaseIterable, Hashable, Sendable {
    case heartRate
    case restingHeartRate
    case hrv
    case sleep
}


/// Everything that shapes the simulated device's output. A pure value: the same config and seed always produce the same
/// samples, so tests and demos are reproducible.
struct SyntheticConfig: Equatable, Sendable {
    struct Gaps: Equatable, Sendable {
        /// Expected number of gaps per local day.
        var perDay = 0.0
        var meanMinutes = 0.0
    }
    
    struct LateDelivery: Equatable, Sendable {
        /// Fraction of samples held back before delivery.
        var fraction = 0.0
        var minDelay: TimeInterval = 0
        var maxDelay: TimeInterval = 0
    }
    
    var seed: UInt64 = 42
    var timeZoneIdentifier = "America/Los_Angeles"
    /// Seconds between heart-rate samples (the dense stream).
    var heartRateCadence: TimeInterval = 5
    /// Timing noise as a fraction of the cadence, 0...0.45 (so samples never swap order).
    var jitter = 0.0
    var gaps = Gaps()
    var late = LateDelivery()
    /// Delivery is held to the next multiple of this many seconds (a phone syncing every N minutes). 0 = immediately.
    var batchInterval: TimeInterval = 0
    var duplicateFraction = 0.0
    var artifactFraction = 0.0
    /// Seconds between HRV samples.
    var hrvInterval: TimeInterval = 1800
    var metrics = Set(SyntheticMetric.allCases)
    
    
    init(seed: UInt64 = 42, heartRateCadence: TimeInterval = 5, metrics: Set<SyntheticMetric> = Set(SyntheticMetric.allCases)) {
        self.seed = seed
        self.heartRateCadence = heartRateCadence
        self.metrics = metrics
    }
    
    var timeZone: TimeZone {
        TimeZone(identifier: timeZoneIdentifier) ?? .gmt
    }
    
    /// The same config with every value forced into the range the generator's guarantees assume.
    var clamped: SyntheticConfig {
        var c = self
        c.heartRateCadence = min(max(heartRateCadence, 1), 3600)
        c.jitter = min(max(jitter, 0), 0.45)
        c.gaps.perDay = min(max(gaps.perDay, 0), 48)
        c.gaps.meanMinutes = min(max(gaps.meanMinutes, 0), 720)
        c.late.fraction = min(max(late.fraction, 0), 1)
        c.late.minDelay = min(max(late.minDelay, 0), 7 * 86400)
        c.late.maxDelay = min(max(late.maxDelay, c.late.minDelay), 7 * 86400)
        c.batchInterval = min(max(batchInterval, 0), 86400)
        c.duplicateFraction = min(max(duplicateFraction, 0), 1)
        c.artifactFraction = min(max(artifactFraction, 0), 1)
        c.hrvInterval = min(max(hrvInterval, 60), 86400)
        return c
    }
}


/// Named bundles of controls. Each is chosen to exercise one thing the downstream pipeline must handle.
enum SyntheticPreset: String, CaseIterable, Identifiable, Sendable {
    case cleanDay
    case flakyWatch
    case offlineCatchUp
    case retryStorm
    case artifacts
    case everything
    case dense
    
    var id: String { rawValue }
    
    var title: String {
        switch self {
        case .cleanDay: "Clean day"
        case .flakyWatch: "Flaky watch"
        case .offlineCatchUp: "Offline catch-up"
        case .retryStorm: "Retry storm"
        case .artifacts: "Artifacts"
        case .everything: "Everything at once"
        case .dense: "Dense stream"
        }
    }
    
    var summary: String {
        switch self {
        case .cleanDay: "Regular samples, no faults. The baseline."
        case .flakyWatch: "Timing jitter and several gaps a day, as if the watch kept coming off or losing contact."
        case .offlineCatchUp: "A fifth of the samples arrive hours late, in sync bursts, as after a day offline."
        case .retryStorm: "Many samples are delivered twice: tests that resends change nothing."
        case .artifacts: "A few percent of values are implausible spikes: tests that they are flagged, not dropped."
        case .everything: "Jitter, gaps, late and batched delivery, duplicates and artifacts together."
        case .dense: "One heart-rate sample per second: volume and paging."
        }
    }
    
    /// This preset applied on top of a config (the seed, zone and enabled metrics are kept).
    func applied(to base: SyntheticConfig) -> SyntheticConfig {
        var c = base
        c.heartRateCadence = 5
        c.jitter = 0
        c.gaps = .init()
        c.late = .init()
        c.batchInterval = 0
        c.duplicateFraction = 0
        c.artifactFraction = 0
        switch self {
        case .cleanDay:
            break
        case .flakyWatch:
            c.jitter = 0.3
            c.gaps = .init(perDay: 4, meanMinutes: 20)
        case .offlineCatchUp:
            c.late = .init(fraction: 0.2, minDelay: 3600, maxDelay: 6 * 3600)
            c.batchInterval = 1800
        case .retryStorm:
            c.duplicateFraction = 0.15
        case .artifacts:
            c.artifactFraction = 0.03
        case .everything:
            c.jitter = 0.3
            c.gaps = .init(perDay: 4, meanMinutes: 20)
            c.late = .init(fraction: 0.2, minDelay: 3600, maxDelay: 6 * 3600)
            c.batchInterval = 900
            c.duplicateFraction = 0.1
            c.artifactFraction = 0.03
        case .dense:
            c.heartRateCadence = 1
        }
        return c
    }
}
