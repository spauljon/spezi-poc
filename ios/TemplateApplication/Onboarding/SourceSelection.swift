//
// This source file is part of the Spezi POC capture app, adapted from the Stanford Spezi Template Application
//
// SPDX-FileCopyrightText: 2023 Stanford University and the project authors (see CONTRIBUTORS.md)
//
// SPDX-License-Identifier: MIT
//

import SwiftUI


/// Chooses the data source. Only the synthetic source is enabled until the HealthKit milestone.
struct SourceSelection: View {
    @AppStorage(StorageKeys.dataSource) private var stored = DataSource.synthetic
    
    let onBack: () -> Void
    let onContinue: () -> Void
    
    
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Button("Back", action: onBack)
                .padding(.top, 8)
            Text("Data source")
                .font(.largeTitle.bold())
            Text("Choose where measurements come from.")
                .foregroundStyle(.secondary)
            
            List(DataSource.allCases) { source in
                Button {
                    stored = source
                } label: {
                    HStack {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(source.title)
                                .font(.headline)
                            Text(source.detail)
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                        }
                        Spacer()
                        if DataSource.effective(stored) == source {
                            Image(systemName: "checkmark.circle.fill")
                                .foregroundStyle(.tint)
                                .accessibilityLabel("Selected")
                        }
                    }
                }
                .disabled(!source.isAvailable)
            }
            .listStyle(.plain)
            
            Button {
                stored = DataSource.effective(stored)
                onContinue()
            } label: {
                Text("Continue")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .padding(.bottom, 24)
        }
        .padding(.horizontal)
    }
}


#Preview {
    SourceSelection(onBack: {}, onContinue: {})
}
