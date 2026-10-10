//
// This source file is part of the Spezi POC capture app, adapted from the Stanford Spezi Template Application
//
// SPDX-FileCopyrightText: 2023 Stanford University and the project authors (see CONTRIBUTORS.md)
//
// SPDX-License-Identifier: MIT
//

@testable import TemplateApplication
import Foundation
import SpeziKeychainStorage
import Testing


// MARK: - Fixtures (synthetic: unsigned tokens made here, no real credential anywhere)

private func base64URL(_ object: [String: Any]) -> String {
    let data = (try? JSONSerialization.data(withJSONObject: object)) ?? Data()
    return data.base64EncodedString()
        .replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
}

private func jwt(user: String? = "capture-user", roles: [String]? = ["capture-writer"], expiresIn: TimeInterval = 600, now: Date = .now) -> String {
    var payload: [String: Any] = ["sub": "00000000-synthetic", "exp": Int(now.addingTimeInterval(expiresIn).timeIntervalSince1970)]
    if let user { payload["preferred_username"] = user }
    if let roles { payload["roles"] = roles }
    return "\(base64URL(["alg": "RS256", "typ": "JWT"])).\(base64URL(payload)).synthetic-signature"
}

private let issuer = "https://idp.example.test:8444/realms/poc"

private func configuration(issuer: String = issuer) throws -> ServerConfiguration {
    try ServerConfiguration(info: [
        ServerConfiguration.Key.fhirBaseURL: "https://fhir.example.test:8443/fhir",
        ServerConfiguration.Key.issuerURL: issuer,
        ServerConfiguration.Key.clientID: "ios-capture",
        ServerConfiguration.Key.redirectScheme: "com.example.poc"
    ])
}

private func tokens(expiresIn: TimeInterval = 600, refresh: String? = "refresh-1", issuer: String = issuer, now: Date = .now) -> TokenSet {
    TokenSet(accessToken: jwt(expiresIn: expiresIn, now: now), refreshToken: refresh, idToken: nil,
             expiresAt: now.addingTimeInterval(expiresIn), issuer: issuer)
}

/// A scripted OIDC client that records what it was asked to do.
private final class FakeClient: OIDCClient, @unchecked Sendable {
    var signInResult: Result<TokenSet, AuthError> = .failure(.failed("not scripted"))
    var refreshResult: Result<TokenSet, AuthError> = .failure(.failed("not scripted"))
    private(set) var signIns = 0
    private(set) var refreshes = 0
    
    func signIn(configuration: ServerConfiguration) async throws(AuthError) -> TokenSet {
        signIns += 1
        return try signInResult.get()
    }
    
    func refresh(_ tokens: TokenSet, configuration: ServerConfiguration) async throws(AuthError) -> TokenSet {
        refreshes += 1
        return try refreshResult.get()
    }
}


// MARK: - Tokens

@Suite("Token set")
struct TokenSetTests {
    @Test("refresh is due inside the skew window and not outside it")
    func refreshWindow() {
        let now = Date.now
        let soon = tokens(expiresIn: TokenSet.refreshSkew - 1, now: now)
        let later = tokens(expiresIn: TokenSet.refreshSkew + 30, now: now)
        #expect(soon.needsRefresh(at: now))
        #expect(!later.needsRefresh(at: now)) // positive control for the line above
        #expect(!soon.isExpired(at: now)) // due for refresh is not the same as expired
        #expect(tokens(expiresIn: -1, now: now).isExpired(at: now))
    }
    
    @Test("the description never contains a token")
    func redacted() {
        let set = tokens()
        #expect(!"\(set)".contains(set.accessToken))
        #expect(!String(reflecting: set).contains(set.accessToken))
        #expect(!"\(set)".contains("refresh-1"))
    }
}

@Suite("Token claims")
struct TokenClaimsTests {
    @Test("reads user, roles and expiry from a payload")
    func readsClaims() throws {
        let claims = try TokenClaims(jwt: jwt(roles: ["capture-writer", "x"], expiresIn: 600))
        #expect(claims.preferredUsername == "capture-user")
        #expect(claims.roles == ["capture-writer", "x"])
        #expect(claims.expiresAt != nil)
    }
    
    @Test("absent roles are an empty list, not a failure")
    func absentRoles() throws {
        #expect(try TokenClaims(jwt: jwt(roles: nil)).roles == [])
    }
    
    @Test("malformed input is refused", arguments: ["", "a.b", "a.b.c.d", "a.!!!.c", "a.\(Data("not json".utf8).base64EncodedString()).c"])
    func malformed(_ value: String) {
        #expect(throws: TokenClaims.Failure.malformed) { try TokenClaims(jwt: value) }
    }
}


// MARK: - Store

@Suite("Token store")
struct TokenStoreTests {
    @Test("the Keychain round-trips a token set, replaces it, and clears it")
    func keychainRoundTrip() throws {
        // A unique service name: this never touches a real sign-in on the same simulator.
        let store = KeychainTokenStore(service: "com.blueysoft.spezipoc.tests.\(UUID().uuidString)")
        defer { try? store.clear() }
        #expect(try store.load() == nil)
        
        let first = tokens()
        try store.save(first)
        #expect(try store.load() == first)
        
        let second = tokens(refresh: "refresh-2")
        try store.save(second)
        #expect(try store.load() == second) // replaced, not duplicated
        
        try store.clear()
        #expect(try store.load() == nil)
    }
}


