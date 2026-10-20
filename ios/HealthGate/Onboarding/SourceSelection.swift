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
                .foregroundStyle(Color.readableSecondary)
            
            List(DataSource.allCases) { source in
                SourceRow(
                    title: source.title, detail: source.detail, isSelected: DataSource.effective(stored) == source,
                    isEnabled: source.isAvailable
                ) {
                    stored = source
                }
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
