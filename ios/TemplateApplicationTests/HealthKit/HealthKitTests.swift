//
// This source file is part of the Spezi POC capture app, adapted from the Stanford Spezi Template Application
//
// SPDX-FileCopyrightText: 2023 Stanford University and the project authors (see CONTRIBUTORS.md)
//
// SPDX-License-Identifier: MIT
//

import Foundation
import HealthKit
import Testing
@testable import TemplateApplication


// Everything here uses SYNTHETIC values built in memory. No test reads the device's HealthKit store, and no value
// below is anyone's measurement.

private let t0 = Date(timeIntervalSince1970: 1_800_000_000)
private let patientSystem = "http://blueysoft.com/fhir/identifier/poc-patient"

private func registry() throws -> MetricRegistry {
    try MetricRegistry.load(bundle: .main)
}

private func quantity(
    _ identifier: HKQuantityTypeIdentifier, _ value: Double, unit: HKUnit, at offset: TimeInterval = 0,
    device: HKDevice? = nil, metadata: [String: Any]? = nil
) -> HKQuantitySample {
    let time = t0.addingTimeInterval(offset)
    return HKQuantitySample(
        type: HKQuantityType(identifier), quantity: HKQuantity(unit: unit, doubleValue: value), start: time, end: time,
        device: device, metadata: metadata)
}

private let perMinute = HKUnit.count().unitDivided(by: .minute())

private func sleepSample(_ value: HKCategoryValueSleepAnalysis, metadata: [String: Any]? = nil) -> HKCategorySample {
    HKCategorySample(
        type: HKCategoryType(.sleepAnalysis), value: value.rawValue, start: t0, end: t0.addingTimeInterval(1800), metadata: metadata)
}

private let watch = HKDevice(
    name: "Apple Watch", manufacturer: "Apple Inc.", model: "Watch7,1", hardwareVersion: "Watch7,1", firmwareVersion: nil,
    softwareVersion: "11.2", localIdentifier: nil, udiDeviceIdentifier: nil)


// MARK: - HKSample to record

@Suite("HealthKit record")
struct HealthKitRecordTests {
    @Test("heart rate is read in beats per minute, with its identity and times")
    func heartRate() throws {
        let sample = quantity(.heartRate, 72, unit: perMinute)
        let record = try #require(HealthKitRecord(sample: sample))
        #expect(record.typeIdentifier == HKQuantityTypeIdentifier.heartRate.rawValue)
        #expect(record.value == 72)
        #expect(record.categoryValue == nil)
        #expect(record.uuid == sample.uuid.uuidString)
        #expect(record.start == t0 && record.end == t0)
    }
    
    @Test("HRV is converted to milliseconds whatever unit it was stored in")
    func hrvUnits() throws {
        let inSeconds = quantity(.heartRateVariabilitySDNN, 0.048, unit: .second())
        let inMillis = quantity(.heartRateVariabilitySDNN, 48, unit: .secondUnit(with: .milli))
        #expect(try #require(HealthKitRecord(sample: inSeconds)).value == 48)
        #expect(try #require(HealthKitRecord(sample: inMillis)).value == 48)
    }
    
    @Test("resting heart rate is read like heart rate")
    func restingHeartRate() throws {
        let record = try #require(HealthKitRecord(sample: quantity(.restingHeartRate, 58, unit: perMinute)))
        #expect(record.value == 58)
        #expect(record.typeIdentifier == HKQuantityTypeIdentifier.restingHeartRate.rawValue)
    }
    
    @Test("a sleep stage keeps its raw value and times")
    func sleep() throws {
        let record = try #require(HealthKitRecord(sample: sleepSample(.asleepCore)))
        #expect(record.categoryValue == HKCategoryValueSleepAnalysis.asleepCore.rawValue)
        #expect(record.value == nil)
        #expect(record.end.timeIntervalSince(record.start) == 1800)
    }
    
    @Test("a type the contract does not list is not read at all")
    func unsupportedType() {
        #expect(HealthKitRecord(sample: quantity(.stepCount, 100, unit: .count())) == nil)
        // control: the same call on a listed type does read it
        #expect(HealthKitRecord(sample: quantity(.heartRate, 70, unit: perMinute)) != nil)
    }
    
