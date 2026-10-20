//
// This source file is part of the Spezi POC capture app, adapted from the Stanford Spezi Template Application
//
// SPDX-FileCopyrightText: 2023 Stanford University and the project authors (see CONTRIBUTORS.md)
//
// SPDX-License-Identifier: MIT
//

@preconcurrency import AppAuth
import Foundation
import UIKit


/// AppAuth-iOS 3.0.0 behind ``OIDCClient``.
///
/// - Flow: authorization code with PKCE `S256` (AppAuth's standard request does this; `state` and `nonce` are generated
///   and checked by AppAuth, and the ID token's issuer, audience, expiry and nonce are validated).
/// - The browser session is **ephemeral**: it shares no cookies with Safari, so signing out here really signs out
///   (no lingering Keycloak single-sign-on session).
/// - Everything runs on the main actor: AppAuth presents UI and its types are not `Sendable`.
@MainActor
final class AppAuthClient: OIDCClient {
    private var session: (any OIDExternalUserAgentSession)?
    
    
    nonisolated init() {}
    
    
    func signIn(configuration: ServerConfiguration) async throws(AuthError) -> TokenSet {
        let discovered = try await discover(configuration)
        let request = OIDAuthorizationRequest(
            configuration: discovered,
            clientId: configuration.clientID,
            clientSecret: nil, // public client: PKCE, no secret
            scopes: [OIDScopeOpenID, OIDScopeProfile],
            redirectURL: configuration.redirectURI,
            responseType: OIDResponseTypeCode,
            additionalParameters: nil
        )
        guard let presenter = Self.topViewController() else {
            throw .failed("No window to present the sign-in sheet from.")
        }
        
        do {
            let state: OIDAuthState = try await withCheckedThrowingContinuation { continuation in
                session = OIDAuthState.authState(byPresenting: request, presenting: presenter, prefersEphemeralSession: true) { state, error in
                    if let state {
                        continuation.resume(returning: state)
                    } else {
                        continuation.resume(throwing: error ?? AuthError.failed("Sign-in returned nothing."))
                    }
                }
            }
            session = nil
            return try Self.tokenSet(from: state.lastTokenResponse, issuer: configuration.issuerURL.absoluteString)
        } catch let error as AuthError {
            session = nil
            throw error
        } catch {
            session = nil
            throw Self.map(error)
        }
    }
    
    func refresh(_ tokens: TokenSet, configuration: ServerConfiguration) async throws(AuthError) -> TokenSet {
        guard let refreshToken = tokens.refreshToken else {
            throw .notRefreshable
        }
        let discovered = try await discover(configuration)
        let request = OIDTokenRequest(
            configuration: discovered,
            grantType: OIDGrantTypeRefreshToken,
            authorizationCode: nil,
            redirectURL: nil,
            clientID: configuration.clientID,
            clientSecret: nil,
            scope: nil,
            refreshToken: refreshToken,
            codeVerifier: nil,
            additionalParameters: nil
        )
        do {
            let response: OIDTokenResponse = try await withCheckedThrowingContinuation { continuation in
                OIDAuthorizationService.perform(request) { response, error in
                    if let response {
                        continuation.resume(returning: response)
                    } else {
                        continuation.resume(throwing: error ?? AuthError.failed("Refresh returned nothing."))
                    }
                }
            }
            var updated = try Self.tokenSet(from: response, issuer: configuration.issuerURL.absoluteString)
            // A server may omit a new refresh token; keep the one we have.
            updated.refreshToken = updated.refreshToken ?? refreshToken
            return updated
        } catch let error as AuthError {
            throw error
        } catch {
            throw Self.map(error)
        }
    }
    
    
    private func discover(_ configuration: ServerConfiguration) async throws(AuthError) -> OIDServiceConfiguration {
        do {
            return try await withCheckedThrowingContinuation { continuation in
                OIDAuthorizationService.discoverConfiguration(forIssuer: configuration.issuerURL) { discovered, error in
                    if let discovered {
                        continuation.resume(returning: discovered)
                    } else {
                        continuation.resume(throwing: error ?? AuthError.failed("Discovery returned nothing."))
                    }
                }
            }
        } catch {
            throw Self.map(error)
        }
    }
    
    private static func tokenSet(from response: OIDTokenResponse?, issuer: String) throws(AuthError) -> TokenSet {
        guard let response, let accessToken = response.accessToken else {
            throw .failed("The server returned no access token.")
        }
        return TokenSet(
            accessToken: accessToken,
            refreshToken: response.refreshToken,
            idToken: response.idToken,
            expiresAt: response.accessTokenExpirationDate ?? Date().addingTimeInterval(60),
            issuer: issuer
        )
    }
    
    private static func map(_ error: any Error) -> AuthError {
        let nsError = error as NSError
        if nsError.domain == OIDGeneralErrorDomain, nsError.code == OIDErrorCode.userCanceledAuthorizationFlow.rawValue {
            return .cancelled
        }
        // Never include a token: AppAuth's localized descriptions do not carry one.
        return .failed(nsError.localizedDescription)
    }
    
    private static func topViewController() -> UIViewController? {
        let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first { $0.activationState == .foregroundActive }
        var top = scene?.keyWindow?.rootViewController
        while let presented = top?.presentedViewController {
            top = presented
        }
        return top
    }
}
