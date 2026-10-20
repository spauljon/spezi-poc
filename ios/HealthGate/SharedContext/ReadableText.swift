//
// This source file is part of the Spezi POC capture app, adapted from the Stanford Spezi Template Application
//
// SPDX-FileCopyrightText: 2023 Stanford University and the project authors (see CONTRIBUTORS.md)
//
// SPDX-License-Identifier: MIT
//

import SwiftUI


extension Color {
    /// Secondary text that stays readable. iOS's own `.secondary` is about 3.3:1 against white, below the 4.5:1 that the
    /// accessibility audit (and WCAG AA) asks of small text; this is the primary colour at 72%, which is about 8:1 on
    /// white and about 11:1 on black, and follows light and dark mode.
    static let readableSecondary = Color.primary.opacity(0.72)
}