    @Test("the time zone and the 'entered by hand' marker come from the sample's metadata, and default to none")
    func metadata() throws {
        let plain = try #require(HealthKitRecord(sample: quantity(.heartRate, 70, unit: perMinute)))
        #expect(plain.timeZoneIdentifier == nil)
        #expect(plain.userEntered == false)
        
        let rich = try #require(HealthKitRecord(sample: quantity(
            .heartRate, 70, unit: perMinute,
            metadata: [HKMetadataKeyTimeZone: "America/Los_Angeles", HKMetadataKeyWasUserEntered: true])))
        #expect(rich.timeZoneIdentifier == "America/Los_Angeles")
        #expect(rich.userEntered == true)
        
        // an explicit `false` is not user-entered either
        let no = try #require(HealthKitRecord(sample: quantity(.heartRate, 70, unit: perMinute, metadata: [HKMetadataKeyWasUserEntered: false])))
        #expect(no.userEntered == false)
    }
    
    @Test("device fields are kept as given; a sample without a device has none and names its source")
    func device() throws {
        let withDevice = try #require(HealthKitRecord(sample: quantity(.heartRate, 70, unit: perMinute, device: watch)))
        #expect(withDevice.device == HealthKitDevice(name: "Apple Watch", manufacturer: "Apple Inc.", model: "Watch7,1", hardwareVersion: "Watch7,1", softwareVersion: "11.2"))
        
        let sample = quantity(.heartRate, 70, unit: perMinute)
        let without = try #require(HealthKitRecord(sample: sample))
        #expect(without.device == nil)
        #expect(without.sourceName == sample.sourceRevision.source.name)
    }
    
    @Test("every metric's unit in the contract is the unit this code converts to")
    func unitsAgreeWithContract() throws {
        let registry = try registry()
        for id in MetricID.allCases {
            let metric = try #require(registry.metric(id))
            let identifier = try #require(metric.healthKit)
            let unit = try #require(HealthKitRecord.unit(forQuantityIdentifier: identifier), "\(id.rawValue)")
            switch metric.unit.ucum {
            case "/min": #expect(unit == perMinute, "\(id.rawValue)")
            case "ms": #expect(unit == HKUnit.secondUnit(with: .milli), "\(id.rawValue)")
            case "kcal": #expect(unit == HKUnit.kilocalorie(), "\(id.rawValue)")
            case "g": #expect(unit == HKUnit.gram(), "\(id.rawValue)")
            case "mg": #expect(unit == HKUnit.gramUnit(with: .milli), "\(id.rawValue)")
            case "mL": #expect(unit == HKUnit.literUnit(with: .milli), "\(id.rawValue)")
            default: Issue.record("\(id.rawValue) has the unit \(metric.unit.ucum), which this adapter does not know")
            }
        }
    }
}


// MARK: - record to MetricSample

@Suite("HealthKit mapper")
struct HealthKitMapperTests {
    private let issued = t0.addingTimeInterval(60)
    private let la = TimeZone(identifier: "America/Los_Angeles") ?? .gmt
    private let utc = TimeZone(identifier: "UTC") ?? .gmt
    
    private func mapper() throws -> HealthKitMapper {
        HealthKitMapper(registry: try registry())
    }
    
    private func record(_ sample: HKSample) throws -> HealthKitRecord {
        try #require(HealthKitRecord(sample: sample))
    }
    
    @Test("it reads exactly the types the contract lists (read from the contract file, not from the registry)")
    func identifiers() throws {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent().appending(path: "contract/metrics.json")
        let raw = try #require(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        let listed = Set((try #require(raw["metrics"] as? [[String: Any]])).compactMap { $0["healthKit"] as? String })
        #expect(listed.count == 12, "four existing metrics and eight intake metrics")
        #expect(try mapper().identifiers == listed)
        #expect(listed.contains(HKQuantityTypeIdentifier.dietaryEnergyConsumed.rawValue) && listed.contains(HKCategoryTypeIdentifier.sleepAnalysis.rawValue))
    }
    
    @Test("a heart rate sample becomes a healthKit-source metric sample with the record's identity")
    func heartRate() throws {
        let sample = quantity(.heartRate, 72, unit: perMinute, device: watch, metadata: [HKMetadataKeyTimeZone: "America/Los_Angeles"])
        let mapped = try #require(try mapper().map(try record(sample), issued: issued, fallbackTimeZone: utc))
        #expect(mapped.sample.measurement == .quantity(.heartRate, 72))
        #expect(mapped.sample.source == .healthKit)
        #expect(mapped.sample.id == sample.uuid.uuidString)
        #expect(mapped.sample.timeZone == la)
        #expect(mapped.sample.issued == issued)
        #expect(mapped.sample.userEntered == false)
        #expect(mapped.device == .healthKit(name: "Apple Watch", manufacturer: "Apple Inc.", model: "Watch7,1", hardwareVersion: "Watch7,1", softwareVersion: "11.2"))
    }
    
    /// A record built by hand: HealthKit refuses to create an object with a value or a zone name it does not know, so
    /// these inputs (which a future iOS, or another writer, could still deliver) can only be exercised this way.
    private func handBuilt(typeIdentifier: String = HKQuantityTypeIdentifier.heartRate.rawValue, value: Double? = 70, category: Int? = nil,
                           zone: String? = nil, source: String = "Health", device: HealthKitDevice? = nil) -> HealthKitRecord {
        HealthKitRecord(typeIdentifier: typeIdentifier, value: value, categoryValue: category, start: t0, end: t0, uuid: "U-1",
                        timeZoneIdentifier: zone, userEntered: false, device: device, sourceName: source)
    }
    
