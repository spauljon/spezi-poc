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
        case .appleHealth: "Your own measurements. Not available yet: added in a later milestone."
        }
    }
    
    /// Only the synthetic source exists until the HealthKit milestone.
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
}
