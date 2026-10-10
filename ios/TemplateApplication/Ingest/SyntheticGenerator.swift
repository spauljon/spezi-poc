//
// This source file is part of the Spezi POC capture app, adapted from the Stanford Spezi Template Application
//
// SPDX-FileCopyrightText: 2023 Stanford University and the project authors (see CONTRIBUTORS.md)
//
// SPDX-License-Identifier: MIT
//

import Foundation


/// A sample as delivered, with the ground truth of what was done to it.
struct Emission: Equatable, Sendable {
    var sample: MetricSample
    var injected: InjectedAnomalies
}


/// The simulated device: a PURE function from (config, seed, time) to samples.
///
/// - Deterministic: every random choice is a keyed hash of (seed, what, which), so the same config and seed always give
///   the same samples, and a window generated in pieces equals the same window generated whole.
/// - Delivery, not measurement, defines the window: ``emissions(deliveredIn:)`` returns what reaches the queue during a
///   window. A late or batched sample keeps its true measurement time and gets a later `issued`.
/// - The waveforms are plausible, not physiological: a circadian heart rate with a night dip and a daily exercise bout,
///   HRV that rises at night and falls with heart rate, one resting value a day, and a night of sleep stages in
///   roughly 90-minute cycles. They exist to give the clinician views realistic shapes to draw.
/// - Identifiers include the seed (`syn-<seed>-...`), so two seeds can never collide on a conditional create.
struct SyntheticGenerator: Sendable {
    let config: SyntheticConfig
    
    private let rng: KeyedRandom
    private let zone: TimeZone
    private let seedTag: String
    
    private enum Kind: UInt64 {
        case heartRate = 0x100
        case hrv = 0x200
        case resting = 0x300
        case sleep = 0x400
        case world = 0x500
    }
    
    private enum Purpose: UInt64 {
        case jitter = 1, noise, artifact, artifactValue, late, lateDelay, duplicate, duplicateDelay
        case gapCount, gapStart, gapLength, exercise, exerciseStart, exerciseLength, exercisePeak
        case sleepStart, sleepLength, cycle
    }
    
    /// A sample before delivery has been decided.
    private struct Base {
        var sample: MetricSample
        var baseDelivery: Date
        var key: Int64
        var kind: Kind
        var injected: InjectedAnomalies
    }
    
    
    init(config: SyntheticConfig) {
        self.config = config.clamped
        self.rng = KeyedRandom(seed: config.seed)
        self.zone = self.config.timeZone
        self.seedTag = String(config.seed, radix: 16)
    }
    
    
    // MARK: - API
    
    /// Everything delivered (`issued`) in `window`, ordered by delivery, then measurement time, then id.
    func emissions(deliveredIn window: Range<Date>) -> [Emission] {
        guard window.lowerBound < window.upperBound else {
            return []
        }
        // A sample measured before the window can be delivered inside it, but never by more than this.
        let maxShift = config.late.maxDelay + 2 * config.batchInterval + 1800 + 600 + 120
        let low = window.lowerBound.addingTimeInterval(-maxShift)
        let high = window.upperBound
        
        var bases: [Base] = []
        if config.metrics.contains(.heartRate) { bases += heartRateSamples(from: low, to: high) }
        if config.metrics.contains(.hrv) { bases += hrvSamples(from: low, to: high) }
        if config.metrics.contains(.restingHeartRate) { bases += restingSamples(from: low, to: high) }
        if config.metrics.contains(.sleep) { bases += sleepSamples(from: low, to: high) }
        
        var out: [Emission] = []
        for base in bases {
            for (deliveredAt, injected) in deliveries(of: base) where window.contains(deliveredAt) {
                var sample = base.sample
                sample.issued = deliveredAt
                out.append(Emission(sample: sample, injected: injected))
            }
        }
        out.sort {
            ($0.sample.issued, $0.sample.start, $0.sample.id) < ($1.sample.issued, $1.sample.start, $1.sample.id)
        }
        return out
    }
    
