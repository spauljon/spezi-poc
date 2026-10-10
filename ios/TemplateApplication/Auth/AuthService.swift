//
// This source file is part of the Spezi POC capture app, adapted from the Stanford Spezi Template Application
//
// SPDX-FileCopyrightText: 2023 Stanford University and the project authors (see CONTRIBUTORS.md)
//
// SPDX-License-Identifier: MIT
//

import Foundation
import Observation


/// Sign-in state and token lifecycle: sign in, restore at launch, refresh before expiry, sign out.
///
/// The library and the Keychain sit behind ``OIDCClient`` and ``TokenStore``, so this logic is unit-tested with fakes.
/// Tokens are never exposed in `state`: the UI sees only who is signed in, their roles and the expiry.
@MainActor
@Observable
final class AuthService {
    struct Session: Equatable {
        let username: String?
        let roles: [String]
        let expiresAt: Date
    }
    
    enum State: Equatable {
        case signedOut
        case signingIn
        case signedIn(Session)
        case failed(String)
    }
    
    
    private(set) var state = State.signedOut
    
    @ObservationIgnored private let client: any OIDCClient
    @ObservationIgnored private let store: any TokenStore
    @ObservationIgnored private let now: @Sendable () -> Date
    
    
    init(client: any OIDCClient, store: any TokenStore, now: @escaping @Sendable () -> Date = { .now }) {
        self.client = client
        self.store = store
        self.now = now
    }
    
    /// The real thing: AppAuth and the Keychain.
    static func live() -> AuthService {
        AuthService(client: AppAuthClient(), store: KeychainTokenStore())
    }
    
    
    /// Called at launch: picks up a previous sign-in if it is still usable, and drops it otherwise.
    func restore(configuration: ServerConfiguration) {
        guard let tokens = try? store.load() else {
            state = .signedOut
            return
        }
        // Tokens from another issuer (the configuration changed) or expired with no way to refresh are useless.
        guard tokens.issuer == configuration.issuerURL.absoluteString,
              !tokens.isExpired(at: now()) || tokens.refreshToken != nil else {
            try? store.clear()
            state = .signedOut
            return
        }
        state = .signedIn(session(for: tokens))
    }
    
    func signIn(configuration: ServerConfiguration) async {
        guard state != .signingIn else {
            return
        }
        state = .signingIn
        do {
            let tokens = try await client.signIn(configuration: configuration)
            try store.save(tokens)
            state = .signedIn(session(for: tokens))
        } catch AuthError.cancelled {
            state = .signedOut // the user changed their mind: not an error
        } catch AuthError.failed(let message) {
            state = .failed(message)
        } catch {
            state = .failed("Could not sign in.")
        }
    }
    
    func signOut() {
        try? store.clear()
        state = .signedOut
    }
    
    /// A usable access token, refreshed first if it expires within ``TokenSet/refreshSkew``.
    func accessToken(configuration: ServerConfiguration) async throws(AuthError) -> String {
        guard var tokens = try? store.load() else {
            state = .signedOut
            throw .signedOut
        }
        if tokens.needsRefresh(at: now()) {
            guard tokens.refreshToken != nil else {
                if tokens.isExpired(at: now()) {
                    signOut()
                    throw .signedOut
                }
                return tokens.accessToken // not yet expired, nothing to refresh with
            }
            do {
                tokens = try await client.refresh(tokens, configuration: configuration)
                try? store.save(tokens)
                state = .signedIn(session(for: tokens))
            } catch {
                signOut() // a refresh the server refused means the session is over
                throw error
            }
        }
        return tokens.accessToken
    }
    
    
    private func session(for tokens: TokenSet) -> Session {
        let claims = try? TokenClaims(jwt: tokens.accessToken)
        return Session(username: claims?.preferredUsername, roles: claims?.roles ?? [], expiresAt: tokens.expiresAt)
    }
}
