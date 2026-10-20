//
// This source file is part of the Spezi POC capture app, adapted from the Stanford Spezi Template Application
//
// SPDX-FileCopyrightText: 2023 Stanford University and the project authors (see CONTRIBUTORS.md)
//
// SPDX-License-Identifier: MIT
//

import Foundation


extension SyncModel {
    /// The real wiring: the Application Support queue file, the configured FHIR endpoint over TLS, and the signed-in
    /// user's bearer token. If the app is not configured, the model exists but has no engine and says why.
    @MainActor
    static func live(auth: AuthService) -> SyncModel {
        let queue: SampleQueue
        do {
            queue = try SampleQueue(path: try queueFilePath())
        } catch {
            // Fall back to memory so the app still runs; the screen shows that nothing is persisted.
            // swiftlint:disable:next force_try
            return SyncModel(queue: try! SampleQueue(path: nil), engine: nil, unavailableReason: "The upload queue could not be opened: \(error)", monitorNetwork: false)
        }
        guard case .success(let configuration) = ServerConfiguration.load() else {
            return SyncModel(queue: queue, engine: nil, unavailableReason: "The server is not configured.", monitorNetwork: false)
        }
        let registry: MetricRegistry
        do {
            registry = try MetricRegistry.load()
        } catch {
            return SyncModel(queue: queue, engine: nil, unavailableReason: "The metric contract could not be loaded.", monitorNetwork: false)
        }
        let engine = SyncEngine(
            queue: queue,
            transport: URLSessionTransport(baseURL: configuration.fhirBaseURL),
            token: { () async throws(AuthError) -> String in
                try await auth.accessToken(configuration: configuration)
            },
            registry: registry,
            settings: .init(
                patientIdentifier: configuration.patientIdentifier,
                patientSystem: registry.systems.identifier.patient,
                healthKitPatientIdentifier: configuration.healthKitPatientIdentifier))
        return SyncModel(queue: queue, engine: engine, flagger: QualityFlagger(registry: registry))
    }
    
    private static func queueFilePath() throws -> String {
        let directory = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        return directory.appendingPathComponent("upload-queue.sqlite").path
    }
}
