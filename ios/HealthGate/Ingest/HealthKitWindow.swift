//
// This source file is part of the Spezi POC capture app, adapted from the Stanford Spezi Template Application
//
// SPDX-FileCopyrightText: 2023 Stanford University and the project authors (see CONTRIBUTORS.md)
//
// SPDX-License-Identifier: MIT
//

import Foundation


/// Where HealthKit collection starts, and for how long that start stays fixed.
///
/// The collectors are given a start date, and SpeziHealthKit keeps its place (an anchor) separately. If the start date
/// were "seven days before this launch", an app left unopened for ten days would silently skip three days of samples
/// the anchor would otherwise have delivered. So the first start is fixed once, when Apple Health is first chosen, and
/// reused at every launch: after that nothing the anchor has not delivered is ever excluded.
///
/// - The first window is a week (a first sync stays small); older samples are never read.
/// - Widening it deliberately is not exposed in the app. It would mean resetting the module's collection for a type
///   (which re-delivers the window; harmless, because every upload is a conditional create).
enum HealthKitWindow {
    static let backfill: TimeInterval = 7 * 24 * 60 * 60
    static let key = "healthKit.windowStart"
    
    /// The start every collector uses this launch: the fixed one if there is one, else a week before `now`.
    static func start(now: Date = .now, defaults: UserDefaults = .standard) -> Date {
        if let stored = defaults.object(forKey: key) as? Double {
            return Date(timeIntervalSince1970: stored)
        }
        return now.addingTimeInterval(-backfill)
    }
    
    /// Fixes the start (once). Called when the user first chooses Apple Health, with the start this launch used.
    static func commit(_ start: Date, defaults: UserDefaults = .standard) {
        guard defaults.object(forKey: key) == nil else { return }
        defaults.set(start.timeIntervalSince1970, forKey: key)
    }
}