    @Test("without a zone in the metadata the device's zone is used; an unknown zone name does not fail the sample")
    func zones() throws {
        let none = try mapper().map(try record(quantity(.heartRate, 70, unit: perMinute)), issued: issued, fallbackTimeZone: la)
        #expect(none?.sample.timeZone == la)
        let bad = try mapper().map(handBuilt(zone: "Not/AZone"), issued: issued, fallbackTimeZone: la)
        #expect(bad?.sample.timeZone == la)
        // control: a valid zone in the record wins over the fallback
        let good = try mapper().map(handBuilt(zone: "Asia/Kolkata"), issued: issued, fallbackTimeZone: la)
        #expect(good?.sample.timeZone == TimeZone(identifier: "Asia/Kolkata"))
    }
    
    @Test("a sample whose source names itself with nothing still gets a usable device descriptor")
    func emptySourceName() throws {
        let mapped = try #require(try mapper().map(handBuilt(source: "  "), issued: issued, fallbackTimeZone: utc))
        #expect(mapped.device == .sourceApp(name: "Apple Health", bundleIdentifier: nil))
        // and the device mapper accepts it (an empty descriptor would be refused with emptyDeviceDescriptor)
        let key = try DeviceMapper(registry: try registry()).key(for: mapped.device)
        #expect(key.count == 64)
    }
    
    @Test("a hand entry is marked, and described by the app it came from when it has no device")
    func handEntry() throws {
        let sample = quantity(.heartRate, 80, unit: perMinute, metadata: [HKMetadataKeyWasUserEntered: true])
        let mapped = try #require(try mapper().map(try record(sample), issued: issued, fallbackTimeZone: utc))
        #expect(mapped.sample.userEntered)
        guard case .sourceApp(let name, let bundle) = mapped.device else {
            Issue.record("expected a source application (no HKDevice)")
            return
        }
        // an in-memory sample has not been saved, so its source has no name yet: the descriptor then falls back
        let source = sample.sourceRevision.source.name
        #expect(name == (source.isEmpty ? (sample.sourceRevision.source.bundleIdentifier.isEmpty ? "Apple Health" : nil) : source))
        let sourceBundle = sample.sourceRevision.source.bundleIdentifier
        #expect(bundle == (sourceBundle.isEmpty ? nil : sourceBundle), "a blank bundle identifier is none, not an empty string")
    }
    
    @Test("all six HealthKit sleep values map; an unknown one is ignored, not guessed", arguments: [
        (HKCategoryValueSleepAnalysis.inBed.rawValue, SleepStage.inBed),
        (HKCategoryValueSleepAnalysis.asleepUnspecified.rawValue, SleepStage.asleepUnspecified),
        (HKCategoryValueSleepAnalysis.awake.rawValue, SleepStage.awake),
        (HKCategoryValueSleepAnalysis.asleepCore.rawValue, SleepStage.asleepCore),
        (HKCategoryValueSleepAnalysis.asleepDeep.rawValue, SleepStage.asleepDeep),
        (HKCategoryValueSleepAnalysis.asleepREM.rawValue, SleepStage.asleepREM),
    ])
    func sleepStages(raw: Int, stage: SleepStage) throws {
        let sample = HKCategorySample(type: HKCategoryType(.sleepAnalysis), value: raw, start: t0, end: t0.addingTimeInterval(600))
        let mapped = try #require(try mapper().map(try record(sample), issued: issued, fallbackTimeZone: utc))
        #expect(mapped.sample.measurement == .sleep(stage))
    }
    
    @Test("an unknown sleep value (say, from a newer iOS) is ignored, not guessed")
    func unknownSleepValue() throws {
        let unknown = handBuilt(typeIdentifier: HKCategoryTypeIdentifier.sleepAnalysis.rawValue, value: nil, category: 99)
        #expect(try mapper().map(unknown, issued: issued, fallbackTimeZone: utc) == nil)
        // control: a known one maps
        let known = handBuilt(typeIdentifier: HKCategoryTypeIdentifier.sleepAnalysis.rawValue, value: nil, category: HKCategoryValueSleepAnalysis.awake.rawValue)
        #expect(try mapper().map(known, issued: issued, fallbackTimeZone: utc)?.sample.measurement == .sleep(.awake))
    }
    
    @Test("through the observation mapper: lowercase UUID, the healthKit source, the user-entered tag, the value untouched")
    func endToEnd() throws {
        let registry = try registry()
        let sample = quantity(.heartRate, 80, unit: perMinute, metadata: [HKMetadataKeyWasUserEntered: true])
        let mapped = try #require(try HealthKitMapper(registry: registry).map(try record(sample), issued: issued, fallbackTimeZone: utc))
        guard case .observation(let observation) = try ObservationMapper(registry: registry).map(mapped.sample, patientID: "p") else {
            Issue.record("expected an observation")
            return
        }
        let object = try #require(JSONSerialization.jsonObject(with: try JSONEncoder.fhir.encode(observation)) as? [String: Any])
        let identifier = try #require((object["identifier"] as? [[String: Any]])?.first)
        #expect(identifier["system"] as? String == registry.systems.identifier.healthKit)
        #expect(identifier["value"] as? String == sample.uuid.uuidString.lowercased())
        let meta = try #require(object["meta"] as? [String: Any])
        #expect(meta["source"] as? String == registry.systems.metaSource.healthKit)
        #expect((meta["tag"] as? [[String: Any]])?.first?["code"] as? String == registry.dataQualityFlags["userEntered"])
    }
}