    /// The time ranges in which the simulated device delivers no heart-rate or HRV samples, for one local day.
    func gaps(forLocalDayStarting dayStart: Date) -> [Range<Date>] {
        guard config.gaps.perDay > 0, config.gaps.meanMinutes > 0 else {
            return []
        }
        let day = dayIndex(of: dayStart)
        let whole = Int(config.gaps.perDay)
        let fraction = config.gaps.perDay - Double(whole)
        let count = whole + (u(.world, .gapCount, day) < fraction ? 1 : 0)
        return (0..<count).map { i in
            let key = day &* 64 &+ Int64(i)
            let start = dayStart.addingTimeInterval(u(.world, .gapStart, key) * 86_400)
            let length = config.gaps.meanMinutes * 60 * (0.5 + u(.world, .gapLength, key))
            return start..<start.addingTimeInterval(length)
        }
    }
    
    
    // MARK: - Delivery
    
    private func deliveries(of base: Base) -> [(Date, InjectedAnomalies)] {
        var injected = base.injected
        var delivered = base.baseDelivery
        let late = config.late
        if late.fraction > 0, u(base.kind, .late, base.key) < late.fraction {
            delivered = delivered.addingTimeInterval(late.minDelay + u(base.kind, .lateDelay, base.key) * (late.maxDelay - late.minDelay))
            injected.insert(.late)
        }
        let aligned = align(delivered)
        if aligned > delivered {
            injected.insert(.batched)
        }
        delivered = aligned
        
        var out = [(delivered, injected)]
        if config.duplicateFraction > 0, u(base.kind, .duplicate, base.key) < config.duplicateFraction {
            let again = align(delivered.addingTimeInterval(30 + u(base.kind, .duplicateDelay, base.key) * 1770))
            out.append((again, injected.union(.duplicate)))
        }
        return out
    }
    
    private func align(_ date: Date) -> Date {
        guard config.batchInterval > 0 else {
            return date
        }
        let slots = (date.timeIntervalSince1970 / config.batchInterval).rounded(.up)
        return Date(timeIntervalSince1970: slots * config.batchInterval)
    }
    
    
    // MARK: - Heart rate (dense)
    
    private func heartRateSamples(from low: Date, to high: Date) -> [Base] {
        let cadence = config.heartRateCadence
        let first = Int64((low.timeIntervalSince1970 / cadence).rounded(.down)) - 1
        let last = Int64((high.timeIntervalSince1970 / cadence).rounded(.up)) + 1
        var out: [Base] = []
        out.reserveCapacity(Int(max(0, last - first)))
        for k in first...last {
            let offset = (u(.heartRate, .jitter, k) - 0.5) * 2 * config.jitter * cadence
            let t = ms(Double(k) * cadence + offset)
            guard t >= low, t < high, !isInGap(t) else {
                continue
            }
            var value = heartRateMean(at: t) + (u(.heartRate, .noise, k) - 0.5) * 5
            var injected: InjectedAnomalies = []
            if config.artifactFraction > 0, u(.heartRate, .artifact, k) < config.artifactFraction {
                value = [25.0, 240.0, 280.0][Int(u(.heartRate, .artifactValue, k) * 3) % 3]
                injected.insert(.artifact)
            }
            out.append(Base(
                sample: sample(.quantity(.heartRate, (min(max(value, 20), 300) * 10).rounded() / 10), t, t, "hr-\(k)"),
                baseDelivery: t, key: k, kind: .heartRate, injected: injected))
        }
        return out
    }
    
    /// The noise-free heart rate at a moment.
    private func heartRateMean(at t: Date) -> Double {
        let h = hourOfDay(t)
        var bpm = 66 + 7 * sin(2 * .pi * (h - 9) / 24)
        if h >= 23 || h < 7 {
            bpm -= 6
        }
        bpm += exerciseBump(at: t, hour: h)
        return min(max(bpm, 35), 200)
    }
    
    /// A daily exercise bout (on about 70% of days): ramps up over 5 minutes, holds, ramps down.
    private func exerciseBump(at t: Date, hour: Double) -> Double {
        let day = dayIndex(of: startOfDay(t))
        guard u(.world, .exercise, day) < 0.7 else {
            return 0
        }
        let start = 17 + 2 * u(.world, .exerciseStart, day)
        let length = 20 + 25 * u(.world, .exerciseLength, day)
        let peak = 40 + 40 * u(.world, .exercisePeak, day)
        let minutes = (hour - start) * 60
        guard minutes >= 0, minutes <= length else {
            return 0
        }
        return peak * max(0, min(1, minutes / 5, (length - minutes) / 5))
    }
    
    
    // MARK: - HRV
    
