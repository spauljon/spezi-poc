//
// This source file is part of the Spezi POC capture app, adapted from the Stanford Spezi Template Application
//
// SPDX-FileCopyrightText: 2023 Stanford University and the project authors (see CONTRIBUTORS.md)
//
// SPDX-License-Identifier: MIT
//

import SwiftUI


/// The synthetic source's controls: what the simulated device does, and what it has emitted so far. Reached only when
/// the data source is synthetic (a real source has no such controls).
struct SimulatorView: View {
    @Environment(SimulatorModel.self) private var model
    
    private static let batchChoices: [(String, TimeInterval)] = [("Immediately", 0), ("Every 5 min", 300), ("Every 15 min", 900), ("Every 30 min", 1800), ("Every hour", 3600)]
    private static let speedChoices: [(String, Double)] = [("Real time", 1), ("60x", 60), ("600x", 600), ("3600x", 3600)]
    private static let startChoices: [(String, Int)] = [("Now", 0), ("1 day ago", 1), ("7 days ago", 7), ("14 days ago", 14)]
    
    var body: some View {
        @Bindable var model = model
        
        Form {
            Section {
                Picker("Scenario", selection: Binding(
                    get: { model.preset },
                    set: { if let preset = $0 { model.apply(preset) } }
                )) {
                    if model.preset == nil {
                        Text("Custom").tag(SyntheticPreset?.none)
                    }
                    ForEach(SyntheticPreset.allCases) { preset in
                        Text(preset.title).tag(SyntheticPreset?.some(preset))
                    }
                }
                if let preset = model.preset {
                    Text(preset.summary)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            } header: {
                Text("Scenario")
            }
            .disabled(model.isRunning)
            
            Section("Timing") {
                Stepper("Heart-rate cadence: every \(Int(model.config.heartRateCadence)) s", value: $model.config.heartRateCadence, in: 1...600, step: 1)
                LabeledSlider(title: "Jitter", value: $model.config.jitter, range: 0...0.45, format: "%.0f%% of cadence", scale: 100)
                Picker("Delivery", selection: $model.config.batchInterval) {
                    ForEach(Self.batchChoices, id: \.1) { Text($0.0).tag($0.1) }
                }
            }
            .disabled(model.isRunning)
            
            Section("Faults") {
                Stepper("Gaps per day: \(Int(model.config.gaps.perDay))", value: $model.config.gaps.perDay, in: 0...12, step: 1)
                Stepper("Gap length: \(Int(model.config.gaps.meanMinutes)) min", value: $model.config.gaps.meanMinutes, in: 0...180, step: 5)
                LabeledSlider(title: "Late samples", value: $model.config.late.fraction, range: 0...1, format: "%.0f%%", scale: 100)
                Stepper("Late by up to \(Int(model.config.late.maxDelay / 3600)) h", value: Binding(
                    get: { model.config.late.maxDelay / 3600 },
                    set: {
                        model.config.late.maxDelay = $0 * 3600
                        model.config.late.minDelay = min(model.config.late.minDelay, $0 * 3600)
                    }
                ), in: 0...24, step: 1)
                LabeledSlider(title: "Duplicates", value: $model.config.duplicateFraction, range: 0...0.5, format: "%.0f%%", scale: 100)
                LabeledSlider(title: "Artifacts", value: $model.config.artifactFraction, range: 0...0.2, format: "%.0f%%", scale: 100)
            }
            .disabled(model.isRunning)
            
            Section("Clock") {
                Picker("Speed", selection: $model.speed) {
                    ForEach(Self.speedChoices, id: \.1) { Text($0.0).tag($0.1) }
                }
                Picker("Start", selection: $model.startDaysAgo) {
                    ForEach(Self.startChoices, id: \.1) { Text($0.0).tag($0.1) }
                }
                Stepper("Seed: \(model.config.seed)", value: Binding(
                    get: { Int(model.config.seed) },
                    set: { model.config.seed = UInt64(max($0, 0)) }
                ), in: 0...9_999, step: 1)
            }
            .disabled(model.isRunning)
            
            Section("Run") {
                Button(model.isRunning ? "Stop" : "Start", role: model.isRunning ? .destructive : nil) {
                    model.isRunning ? model.stop() : model.start()
                }
                .accessibilityIdentifier("simulatorStartStop")
                Button("Clear counts") {
                    model.resetCounters()
                }
                .disabled(model.isRunning)
            }
            
            Section("Emitted") {
                LabeledContent("Total", value: "\(model.counts.total)")
                LabeledContent("Heart rate", value: "\(model.counts.heartRate)")
                LabeledContent("Resting heart rate", value: "\(model.counts.restingHeartRate)")
                LabeledContent("HRV", value: "\(model.counts.hrv)")
                LabeledContent("Sleep intervals", value: "\(model.counts.sleepIntervals)")
                LabeledContent("Late", value: "\(model.counts.late)")
                LabeledContent("Batched", value: "\(model.counts.batched)")
                LabeledContent("Duplicates", value: "\(model.counts.duplicates)")
                LabeledContent("Artifacts", value: "\(model.counts.artifacts)")
            }
            
            Section("Latest samples") {
                if model.recent.isEmpty {
                    Text("Nothing emitted yet.")
                        .foregroundStyle(.secondary)
                }
                ForEach(model.recent) { sample in
                    VStack(alignment: .leading, spacing: 2) {
                        HStack {
                            Text(sample.metric)
                            Spacer()
                            Text(sample.value)
                        }
                        Text(sample.measured)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        if !sample.badges.isEmpty {
                            // Text, not colour alone: the anomaly is named.
                            Text(sample.badges.joined(separator: ", "))
                                .font(.caption.bold())
                        }
                    }
                }
            }
        }
        .navigationTitle("Simulator")
        .onChange(of: model.config) {
            // A hand edit leaves the preset behind (applying a preset sets it again).
            if model.preset != nil, let preset = model.preset, preset.applied(to: model.config) != model.config {
                model.configChanged()
            }
        }
    }
}


/// A slider with a visible, formatted value (never colour or position alone).
private struct LabeledSlider: View {
    let title: String
    @Binding var value: Double
    let range: ClosedRange<Double>
    let format: String
    let scale: Double
    
    var body: some View {
        VStack(alignment: .leading) {
            HStack {
                Text(title)
                Spacer()
                Text(String(format: format, value * scale))
                    .foregroundStyle(.secondary)
            }
            Slider(value: $value, in: range)
                .accessibilityLabel(title)
        }
    }
}


#Preview {
    NavigationStack {
        SimulatorView()
    }
    .environment(SimulatorModel())
}
