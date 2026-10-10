//
// This source file is part of the Spezi POC capture app, adapted from the Stanford Spezi Template Application
//
// SPDX-FileCopyrightText: 2023 Stanford University and the project authors (see CONTRIBUTORS.md)
//
// SPDX-License-Identifier: MIT
//

/// A collection of launch-argument feature flags, used by UI tests and during development.
enum FeatureFlags {
    /// Skips the onboarding flow.
    static let skipOnboarding = CommandLine.arguments.contains("--skipOnboarding")
    /// Always shows the onboarding when the application is launched.
    static let showOnboarding = CommandLine.arguments.contains("--showOnboarding")
}
