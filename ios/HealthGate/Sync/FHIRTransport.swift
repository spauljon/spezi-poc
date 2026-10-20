//
// This source file is part of the Spezi POC capture app, adapted from the Stanford Spezi Template Application
//
// SPDX-FileCopyrightText: 2023 Stanford University and the project authors (see CONTRIBUTORS.md)
//
// SPDX-License-Identifier: MIT
//

import Foundation


struct FHIRHTTPRequest: Sendable {
    var method: String
    /// Relative to the FHIR base, query included and already percent-encoded (for example `Patient?identifier=...`).
    var path: String
    var headers: [String: String] = [:]
    var body: Data?
}

struct FHIRHTTPResponse: Sendable {
    var status: Int
    var headers: [String: String] = [:]
    var body = Data()
}

/// The request never produced an HTTP response (offline, DNS, TLS, timeout...). Always worth retrying later, except
/// where the cause is a certificate problem, which retrying cannot fix but also never makes worse.
struct TransportFailure: Error, Equatable, Sendable {
    var description: String
}

/// The only place the engine touches the network, so the engine is tested with a fake.
protocol FHIRTransport: Sendable {
    /// `token` is sent as the bearer credential and is never logged.
    func send(_ request: FHIRHTTPRequest, token: String) async throws(TransportFailure) -> FHIRHTTPResponse
}


/// URLSession over TLS to the configured FHIR base. Trust is the system's: the POC's CA is installed in the device (or
/// simulator) trust store, and nothing here relaxes certificate validation.
struct URLSessionTransport: FHIRTransport {
    let baseURL: URL
    var session = URLSession.shared
    var timeout: TimeInterval = 30
    
    func send(_ request: FHIRHTTPRequest, token: String) async throws(TransportFailure) -> FHIRHTTPResponse {
        guard let url = URL(string: request.path.isEmpty ? baseURL.absoluteString : baseURL.absoluteString + "/" + request.path) else {
            throw TransportFailure(description: "The request URL is not valid.")
        }
        var urlRequest = URLRequest(url: url, timeoutInterval: timeout)
        urlRequest.httpMethod = request.method
        urlRequest.httpBody = request.body
        urlRequest.setValue("application/fhir+json", forHTTPHeaderField: "Accept")
        if request.body != nil {
            urlRequest.setValue("application/fhir+json", forHTTPHeaderField: "Content-Type")
        }
        urlRequest.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        for (name, value) in request.headers {
            urlRequest.setValue(value, forHTTPHeaderField: name)
        }
        do {
            let (data, response) = try await session.data(for: urlRequest)
            guard let http = response as? HTTPURLResponse else {
                throw TransportFailure(description: "The response was not HTTP.")
            }
            var headers: [String: String] = [:]
            for (name, value) in http.allHeaderFields {
                if let name = name as? String, let value = value as? String {
                    headers[name.lowercased()] = value
                }
            }
            return FHIRHTTPResponse(status: http.statusCode, headers: headers, body: data)
        } catch let failure as TransportFailure {
            throw failure
        } catch let error as URLError {
            throw TransportFailure(description: "Network: \(error.localizedDescription) (\(error.code.rawValue))")
        } catch {
            throw TransportFailure(description: "Network: \(error.localizedDescription)")
        }
    }
}
