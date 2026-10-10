//
// This source file is part of the Spezi POC capture app, adapted from the Stanford Spezi Template Application
//
// SPDX-FileCopyrightText: 2023 Stanford University and the project authors (see CONTRIBUTORS.md)
//
// SPDX-License-Identifier: MIT
//

@testable import TemplateApplication
import Foundation
import Testing


/// Time that moves only when the runner pauses: each pause advances it by exactly the requested seconds.
private final class FakeClock: @unchecked Sendable {
    private let lock = NSLock()
    private var current: Date
    
    init(_ start: Date) {
        current = start
    }
    
    var clock: RunnerClock {
        RunnerClock(
            now: { self.lock.withLock { self.current } },
            pause: { seconds in
                self.lock.withLock { self.current = self.current.addingTimeInterval(seconds) }
                await Task.yield()
            }
        )
    }
}

private let origin = Date(timeIntervalSince1970: 1_768_176_000) // 2026-01-12 00:00:00 UTC


@Suite("Synthetic ingest source")
struct IngestSourceTests {
    @Test("the live stream is exactly the pure generator's output for the same virtual window")
    func liveEqualsPure() async {
        var config = SyntheticPreset.everything.applied(to: SyntheticConfig())
        config.metrics = [.heartRate, .hrv]
        let fake = FakeClock(origin)
        let source = SyntheticIngestSource(config: config, virtualStart: origin, speed: 60, tick: 1, clock: fake.clock)
        
        let expected = SyntheticGenerator(config: config).emissions(deliveredIn: origin..<origin.addingTimeInterval(3_600))
        #expect(expected.count > 500)
        
        var got: [IngestedSample] = []
        for await item in source.stream() {
            got.append(item)
            if got.count == expected.count { break }
        }
        #expect(got.map(\.sample) == expected.map(\.sample))
        #expect(got.map(\.injected) == expected.map(\.injected))
    }
    
    @Test("delivery order never goes backwards across ticks")
    func ordered() async {
        let fake = FakeClock(origin)
        let source = SyntheticIngestSource(config: SyntheticPreset.offlineCatchUp.applied(to: SyntheticConfig(metrics: [.heartRate])),
                                           virtualStart: origin, speed: 600, tick: 1, clock: fake.clock)
        var last = Date.distantPast
        var seen = 0
        for await item in source.stream() {
            #expect(item.sample.issued >= last)
            #expect(item.sample.issued >= origin)
            last = item.sample.issued
            seen += 1
            if seen == 2_000 { break }
        }
        #expect(seen == 2_000)
    }
    
    @Test("cancelling the consumer ends the stream")
    func cancellation() async {
        let fake = FakeClock(origin)
        let source = SyntheticIngestSource(config: SyntheticConfig(metrics: [.heartRate]), virtualStart: origin, speed: 60, tick: 1, clock: fake.clock)
        let consumer = Task {
            var n = 0
            for await _ in source.stream() { n += 1 }
            return n
        }
        try? await Task.sleep(for: .milliseconds(100))
        consumer.cancel()
        let n = await consumer.value // returns only if the stream terminated
        #expect(n >= 0)
    }
    
    @Test("it identifies itself as the synthetic source with the synthetic device")
    func identity() {
        let source = SyntheticIngestSource(config: SyntheticConfig())
        #expect(source.kind == .synthetic)
        #expect(source.device == .synthetic)
    }
}


@MainActor
@Suite("Simulator model")
struct SimulatorModelTests {
    private func runUntil(_ model: SimulatorModel, _ condition: () -> Bool) async {
        for _ in 0..<2_000 where !condition() {
            try? await Task.sleep(for: .milliseconds(5))
        }
    }
    
    @Test("running emits samples, counts add up, and the recent list is bounded and newest-first")
    func running() async {
        let fake = FakeClock(origin)
        let model = SimulatorModel(clock: fake.clock, now: { origin })
        model.apply(.everything)
        model.speed = 3_600
        model.startDaysAgo = 0
        model.start()
        #expect(model.isRunning)
        await runUntil(model) { model.counts.total >= 500 }
        model.stop()
        
        let c = model.counts
        #expect(c.total >= 500)
        #expect(c.heartRate + c.restingHeartRate + c.hrv + c.sleepIntervals == c.total)
        #expect(model.recent.count == SimulatorModel.recentLimit)
        #expect(zip(model.recent, model.recent.dropFirst()).allSatisfy { $0.id > $1.id }, "newest first")
        #expect(!model.isRunning)
    }
    
    @Test("the faults the preset asks for show up in the counters")
    func faultsVisible() async {
        let fake = FakeClock(origin)
        let model = SimulatorModel(clock: fake.clock, now: { origin })
        model.apply(.everything)
        model.speed = 3_600
        model.start()
        await runUntil(model) { model.counts.late > 0 && model.counts.duplicates > 0 && model.counts.artifacts > 0 && model.counts.batched > 0 }
        model.stop()
        #expect(model.counts.late > 0)
        #expect(model.counts.duplicates > 0)
        #expect(model.counts.artifacts > 0)
        #expect(model.counts.batched > 0)
    }
    
    @Test("a clean scenario shows no faults")
    func cleanShowsNone() async {
        let fake = FakeClock(origin)
        let model = SimulatorModel(clock: fake.clock, now: { origin })
        model.apply(.cleanDay)
        model.speed = 3_600
        model.start()
        await runUntil(model) { model.counts.total >= 300 }
        model.stop()
        #expect(model.counts.total >= 300)
        #expect(model.counts.late + model.counts.batched + model.counts.duplicates + model.counts.artifacts == 0)
    }
    
    @Test("starting twice does not start a second runner, and stopping is idempotent")
    func startStop() async {
        let fake = FakeClock(origin)
        let model = SimulatorModel(clock: fake.clock, now: { origin })
        model.start()
        model.start()
        model.stop()
        model.stop()
        #expect(!model.isRunning)
    }
    
    @Test("applying a preset replaces the faults but keeps the seed; editing by hand clears the preset label")
    func presets() {
        let model = SimulatorModel()
        model.config.seed = 7
        model.apply(.retryStorm)
        #expect(model.preset == .retryStorm)
        #expect(model.config.duplicateFraction == 0.15 && model.config.seed == 7)
        model.apply(.artifacts)
        #expect(model.config.duplicateFraction == 0 && model.config.artifactFraction == 0.03)
        model.configChanged()
        #expect(model.preset == nil)
    }
    
    @Test("clearing resets the counters and the list")
    func clearing() async {
        let fake = FakeClock(origin)
        let model = SimulatorModel(clock: fake.clock, now: { origin })
        model.speed = 3_600
        model.start()
        await runUntil(model) { model.counts.total >= 50 }
        model.stop()
        model.resetCounters()
        #expect(model.counts == SimulatorModel.Counts())
        #expect(model.recent.isEmpty)
    }
}


@Suite("Simulator visibility")
struct SimulatorVisibilityTests {
    @Test("the simulator is shown for the synthetic source only")
    func visibility() {
        #expect(DataSource.synthetic.showsSimulator)
        #expect(!DataSource.appleHealth.showsSimulator)
        // A stored Apple Health choice is not available yet and falls back to synthetic, so the screen is still reachable.
        #expect(DataSource.effective(.appleHealth).showsSimulator)
    }
}
