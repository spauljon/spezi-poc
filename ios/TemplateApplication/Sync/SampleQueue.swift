//
// This source file is part of the Spezi POC capture app, adapted from the Stanford Spezi Template Application
//
// SPDX-FileCopyrightText: 2023 Stanford University and the project authors (see CONTRIBUTORS.md)
//
// SPDX-License-Identifier: MIT
//

import Foundation
import SQLite3


/// One sample waiting to be uploaded, with the device that produced it.
struct QueuedItem: Codable, Equatable, Sendable {
    var sample: MetricSample
    var device: DeviceDescriptor
    
    /// The queue's identity for a sample: source and sample id. The same sample delivered twice is one queue row.
    var key: String { "\(sample.source.rawValue)|\(sample.id)" }
}


struct QueueCounts: Equatable, Sendable {
    var pending = 0
    /// Accepted by the server (created, or already present).
    var sent = 0
    /// Refused for good (the mapper or the server said this sample can never upload as it is).
    var rejected = 0
    /// Valid but deliberately not uploaded (`inBed` has no FHIR mapping in contract v1), or deleted in Apple Health
    /// before it was ever uploaded (M21: there is then nothing to retract, and nothing is sent).
    var skipped = 0
    
    var total: Int { pending + sent + rejected + skipped }
}


/// Where the samples HealthKit reported deleted stand (M21). Counted per deletion, not per Observation.
struct DeletionCounts: Equatable, Sendable {
    /// Not yet applied: waiting for the next upload, for the network, or for a retry.
    var pending = 0
    /// The server marked its copy `entered-in-error`.
    var retracted = 0
    /// Nothing to retract: the sample was never uploaded (withdrawn from the queue) or the server has no such Observation.
    var notOnServer = 0
    /// The server refused the retraction for good (a request it cannot take); the Observation is unchanged.
    var refused = 0
    
    var total: Int { pending + retracted + notOnServer + refused }
}

enum DeletionOutcome: Int32, Sendable {
    case retracted = 1
    case notOnServer = 2
    case refused = 3
}


enum QueueError: Error, Equatable {
    case open(String)
    case sql(String)
}


