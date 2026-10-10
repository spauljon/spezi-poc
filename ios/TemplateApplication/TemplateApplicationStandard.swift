//
// This source file is part of the Spezi POC capture app, adapted from the Stanford Spezi Template Application
//
// SPDX-FileCopyrightText: 2023 Stanford University and the project authors (see CONTRIBUTORS.md)
//
// SPDX-License-Identifier: MIT
//

import Spezi
import SwiftUI


/// The app's Spezi `Standard`: the single place data sources and the server client will meet.
///
/// Empty for now. Constraints such as `HealthKitConstraint` are adopted when the matching module is added.
actor TemplateApplicationStandard: Standard, EnvironmentAccessible {
    init() {}
}