    private func hrvSamples(from low: Date, to high: Date) -> [Base] {
        let interval = config.hrvInterval
        let first = Int64((low.timeIntervalSince1970 / interval).rounded(.down)) - 1
        let last = Int64((high.timeIntervalSince1970 / interval).rounded(.up)) + 1
        var out: [Base] = []
        for j in first...last {
            let t = ms(Double(j) * interval)
            guard t >= low, t < high, !isInGap(t) else {
                continue
            }
            let h = hourOfDay(t)
            let night = h >= 23 || h < 7
            var value = 45 + (night ? 12 : 0) - 0.3 * (heartRateMean(at: t) - 65) + (u(.hrv, .noise, j) - 0.5) * 12
            var injected: InjectedAnomalies = []
            if config.artifactFraction > 0, u(.hrv, .artifact, j) < config.artifactFraction {
                value = [3.0, 450.0][Int(u(.hrv, .artifactValue, j) * 2) % 2]
                injected.insert(.artifact)
            }
            out.append(Base(
                sample: sample(.quantity(.hrvSdnn, (min(max(value, 1), 600) * 10).rounded() / 10), t, t, "hrv-\(j)"),
                baseDelivery: t, key: j, kind: .hrv, injected: injected))
        }
        return out
    }
    
    
    // MARK: - Resting heart rate (one per local day, a period covering the day)
    
    private func restingSamples(from low: Date, to high: Date) -> [Base] {
        var out: [Base] = []
        var dayStart = startOfDay(low.addingTimeInterval(-86_400))
        while dayStart < high {
            let dayEnd = nextDay(after: dayStart)
            if dayEnd >= low, dayEnd < high {
                let day = dayIndex(of: dayStart)
                var value = 56 + 2 * sin(2 * .pi * Double(day) / 28) + (u(.resting, .noise, day) - 0.5) * 3
                var injected: InjectedAnomalies = []
                if config.artifactFraction > 0, u(.resting, .artifact, day) < config.artifactFraction * 4 {
                    value = [25.0, 230.0][Int(u(.resting, .artifactValue, day) * 2) % 2]
                    injected.insert(.artifact)
                }
                out.append(Base(
                    sample: sample(.quantity(.restingHeartRate, (min(max(value, 20), 300) * 10).rounded() / 10), dayStart, dayEnd, "rest-\(day)"),
                    baseDelivery: dayEnd.addingTimeInterval(60), key: day, kind: .resting, injected: injected))
            }
            dayStart = dayEnd
        }
        return out
    }
    
    
    // MARK: - Sleep (one night per local day, contiguous stage intervals)
    
    private func sleepSamples(from low: Date, to high: Date) -> [Base] {
        var out: [Base] = []
        var dayStart = startOfDay(low.addingTimeInterval(-2 * 86_400))
        while dayStart < high {
            let night = dayIndex(of: dayStart)
            let intervals = sleepNight(forDayStarting: dayStart, night: night)
            if let end = intervals.last?.end, end >= low, end < high {
                let delivered = end.addingTimeInterval(600)
                for (n, interval) in intervals.enumerated() {
                    out.append(Base(
                        sample: sample(.sleep(interval.stage), interval.start, interval.end, "sleep-\(night)-\(n)"),
                        baseDelivery: delivered, key: night &* 100 &+ Int64(n), kind: .sleep, injected: []))
                }
            }
            dayStart = nextDay(after: dayStart)
        }
        return out
    }
    
    private struct StageInterval {
        var stage: SleepStage
        var start: Date
        var end: Date
    }
    
