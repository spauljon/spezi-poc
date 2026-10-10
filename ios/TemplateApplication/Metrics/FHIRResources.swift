//
// This source file is part of the Spezi POC capture app, adapted from the Stanford Spezi Template Application
//
// SPDX-FileCopyrightText: 2023 Stanford University and the project authors (see CONTRIBUTORS.md)
//
// SPDX-License-Identifier: MIT
//

import Foundation


// Minimal Codable shapes for exactly the R4 elements the mapping writes. Optionals are omitted when nil, which is
// what FHIR wants (no null, no empty arrays). Field names are the FHIR JSON names.

struct FHIRCoding: Codable, Equatable, Sendable {
    var system: String
    var code: String
    var display: String
}

struct FHIRCodeableConcept: Codable, Equatable, Sendable {
    var coding: [FHIRCoding]?
    var text: String?
}

struct FHIRIdentifier: Codable, Equatable, Sendable {
    var system: String
    var value: String
}

struct FHIRReference: Codable, Equatable, Sendable {
    var reference: String
}

struct FHIRMeta: Codable, Equatable, Sendable {
    var source: String
}

struct FHIRPeriod: Codable, Equatable, Sendable {
    var start: String
    var end: String
}

struct FHIRQuantity: Codable, Equatable, Sendable {
    var value: Decimal
    var unit: String
    var system: String
    var code: String
}

struct FHIRObservation: Codable, Equatable, Sendable {
    var resourceType = "Observation"
    var meta: FHIRMeta
    var identifier: [FHIRIdentifier]
    var status: String
    var category: [FHIRCodeableConcept]
    var code: FHIRCodeableConcept
    var subject: FHIRReference
    var effectiveDateTime: String?
    var effectivePeriod: FHIRPeriod?
    var issued: String
    var valueQuantity: FHIRQuantity
    var device: FHIRReference?
}

struct FHIRDevice: Codable, Equatable, Sendable {
    struct Name: Codable, Equatable, Sendable {
        var name: String
        var type: String
    }
    
    struct Version: Codable, Equatable, Sendable {
        var type: FHIRCodeableConcept
        var value: String
    }
    
    var resourceType = "Device"
    var identifier: [FHIRIdentifier]
    var status: String
    var manufacturer: String?
    var deviceName: [Name]?
    var modelNumber: String?
    var version: [Version]?
    var patient: FHIRReference
}


extension JSONEncoder {
    /// The encoder every FHIR resource goes through: stable key order, so equal resources are byte-equal.
    static var fhir: JSONEncoder {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return encoder
    }
}
