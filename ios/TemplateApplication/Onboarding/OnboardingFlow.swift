//
// This source file is part of the Spezi POC capture app, adapted from the Stanford Spezi Template Application
//
// SPDX-FileCopyrightText: 2023 Stanford University and the project authors (see CONTRIBUTORS.md)
//
// SPDX-License-Identifier: MIT
//

import SwiftUI


/// The first-run flow: what the app does, then which data source to use.
///
/// Two steps need no navigation container, so this is a plain state switch. (SpeziViews' `ManagedNavigationStack`,
/// which the template uses, rendered nothing on the Xcode 27 / iOS 27 simulator: SwiftUI reported "Accessing
/// State<Path>'s value without being installed on a View". Revisit when SpeziViews is updated for that SDK.)
struct OnboardingFlow: View {
    private enum Step {
        case orientation
        case sourceSelection
    }
    
    @AppStorage(StorageKeys.onboardingFlowComplete) private var completedOnboardingFlow = false
    @State private var step = Step.orientation
    
    
    var body: some View {
        switch step {
        case .orientation:
            Orientation {
                step = .sourceSelection
            }
        case .sourceSelection:
            SourceSelection(onBack: { step = .orientation }) {
                completedOnboardingFlow = true
            }
        }
    }
}


#Preview {
    OnboardingFlow()
}
