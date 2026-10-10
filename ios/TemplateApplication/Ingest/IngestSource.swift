//
// This source file is part of the Spezi POC capture app, adapted from the Stanford Spezi Template Application
//
// SPDX-FileCopyrightText: 2023 Stanford University and the project authors (see CONTRIBUTORS.md)
//
// SPDX-License-Identifier: MIT
//

import Foundation


/// What was deliberately done to a sample, as ground truth. Only the synthetic source can know this: a real source
/// leaves it empty. It exists so the simulator screen and the tests can check that the pipeline *notices* what was
/// injected; nothing in the data path may depend on it.
struct InjectedAnomalies: OptionSet, Sendable, Hashable {
    let rawValue: Int
    
    /// Delivered long after it was measured (`issued` is much later than the sample's own time).
    static let late = InjectedAnomalies(rawValue: 1 << 0)
    /// Held back and delivered together with others at a batch boundary.
    static let batched = InjectedAnomalies(rawValue: 1 << 1)
    /// Its value was replaced with an implausible one.
    static let artifact = InjectedAnomalies(rawValue: 1 << 2)
    /// A second delivery of a sample that was already delivered (same identity, same content).
    static let duplicate = InjectedAnomalies(rawValue: 1 << 3)
    
    var labels: [String] {
        var out: [String] = []
        if contains(.late) { out.append("late") }
        if contains(.batched) { out.append("batched") }
        if contains(.artifact) { out.append("artifact") }
        if contains(.duplicate) { out.append("duplicate") }
        return out
    }
}


/// One sample as it leaves a source, on its way to the local queue (M8).
struct IngestedSample: Equatable, Sendable {
    var sample: MetricSample
    var injected: InjectedAnomalies = []
}


/// The seam between where samples come from and everything downstream (mapping, queue, upload). The synthetic source
/// implements it now; the HealthKit source implements the same protocol in M17, so nothing downstream changes.
protocol IngestSource: Sendable {
    var kind: SampleSource { get }
    /// What to describe as the emitting `Device`.
    var device: DeviceDescriptor { get }
    /// Samples as they become available, until the consuming task is cancelled.
    func stream() -> AsyncStream<IngestedSample>
}