// MARK: - the bridge (what flows, and what is dropped)

private final class Collected: @unchecked Sendable {
    private let lock = NSLock()
    private var samples: [IngestedSample] = []
    private var deletions: [String] = []
    func add(_ s: IngestedSample) { lock.withLock { samples.append(s) } }
    func add(all s: [IngestedSample]) { lock.withLock { samples += s } }
    func add(deletions d: [String]) { lock.withLock { deletions += d } }
    var all: [IngestedSample] { lock.withLock { samples } }
    var deleted: [String] { lock.withLock { deletions } }
}

/// A throwaway preferences store, so a test never touches the app's own.
private func isolatedDefaults() -> UserDefaults {
    let name = "healthkit-tests-\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: name)!
    defaults.removePersistentDomain(forName: name)
    return defaults
}

/// A scripted sequence of store outcomes (the last one repeats).
private final class Outcomes: @unchecked Sendable {
    private let lock = NSLock()
    private var values: [Bool]
    init(_ values: [Bool]) { self.values = values }
    func next() -> Bool { lock.withLock { values.count > 1 ? values.removeFirst() : (values.first ?? true) } }
}

@Suite("HealthKit bridge")
struct HealthKitBridgeTests {
    private func bridge(into collected: Collected) async throws -> HealthKitBridge {
        let bridge = HealthKitBridge(defaults: isolatedDefaults())
        await bridge.configure(
            mapper: HealthKitMapper(registry: try registry()),
            deliver: { collected.add(all: $0); return true },
            recordDeletions: { collected.add(deletions: $0) })
        return bridge
    }
    
    private func records() throws -> [HealthKitRecord] {
        [
            try #require(HealthKitRecord(sample: quantity(.heartRate, 70, unit: perMinute, device: watch))),
            try #require(HealthKitRecord(sample: quantity(.restingHeartRate, 58, unit: perMinute, at: 60, device: watch))),
        ]
    }
    
    @Test("nothing flows until Apple Health is enabled; what arrives before is dropped and counted")
    func dropsWhileOff() async throws {
        let collected = Collected()
        let bridge = try await bridge(into: collected)
        await bridge.receive(try records(), now: t0, fallbackTimeZone: .gmt)
        #expect(collected.all.isEmpty)
        #expect(await bridge.counters.droppedWhileOff == 2)
        #expect(await bridge.counters.accepted == 0)
    }
    
    @Test("once enabled, records flow with their own device (the control for the drop above)")
    func flowsWhenOn() async throws {
        let collected = Collected()
        let bridge = try await bridge(into: collected)
        await bridge.setEnabled(true)
        await bridge.receive(try records(), now: t0, fallbackTimeZone: .gmt)
        #expect(collected.all.count == 2)
        #expect(collected.all.allSatisfy { $0.sample.source == .healthKit && $0.device != nil })
        #expect(await bridge.counters.accepted == 2)
        #expect(await bridge.counters.lastReceivedAt == t0)
        
        // switching it off again stops the flow
        await bridge.setEnabled(false)
        await bridge.receive(try records(), now: t0, fallbackTimeZone: .gmt)
        #expect(collected.all.count == 2)
        #expect(await bridge.counters.droppedWhileOff == 2)
    }
    
    // The library saves its anchor the moment `receive` returns: a sample must already be stored by then.
    @Test("receive returns only after the batch is stored; a failed store is kept, counted, and retried exactly once")
    func durableHandoff() async throws {
        let collected = Collected()
        let outcomes = Outcomes([false, true])
        let bridge = HealthKitBridge(defaults: isolatedDefaults())
        await bridge.configure(
            mapper: HealthKitMapper(registry: try registry()),
            deliver: { batch in
                let ok = outcomes.next()
                if ok { collected.add(all: batch) }
                return ok
            },
            recordDeletions: { _ in })
        await bridge.setEnabled(true)
        
        await bridge.receive(Array(try records().prefix(1)), now: t0, fallbackTimeZone: .gmt)
        #expect(collected.all.isEmpty, "the store failed, so nothing is stored")
        #expect(await bridge.counters.accepted == 0, "and it is not counted as received")
        #expect(await bridge.counters.unsaved == 1, "but it is not forgotten either")
        
        // the next arrival carries the earlier one with it: one store of both, in order, nothing doubled
        await bridge.receive(Array(try records().suffix(1)), now: t0, fallbackTimeZone: .gmt)
        #expect(collected.all.count == 2)
        #expect(await bridge.counters.accepted == 2)
        #expect(await bridge.counters.unsaved == 0)
        
        // and with nothing pending, a flush stores nothing more (the control for the retry above)
        await bridge.flush()
        #expect(collected.all.count == 2)
    }
    
