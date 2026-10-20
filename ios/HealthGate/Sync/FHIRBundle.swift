//
// This source file is part of the Spezi POC capture app, adapted from the Stanford Spezi Template Application
//
// SPDX-FileCopyrightText: 2023 Stanford University and the project authors (see CONTRIBUTORS.md)
//
// SPDX-License-Identifier: MIT
//

import CryptoKit
import Foundation


/// A FHIR R4 `transaction` Bundle, of exactly the shape the capture app uploads: conditional creates of one Device and
/// the Observations that reference it.
struct FHIRBundle: Encodable, Equatable, Sendable {
    struct Entry: Encodable, Equatable, Sendable {
        struct Request: Encodable, Equatable, Sendable {
            var method = "POST"
            var url: String
            var ifNoneExist: String
        }
        
        var fullUrl: String
        var resource: Resource
        var request: Request
    }
    
    enum Resource: Encodable, Equatable, Sendable {
        case observation(FHIRObservation)
        case device(FHIRDevice)
        
        func encode(to encoder: any Encoder) throws {
            switch self {
            case .observation(let observation): try observation.encode(to: encoder)
            case .device(let device): try device.encode(to: encoder)
            }
        }
    }
    
    var resourceType = "Bundle"
    var type = "transaction"
    var entry: [Entry]
    
    
    /// A deterministic `urn:uuid:` for an entry, derived from its identifier. Deterministic so that the same batch always
    /// produces the same Bundle bytes (testable, and a resend is byte-identical).
    static func fullUrl(system: String, value: String) -> String {
        var bytes = Array(SHA256.hash(data: Data("\(system)|\(value)".utf8)).prefix(16))
        bytes[6] = (bytes[6] & 0x0F) | 0x50 // version 5 style
        bytes[8] = (bytes[8] & 0x3F) | 0x80 // RFC 4122 variant
        let hex = bytes.map { String(format: "%02x", $0) }.joined()
        let s = Array(hex)
        func part(_ a: Int, _ b: Int) -> String { String(s[a..<b]) }
        return "urn:uuid:\(part(0, 8))-\(part(8, 12))-\(part(12, 16))-\(part(16, 20))-\(part(20, 32))"
    }
}
