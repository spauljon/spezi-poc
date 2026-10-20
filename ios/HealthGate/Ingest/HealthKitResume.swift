//
// This source file is part of the Spezi POC capture app, adapted from the Stanford Spezi Template Application
//
// SPDX-FileCopyrightText: 2023 Stanford University and the project authors (see CONTRIBUTORS.md)
//
// SPDX-License-Identifier: MIT
//

import Foundation
import HealthKit
import Spezi
import SpeziHealthKit


/// Re-registers HealthKit collection when the app is launched, with or without a screen.
///
/// Background delivery only works if the app registers its observer queries every time it starts: iOS launches the app
/// in the background to deliver, and nothing on a screen has run yet. The collectors are `start: .manual` (nothing is
/// read until the user chooses Apple Health), so once that choice has been made this module starts them at launch.
/// It starts nothing for a user who never chose Apple Health, and never opens the gate itself: the same conditions as
/// `HealthKitGate` (HealthKit available, https server, a separate patient for real data) apply, minus being signed in,
/// because a launch in the background may not have a usable session yet (samples are then held, not uploaded).
final class HealthKitResume: Module, @unchecked Sendable {
    @Dependency(HealthKit.self) private var healthKit
    
    func configure() {
        let resume = Self.shouldResume(
            storedChoice: UserDefaults.standard.string(forKey: StorageKeys.dataSource),
            configuration: ServerConfiguration.load(),
            healthDataAvailable: HKHealthStore.isHealthDataAvailable())
        guard resume else { return }
        Task { @MainActor [healthKit] in
            await healthKit.waitForConfigurationDone()
            await HealthKitBridge.shared.setEnabled(true)
            await healthKit.triggerDataSourceCollection()
        }
    }
    
    /// A pure function so each condition is a test.
    static func shouldResume(
        storedChoice: String?,
        configuration: Result<ServerConfiguration, ServerConfiguration.Failure>,
        healthDataAvailable: Bool
    ) -> Bool {
        guard storedChoice == DataSource.appleHealth.rawValue else { return false }
        return HealthKitGate.evaluate(configuration: configuration, signedIn: true, healthDataAvailable: healthDataAvailable).isAvailable
    }
}