    @Test("flush retries a pending batch without waiting for another sample")
    func flushRetries() async throws {
        let collected = Collected()
        let outcomes = Outcomes([false, true])
        let bridge = HealthKitBridge(defaults: isolatedDefaults())
        await bridge.configure(
            mapper: HealthKitMapper(registry: try registry()),
            deliver: { batch in
                let ok = outcomes.next()
                if ok { collected.add(all: batch) }
                return ok
            },
            recordDeletions: { _ in })
        await bridge.setEnabled(true)
        await bridge.receive(try records(), now: t0, fallbackTimeZone: .gmt)
        #expect(collected.all.isEmpty)
        await bridge.flush()
        #expect(collected.all.count == 2)
        #expect(await bridge.counters.unsaved == 0)
    }
    
    // A background launch is quick: HealthKit may deliver before the app has wired the bridge.
    @Test("records that arrive before the bridge is wired are processed when it is, not dropped")
    func arrivesBeforeWiring() async throws {
        let collected = Collected()
        let bridge = HealthKitBridge(defaults: isolatedDefaults())
        await bridge.setEnabled(true)
        await bridge.receive(try records(), now: t0, fallbackTimeZone: .gmt)
        #expect(collected.all.isEmpty)
        #expect(await bridge.counters.droppedWhileOff == 0, "waiting is not dropping")
        
        await bridge.configure(
            mapper: HealthKitMapper(registry: try registry()),
            deliver: { collected.add(all: $0); return true },
            recordDeletions: { _ in })
        #expect(collected.all.count == 2)
        #expect(await bridge.counters.accepted == 2)
    }
    
    @Test("a record the mapper does not read is counted as ignored")
    func ignored() async throws {
        let collected = Collected()
        let bridge = try await bridge(into: collected)
        await bridge.setEnabled(true)
        let odd = HealthKitRecord(
            typeIdentifier: "HKQuantityTypeIdentifierBodyMass", value: 70, categoryValue: nil, start: t0, end: t0, uuid: "U",
            timeZoneIdentifier: nil, userEntered: false, device: nil, sourceName: "Health")
        await bridge.receive([odd], now: t0, fallbackTimeZone: .gmt)
        #expect(collected.all.isEmpty)
        #expect(await bridge.counters.ignored == 1)
    }
    
    @Test("deletions are handed on lowercased, and only while enabled")
    func deletions() async throws {
        let collected = Collected()
        let bridge = try await bridge(into: collected)
        await bridge.receiveDeleted(["ABC-1"])
        #expect(collected.deleted.isEmpty)
        await bridge.setEnabled(true)
        await bridge.receiveDeleted(["ABC-1", "DEF-2"])
        #expect(collected.deleted == ["abc-1", "def-2"])
        #expect(await bridge.counters.deletionsSeen == 2)
    }
}


// MARK: - the gate

@Suite("HealthKit gate")
struct HealthKitGateTests {
    private func configuration(real: String? = "poc-real", https: Bool = true) -> Result<ServerConfiguration, ServerConfiguration.Failure> {
        var info: [String: Any] = [
            "POCFHIRBaseURL": https ? "https://macpro16.local:8443/fhir" : "http://macpro16.local:8443/fhir",
            "POCIssuerURL": "https://macpro16.local:8444/realms/poc", "POCClientID": "ios-capture",
            "POCRedirectScheme": "com.blueysoft.spezipoc", "POCPatientIdentifier": "poc-0001",
        ]
        if let real { info["POCHealthKitPatientIdentifier"] = real }
        do {
            return .success(try ServerConfiguration(info: info))
        } catch {
            return .failure(error)
        }
    }
    
    @Test("allowed only with TLS, a separate patient, a signed-in user, and Health data on the device")
    func available() {
        #expect(HealthKitGate.evaluate(configuration: configuration(), signedIn: true, healthDataAvailable: true) == .available)
    }
    
    @Test("each missing condition says why", arguments: [
        ("signed out", false, true, "poc-real", true, HealthKitGate.Reason.signedOut),
        ("no health data", true, false, "poc-real", true, .healthDataUnavailable),
        ("no separate patient", true, true, nil, true, .noSeparatePatient),
        ("not https", true, true, "poc-real", false, .notConfigured),
    ] as [(String, Bool, Bool, String?, Bool, HealthKitGate.Reason)])
    func unavailable(name: String, signedIn: Bool, health: Bool, real: String?, https: Bool, reason: HealthKitGate.Reason) {
        let gate = HealthKitGate.evaluate(configuration: configuration(real: real, https: https), signedIn: signedIn, healthDataAvailable: health)
        #expect(gate == .unavailable(reason), "\(name)")
    }
    
    @Test("the real-data patient may not be the synthetic one")
    func samePatientRefused() {
        let result = configuration(real: "POC-0001")
        #expect(result == .failure(.invalid("POCHealthKitPatientIdentifier")))
        // control: a different identifier is accepted
        if case .failure = configuration(real: "poc-real") { Issue.record("a distinct identifier must be accepted") }
    }
    
    @Test("an unfilled build setting means 'no real-data patient', not a broken configuration")
    func unresolved() throws {
        guard case .success(let c) = configuration(real: "$(POC_HEALTHKIT_PATIENT_IDENTIFIER)") else {
            Issue.record("the configuration itself must still load")
            return
        }
        #expect(c.healthKitPatientIdentifier == nil)
    }
    
