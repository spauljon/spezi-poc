//
// This source file is part of the Spezi POC capture app, adapted from the Stanford Spezi Template Application
//
// SPDX-FileCopyrightText: 2023 Stanford University and the project authors (see CONTRIBUTORS.md)
//
// SPDX-License-Identifier: MIT
//

import Foundation
import Observation


/// Which data source is actually in effect, and why. The stored choice is the user's wish; the effective source is what
/// the gate allows right now (signing out pauses Apple Health without forgetting the choice).
@MainActor
@Observable
final class SourceModel {
    private(set) var gate: HealthKitGate = .unavailable(.notConfigured)
    private(set) var effective: DataSource = .synthetic
    private(set) var counters = HealthKitBridge.Counters()
    /// A sentence for the user when asking for Apple Health access did not work out.
    var message: String?
    
    func update(stored: DataSource, gate: HealthKitGate) {
        self.gate = gate
        effective = DataSource.effective(stored, gate: gate)
    }
    
    func refreshCounters() async {
        counters = await HealthKitBridge.shared.counters
    }
}