// MARK: - Service

@MainActor
@Suite("Auth service")
struct AuthServiceTests {
    private func makeService(store: InMemoryTokenStore = InMemoryTokenStore(), client: FakeClient = FakeClient()) -> (AuthService, InMemoryTokenStore, FakeClient) {
        (AuthService(client: client, store: store), store, client)
    }
    
    @Test("a successful sign-in stores the tokens and shows who is signed in, without exposing the token")
    func signIn() async throws {
        let (service, store, client) = makeService()
        client.signInResult = .success(tokens())
        await service.signIn(configuration: try configuration())
        
        guard case .signedIn(let session) = service.state else {
            Issue.record("expected signedIn, got \(service.state)")
            return
        }
        #expect(session.username == "capture-user")
        #expect(session.roles == ["capture-writer"])
        #expect(try store.load() != nil)
        #expect(client.signIns == 1)
    }
    
    @Test("cancelling the browser sheet is not an error and stores nothing")
    func cancelled() async throws {
        let (service, store, client) = makeService()
        client.signInResult = .failure(.cancelled)
        await service.signIn(configuration: try configuration())
        #expect(service.state == .signedOut)
        #expect(try store.load() == nil)
    }
    
    @Test("a failed sign-in is reported and stores nothing")
    func failed() async throws {
        let (service, store, client) = makeService()
        client.signInResult = .failure(.failed("The server could not be reached."))
        await service.signIn(configuration: try configuration())
        #expect(service.state == .failed("The server could not be reached."))
        #expect(try store.load() == nil)
    }
    
    @Test("sign-out clears the stored tokens")
    func signOut() async throws {
        let (service, store, client) = makeService()
        client.signInResult = .success(tokens())
        await service.signIn(configuration: try configuration())
        service.signOut()
        #expect(service.state == .signedOut)
        #expect(try store.load() == nil)
    }
    
    @Test("restore keeps a usable session")
    func restoreUsable() throws {
        let (service, _, _) = makeService(store: InMemoryTokenStore(tokens()))
        service.restore(configuration: try configuration())
        guard case .signedIn = service.state else {
            Issue.record("expected signedIn, got \(service.state)")
            return
        }
    }
    
    @Test("restore drops tokens that are expired with no refresh token")
    func restoreExpired() throws {
        let (service, store, _) = makeService(store: InMemoryTokenStore(tokens(expiresIn: -30, refresh: nil)))
        service.restore(configuration: try configuration())
        #expect(service.state == .signedOut)
        #expect(try store.load() == nil)
    }
    
    @Test("restore keeps expired tokens that can still be refreshed")
    func restoreRefreshable() throws {
        let (service, store, _) = makeService(store: InMemoryTokenStore(tokens(expiresIn: -30, refresh: "refresh-1")))
        service.restore(configuration: try configuration())
        guard case .signedIn = service.state else {
            Issue.record("expected signedIn, got \(service.state)")
            return
        }
        #expect(try store.load() != nil)
    }
    
    @Test("restore drops tokens issued by a different issuer")
    func restoreOtherIssuer() throws {
        let (service, store, _) = makeService(store: InMemoryTokenStore(tokens(issuer: "https://elsewhere.example.test/realms/x")))
        service.restore(configuration: try configuration())
        #expect(service.state == .signedOut)
        #expect(try store.load() == nil)
    }
    
    @Test("a token with time left is returned as is, with no refresh")
    func noRefreshNeeded() async throws {
        let stored = tokens(expiresIn: 600)
        let (service, _, client) = makeService(store: InMemoryTokenStore(stored))
        let token = try await service.accessToken(configuration: try configuration())
        #expect(token == stored.accessToken)
        #expect(client.refreshes == 0)
    }
    
    @Test("a token inside the skew window is refreshed, and the new one is stored and returned")
    func refreshes() async throws {
        let (service, store, client) = makeService(store: InMemoryTokenStore(tokens(expiresIn: 20)))
        let renewed = tokens(expiresIn: 600, refresh: "refresh-2")
        client.refreshResult = .success(renewed)
        let token = try await service.accessToken(configuration: try configuration())
        #expect(token == renewed.accessToken)
        #expect(try store.load() == renewed)
        #expect(client.refreshes == 1)
    }
    
    @Test("a refresh the server refuses ends the session")
    func refreshRefused() async throws {
        let (service, store, client) = makeService(store: InMemoryTokenStore(tokens(expiresIn: 20)))
        client.refreshResult = .failure(.failed("invalid_grant"))
        await #expect(throws: AuthError.failed("invalid_grant")) { try await service.accessToken(configuration: try configuration()) }
        #expect(service.state == .signedOut)
        #expect(try store.load() == nil)
    }
    
    @Test("an expired token with no refresh token signs out instead of being sent")
    func expiredNoRefresh() async throws {
        let (service, store, client) = makeService(store: InMemoryTokenStore(tokens(expiresIn: -5, refresh: nil)))
        await #expect(throws: AuthError.signedOut) { try await service.accessToken(configuration: try configuration()) }
        #expect(try store.load() == nil)
        #expect(client.refreshes == 0)
    }
    
    @Test("with nothing stored there is no token to give")
    func nothingStored() async throws {
        let (service, _, _) = makeService()
        await #expect(throws: AuthError.signedOut) { try await service.accessToken(configuration: try configuration()) }
    }
}