/// The on-device upload queue: a SQLite file, so a queued sample survives the app being killed or the phone restarting.
///
/// What is stored is the sample in the app's own terms (not mapped FHIR): the Bundle is built at upload time, so a
/// correction to the mapping, or a different patient id, applies to everything not yet sent. SQLite is the system
/// library (no package), accessed through its C API.
actor SampleQueue {
    private enum State: Int32 {
        case pending = 0
        case sent = 1
        case rejected = 2
        case skipped = 3
    }
    
    // Only touched inside the actor and in deinit (when no other reference exists).
    nonisolated(unsafe) private var db: OpaquePointer?
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()
    
    
    /// - Parameter path: a file path, or `nil` for an in-memory queue (tests).
    init(path: String?) throws(QueueError) {
        var handle: OpaquePointer?
        let target = path ?? ":memory:"
        guard sqlite3_open_v2(target, &handle, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX, nil) == SQLITE_OK else {
            let message = handle.map { String(cString: sqlite3_errmsg($0)) } ?? "sqlite3_open failed"
            sqlite3_close(handle)
            throw .open(message)
        }
        db = handle
        let schema = """
        CREATE TABLE IF NOT EXISTS queue (
            seq INTEGER PRIMARY KEY AUTOINCREMENT,
            key TEXT NOT NULL UNIQUE,
            payload BLOB NOT NULL,
            state INTEGER NOT NULL DEFAULT 0,
            attempts INTEGER NOT NULL DEFAULT 0,
            next_attempt REAL NOT NULL DEFAULT 0,
            last_error TEXT
        );
        CREATE INDEX IF NOT EXISTS queue_state ON queue (state, next_attempt, seq);
        CREATE TABLE IF NOT EXISTS pending_deletions (
            uuid TEXT PRIMARY KEY,
            seen REAL NOT NULL,
            state INTEGER NOT NULL DEFAULT 0,
            attempts INTEGER NOT NULL DEFAULT 0,
            next_attempt REAL NOT NULL DEFAULT 0,
            last_error TEXT
        );
        """
        guard sqlite3_exec(handle, "PRAGMA journal_mode=WAL;", nil, nil, nil) == SQLITE_OK || path == nil,
              sqlite3_exec(handle, schema, nil, nil, nil) == SQLITE_OK else {
            let message = String(cString: sqlite3_errmsg(handle))
            sqlite3_close(handle)
            throw .open(message)
        }
        do throws(QueueError) {
            try Self.migrateDeletions(handle)
        } catch {
            sqlite3_close(handle)
            throw error
        }
        if let path {
            Self.protectFiles(at: path)
        }
    }
    
    /// A queue file from before M21 has `pending_deletions (uuid, seen)` only: those deletions were counted, never applied.
    /// They gain the retraction columns and stay pending, so the first sync after the upgrade retracts them.
    private static func migrateDeletions(_ handle: OpaquePointer?) throws(QueueError) {
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(handle, "PRAGMA table_info(pending_deletions)", -1, &statement, nil) == SQLITE_OK else {
            throw .open(String(cString: sqlite3_errmsg(handle)))
        }
        var columns = Set<String>()
        while sqlite3_step(statement) == SQLITE_ROW {
            if let name = sqlite3_column_text(statement, 1) { columns.insert(String(cString: name)) }
        }
        sqlite3_finalize(statement)
        for (name, definition) in [("state", "INTEGER NOT NULL DEFAULT 0"), ("attempts", "INTEGER NOT NULL DEFAULT 0"),
                                   ("next_attempt", "REAL NOT NULL DEFAULT 0"), ("last_error", "TEXT")] where !columns.contains(name) {
            guard sqlite3_exec(handle, "ALTER TABLE pending_deletions ADD COLUMN \(name) \(definition)", nil, nil, nil) == SQLITE_OK else {
                throw .open(String(cString: sqlite3_errmsg(handle)))
            }
        }
    }
    
    /// A queue file may hold real health data. It stays encrypted at rest (class "complete until first user
    /// authentication": readable after the first unlock, which background delivery in M18 needs, where "complete" would
    /// fail with the phone locked) and out of iCloud and device backups. Set on the database and its WAL/SHM files.
    static func protectFiles(at path: String) {
        for suffix in ["", "-wal", "-shm"] {
            let file = path + suffix
            guard FileManager.default.fileExists(atPath: file) else { continue }
            try? FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: file)
            var url = URL(fileURLWithPath: file)
            var values = URLResourceValues()
            values.isExcludedFromBackup = true
            try? url.setResourceValues(values)
        }
    }
    
    deinit {
        sqlite3_close(db)
    }
    
    
    /// Adds items; one whose key is already in the queue (in any state) is left alone.
    /// - Returns: how many were new and how many were already known.
    func enqueue(_ items: [QueuedItem]) throws(QueueError) -> (added: Int, known: Int) {
        var added = 0
        try exec("BEGIN IMMEDIATE")
        do throws(QueueError) {
            for item in items {
                let payload = try encode(item)
                // A sample HealthKit already reported deleted that is delivered after the report is never uploaded.
                let deleted = item.sample.source == .healthKit ? try deletionKnown(item.sample.id) : false
                let statement = try prepare("INSERT OR IGNORE INTO queue (key, payload, state, last_error) VALUES (?1, ?2, ?3, ?4)")
                defer { sqlite3_finalize(statement) }
                bind(statement, 1, text: item.key)
                bind(statement, 2, blob: payload)
                sqlite3_bind_int(statement, 3, deleted ? State.skipped.rawValue : State.pending.rawValue)
                if deleted { bind(statement, 4, text: Self.deletedBeforeUpload) } else { sqlite3_bind_null(statement, 4) }
                guard sqlite3_step(statement) == SQLITE_DONE else { throw QueueError.sql(message()) }
                if sqlite3_changes(db) > 0 {
                    added += 1
                } else {
                    try flagDuplicate(key: item.key)
                }
            }
            try exec("COMMIT")
        } catch {
            sqlite3_exec(db, "ROLLBACK", nil, nil, nil)
            throw error
        }
        return (added, items.count - added)
    }
    
    /// A second delivery met the first while it was still waiting: record that on the surviving copy (contract rule
    /// `duplicateResolved`). Once the first copy has been uploaded the flag can no longer be added (the capture role
    /// cannot update, assumption A31), so a late duplicate is simply absorbed.
    private func flagDuplicate(key: String) throws(QueueError) {
        let select = try prepare("SELECT payload FROM queue WHERE key = ?1 AND state = 0")
        defer { sqlite3_finalize(select) }
        bind(select, 1, text: key)
        guard sqlite3_step(select) == SQLITE_ROW, let bytes = sqlite3_column_blob(select, 0) else { return }
        let data = Data(bytes: bytes, count: Int(sqlite3_column_bytes(select, 0)))
        var existing: QueuedItem
        do {
            existing = try decoder.decode(QueuedItem.self, from: data)
        } catch {
            throw QueueError.sql("A queued payload could not be decoded.")
        }
        guard !existing.sample.duplicateResolved else { return }
        existing.sample.duplicateResolved = true
        let update = try prepare("UPDATE queue SET payload = ?2 WHERE key = ?1 AND state = 0")
        defer { sqlite3_finalize(update) }
        bind(update, 1, text: key)
        bind(update, 2, blob: try encode(existing))
        guard sqlite3_step(update) == SQLITE_DONE else { throw QueueError.sql(message()) }
    }
    
    static let deletedBeforeUpload = "Deleted in Apple Health before it was uploaded"
    
    /// Remembers that HealthKit reported these samples deleted. They are applied by the sync engine (M21): a sample still
    /// waiting to upload is withdrawn, an uploaded one is retracted on the server (status `entered-in-error`). A
    /// repeated report of the same sample is one record.
    /// - Returns: how many were new.
    func recordDeletions(_ uuids: [String], now: Date = .now) throws(QueueError) -> Int {
        var added = 0
        try exec("BEGIN IMMEDIATE")
        do throws(QueueError) {
            for uuid in uuids {
                let statement = try prepare("INSERT OR IGNORE INTO pending_deletions (uuid, seen) VALUES (?1, ?2)")
                defer { sqlite3_finalize(statement) }
                bind(statement, 1, text: uuid)
                sqlite3_bind_double(statement, 2, now.timeIntervalSince1970)
                guard sqlite3_step(statement) == SQLITE_DONE else { throw QueueError.sql(message()) }
                added += Int(sqlite3_changes(db))
            }
            try exec("COMMIT")
        } catch {
            sqlite3_exec(db, "ROLLBACK", nil, nil, nil)
            throw error
        }
        return added
    }
    
    func deletionCount() throws(QueueError) -> Int {
        let statement = try prepare("SELECT COUNT(*) FROM pending_deletions")
        defer { sqlite3_finalize(statement) }
        guard sqlite3_step(statement) == SQLITE_ROW else { throw QueueError.sql(message()) }
        return Int(sqlite3_column_int(statement, 0))
    }
    
    func deletionCounts() throws(QueueError) -> DeletionCounts {
        let statement = try prepare("SELECT state, COUNT(*) FROM pending_deletions GROUP BY state")
        defer { sqlite3_finalize(statement) }
        var counts = DeletionCounts()
        while sqlite3_step(statement) == SQLITE_ROW {
            let n = Int(sqlite3_column_int(statement, 1))
            switch sqlite3_column_int(statement, 0) {
            case 0: counts.pending = n
            case DeletionOutcome.retracted.rawValue: counts.retracted = n
            case DeletionOutcome.notOnServer.rawValue: counts.notOnServer = n
            case DeletionOutcome.refused.rawValue: counts.refused = n
            default: break
            }
        }
        return counts
    }
    
    /// `uuid` is compared lowercased: deletions are recorded lowercased, queue keys carry the UUID as HealthKit wrote it.
    private func deletionKnown(_ uuid: String) throws(QueueError) -> Bool {
        let statement = try prepare("SELECT 1 FROM pending_deletions WHERE uuid = ?1")
        defer { sqlite3_finalize(statement) }
        bind(statement, 1, text: uuid.lowercased())
        return sqlite3_step(statement) == SQLITE_ROW
    }
    
    /// A sample deleted in Apple Health while still waiting to upload is never uploaded: its queue row is skipped and its
    /// deletion is done (nothing to retract). Local only; the network is not involved.
    /// - Returns: how many queued samples were withdrawn.
    @discardableResult
    func withdrawDeletedUploads() throws(QueueError) -> Int {
        try exec("BEGIN IMMEDIATE")
        var withdrawn = 0
        do throws(QueueError) {
            let withdraw = try prepare("""
                UPDATE queue SET state = ?1, last_error = ?2
                WHERE state = 0 AND EXISTS (
                    SELECT 1 FROM pending_deletions d
                    WHERE d.state = 0 AND queue.key = ('healthKit|' || d.uuid) COLLATE NOCASE)
                """)
            defer { sqlite3_finalize(withdraw) }
            sqlite3_bind_int(withdraw, 1, State.skipped.rawValue)
            bind(withdraw, 2, text: Self.deletedBeforeUpload)
            guard sqlite3_step(withdraw) == SQLITE_DONE else { throw QueueError.sql(message()) }
            withdrawn = Int(sqlite3_changes(db))
            let done = try prepare("""
                UPDATE pending_deletions SET state = ?1
                WHERE state = 0 AND EXISTS (
                    SELECT 1 FROM queue q WHERE q.state = ?2 AND q.last_error = ?3 AND q.key = ('healthKit|' || pending_deletions.uuid) COLLATE NOCASE)
                """)
            defer { sqlite3_finalize(done) }
            sqlite3_bind_int(done, 1, DeletionOutcome.notOnServer.rawValue)
            sqlite3_bind_int(done, 2, State.skipped.rawValue)
            bind(done, 3, text: Self.deletedBeforeUpload)
            guard sqlite3_step(done) == SQLITE_DONE else { throw QueueError.sql(message()) }
            try exec("COMMIT")
        } catch {
            sqlite3_exec(db, "ROLLBACK", nil, nil, nil)
            throw error
        }
        return withdrawn
    }
    
    /// Deletions still to apply that are due, oldest report first.
    func dueDeletions(limit: Int, now: Date) throws(QueueError) -> [(uuid: String, attempts: Int)] {
        let statement = try prepare("SELECT uuid, attempts FROM pending_deletions WHERE state = 0 AND next_attempt <= ?1 ORDER BY seen, uuid LIMIT ?2")
        defer { sqlite3_finalize(statement) }
        sqlite3_bind_double(statement, 1, now.timeIntervalSince1970)
        sqlite3_bind_int(statement, 2, Int32(limit))
        var out: [(String, Int)] = []
        while sqlite3_step(statement) == SQLITE_ROW {
            if let text = sqlite3_column_text(statement, 0) {
                out.append((String(cString: text), Int(sqlite3_column_int(statement, 1))))
            }
        }
        return out
    }
    
    func markDeletion(_ uuid: String, _ outcome: DeletionOutcome, note: String? = nil) throws(QueueError) {
        let statement = try prepare("UPDATE pending_deletions SET state = ?2, last_error = ?3 WHERE uuid = ?1")
        defer { sqlite3_finalize(statement) }
        bind(statement, 1, text: uuid)
        sqlite3_bind_int(statement, 2, outcome.rawValue)
        if let note { bind(statement, 3, text: note) } else { sqlite3_bind_null(statement, 3) }
        guard sqlite3_step(statement) == SQLITE_DONE else { throw QueueError.sql(message()) }
    }
    
    /// A deletion that could not be applied now and stays pending; it is not due again before `retryAt`.
    func recordDeletionFailure(_ uuid: String, error: String, retryAt: Date) throws(QueueError) {
        let statement = try prepare("UPDATE pending_deletions SET attempts = attempts + 1, last_error = ?2, next_attempt = ?3 WHERE uuid = ?1 AND state = 0")
        defer { sqlite3_finalize(statement) }
        bind(statement, 1, text: uuid)
        bind(statement, 2, text: error)
        sqlite3_bind_double(statement, 3, retryAt.timeIntervalSince1970)
        guard sqlite3_step(statement) == SQLITE_DONE else { throw QueueError.sql(message()) }
    }
    
    /// The most recent reasons a deletion could not be applied (for the status screen).
    func deletionProblems(limit: Int) throws(QueueError) -> [String] {
        let statement = try prepare("SELECT last_error FROM pending_deletions WHERE state IN (0, 3) AND last_error IS NOT NULL ORDER BY seen DESC LIMIT ?1")
        defer { sqlite3_finalize(statement) }
        sqlite3_bind_int(statement, 1, Int32(limit))
        var out: [String] = []
        while sqlite3_step(statement) == SQLITE_ROW {
            if let text = sqlite3_column_text(statement, 0) { out.append(String(cString: text)) }
        }
        return out
    }
    
    /// Pending items that are due, oldest first.
    func nextBatch(limit: Int, now: Date) throws(QueueError) -> [(item: QueuedItem, attempts: Int)] {
        let statement = try prepare("SELECT payload, attempts FROM queue WHERE state = 0 AND next_attempt <= ?1 ORDER BY seq LIMIT ?2")
        defer { sqlite3_finalize(statement) }
        sqlite3_bind_double(statement, 1, now.timeIntervalSince1970)
        sqlite3_bind_int(statement, 2, Int32(limit))
        var out: [(QueuedItem, Int)] = []
        while sqlite3_step(statement) == SQLITE_ROW {
            guard let bytes = sqlite3_column_blob(statement, 0) else { continue }
            let data = Data(bytes: bytes, count: Int(sqlite3_column_bytes(statement, 0)))
            do {
                out.append((try decoder.decode(QueuedItem.self, from: data), Int(sqlite3_column_int(statement, 1))))
            } catch {
                throw QueueError.sql("A queued payload could not be decoded.")
            }
        }
        return out
    }
    
    func markSent(_ keys: [String]) throws(QueueError) {
        try set(.sent, keys: keys, error: nil)
    }
    
    func markSkipped(_ keys: [String]) throws(QueueError) {
        try set(.skipped, keys: keys, error: nil)
    }
    
    func markRejected(_ key: String, reason: String) throws(QueueError) {
        try set(.rejected, keys: [key], error: reason)
    }
    
    /// A transient failure: the items stay pending and are not due again before `retryAt`.
    func recordFailure(_ keys: [String], error: String, retryAt: Date) throws(QueueError) {
        try exec("BEGIN IMMEDIATE")
        do throws(QueueError) {
            for key in keys {
                let statement = try prepare("UPDATE queue SET attempts = attempts + 1, last_error = ?2, next_attempt = ?3 WHERE key = ?1 AND state = 0")
                defer { sqlite3_finalize(statement) }
                bind(statement, 1, text: key)
                bind(statement, 2, text: error)
                sqlite3_bind_double(statement, 3, retryAt.timeIntervalSince1970)
                guard sqlite3_step(statement) == SQLITE_DONE else { throw QueueError.sql(message()) }
            }
            try exec("COMMIT")
        } catch {
            sqlite3_exec(db, "ROLLBACK", nil, nil, nil)
            throw error
        }
    }
    
    /// Makes every pending item due now (used by "Sync now" and when connectivity returns).
    func makeAllDue() throws(QueueError) {
        try exec("UPDATE queue SET next_attempt = 0 WHERE state = 0")
        try exec("UPDATE pending_deletions SET next_attempt = 0 WHERE state = 0")
    }
    
    func counts() throws(QueueError) -> QueueCounts {
        let statement = try prepare("SELECT state, COUNT(*) FROM queue GROUP BY state")
        defer { sqlite3_finalize(statement) }
        var counts = QueueCounts()
        while sqlite3_step(statement) == SQLITE_ROW {
            let n = Int(sqlite3_column_int(statement, 1))
            switch State(rawValue: sqlite3_column_int(statement, 0)) {
            case .pending: counts.pending = n
            case .sent: counts.sent = n
            case .rejected: counts.rejected = n
            case .skipped: counts.skipped = n
            case nil: break
            }
        }
        return counts
    }
    
    /// When the next pending item becomes due, or `nil` if nothing is pending.
    func earliestDue() throws(QueueError) -> Date? {
        let statement = try prepare("SELECT MIN(next_attempt) FROM queue WHERE state = 0")
        defer { sqlite3_finalize(statement) }
        guard sqlite3_step(statement) == SQLITE_ROW, sqlite3_column_type(statement, 0) != SQLITE_NULL else {
            return nil
        }
        return Date(timeIntervalSince1970: sqlite3_column_double(statement, 0))
    }
    
    /// The most recent rejection reasons, newest first (for the status screen).
    func rejections(limit: Int) throws(QueueError) -> [(key: String, reason: String)] {
        let statement = try prepare("SELECT key, last_error FROM queue WHERE state = 2 ORDER BY seq DESC LIMIT ?1")
        defer { sqlite3_finalize(statement) }
        sqlite3_bind_int(statement, 1, Int32(limit))
        var out: [(String, String)] = []
        while sqlite3_step(statement) == SQLITE_ROW {
            let key = sqlite3_column_text(statement, 0).map { String(cString: $0) } ?? ""
            let reason = sqlite3_column_text(statement, 1).map { String(cString: $0) } ?? ""
            out.append((key, reason))
        }
        return out
    }
    
    /// Number of attempts recorded for a key (tests).
    func attempts(for key: String) throws(QueueError) -> Int? {
        let statement = try prepare("SELECT attempts FROM queue WHERE key = ?1")
        defer { sqlite3_finalize(statement) }
        bind(statement, 1, text: key)
        return sqlite3_step(statement) == SQLITE_ROW ? Int(sqlite3_column_int(statement, 0)) : nil
    }
    
    
    // MARK: SQLite plumbing
    
    private func set(_ state: State, keys: [String], error: String?) throws(QueueError) {
        try exec("BEGIN IMMEDIATE")
        do throws(QueueError) {
            for key in keys {
                let statement = try prepare("UPDATE queue SET state = ?2, last_error = ?3 WHERE key = ?1")
                defer { sqlite3_finalize(statement) }
                bind(statement, 1, text: key)
                sqlite3_bind_int(statement, 2, state.rawValue)
                if let error { bind(statement, 3, text: error) } else { sqlite3_bind_null(statement, 3) }
                guard sqlite3_step(statement) == SQLITE_DONE else { throw QueueError.sql(message()) }
            }
            try exec("COMMIT")
        } catch {
            sqlite3_exec(db, "ROLLBACK", nil, nil, nil)
            throw error
        }
    }
    
    private func encode(_ item: QueuedItem) throws(QueueError) -> Data {
        do {
            return try encoder.encode(item)
        } catch {
            throw .sql("A sample could not be encoded for the queue.")
        }
    }
    
    private func exec(_ sql: String) throws(QueueError) {
        guard sqlite3_exec(db, sql, nil, nil, nil) == SQLITE_OK else {
            throw .sql(message())
        }
    }
    
    private func prepare(_ sql: String) throws(QueueError) -> OpaquePointer {
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK, let statement else {
            throw .sql(message())
        }
        return statement
    }
    
    private func message() -> String {
        db.map { String(cString: sqlite3_errmsg($0)) } ?? "no database"
    }
    
    private nonisolated func bind(_ statement: OpaquePointer, _ index: Int32, text: String) {
        sqlite3_bind_text(statement, index, text, -1, unsafeBitCast(-1, to: sqlite3_destructor_type.self))
    }
    
    private nonisolated func bind(_ statement: OpaquePointer, _ index: Int32, blob: Data) {
        _ = blob.withUnsafeBytes { raw in
            sqlite3_bind_blob(statement, index, raw.baseAddress, Int32(blob.count), unsafeBitCast(-1, to: sqlite3_destructor_type.self))
        }
    }
}
