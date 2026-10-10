//
// This source file is part of the Spezi POC capture app, adapted from the Stanford Spezi Template Application
//
// SPDX-FileCopyrightText: 2023 Stanford University and the project authors (see CONTRIBUTORS.md)
//
// SPDX-License-Identifier: MIT
//

import Foundation
import SpeziKeychainStorage


/// Where the tokens live between launches.
protocol TokenStore: Sendable {
    func load() throws -> TokenSet?
    func save(_ tokens: TokenSet) throws
    func clear() throws
}


/// The Keychain, via Spezi's `KeychainStorage`: never `UserDefaults`, never a file.
final class KeychainTokenStore: TokenStore {
    static let defaultService = "com.blueysoft.spezipoc.tokens"
    private static let account = "capture"
    
    private let keychain: KeychainStorage
    private let tag: CredentialsTag
    
    
    /// - Parameter service: the Keychain service name; tests pass a unique one so they never touch a real session.
    init(keychain: KeychainStorage = KeychainStorage(), service: String = KeychainTokenStore.defaultService) {
        self.keychain = keychain
        self.tag = CredentialsTag.genericPassword(forService: service)
    }
    
    
    func load() throws -> TokenSet? {
        guard let credentials = try keychain.retrieveCredentials(withUsername: Self.account, for: tag) else {
            return nil
        }
        return try JSONDecoder().decode(TokenSet.self, from: Data(credentials.password.utf8))
    }
    
    func save(_ tokens: TokenSet) throws {
        let json = String(decoding: try JSONEncoder().encode(tokens), as: UTF8.self)
        try keychain.store(Credentials(username: Self.account, password: json), for: tag)
    }
    
    func clear() throws {
        try keychain.deleteCredentials(withUsername: Self.account, for: tag)
    }
}


/// For tests: same contract, no Keychain.
final class InMemoryTokenStore: TokenStore, @unchecked Sendable {
    private let lock = NSLock()
    private var tokens: TokenSet?
    
    init(_ tokens: TokenSet? = nil) {
        self.tokens = tokens
    }
    
    func load() throws -> TokenSet? {
        lock.withLock { tokens }
    }
    
    func save(_ tokens: TokenSet) throws {
        lock.withLock { self.tokens = tokens }
    }
    
    func clear() throws {
        lock.withLock { tokens = nil }
    }
}
