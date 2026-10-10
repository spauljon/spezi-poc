//
// This source file is part of the Spezi POC capture app, adapted from the Stanford Spezi Template Application
//
// SPDX-FileCopyrightText: 2023 Stanford University and the project authors (see CONTRIBUTORS.md)
//
// SPDX-License-Identifier: MIT
//

import Foundation


enum AuthError: Error, Equatable {
    /// The user closed the sign-in browser sheet.
    case cancelled
    /// Discovery, the authorization request or the token exchange failed (the message carries no token).
    case failed(String)
    /// The server returned no refresh token, or refreshing is not possible.
    case notRefreshable
    /// Nothing is signed in.
    case signedOut
}


/// The OpenID Connect operations the app needs. The AppAuth implementation is the only code that touches the library;
/// everything else (and the tests) talk to this.
protocol OIDCClient: Sendable {
    /// Authorization code + PKCE (S256) in the system browser session; returns the resulting tokens.
    func signIn(configuration: ServerConfiguration) async throws(AuthError) -> TokenSet
    /// The refresh-token grant.
    func refresh(_ tokens: TokenSet, configuration: ServerConfiguration) async throws(AuthError) -> TokenSet
}
