//
// This source file is part of the Spezi POC capture app, adapted from the Stanford Spezi Template Application
//
// SPDX-FileCopyrightText: 2023 Stanford University and the project authors (see CONTRIBUTORS.md)
//
// SPDX-License-Identifier: MIT
//

import HealthKit
import SpeziHealthKit
import SwiftUI


/// The app's home: what is configured and who is signed in, with nothing hidden. Capture itself arrives later.
struct HomeView: View {
    @Environment(AuthService.self) private var auth
    @Environment(SourceModel.self) private var sources
    @Environment(SimulatorModel.self) private var simulator
    @Environment(HealthKit.self) private var healthKit
    @AppStorage(StorageKeys.dataSource) private var stored = DataSource.synthetic
    
    @State private var checks: [ServerCheck] = []
    @State private var checking = false
    
    private let configuration = ServerConfiguration.load()
    
    private var signedIn: Bool {
        if case .signedIn = auth.state { return true }
        return false
    }
    
    private var gate: HealthKitGate {
        HealthKitGate.evaluate(configuration: configuration, signedIn: signedIn, healthDataAvailable: HKHealthStore.isHealthDataAvailable())
    }
    
    private var source: DataSource {
        sources.effective
    }
    
    /// What decides whether collection runs: the stored choice and whether the gate currently allows it.
    private struct Wish: Hashable {
        var stored: DataSource
        var allowed: Bool
    }
    
    
    var body: some View {
        NavigationStack {
            List {
                dataSourceSection
                
                if source.showsSimulator {
                    Section("Simulator") {
                        NavigationLink("Simulator controls") {
                            SimulatorView()
                        }
                        .accessibilityIdentifier("simulatorLink")
                    }
                }
                
                Section("Server") {
                    switch configuration {
                    case .success(let configuration):
                        LabeledContent("FHIR endpoint", value: configuration.fhirBaseURL.absoluteString)
                        LabeledContent("Sign-in", value: configuration.issuerURL.absoluteString)
                    case .failure(let failure):
                        Label(failure.message, systemImage: "exclamationmark.triangle")
                            .foregroundStyle(.red)
                    }
                }
                
                accountSection
                
                if !checks.isEmpty {
                    Section("Server check") {
                        ForEach(checks) { check in
                            Label {
                                Text(check.label)
                                Text(describe(check))
                                    .font(.footnote)
                                    .foregroundStyle(.secondary)
                            } icon: {
                                Image(systemName: check.passed ? "checkmark.circle.fill" : "xmark.octagon.fill")
                                    .foregroundStyle(check.passed ? .green : .red)
                            }
                        }
                    }
                }
                
                SyncSection()
            }
            .navigationTitle("Capture")
            .task {
                if case .success(let configuration) = configuration {
                    auth.restore(configuration: configuration)
                }
            }
            // Collection runs exactly while Apple Health is both chosen and allowed; otherwise the bridge drops (and counts).
            .task(id: Wish(stored: stored, allowed: gate.isAvailable)) {
                sources.update(stored: stored, gate: gate)
                let running = stored == .appleHealth && gate.isAvailable
                await HealthKitBridge.shared.setEnabled(running)
                if running {
                    simulator.stop()
                    await healthKit.triggerDataSourceCollection()
                }
                await sources.refreshCounters()
            }
            // The counters live in the bridge actor, which nothing observes: while Apple Health is in effect, read them
            // again every couple of seconds so the screen shows what has arrived since the choice was made.
            .task(id: source) {
                guard source == .appleHealth else { return }
                while !Task.isCancelled {
                    await sources.refreshCounters()
                    try? await Task.sleep(for: .seconds(2))
                }
            }
        }
    }
    
    
    @ViewBuilder private var dataSourceSection: some View {
        Section("Data source") {
            ForEach(DataSource.allCases) { option in
                Button {
                    Task { await choose(option) }
                } label: {
                    HStack {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(option.title)
                                .foregroundStyle(.primary)
                            Text(option == .appleHealth ? appleHealthDetail : option.detail)
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                        }
                        Spacer()
                        if source == option {
                            Image(systemName: "checkmark.circle.fill")
                                .foregroundStyle(.tint)
                                .accessibilityLabel("Selected")
                        }
                    }
                }
                .disabled(option == .appleHealth && !gate.isAvailable)
                .accessibilityIdentifier("source-\(option.rawValue)")
            }
            if stored == .appleHealth, case .unavailable(let reason) = gate {
                Label("Apple Health is paused. \(reason.message)", systemImage: "pause.circle")
                    .font(.footnote)
                    .foregroundStyle(.orange)
            }
            if let message = sources.message {
                Label(message, systemImage: "exclamationmark.triangle")
                    .font(.footnote)
                    .foregroundStyle(.orange)
            }
            if source == .appleHealth {
                LabeledContent("Received since app start", value: "\(sources.counters.accepted)")
                    .accessibilityIdentifier("healthKitReceived")
                if let last = sources.counters.lastReceivedAt {
                    LabeledContent("Last received", value: last.formatted(date: .omitted, time: .standard))
                }
            }
        }
    }
    
    private var appleHealthDetail: String {
        switch gate {
        case .available:
            "Your own measurements (heart rate, resting heart rate, HRV, sleep) from the last 7 days onwards, read-only, sent to your own server as a separate patient."
        case .unavailable(let reason):
            reason.message
        }
    }
    
    private func choose(_ option: DataSource) async {
        sources.message = nil
        switch option {
        case .synthetic:
            stored = .synthetic
        case .appleHealth:
            guard gate.isAvailable else { return }
            do {
                try await healthKit.askForAuthorization()
                stored = .appleHealth
            } catch {
                sources.message = "Apple Health access could not be requested."
            }
        }
    }
    
    @ViewBuilder private var accountSection: some View {
        Section("Account") {
            switch auth.state {
            case .signedOut:
                Label("Not signed in", systemImage: "person.crop.circle.badge.questionmark")
                signInButton
            case .signingIn:
                HStack {
                    ProgressView()
                    Text("Signing in…")
                }
            case .signedIn(let session):
                Label(session.username ?? "Signed in", systemImage: "person.crop.circle.badge.checkmark")
                LabeledContent("Roles", value: session.roles.isEmpty ? "none" : session.roles.joined(separator: ", "))
                LabeledContent("Token expires", value: session.expiresAt.formatted(date: .omitted, time: .standard))
                Button("Check server") {
                    Task { await runChecks() }
                }
                .disabled(checking)
                Button("Sign out", role: .destructive) {
                    auth.signOut()
                    checks = []
                }
            case .failed(let message):
                Label(message, systemImage: "exclamationmark.triangle")
                    .foregroundStyle(.red)
                signInButton
            }
        }
    }
    
    @ViewBuilder private var signInButton: some View {
        if case .success(let configuration) = configuration {
            Button("Sign in") {
                Task { await auth.signIn(configuration: configuration) }
            }
        }
    }
    
    
    private func runChecks() async {
        guard case .success(let configuration) = configuration else {
            return
        }
        checking = true
        defer { checking = false }
        let token = try? await auth.accessToken(configuration: configuration)
        checks = await ServerProbe.run(configuration: configuration, accessToken: token)
    }
    
    private func describe(_ check: ServerCheck) -> String {
        if let status = check.status {
            return "HTTP \(status), expected \(check.expected)"
        }
        return check.failure ?? "no response"
    }
}


#Preview {
    HomeView()
        .environment(AuthService(client: AppAuthClient(), store: InMemoryTokenStore()))
        .environment(SimulatorModel())
        .environment(SyncModel(queue: try! SampleQueue(path: nil), engine: nil, monitorNetwork: false))
}
