//
// This source file is part of the Spezi POC capture app, adapted from the Stanford Spezi Template Application
//
// SPDX-FileCopyrightText: 2023 Stanford University and the project authors (see CONTRIBUTORS.md)
//
// SPDX-License-Identifier: MIT
//

import Foundation
import Spezi
import SpeziHealthKit
import SwiftUI


class TemplateApplicationDelegate: SpeziAppDelegate {
    /// The start every collector uses in this launch (see `HealthKitWindow`); fixed for good once Apple Health is chosen.
    static let windowStart = HealthKitWindow.start()
    
    override var configuration: Configuration {
        let since = Self.windowStart
        return Configuration(standard: TemplateApplicationStandard()) {
            // Read-only, the four types the contract lists, and nothing starts until the user chooses Apple Health on the
            // home screen (`start: .manual`): the module is configured at launch, collection is not.
            // Registered at every launch (see `HealthKitResume`) so iOS can wake the app to deliver new samples.
            HealthKitResume()
            HealthKit {
                CollectSamples(.heartRate, start: .manual, continueInBackground: true, timeRange: .startingAt(since))
                CollectSamples(.restingHeartRate, start: .manual, continueInBackground: true, timeRange: .startingAt(since))
                CollectSamples(.heartRateVariabilitySDNN, start: .manual, continueInBackground: true, timeRange: .startingAt(since))
                CollectSamples(.sleepAnalysis, start: .manual, continueInBackground: true, timeRange: .startingAt(since))
            }
        }
    }
}
