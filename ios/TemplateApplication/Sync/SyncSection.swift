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
    @AppStorage(StorageKeys.dataSource) private var stored = DataSource.synthetic
    
    var body: some View {
        @Bindable var sync = sync
        Section("Sync") {
            LabeledContent("Source", value: DataSource.effective(stored).title)
            LabeledContent("State", value: stateText)
                .accessibilityIdentifier("syncState")
            LabeledContent("Last sync", value: sync.status.lastSuccess.map { $0.formatted(date: .omitted, time: .standard) } ?? "never")
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
                    .foregroundStyle(.secondary)
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
