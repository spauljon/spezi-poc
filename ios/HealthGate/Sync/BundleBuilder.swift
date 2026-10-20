//
// This source file is part of the Spezi POC capture app, adapted from the Stanford Spezi Template Application
//
// SPDX-FileCopyrightText: 2023 Stanford University and the project authors (see CONTRIBUTORS.md)
//
// SPDX-License-Identifier: MIT
//

import Foundation


/// What happened to each queued sample when it was turned into Bundle entries.
struct BuildResult: Equatable, Sendable {
    var bundle: FHIRBundle
    /// Queue keys of the Observation entries, in entry order (after the Device entries).
    var observationKeys: [String]
    /// Valid samples that deliberately produce no resource (`inBed`): nothing to upload.
    var unmappedKeys: [String]
    /// Samples the mapper refused, with the reason (they can never upload as they are).
    var invalid: [(key: String, error: MappingError)]
    
    static func == (lhs: BuildResult, rhs: BuildResult) -> Bool {
        lhs.bundle == rhs.bundle && lhs.observationKeys == rhs.observationKeys && lhs.unmappedKeys == rhs.unmappedKeys
            && lhs.invalid.map(\.key) == rhs.invalid.map(\.key) && lhs.invalid.map(\.error) == rhs.invalid.map(\.error)
    }
}


/// Builds one transaction Bundle from a batch of queued samples: the emitting Device(s) first, then each Observation, all
/// as conditional creates, so that resending changes nothing on the server.
struct BundleBuilder: Sendable {
    let registry: MetricRegistry
    
    func build(_ items: [(key: String, sample: MetricSample, device: DeviceDescriptor)], patientID: String) throws(MappingError) -> BuildResult {
        let observations = ObservationMapper(registry: registry)
        let devices = DeviceMapper(registry: registry)
        
        var deviceEntries: [FHIRBundle.Entry] = []
        var deviceURLs: [DeviceDescriptor: String] = [:]
        var observationEntries: [FHIRBundle.Entry] = []
        var keys: [String] = []
        var unmapped: [String] = []
        var invalid: [(key: String, error: MappingError)] = []
        
        for item in items {
            let deviceURL: String
            if let existing = deviceURLs[item.device] {
                deviceURL = existing
            } else {
                do throws(MappingError) {
                    let device = try devices.map(item.device, patientID: patientID)
                    guard let identifier = device.identifier.first else {
                        throw MappingError.emptyDeviceDescriptor
                    }
                    deviceURL = FHIRBundle.fullUrl(system: identifier.system, value: identifier.value)
                    deviceURLs[item.device] = deviceURL
                    deviceEntries.append(FHIRBundle.Entry(
                        fullUrl: deviceURL, resource: .device(device),
                        request: .init(url: "Device", ifNoneExist: FHIRSearch.identifierQuery(system: identifier.system, value: identifier.value))))
                } catch {
                    invalid.append((item.key, error))
                    continue
                }
            }
            
            do throws(MappingError) {
                switch try observations.map(item.sample, patientID: patientID, deviceReference: deviceURL) {
                case .unmapped:
                    unmapped.append(item.key)
                case .observation(let observation):
                    guard let identifier = observation.identifier.first else {
                        throw MappingError.emptySampleID
                    }
                    observationEntries.append(FHIRBundle.Entry(
                        fullUrl: FHIRBundle.fullUrl(system: identifier.system, value: identifier.value),
                        resource: .observation(observation),
                        request: .init(url: "Observation", ifNoneExist: FHIRSearch.identifierQuery(system: identifier.system, value: identifier.value))))
                    keys.append(item.key)
                }
            } catch {
                invalid.append((item.key, error))
            }
        }
        
        // A Device entry is only worth sending if some Observation uses it.
        let used = Set(observationEntries.compactMap { entry -> String? in
            if case .observation(let o) = entry.resource { return o.device?.reference }
            return nil
        })
        let usedDevices = deviceEntries.filter { used.contains($0.fullUrl) }
        return BuildResult(bundle: FHIRBundle(entry: usedDevices + observationEntries), observationKeys: keys, unmappedKeys: unmapped, invalid: invalid)
    }
}