    @Test("the stored choice only takes effect while the gate allows it")
    func effectiveSource() {
        #expect(DataSource.effective(.appleHealth, gate: .available) == .appleHealth)
        #expect(DataSource.effective(.appleHealth, gate: .unavailable(.signedOut)) == .synthetic)
        #expect(DataSource.effective(.synthetic, gate: .available) == .synthetic)
    }
}


// MARK: - what is held, what is dropped, what may start

@Suite("HealthKit collection policy")
struct HealthKitPolicyTests {
    private let reasons: [HealthKitGate.Reason] = [.healthDataUnavailable, .notConfigured, .noSeparatePatient, .signedOut]
    
    @Test("an open gate starts collection and accepts samples, but only when Apple Health is chosen")
    func open() {
        #expect(HealthKitGate.available.mayStartCollection(chosen: true))
        #expect(HealthKitGate.available.acceptsSamples(chosen: true))
        #expect(!HealthKitGate.available.mayStartCollection(chosen: false))
        #expect(!HealthKitGate.available.acceptsSamples(chosen: false))
    }
    
    @Test("signed out: collection that was running keeps queueing (nothing uploads without a token); it never starts")
    func signedOutHolds() {
        let gate = HealthKitGate.unavailable(.signedOut)
        #expect(gate.acceptsSamples(chosen: true))
        #expect(!gate.mayStartCollection(chosen: true))
        #expect(!gate.acceptsSamples(chosen: false))
    }
    
    @Test("every other closed gate drops, and never starts")
    func otherReasonsDrop() {
        for reason in reasons where reason != .signedOut {
            let gate = HealthKitGate.unavailable(reason)
            #expect(!gate.acceptsSamples(chosen: true), "\(reason)")
            #expect(!gate.mayStartCollection(chosen: true), "\(reason)")
        }
    }
}


// MARK: - resuming at launch

@Suite("HealthKit resume at launch")
struct HealthKitResumeTests {
    private func configuration(real: String? = "poc-real", https: Bool = true) -> Result<ServerConfiguration, ServerConfiguration.Failure> {
        var info: [String: Any] = [
            "POCFHIRBaseURL": https ? "https://macpro16.local:8443/fhir" : "http://macpro16.local:8443/fhir",
            "POCIssuerURL": "https://macpro16.local:8444/realms/poc", "POCClientID": "ios-capture",
            "POCRedirectScheme": "com.blueysoft.spezipoc", "POCPatientIdentifier": "poc-0001",
        ]
        if let real { info["POCHealthKitPatientIdentifier"] = real }
        do {
            return .success(try ServerConfiguration(info: info))
        } catch {
            return .failure(error)
        }
    }
    
    private let chosen = DataSource.appleHealth.rawValue
    
    @Test("resumes only for a user who chose Apple Health, with everything but sign-in in place")
    func resumes() {
        #expect(HealthKitResume.shouldResume(storedChoice: chosen, configuration: configuration(), healthDataAvailable: true))
    }
    
    @Test("never for a user who did not choose it (the control for the refusals below)")
    func notChosen() {
        #expect(!HealthKitResume.shouldResume(storedChoice: nil, configuration: configuration(), healthDataAvailable: true))
        #expect(!HealthKitResume.shouldResume(storedChoice: DataSource.synthetic.rawValue, configuration: configuration(), healthDataAvailable: true))
    }
    
    @Test("never without HealthKit, without a separate patient, or on a configuration that is not https")
    func refusals() {
        #expect(!HealthKitResume.shouldResume(storedChoice: chosen, configuration: configuration(), healthDataAvailable: false))
        #expect(!HealthKitResume.shouldResume(storedChoice: chosen, configuration: configuration(real: nil), healthDataAvailable: true))
        #expect(!HealthKitResume.shouldResume(storedChoice: chosen, configuration: configuration(https: false), healthDataAvailable: true))
    }
}


// MARK: - the collection window and the counters that outlive a launch

@Suite("HealthKit window and counters")
struct HealthKitWindowTests {
    private let day: TimeInterval = 86_400
    
    @Test("the first start is a week back; once committed it does not move with the launch time")
    func windowIsFixedOnce() {
        let defaults = isolatedDefaults()
        let first = Date(timeIntervalSince1970: 1_800_000_000)
        let start = HealthKitWindow.start(now: first, defaults: defaults)
        #expect(start == first.addingTimeInterval(-7 * day))
        
        // not yet committed (the user has not chosen Apple Health): a later launch computes its own
        #expect(HealthKitWindow.start(now: first.addingTimeInterval(3 * day), defaults: defaults) == first.addingTimeInterval(-4 * day))
        
        HealthKitWindow.commit(start, defaults: defaults)
        // ten days later nothing the anchor has not delivered is excluded: the start is still the original one
        #expect(HealthKitWindow.start(now: first.addingTimeInterval(10 * day), defaults: defaults) == start)
    }
    
    @Test("committing again does not move it")
    func commitOnce() {
        let defaults = isolatedDefaults()
        let a = Date(timeIntervalSince1970: 1_800_000_000)
        HealthKitWindow.commit(a, defaults: defaults)
        HealthKitWindow.commit(a.addingTimeInterval(5 * day), defaults: defaults)
        #expect(HealthKitWindow.start(now: a.addingTimeInterval(20 * day), defaults: defaults) == a)
    }
    
