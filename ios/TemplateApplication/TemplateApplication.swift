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
    @State private var source = SourceModel()
    
    
    init() {
        let auth = AuthService.live()
        let simulator = SimulatorModel()
        let sync = SyncModel.live(auth: auth)
        simulator.onEmit = { ingested, device in sync.enqueue(ingested, device: device) }
        _auth = State(initialValue: auth)
        _simulator = State(initialValue: simulator)
        _sync = State(initialValue: sync)
        // A background launch has no screen: pick up the previous sign-in here so a wake-up can upload.
        if case .success(let configuration) = ServerConfiguration.load() {
            auth.restore(configuration: configuration)
        }
        Self.connectAppleHealth(to: sync)
    }
    
    /// HealthKit's samples go through the same queue as the synthetic ones, but by acknowledged push (see
    /// `HealthKitBridge`). Nothing flows until the user chooses Apple Health and the gate allows it.
    private static func connectAppleHealth(to sync: SyncModel) {
        let healthKit = HealthKitIngestSource()
        let mapper = (try? MetricRegistry.load()).map { HealthKitMapper(registry: $0) }
        Task {
            await HealthKitBridge.shared.configure(
                mapper: mapper,
                // Acknowledged: the bridge returns to HealthKit (which then saves its anchor) only after this commits.
                deliver: { samples in await sync.enqueueDurably(samples, fallbackDevice: healthKit.device) },
                recordDeletions: { uuids in await sync.recordDeletions(uuids) })
        }
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
            .environment(source)
            .testingSetup()
            .spezi(appDelegate)
        }
    }
}
