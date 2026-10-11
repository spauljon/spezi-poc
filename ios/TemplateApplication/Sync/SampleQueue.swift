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
    /// Valid but deliberately not uploaded (`inBed` has no FHIR mapping in contract v1).
    var skipped = 0
    
    var total: Int { pending + sent + rejected + skipped }
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
        """
        guard sqlite3_exec(handle, "PRAGMA journal_mode=WAL;", nil, nil, nil) == SQLITE_OK || path == nil,
              sqlite3_exec(handle, schema, nil, nil, nil) == SQLITE_OK else {
            let message = String(cString: sqlite3_errmsg(handle))
            sqlite3_close(handle)
            throw .open(message)
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
                let statement = try prepare("INSERT OR IGNORE INTO queue (key, payload) VALUES (?1, ?2)")
                defer { sqlite3_finalize(statement) }
                bind(statement, 1, text: item.key)
                bind(statement, 2, blob: payload)
                guard sqlite3_step(statement) == SQLITE_DONE else { throw QueueError.sql(message()) }
                added += Int(sqlite3_changes(db))
            }
            try exec("COMMIT")
        } catch {
            sqlite3_exec(db, "ROLLBACK", nil, nil, nil)
            throw error
        }
        return (added, items.count - added)
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
