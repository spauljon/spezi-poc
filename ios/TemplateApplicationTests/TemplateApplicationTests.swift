//
// This source file is part of the Spezi POC capture app, adapted from the Stanford Spezi Template Application
//
// SPDX-FileCopyrightText: 2023 Stanford University and the project authors (see CONTRIBUTORS.md)
//
// SPDX-License-Identifier: MIT
//

@testable import TemplateApplication
import Foundation
import Testing


@Suite("Server configuration")
struct ServerConfigurationTests {
    private var valid: [String: Any] {
        [
            ServerConfiguration.Key.fhirBaseURL: "https://fhir.example.test:8443/fhir",
            ServerConfiguration.Key.issuerURL: "https://idp.example.test:8444/realms/poc",
            ServerConfiguration.Key.clientID: "ios-capture",
            ServerConfiguration.Key.redirectScheme: "com.example.poc"
        ]
    }
    
    /// Returns the failure for a copy of the valid settings with one key changed (nil removes it), or nil if it parsed.
    private func failure(changing key: String, to value: String?) -> ServerConfiguration.Failure? {
        var info = valid
        info[key] = value
        do {
            _ = try ServerConfiguration(info: info)
            return nil
        } catch {
            return error
        }
    }
    
    @Test("valid settings parse (the positive control for every refusal below)")
    func validSettings() throws {
        let configuration = try ServerConfiguration(info: valid)
        #expect(configuration.fhirBaseURL.absoluteString == "https://fhir.example.test:8443/fhir")
        #expect(configuration.issuerURL.host == "idp.example.test")
        #expect(configuration.clientID == "ios-capture")
        #expect(configuration.redirectURI.absoluteString == "com.example.poc:/oauth2redirect")
    }
    
    @Test("plain http is refused for both URLs")
    func httpRefused() {
        #expect(failure(changing: ServerConfiguration.Key.fhirBaseURL, to: "http://fhir.example.test:8192/fhir") == .notHTTPS(ServerConfiguration.Key.fhirBaseURL))
        #expect(failure(changing: ServerConfiguration.Key.issuerURL, to: "http://idp.example.test/realms/poc") == .notHTTPS(ServerConfiguration.Key.issuerURL))
    }
    
    @Test("a missing or blank setting is refused")
    func missing() {
        #expect(failure(changing: ServerConfiguration.Key.clientID, to: nil) == .missing(ServerConfiguration.Key.clientID))
        #expect(failure(changing: ServerConfiguration.Key.clientID, to: "   ") == .missing(ServerConfiguration.Key.clientID))
    }
    
    @Test("an unresolved build-setting placeholder is refused")
    func unresolved() {
        #expect(failure(changing: ServerConfiguration.Key.fhirBaseURL, to: "$(POC_FHIR_BASE_URL)") == .unresolved(ServerConfiguration.Key.fhirBaseURL))
    }
    
    @Test("a URL without a host and a malformed scheme are refused")
    func invalid() {
        #expect(failure(changing: ServerConfiguration.Key.issuerURL, to: "https://") != nil)
        #expect(failure(changing: ServerConfiguration.Key.redirectScheme, to: "not a scheme") == .invalid(ServerConfiguration.Key.redirectScheme))
    }
    
    @Test("the shipped Info.plist resolves to usable settings")
    func shippedConfiguration() {
        // The tests are hosted by the app, so Bundle.main is the app's own Info.plist, filled in from
        // Config/Defaults.xcconfig at build time. This catches the xcconfig not being wired in.
        guard case .success(let configuration) = ServerConfiguration.load(bundle: .main) else {
            Issue.record("the app's Info.plist did not resolve to a valid server configuration")
            return
        }
        #expect(configuration.fhirBaseURL.scheme == "https")
        #expect(configuration.issuerURL.path.hasSuffix("/realms/poc"))
    }
}


@Suite("Data source")
struct DataSourceTests {
    @Test("only the synthetic source is available")
    func availability() {
        #expect(DataSource.synthetic.isAvailable)
        #expect(!DataSource.appleHealth.isAvailable)
    }
    
    @Test("an unavailable stored choice falls back to synthetic")
    func fallback() {
        #expect(DataSource.effective(.appleHealth) == .synthetic)
        #expect(DataSource.effective(.synthetic) == .synthetic)
    }
}