    @Test("the lifetime count and last-received time survive a new bridge (a relaunch); the per-launch count does not")
    func countersPersist() async throws {
        // two handles on one suite, the way a relaunch gets a new object over the same stored values
        let suite = "healthkit-tests-\(UUID().uuidString)"
        let first = HealthKitBridge(defaults: UserDefaults(suiteName: suite)!)
        await first.configure(
            mapper: HealthKitMapper(registry: try registry()),
            deliver: { _ in true },
            recordDeletions: { _ in })
        await first.setEnabled(true)
        await first.receive(try [
            #require(HealthKitRecord(sample: quantity(.heartRate, 70, unit: perMinute, device: watch))),
        ], now: t0, fallbackTimeZone: .gmt)
        #expect(await first.counters.accepted == 1)
        #expect(await first.counters.lifetimeAccepted == 1)
        
        let relaunched = HealthKitBridge(defaults: UserDefaults(suiteName: suite)!)
        defer { UserDefaults(suiteName: suite)?.removePersistentDomain(forName: suite) }
        #expect(await relaunched.counters.accepted == 0)
        #expect(await relaunched.counters.lifetimeAccepted == 1)
        #expect(await relaunched.counters.lastReceivedAt == t0)
        
        // and a fresh store knows nothing (the control)
        let other = HealthKitBridge(defaults: isolatedDefaults())
        #expect(await other.counters.lifetimeAccepted == 0)
        #expect(await other.counters.lastReceivedAt == nil)
    }
}


// MARK: - dietary intake (M20)

@Suite("HealthKit dietary intake")
struct HealthKitIntakeTests {
    private let issued = t0.addingTimeInterval(60)
    private let utc = TimeZone(identifier: "UTC") ?? .gmt
    
    private func mapper() throws -> HealthKitMapper {
        HealthKitMapper(registry: try registry())
    }
    
    private func handBuilt(_ identifier: HKQuantityTypeIdentifier, value: Double, meal: String? = nil, conflict: Bool = false,
                           source: String = "Example App", bundle: String? = "com.example.app") -> HealthKitRecord {
        HealthKitRecord(typeIdentifier: identifier.rawValue, value: value, categoryValue: nil, start: t0, end: t0, uuid: "F-1",
                        timeZoneIdentifier: nil, userEntered: false, device: nil, sourceName: source,
                        sourceBundleIdentifier: bundle, mealLabel: meal, mealConflict: conflict)
    }
    
    @Test("each dietary type is read in the contract's unit whatever unit the source wrote (no locale, no guess)")
    func unitsAreConverted() throws {
        let cases: [(HKQuantityTypeIdentifier, HKQuantity, Double)] = [
            (.dietaryEnergyConsumed, HKQuantity(unit: .jouleUnit(with: .kilo), doubleValue: 1883), 1883 / 4.184),  // kJ to kcal (4184 J each)
            (.dietaryProtein, HKQuantity(unit: .gramUnit(with: .milli), doubleValue: 31_500), 31.5),          // mg to g
            (.dietaryCarbohydrates, HKQuantity(unit: .gram(), doubleValue: 62), 62),
            (.dietaryFatTotal, HKQuantity(unit: .ounce(), doubleValue: 1), 28.349523125),                      // oz to g
            (.dietaryFiber, HKQuantity(unit: .gram(), doubleValue: 7.5), 7.5),
            (.dietarySugar, HKQuantity(unit: .gram(), doubleValue: 22), 22),
            (.dietarySodium, HKQuantity(unit: .gram(), doubleValue: 0.62), 620),                               // g to mg
            (.dietaryWater, HKQuantity(unit: .liter(), doubleValue: 0.25), 250),                               // L to mL
        ]
        for (identifier, quantity, expected) in cases {
            let sample = HKQuantitySample(type: HKQuantityType(identifier), quantity: quantity, start: t0, end: t0)
            let record = try #require(HealthKitRecord(sample: sample), "\(identifier.rawValue)")
            #expect(abs((record.value ?? .nan) - expected) < 0.01, "\(identifier.rawValue): got \(record.value ?? .nan), expected \(expected)")
        }
    }
    
    @Test("zero is a real intake and is kept; the mapper to FHIR stores it (heart rate zero is still refused)")
    func zeroIsKept() throws {
        let mapped = try #require(try mapper().map(handBuilt(.dietarySodium, value: 0), issued: issued, fallbackTimeZone: utc))
        #expect(mapped.sample.measurement == .quantity(.dietarySodium, 0))
        let observation = try ObservationMapper(registry: try registry()).map(mapped.sample, patientID: "p")
        guard case .observation(let resource) = observation else {
            Issue.record("zero sodium must map to an Observation")
            return
        }
        #expect(resource.valueQuantity.value == 0)
        // the control: the same zero is refused for a metric that does not allow it
        var heart = mapped.sample
        heart.measurement = .quantity(.heartRate, 0)
        #expect(throws: MappingError.nonPositiveValue) { try ObservationMapper(registry: try registry()).map(heart, patientID: "p") }
        var negative = mapped.sample
        negative.measurement = .quantity(.dietarySodium, -1)
        #expect(throws: MappingError.negativeValue) { try ObservationMapper(registry: try registry()).map(negative, patientID: "p") }
    }
    
