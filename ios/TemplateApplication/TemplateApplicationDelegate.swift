//
// This source file is part of the Spezi POC capture app, adapted from the Stanford Spezi Template Application
//
// SPDX-FileCopyrightText: 2023 Stanford University and the project authors (see CONTRIBUTORS.md)
//
// SPDX-License-Identifier: MIT
//

import Spezi
import SwiftUI


class TemplateApplicationDelegate: SpeziAppDelegate {
    override var configuration: Configuration {
        Configuration(standard: TemplateApplicationStandard()) {
            // Spezi modules are added here as milestones need them (HealthKit arrives with the real-source milestone).
        }
    }
}
