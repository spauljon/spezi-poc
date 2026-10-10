//
// This source file is part of the Spezi POC capture app, adapted from the Stanford Spezi Template Application
//
// SPDX-FileCopyrightText: 2023 Stanford University and the project authors (see CONTRIBUTORS.md)
//
// SPDX-License-Identifier: MIT
//

import SpeziOnboarding
import SwiftUI


/// Tells the user, before anything happens: what data, where it goes, and synthetic versus real.
struct Orientation: View {
    let onContinue: () -> Void
    
    var body: some View {
        OnboardingView(
            title: "Spezi POC Capture",
            subtitle: "Sends cardiovascular measurements to your own FHIR server.",
            areas: [
                OnboardingInformationView.Area(
                    icon: {
                        Image(systemName: "heart.text.square")
                            .accessibilityHidden(true)
                    },
                    title: "What it collects",
                    description: "Heart rate, resting heart rate, heart rate variability and sleep. For now these are generated on this device."
                ),
                OnboardingInformationView.Area(
                    icon: {
                        Image(systemName: "lock.shield")
                            .accessibilityHidden(true)
                    },
                    title: "Where it goes",
                    description: "To your own FHIR server, over TLS, with a sign-in token. Never to analytics or any third party."
                ),
                OnboardingInformationView.Area(
                    icon: {
                        Image(systemName: "testtube.2")
                            .accessibilityHidden(true)
                    },
                    title: "Synthetic or real",
                    description: "Synthetic is the only option for now. Reading Apple Health comes later and will always be a separate, explicit choice."
                )
            ],
            actionText: "Continue",
            action: {
                onContinue()
            }
        )
        .padding(.top, 24)
    }
}


#Preview {
    Orientation {}
}