    @Test("a meal label resolves from the two metadata keys: one, two that agree, two that disagree, blank")
    func mealLabelResolution() {
        #expect(HealthKitRecord.resolveMealLabel(["Lunch", nil]).label == "Lunch")
        #expect(HealthKitRecord.resolveMealLabel([nil, "Lunch"]).label == "Lunch")
        let both = HealthKitRecord.resolveMealLabel(["Lunch", " lunch "])
        #expect(both.label == "Lunch" && !both.conflict, "agreeing keys (ignoring case and whitespace) are the first as written")
        let disagree = HealthKitRecord.resolveMealLabel(["Lunch", "Dinner"])
        #expect(disagree.label == nil && disagree.conflict, "a disagreement is no label and is counted, never a guess")
        #expect(HealthKitRecord.resolveMealLabel([nil, nil]) == (nil, false))
        #expect(HealthKitRecord.resolveMealLabel(["  ", ""]) == (nil, false))
    }
    
    @Test("the metadata keys are read from a real sample, and nothing else about it")
    func mealFromMetadata() throws {
        let sample = HKQuantitySample(
            type: HKQuantityType(.dietaryEnergyConsumed), quantity: HKQuantity(unit: .kilocalorie(), doubleValue: 300), start: t0, end: t0,
            metadata: ["meal": "Lunch", "Meal": "Lunch"])
        let record = try #require(HealthKitRecord(sample: sample))
        #expect(record.mealLabel == "Lunch" && !record.mealConflict)
        let none = try #require(HealthKitRecord(sample: HKQuantitySample(
            type: HKQuantityType(.dietaryEnergyConsumed), quantity: HKQuantity(unit: .kilocalorie(), doubleValue: 300), start: t0, end: t0)))
        #expect(none.mealLabel == nil && !none.mealConflict)
        let clash = try #require(HealthKitRecord(sample: HKQuantitySample(
            type: HKQuantityType(.dietaryEnergyConsumed), quantity: HKQuantity(unit: .kilocalorie(), doubleValue: 300), start: t0, end: t0,
            metadata: ["meal": "Lunch", "Meal": "Dinner"])))
        #expect(clash.mealLabel == nil && clash.mealConflict)
    }
    
    @Test("an intake gets its meal from the contract's normalization; a heart-rate sample never does")
    func mealOnTheSample() throws {
        let mapper = try mapper()
        for (label, code) in [("Lunch", "lunch"), ("SNACKS", "snack"), ("Brunch", "other")] {
            let sample = try #require(try mapper.map(handBuilt(.dietaryEnergyConsumed, value: 300, meal: label), issued: issued, fallbackTimeZone: utc)).sample
            #expect(sample.meal == MetricSample.Meal(code: code, label: label), "\(label)")
        }
        #expect(try #require(try mapper.map(handBuilt(.dietaryEnergyConsumed, value: 300), issued: issued, fallbackTimeZone: utc)).sample.meal == nil)
        // the control: the same label on a heart-rate record is ignored
        let heart = try #require(try mapper.map(handBuilt(.heartRate, value: 70, meal: "Lunch"), issued: issued, fallbackTimeZone: utc))
        #expect(heart.sample.meal == nil)
    }
    
    @Test("no HKDevice: the app is the Device, by its bundle identifier; with an HKDevice the device is kept")
    func sourceApplication() throws {
        let mapped = try #require(try mapper().map(handBuilt(.dietaryProtein, value: 20), issued: issued, fallbackTimeZone: utc))
        #expect(mapped.device == .sourceApp(name: "Example App", bundleIdentifier: "com.example.app"))
        let renamed = try #require(try mapper().map(handBuilt(.dietaryProtein, value: 20, source: "Example App Pro"), issued: issued, fallbackTimeZone: utc))
        let devices = DeviceMapper(registry: try registry())
        #expect(try devices.key(for: mapped.device) == devices.key(for: renamed.device), "one bundle identifier is one Device under any display name")
        let other = try #require(try mapper().map(handBuilt(.dietaryProtein, value: 20, bundle: "com.example.other"), issued: issued, fallbackTimeZone: utc))
        #expect(try devices.key(for: mapped.device) != devices.key(for: other.device), "another bundle identifier is another Device (the control)")
        
        let watch = HealthKitDevice(name: "Apple Watch", manufacturer: "Apple Inc.", model: "Watch7,1", hardwareVersion: nil, softwareVersion: nil)
        var withDevice = handBuilt(.heartRate, value: 70)
        withDevice.device = watch
        let kept = try #require(try mapper().map(withDevice, issued: issued, fallbackTimeZone: utc))
        guard case .healthKit(let name, _, _, _, _) = kept.device else {
            Issue.record("a sample with an HKDevice keeps the device, not the source app")
            return
        }
        #expect(name == "Apple Watch")
    }
}
