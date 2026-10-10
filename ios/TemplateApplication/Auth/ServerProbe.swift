//
// This source file is part of the Spezi POC capture app, adapted from the Stanford Spezi Template Application
//
// SPDX-FileCopyrightText: 2023 Stanford University and the project authors (see CONTRIBUTORS.md)
//
// SPDX-License-Identifier: MIT
//

import Foundation


/// One request against the FHIR server, and whether the answer is the one the design expects.
struct ServerCheck: Equatable, Identifiable, Sendable {
    let label: String
    let expected: Int
    /// The HTTP status, or nil when no response came back (``failure`` says why).
    let status: Int?
    let failure: String?
    
    var id: String { label }
    var passed: Bool { status == expected }
}


/// A three-line proof, from the device, that the server enforces what M4 built: the capability statement is public, a
/// data request without a token is refused, and the same request with the signed-in user's token is served.
enum ServerProbe {
    static func run(configuration: ServerConfiguration, accessToken: String?, session: URLSession = .shared) async -> [ServerCheck] {
        let base = configuration.fhirBaseURL
        var checks = [
            await check("Capability statement, no token", expected: 200, url: base.appending(path: "metadata"), token: nil, session: session),
            await check("Patient search, no token", expected: 401, url: patients(base), token: nil, session: session)
        ]
        if let accessToken {
            checks.append(await check("Patient search, your token", expected: 200, url: patients(base), token: accessToken, session: session))
        }
        return checks
    }
    
    
    private static func patients(_ base: URL) -> URL {
        base.appending(path: "Patient").appending(queryItems: [URLQueryItem(name: "_count", value: "1")])
    }
    
    private static func check(_ label: String, expected: Int, url: URL, token: String?, session: URLSession) async -> ServerCheck {
        var request = URLRequest(url: url, timeoutInterval: 10)
        request.setValue("application/fhir+json", forHTTPHeaderField: "Accept")
        if let token {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        do {
            let (_, response) = try await session.data(for: request)
            return ServerCheck(label: label, expected: expected, status: (response as? HTTPURLResponse)?.statusCode, failure: nil)
        } catch {
            return ServerCheck(label: label, expected: expected, status: nil, failure: (error as NSError).localizedDescription)
        }
    }
}
