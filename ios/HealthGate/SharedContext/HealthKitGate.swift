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
            case .signedOut: "Sign in first: real data is only ever sent to your own server, authenticated. Samples that arrive meanwhile are held on this device."
            }
        }
    }
    
    case available
    case unavailable(Reason)
    
    var isAvailable: Bool { self == .available }
    
    /// Collection may START only when the gate is open.
    func mayStartCollection(chosen: Bool) -> Bool {
        chosen && isAvailable
    }
    
    /// Samples that arrive are kept (queued locally) when Apple Health is chosen and the gate is open, OR it is closed
    /// only because the user signed out. That state is transient: the engine uploads nothing without a token ("Sign in
    /// to upload."), and dropping would be permanent, because SpeziHealthKit has no pause that keeps its anchor
    /// (`resetSampleCollection` clears it) and the anchor has already moved past what the callback received.
    func acceptsSamples(chosen: Bool) -> Bool {
        guard chosen else { return false }
        switch self {
        case .available, .unavailable(.signedOut): return true
        case .unavailable: return false
        }
    }
    
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