    /// A night that starts around 23:00 local time: an in-bed interval wrapping contiguous asleep/awake stages built
    /// from roughly 90-minute cycles (deep sleep early, REM later, an occasional brief awakening).
    private func sleepNight(forDayStarting dayStart: Date, night: Int64) -> [StageInterval] {
        let bedtime = calendar.date(bySettingHour: 23, minute: 0, second: 0, of: dayStart) ?? dayStart.addingTimeInterval(23 * 3600)
        let start = bedtime.addingTimeInterval((u(.sleep, .sleepStart, night) - 0.5) * 1.5 * 3600)
        let target = (6.5 + 2 * u(.sleep, .sleepLength, night)) * 3600
        let asleepFrom = start.addingTimeInterval(10 * 60)
        
        var stages: [(SleepStage, TimeInterval)] = []
        var elapsed: TimeInterval = 0
        var cycle = 0
        while elapsed < target, cycle < 12 {
            let r = { (i: Int) in self.u(.sleep, .cycle, night &* 100 &+ Int64(cycle * 10 + i)) }
            var parts: [(SleepStage, TimeInterval)] = [
                (.asleepCore, (35 + 10 * r(0)) * 60),
                (.asleepDeep, (cycle < 2 ? 20 + 10 * r(1) : 5 + 5 * r(1)) * 60),
                (.asleepCore, 15 * 60),
                (.asleepREM, (8 + 4 * Double(cycle) + 10 * r(2)) * 60)
            ]
            if r(3) < 0.5 {
                parts.append((.awake, (2 + 4 * r(4)) * 60))
            }
            for part in parts where elapsed < target {
                let length = min(part.1.rounded(), target - elapsed)
                stages.append((part.0, length))
                elapsed += length
            }
            cycle += 1
        }
        
        var intervals: [StageInterval] = []
        var cursor = asleepFrom
        for (stage, length) in stages where length > 0 {
            intervals.append(StageInterval(stage: stage, start: ms(cursor.timeIntervalSince1970), end: ms(cursor.addingTimeInterval(length).timeIntervalSince1970)))
            cursor = cursor.addingTimeInterval(length)
        }
        let end = intervals.last?.end ?? asleepFrom
        let inBed = StageInterval(stage: .inBed, start: ms(start.timeIntervalSince1970), end: ms(end.addingTimeInterval(5 * 60).timeIntervalSince1970))
        return [inBed] + intervals
    }
    
    
    // MARK: - Helpers
    
    private func sample(_ measurement: MetricSample.Measurement, _ start: Date, _ end: Date, _ tag: String) -> MetricSample {
        MetricSample(measurement: measurement, start: start, end: end, issued: end, timeZone: zone, source: .synthetic, id: "syn-\(seedTag)-\(tag)")
    }
    
    private func isInGap(_ t: Date) -> Bool {
        guard config.gaps.perDay > 0, config.gaps.meanMinutes > 0 else {
            return false
        }
        let today = startOfDay(t)
        let yesterday = startOfDay(today.addingTimeInterval(-3600))
        return (gaps(forLocalDayStarting: yesterday) + gaps(forLocalDayStarting: today)).contains { $0.contains(t) }
    }
    
    private func u(_ kind: Kind, _ purpose: Purpose, _ index: Int64) -> Double {
        rng.unit(kind.rawValue | purpose.rawValue, index)
    }
    
    /// Whole-millisecond instants, so identical inputs give identical `Date`s however they were computed.
    private func ms(_ secondsSince1970: Double) -> Date {
        Date(timeIntervalSince1970: (secondsSince1970 * 1000).rounded() / 1000)
    }
    
    private var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = zone
        return calendar
    }
    
    private func startOfDay(_ date: Date) -> Date {
        calendar.startOfDay(for: date)
    }
    
    private func nextDay(after dayStart: Date) -> Date {
        calendar.date(byAdding: .day, value: 1, to: dayStart) ?? dayStart.addingTimeInterval(86_400)
    }
    
    private func hourOfDay(_ date: Date) -> Double {
        let c = calendar.dateComponents([.hour, .minute, .second], from: date)
        return Double(c.hour ?? 0) + Double(c.minute ?? 0) / 60 + Double(c.second ?? 0) / 3600
    }
    
    /// A stable integer for a local calendar date (days since 1970-01-01 of the civil date), independent of DST.
    private func dayIndex(of dayStart: Date) -> Int64 {
        let c = calendar.dateComponents([.year, .month, .day], from: dayStart)
        var y = Int64(c.year ?? 1970)
        let m = Int64(c.month ?? 1)
        let d = Int64(c.day ?? 1)
        y -= m <= 2 ? 1 : 0
        let era = (y >= 0 ? y : y - 399) / 400
        let yoe = y - era * 400
        let doy = (153 * (m + (m > 2 ? -3 : 9)) + 2) / 5 + d - 1
        let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy
        return era * 146_097 + doe - 719_468
    }
}
