//
// This source file is part of the Spezi POC capture app, adapted from the Stanford Spezi Template Application
//
// SPDX-FileCopyrightText: 2023 Stanford University and the project authors (see CONTRIBUTORS.md)
//
// SPDX-License-Identifier: MIT
//

import Foundation


/// The claims of an access token, read from its payload **without verifying the signature**.
///
/// For display only (who is signed in, which roles, until when). Nothing may be authorized on this: the server
/// (HAPI) verifies the token's signature, issuer, audience and expiry on every request, and that is the only check
/// that counts.
struct TokenClaims: Equatable, Sendable {
    enum Failure: Error, Equatable {
        case malformed
    }
    
    let subject: String?
    let preferredUsername: String?
    let roles: [String]
    let expiresAt: Date?
    
    
    init(jwt: String) throws(Failure) {
        let segments = jwt.split(separator: ".", omittingEmptySubsequences: false)
        guard segments.count == 3, let payload = Self.base64URLDecode(String(segments[1])),
              let object = try? JSONSerialization.jsonObject(with: payload) as? [String: Any] else {
            throw .malformed
        }
        subject = object["sub"] as? String
        preferredUsername = object["preferred_username"] as? String
        roles = (object["roles"] as? [String]) ?? []
        expiresAt = (object["exp"] as? NSNumber).map { Date(timeIntervalSince1970: $0.doubleValue) }
    }
    
    
    private static func base64URLDecode(_ string: String) -> Data? {
        var base64 = string.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        base64 += String(repeating: "=", count: (4 - base64.count % 4) % 4)
        return Data(base64Encoded: base64)
    }
}
