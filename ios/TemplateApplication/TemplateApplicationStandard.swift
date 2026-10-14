//
// This source file is part of the Spezi POC capture app, adapted from the Stanford Spezi Template Application
//
// SPDX-FileCopyrightText: 2023 Stanford University and the project authors (see CONTRIBUTORS.md)
//
// SPDX-License-Identifier: MIT
//

import HealthKit
import Spezi
import SpeziHealthKit
import SwiftUI


/// The app's Spezi `Standard`: where the HealthKit module hands over what it collected.
///
/// It does nothing but reduce each sample to plain values and give them to `HealthKitBridge`, which decides whether
/// they may go on. No value is logged anywhere in this path.
actor TemplateApplicationStandard: Standard, EnvironmentAccessible, HealthKitConstraint {
    init() {}
    
    func handleNewSamples<Sample>(_ addedSamples: some Collection<Sample> & Sendable, ofType sampleType: SampleType<Sample>) async {
        let records = addedSamples.compactMap { HealthKitRecord(sample: $0) }
        await HealthKitBridge.shared.receive(records)
    }
    
    func handleDeletedObjects<Sample>(_ deletedObjects: some Collection<HKDeletedObject> & Sendable, ofType sampleType: SampleType<Sample>) async {
        await HealthKitBridge.shared.receiveDeleted(deletedObjects.map { $0.uuid.uuidString })
    }
}
