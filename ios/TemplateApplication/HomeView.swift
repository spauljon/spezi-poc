//
// This source file is part of the Spezi POC capture app, adapted from the Stanford Spezi Template Application
//
// SPDX-FileCopyrightText: 2023 Stanford University and the project authors (see CONTRIBUTORS.md)
//
// SPDX-License-Identifier: MIT
//

import SwiftUI


/// The app's home: what is configured, with nothing hidden. Capture itself arrives in later milestones.
struct HomeView: View {
    @AppStorage(StorageKeys.dataSource) private var stored = DataSource.synthetic
    
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
                
                Section("Account") {
                    Label("Not signed in", systemImage: "person.crop.circle.badge.questionmark")
                }
            }
            .navigationTitle("Capture")
        }
    }
}


#Preview {
    HomeView()
}
