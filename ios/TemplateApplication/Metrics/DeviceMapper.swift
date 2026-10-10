//
// This source file is part of the Spezi POC capture app, adapted from the Stanford Spezi Template Application
//
// SPDX-FileCopyrightText: 2023 Stanford University and the project authors (see CONTRIBUTORS.md)
//
// SPDX-License-Identifier: MIT
//

import CryptoKit
import Foundation


/// Maps a source description to a FHIR `Device` and its deterministic key (`deviceKey` in the contract).
struct DeviceMapper: Sendable {
    let registry: MetricRegistry
    
    private static let separator = "\u{1F}"
    
    
    /// The key that identifies this device across uploads: a fixed value for the synthetic simulator, otherwise the
    /// SHA-256 (lowercase hex) of the five trimmed fields joined by U+001F.
    func key(for descriptor: DeviceDescriptor) throws(MappingError) -> String {
        switch descriptor {
        case .synthetic:
            return registry.deviceKey.syntheticValue
        case .healthKit(let name, let manufacturer, let model, let hardwareVersion, let softwareVersion):
            let fields = [name, manufacturer, model, hardwareVersion, softwareVersion].map { ($0 ?? "").trimmingCharacters(in: .whitespaces) }
            guard fields.contains(where: { !$0.isEmpty }) else {
                throw .emptyDeviceDescriptor
            }
            let digest = SHA256.hash(data: Data(fields.joined(separator: Self.separator).utf8))
            return digest.map { String(format: "%02x", $0) }.joined()
        }
    }
    
    func map(_ descriptor: DeviceDescriptor, patientID: String) throws(MappingError) -> FHIRDevice {
        guard !patientID.trimmingCharacters(in: .whitespaces).isEmpty else {
            throw .emptyPatientID
        }
        let identifier = FHIRIdentifier(system: registry.systems.identifier.deviceKey, value: try key(for: descriptor))
        let patient = FHIRReference(reference: "Patient/\(patientID)")
        
        switch descriptor {
        case .synthetic:
            return FHIRDevice(identifier: [identifier], status: "active", manufacturer: registry.deviceKey.syntheticManufacturer,
                              deviceName: [FHIRDevice.Name(name: registry.deviceKey.syntheticName, type: "model-name")], patient: patient)
            
        case .healthKit(let name, let manufacturer, let model, let hardwareVersion, let softwareVersion):
            func clean(_ value: String?) -> String? {
                let trimmed = value?.trimmingCharacters(in: .whitespaces) ?? ""
                return trimmed.isEmpty ? nil : trimmed
            }
            var versions: [FHIRDevice.Version] = []
            if let hardware = clean(hardwareVersion) {
                versions.append(FHIRDevice.Version(type: FHIRCodeableConcept(text: "hardware"), value: hardware)) // A15
            }
            if let software = clean(softwareVersion) {
                versions.append(FHIRDevice.Version(type: FHIRCodeableConcept(text: "software"), value: software))
            }
            return FHIRDevice(
                identifier: [identifier],
                status: "active",
                manufacturer: clean(manufacturer),
                deviceName: clean(name).map { [FHIRDevice.Name(name: $0, type: "model-name")] },
                modelNumber: clean(model),
                version: versions.isEmpty ? nil : versions,
                patient: patient
            )
        }
    }
}
