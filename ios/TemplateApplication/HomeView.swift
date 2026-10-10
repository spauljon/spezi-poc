//
// This source file is part of the Spezi POC capture app, adapted from the Stanford Spezi Template Application
//
// SPDX-FileCopyrightText: 2023 Stanford University and the project authors (see CONTRIBUTORS.md)
//
// SPDX-License-Identifier: MIT
//

import SwiftUI


/// The app's home: what is configured and who is signed in, with nothing hidden. Capture itself arrives later.
struct HomeView: View {
    @Environment(AuthService.self) private var auth
    @AppStorage(StorageKeys.dataSource) private var stored = DataSource.synthetic
    
    @State private var checks: [ServerCheck] = []
    @State private var checking = false
    
    private let configuration = ServerConfiguration.load()
    
    private var source: DataSource {
        DataSource.effective(stored)
    }
    
    
    var body: some View {
        NavigationStack {
            List {
                Section("Data source") {
                    Label(source.title, systemImage: "checkmark.circle.fill")
                    Text(source.detail)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                
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
            }
            .navigationTitle("Capture")
            .task {
                if case .success(let configuration) = configuration {
                    auth.restore(configuration: configuration)
                }
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
}
