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
    /// How far back the first collection reaches: a week, so a first sync is small. Samples older than this are never
    /// read. (The module remembers where it got to; this only bounds the start.)
    static let backfill: TimeInterval = 7 * 24 * 60 * 60
    
    override var configuration: Configuration {
        let since = Date.now.addingTimeInterval(-Self.backfill)
        return Configuration(standard: TemplateApplicationStandard()) {
            // Read-only, the four types the contract lists, and nothing starts until the user chooses Apple Health on the
            // home screen (`start: .manual`): the module is configured at launch, collection is not.
            HealthKit {
                CollectSamples(.heartRate, start: .manual, timeRange: .startingAt(since))
                CollectSamples(.restingHeartRate, start: .manual, timeRange: .startingAt(since))
                CollectSamples(.heartRateVariabilitySDNN, start: .manual, timeRange: .startingAt(since))
                CollectSamples(.sleepAnalysis, start: .manual, timeRange: .startingAt(since))
            }
        }
    }
}
