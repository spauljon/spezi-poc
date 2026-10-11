//
// This source file is part of the Spezi POC capture app, adapted from the Stanford Spezi Template Application
//
// SPDX-FileCopyrightText: 2023 Stanford University and the project authors (see CONTRIBUTORS.md)
//
// SPDX-License-Identifier: MIT
//

import Spezi
import SwiftUI


@main
struct TemplateApplication: App {
    @UIApplicationDelegateAdaptor(TemplateApplicationDelegate.self) var appDelegate
    @AppStorage(StorageKeys.onboardingFlowComplete) var completedOnboardingFlow = false
    @State private var auth: AuthService
    @State private var simulator: SimulatorModel
    @State private var sync: SyncModel
    
    
    init() {
        let auth = AuthService.live()
        let simulator = SimulatorModel()
        let sync = SyncModel.live(auth: auth)
        simulator.onEmit = { ingested, device in sync.enqueue(ingested, device: device) }
        _auth = State(initialValue: auth)
        _simulator = State(initialValue: simulator)
        _sync = State(initialValue: sync)
    }
    
    var body: some Scene {
        WindowGroup {
            // The root switches between onboarding and home. The template presented the onboarding as a sheet over
            // an EmptyView; on the Xcode 27 / iOS 27 simulator that sheet came up blank (its content never
            // rendered), while the same flow rendered correctly as the root. Onboarding cannot be dismissed anyway.
            Group {
                if completedOnboardingFlow {
                    HomeView()
                } else {
                    OnboardingFlow()
                }
            }
            .environment(auth)
            .environment(simulator)
            .environment(sync)
            .testingSetup()
            .spezi(appDelegate)
        }
    }
}
