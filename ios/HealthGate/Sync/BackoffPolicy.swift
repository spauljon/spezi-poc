//
// This source file is part of the Spezi POC capture app, adapted from the Stanford Spezi Template Application
//
// SPDX-FileCopyrightText: 2023 Stanford University and the project authors (see CONTRIBUTORS.md)
//
// SPDX-License-Identifier: MIT
//

import Foundation


/// How long to wait before the next attempt after a transient failure: exponential, capped, with jitter so that many
/// clients (or one client's many batches) do not retry in lockstep.
struct BackoffPolicy: Equatable, Sendable {
    var base: TimeInterval = 5
    var cap: TimeInterval = 15 * 60
    /// Fraction of the delay that is randomized: 0.2 means a result in [0.8, 1.2] x the nominal delay (still capped).
    var jitter = 0.2
    
    /// - Parameters:
    ///   - attempt: 1 for the first retry.
    ///   - random: uniform in [0, 1); injected so the result is reproducible in tests.
    func delay(forAttempt attempt: Int, random: Double) -> TimeInterval {
        let exponent = min(max(attempt, 1) - 1, 30)
        let nominal = min(base * pow(2, Double(exponent)), cap)
        let factor = 1 + jitter * (2 * min(max(random, 0), 1) - 1)
        return min(nominal * factor, cap)
    }
}
