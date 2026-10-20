//
// This source file is part of the Spezi POC capture app, adapted from the Stanford Spezi Template Application
//
// SPDX-FileCopyrightText: 2023 Stanford University and the project authors (see CONTRIBUTORS.md)
//
// SPDX-License-Identifier: MIT
//

import Foundation


/// The tokens from one sign-in. This is the only thing persisted, and only in the Keychain.
///
/// The description is redacted on purpose: a token must not reach a log, a crash report or the UI by way of
/// string interpolation.
struct TokenSet: Codable, Equatable, Sendable, CustomStringConvertible, CustomDebugStringConvertible {
    /// Refresh this long before the access token actually expires, so a request never goes out with a token that
    /// expires in flight.
    static let refreshSkew: TimeInterval = 60
    
    var accessToken: String
    var refreshToken: String?
    var idToken: String?
    var expiresAt: Date
    /// The issuer the tokens came from; tokens from another issuer are never used.
    var issuer: String
    
    
    func isExpired(at now: Date = .now) -> Bool {
        now >= expiresAt
    }
    
    /// True once the access token is within ``refreshSkew`` of expiry (or past it).
    func needsRefresh(at now: Date = .now) -> Bool {
        now.addingTimeInterval(Self.refreshSkew) >= expiresAt
    }
    
    var description: String {
        "TokenSet(redacted, expires \(expiresAt.formatted(date: .omitted, time: .standard)), refreshable: \(refreshToken != nil))"
    }
    
    var debugDescription: String {
        description
    }
}
