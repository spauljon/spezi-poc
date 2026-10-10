//
// This source file is part of the Spezi POC capture app, adapted from the Stanford Spezi Template Application
//
// SPDX-FileCopyrightText: 2023 Stanford University and the project authors (see CONTRIBUTORS.md)
//
// SPDX-License-Identifier: MIT
//

import Foundation


/// Where the app sends data and how it signs in, read from the app's Info.plist.
///
/// The plist values come from build settings (`ios/Config/Defaults.xcconfig`, overridable by the git-ignored
/// `ios/Config/Local.xcconfig`), so nothing environment-specific lives in Swift source. Nothing here is secret: the
/// client is a public client (authorization code with PKCE) and the user's password is only ever typed into
/// Keycloak's own login page.
struct ServerConfiguration: Equatable, Sendable {
    enum Failure: Error, Equatable {
        case missing(String)
        case unresolved(String)
        case notHTTPS(String)
        case invalid(String)
        
        var message: String {
            switch self {
            case .missing(let key): "Setting \(key) is missing."
            case .unresolved(let key): "Setting \(key) was not filled in at build time."
            case .notHTTPS(let key): "Setting \(key) must be an https URL: this app only talks TLS."
            case .invalid(let key): "Setting \(key) is not valid."
            }
        }
    }
    
    /// Info.plist keys.
    enum Key {
        static let fhirBaseURL = "POCFHIRBaseURL"
        static let issuerURL = "POCIssuerURL"
        static let clientID = "POCClientID"
        static let redirectScheme = "POCRedirectScheme"
    }
    
    /// The FHIR base, for example `https://macpro16.local:8443/fhir`.
    let fhirBaseURL: URL
    /// The OpenID issuer, for example `https://macpro16.local:8444/realms/poc`.
    let issuerURL: URL
    let clientID: String
    /// The custom URL scheme of the redirect URI.
    let redirectScheme: String
    
    /// The redirect URI registered for this client in the realm (`<scheme>:/oauth2redirect`).
    var redirectURI: URL {
        // The scheme was validated in init, so this cannot fail.
        URL(string: "\(redirectScheme):/oauth2redirect") ?? fhirBaseURL
    }
    
    
    init(info: [String: Any]) throws(Failure) {
        fhirBaseURL = try Self.httpsURL(info, Key.fhirBaseURL)
        issuerURL = try Self.httpsURL(info, Key.issuerURL)
        clientID = try Self.string(info, Key.clientID)
        redirectScheme = try Self.string(info, Key.redirectScheme)
        guard redirectScheme.range(of: #"^[A-Za-z][A-Za-z0-9+.-]*$"#, options: .regularExpression) != nil else {
            throw .invalid(Key.redirectScheme)
        }
    }
    
    static func load(bundle: Bundle = .main) -> Result<ServerConfiguration, Failure> {
        do {
            return .success(try ServerConfiguration(info: bundle.infoDictionary ?? [:]))
        } catch {
            return .failure(error)
        }
    }
    
    
    private static func string(_ info: [String: Any], _ key: String) throws(Failure) -> String {
        guard let value = (info[key] as? String)?.trimmingCharacters(in: .whitespaces), !value.isEmpty else {
            throw .missing(key)
        }
        guard !value.contains("$(") else {
            throw .unresolved(key)
        }
        return value
    }
    
    private static func httpsURL(_ info: [String: Any], _ key: String) throws(Failure) -> URL {
        let value = try string(info, key)
        guard let url = URL(string: value), url.host?.isEmpty == false else {
            throw .invalid(key)
        }
        guard url.scheme?.lowercased() == "https" else {
            throw .notHTTPS(key)
        }
        return url
    }
}
