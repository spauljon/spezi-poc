//
// This source file is part of the Spezi POC capture app, adapted from the Stanford Spezi Template Application
//
// SPDX-FileCopyrightText: 2023 Stanford University and the project authors (see CONTRIBUTORS.md)
//
// SPDX-License-Identifier: MIT
//

/// Where measurements come from.
///
/// Both cases sit behind the same ingest interface (added in the next milestones), so the app, the tests and the
/// simulator can run on the synthetic source while Apple Health stays off.
enum DataSource: String, CaseIterable, Identifiable, Sendable {
    case synthetic
    case appleHealth
    
    var id: String { rawValue }
    
    var title: String {
        switch self {
        case .synthetic: "Synthetic"
        case .appleHealth: "Apple Health"
        }
    }
    
    var detail: String {
        switch self {
        case .synthetic: "Generated on this device. No real health data is read or sent."
        case .appleHealth: "Your own measurements, read from Apple Health and sent to your own server. Choose it on the home screen after signing in."
        }
    }
    
    /// Whether the source can be chosen WITHOUT any context (onboarding, before sign-in). Apple Health needs a verified
    /// server and a signed-in user, so it is chosen on the home screen, where `HealthKitGate` decides.
    var isAvailable: Bool {
        self == .synthetic
    }
    
    /// The simulator controls exist only for the synthetic source; a real source has no such controls.
    var showsSimulator: Bool {
        self == .synthetic
    }
    
    /// A stored choice that is not available (for example left over from a newer build) falls back to synthetic.
    static func effective(_ stored: DataSource) -> DataSource {
        stored.isAvailable ? stored : .synthetic
    }
    
    /// With the gate: Apple Health is in effect only while it is allowed (TLS, a separate patient, signed in).
    static func effective(_ stored: DataSource, gate: HealthKitGate) -> DataSource {
        switch (stored, gate) {
        case (.appleHealth, .available): .appleHealth
        default: .synthetic
        }
    }
}
