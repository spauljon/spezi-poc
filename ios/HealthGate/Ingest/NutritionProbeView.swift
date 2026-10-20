//
// This source file is part of the Spezi POC capture app, adapted from the Stanford Spezi Template Application
//
// SPDX-FileCopyrightText: 2023 Stanford University and the project authors (see CONTRIBUTORS.md)
//
// SPDX-License-Identifier: MIT
//

import SwiftUI


/// Debug builds only: shows the structure of the nutrition samples in Apple Health (counts and key names, see
/// `NutritionStructure`). Nothing is stored, uploaded or logged; the text lives on this screen until it is left.
struct NutritionProbeView: View {
    @State private var lines: [String] = []
    @State private var running = false
    
    var body: some View {
        Section("Nutrition structure (debug)") {
            Button(running ? "Reading…" : "Inspect nutrition structure") {
                running = true
                Task {
                    let found = await NutritionProbe.run(since: HealthKitWindow.start())
                    lines = found.lines
                    running = false
                }
            }
            .disabled(running)
            .accessibilityIdentifier("nutritionProbe")
            ForEach(Array(lines.enumerated()), id: \.offset) { _, line in
                Text(line)
                    .font(.caption)
                    .foregroundStyle(Color.readableSecondary)
            }
            Text("Counts and key names only; no values, no food names.")
                .font(.caption2)
                .foregroundStyle(Color.readableSecondary)
        }
    }
}
