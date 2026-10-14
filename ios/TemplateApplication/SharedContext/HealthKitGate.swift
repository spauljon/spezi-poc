//
// This source file is part of the Spezi POC capture app, adapted from the Stanford Spezi Template Application
//
// SPDX-FileCopyrightText: 2023 Stanford University and the project authors (see CONTRIBUTORS.md)
//
// SPDX-License-Identifier: MIT
//

import Foundation


/// Whether real Apple Health data may be read and sent. It may only when the destination is configured over TLS (the
/// configuration refuses anything but https), real data has a patient of its own, and the user is signed in (every
/// upload carries a bearer token). One pure function, so each reason is a test.
enum HealthKitGate: Equatable, Sendable {
    enum Reason: Equatable, Sendable {
        case healthDataUnavailable
        case notConfigured
        case noSeparatePatient
        case signedOut
        
        var message: String {
            switch self {
            case .healthDataUnavailable: "Apple Health is not available on this device."
            case .notConfigured: "The server is not configured (an https address is required)."
            case .noSeparatePatient: "No separate patient is configured for real data (POC_HEALTHKIT_PATIENT_IDENTIFIER), so real data would have nowhere safe to go."
            case .signedOut: "Sign in first: real data is only ever sent to your own server, authenticated."
            }
        }
    }
    
    case available
    case unavailable(Reason)
    
    var isAvailable: Bool { self == .available }
    
    static func evaluate(
        configuration: Result<ServerConfiguration, ServerConfiguration.Failure>,
        signedIn: Bool,
        healthDataAvailable: Bool
    ) -> HealthKitGate {
        guard healthDataAvailable else { return .unavailable(.healthDataUnavailable) }
        guard case .success(let configuration) = configuration else { return .unavailable(.notConfigured) }
        guard configuration.healthKitPatientIdentifier != nil else { return .unavailable(.noSeparatePatient) }
        guard signedIn else { return .unavailable(.signedOut) }
        return .available
    }
}
