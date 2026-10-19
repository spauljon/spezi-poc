//
// This source file is part of the Spezi POC capture app, adapted from the Stanford Spezi Template Application
//
// SPDX-FileCopyrightText: 2023 Stanford University and the project authors (see CONTRIBUTORS.md)
//
// SPDX-License-Identifier: MIT
//

import SwiftUI


/// Source, last sync, queue and errors: what a patient needs to know that capture is working, nothing clinical.
struct SyncSection: View {
    @Environment(SyncModel.self) private var sync
    @Environment(SourceModel.self) private var source
    
    var body: some View {
        @Bindable var sync = sync
        Section("Sync") {
            LabeledContent("Source", value: source.effective.title)
            LabeledContent("State", value: stateText)
                .accessibilityIdentifier("syncState")
            LabeledContent("Last sync", value: sync.status.lastSuccess.map { $0.formatted(date: .omitted, time: .standard) } ?? "never")
            if let attempt = sync.lastAttempt {
                LabeledContent("Last upload attempt", value: attempt.at.formatted(date: .abbreviated, time: .standard))
                    .accessibilityIdentifier("syncLastAttempt")
                Text(attempt.summary)
                    .font(.footnote)
                    .foregroundStyle(Color.readableSecondary)
                if sync.attempts.count > 1 {
                    DisclosureGroup("Recent upload attempts (\(sync.attempts.count))") {
                        ForEach(Array(sync.attempts.enumerated()), id: \.offset) { _, entry in
                            VStack(alignment: .leading, spacing: 2) {
                                Text(entry.at.formatted(date: .abbreviated, time: .standard))
                                    .font(.footnote)
                                Text(entry.summary)
                                    .font(.caption)
                                    .foregroundStyle(Color.readableSecondary)
                            }
                        }
                    }
                    .accessibilityIdentifier("syncAttempts")
                }
            }
            LabeledContent("Queued", value: "\(sync.status.counts.pending)")
                .accessibilityIdentifier("syncQueued")
            LabeledContent("Uploaded", value: "\(sync.status.counts.sent)")
                .accessibilityIdentifier("syncUploaded")
            if sync.status.counts.rejected > 0 {
                LabeledContent("Rejected", value: "\(sync.status.counts.rejected)")
            }
            if sync.status.counts.skipped > 0 {
                LabeledContent("Not uploaded (no FHIR mapping)", value: "\(sync.status.counts.skipped)")
            }
            if sync.deletions.pending > 0 {
                // Deleted in Apple Health and not yet applied: waiting for the next upload, the network or a retry.
                LabeledContent("Deleted in Apple Health, waiting", value: "\(sync.deletions.pending)")
                    .accessibilityIdentifier("syncDeletions")
            }
            if sync.deletions.retracted > 0 {
                LabeledContent("Retracted on the server", value: "\(sync.deletions.retracted)")
                    .accessibilityIdentifier("syncRetracted")
            }
            if sync.deletions.notOnServer > 0 {
                LabeledContent("Deleted, nothing on the server", value: "\(sync.deletions.notOnServer)")
                    .accessibilityIdentifier("syncDeletedUnsent")
            }
            if sync.deletions.refused > 0 {
                LabeledContent("Retraction refused", value: "\(sync.deletions.refused)")
                    .accessibilityIdentifier("syncRetractionRefused")
            }
            if sync.duplicatesDropped > 0 {
                LabeledContent("Duplicates dropped", value: "\(sync.duplicatesDropped)")
            }
            if let error = sync.status.lastError {
                Label(error, systemImage: "exclamationmark.triangle")
                    .font(.footnote)
                    .foregroundStyle(.orange)
            }
            ForEach(Array(sync.rejections.enumerated()), id: \.offset) { _, rejection in
                Text("\(rejection.key): \(rejection.reason)")
                    .font(.caption)
                    .foregroundStyle(Color.readableSecondary)
            }
            Toggle("Pause upload", isOn: $sync.isPaused)
                .accessibilityIdentifier("syncPause")
            Button("Sync now") { sync.syncNow() }
                .accessibilityIdentifier("syncNow")
        }
        .task { await sync.refreshCounts() }
    }
    
    private var stateText: String {
        if sync.isPaused { return "Paused" }
        if !sync.isOnline { return "Offline" }
        switch sync.status.phase {
        case .idle: return "Up to date"
        case .syncing: return "Syncing…"
        case .waiting(let until): return "Retrying at \(until.formatted(date: .omitted, time: .standard))"
        case .blocked(.signInRequired): return "Sign in required"
        case .blocked(.forbidden): return "Not permitted"
        case .blocked(.configuration): return "Configuration problem"
        }
    }
}


extension UploadAttempt {
    /// One line: the outcome, how many went, where the app was, and how many identical attempts it stands for.
    var summary: String {
        let repeats = count > 1 ? "; \(count) times in a row, the last at this time" : ""
        return "\(outcome); \(sent) sent; app was \(inBackground ? "in the background" : "open")\(repeats)"
    }
}
