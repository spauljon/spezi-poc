//
// This source file is part of the Spezi POC capture app, adapted from the Stanford Spezi Template Application
//
// SPDX-FileCopyrightText: 2023 Stanford University and the project authors (see CONTRIBUTORS.md)
//
// SPDX-License-Identifier: MIT
//

/// Constants shared across the app to access storage information including the `AppStorage` and `SceneStorage`.
enum StorageKeys {
    // MARK: - Onboarding
    /// A `Bool` flag indicating if the onboarding was completed.
    static let onboardingFlowComplete = "onboardingFlow.complete"
    /// The chosen ``DataSource`` (its raw value).
    static let dataSource = "onboardingFlow.dataSource"
}
