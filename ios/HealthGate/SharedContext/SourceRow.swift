//
// This source file is part of the Spezi POC capture app, adapted from the Stanford Spezi Template Application
//
// SPDX-FileCopyrightText: 2023 Stanford University and the project authors (see CONTRIBUTORS.md)
//
// SPDX-License-Identifier: MIT
//

import SwiftUI


/// One data-source choice: a button when it can be chosen, and plain text with its reason when it cannot.
///
/// A disabled button dims everything inside it, and the reason a choice is unavailable is the thing a person most needs
/// to read (and the dimmed text fails the contrast audit). An unavailable choice is therefore not a control at all: it is
/// text, read by VoiceOver as one element, "Apple Health. <reason>".
struct SourceRow: View {
    let title: String
    let detail: String
    let isSelected: Bool
    let isEnabled: Bool
    let action: () -> Void
    
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if isEnabled {
                Button(action: action) {
                    header
                }
            } else {
                header
            }
            Text(detail)
                .font(.footnote)
                .foregroundStyle(Color.readableSecondary)
        }
        .accessibilityElement(children: isEnabled ? .contain : .combine)
    }
    
    private var header: some View {
        HStack {
            Text(title)
                .font(.headline)
            Spacer()
            if isSelected {
                Image(systemName: "checkmark.circle.fill")
                    .foregroundStyle(.tint)
                    .accessibilityLabel("Selected")
            }
        }
    }
}
