//
// This source file is part of the Spezi POC capture app, adapted from the Stanford Spezi Template Application
//
// SPDX-FileCopyrightText: 2023 Stanford University and the project authors (see CONTRIBUTORS.md)
//
// SPDX-License-Identifier: MIT
//

import Foundation


/// The clock the live runner uses, injectable so tests drive time instead of waiting for it.
struct RunnerClock: Sendable {
    var now: @Sendable () -> Date
    var pause: @Sendable (TimeInterval) async throws -> Void
    
    static let system = RunnerClock(
        now: { Date() },
        pause: { seconds in try await Task.sleep(for: .seconds(seconds)) }
    )
}


/// The simulated device as an ``IngestSource``: the pure generator, driven live.
///
/// Virtual time advances `speed` times faster than the wall clock, starting at `virtualStart` (default: now). At speed
/// 1 it behaves like a real device; at speed 3600 an hour of data arrives each second, which is how the later
/// clinician views get weeks of history without waiting for it.
struct SyntheticIngestSource: IngestSource {
    var config: SyntheticConfig
    var virtualStart: Date?
    var speed = 1.0
    /// How often (wall-clock seconds) the runner asks the generator for what became deliverable.
    var tick: TimeInterval = 0.5
    var clock = RunnerClock.system
    
    var kind: SampleSource { .synthetic }
    var device: DeviceDescriptor { .synthetic }
    
    
    func stream() -> AsyncStream<IngestedSample> {
        let generator = SyntheticGenerator(config: config)
        let speed = max(speed, 0)
        let tick = max(tick, 0.01)
        let clock = clock
        let realStart = clock.now()
        let virtualOrigin = virtualStart ?? realStart
        
        return AsyncStream { continuation in
            let task = Task {
                var cursor = virtualOrigin
                while !Task.isCancelled {
                    do {
                        try await clock.pause(tick)
                    } catch {
                        break
                    }
                    let virtualNow = virtualOrigin.addingTimeInterval(clock.now().timeIntervalSince(realStart) * speed)
                    guard virtualNow > cursor else {
                        continue
                    }
                    for emission in generator.emissions(deliveredIn: cursor..<virtualNow) {
                        continuation.yield(IngestedSample(sample: emission.sample, injected: emission.injected))
                    }
                    cursor = virtualNow
                }
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }
}
