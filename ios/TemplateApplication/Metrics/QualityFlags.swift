//
// This source file is part of the Spezi POC capture app, adapted from the Stanford Spezi Template Application
//
// SPDX-FileCopyrightText: 2023 Stanford University and the project authors (see CONTRIBUTORS.md)
//
// SPDX-License-Identifier: MIT
//

import Foundation


/// Decides which data-quality flags a sample carries when it enters the app (contract rules `artifactSuspected` and
/// `lateArrival`). Pure: the ranges and the threshold come from the contract, never from this file.
///
/// A flag is a suspicion that travels WITH the value. Nothing here drops or changes a value, and nothing infers a flag
/// the contract does not define: the clinician views only ever display flags that were stored.
struct QualityFlagger: Sendable {
    private let ranges: [MetricID: MetricRegistry.PlausibleRange]
    private let lateAfter: TimeInterval
    
    init(registry: MetricRegistry) {
        var ranges: [MetricID: MetricRegistry.PlausibleRange] = [:]
        for id in MetricID.allCases {
            if let range = registry.metric(id)?.plausibleRange {
                ranges[id] = range
            }
        }
        self.ranges = ranges
        self.lateAfter = registry.qualityThresholds.lateArrivalHours * 3600
    }
    
    /// Strictly outside the range (a value on a bound is plausible); sleep has no range.
    func isArtifact(_ sample: MetricSample) -> Bool {
        guard case .quantity(let id, let value) = sample.measurement, let range = ranges[id] else {
            return false
        }
        return value < range.lower || value > range.upper
    }
    
    /// Issued strictly more than the threshold after the sample ended.
    func isLate(_ sample: MetricSample) -> Bool {
        sample.issued.timeIntervalSince(sample.end) > lateAfter
    }
    
    /// The sample with its flags set. An existing flag is never cleared (a source may already have set one).
    func applied(to sample: MetricSample) -> MetricSample {
        var flagged = sample
        if isArtifact(sample) { flagged.artifactSuspected = true }
        if isLate(sample) { flagged.lateArrival = true }
        return flagged
    }
}
