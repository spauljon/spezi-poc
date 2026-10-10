//
// This source file is part of the Spezi POC capture app, adapted from the Stanford Spezi Template Application
//
// SPDX-FileCopyrightText: 2023 Stanford University and the project authors (see CONTRIBUTORS.md)
//
// SPDX-License-Identifier: MIT
//

import Foundation


/// FHIR `dateTime` / `instant` strings, written by hand so that nothing depends on `DateFormatter` locale or
/// calendar settings. The offset is the offset of the given zone AT THE GIVEN INSTANT, so a period that spans a DST
/// change has a different offset at each end (`rules.effective` in the contract).
enum FHIRDateTime {
    enum Failure: Error, Equatable {
        /// FHIR offsets are whole minutes; a zone whose offset at this instant is not (historical local mean time).
        case offsetNotWholeMinutes
    }
    
    /// - Parameter alwaysMillis: `issued` always has three fractional digits; effective times only when non-zero.
    static func string(from date: Date, in timeZone: TimeZone, alwaysMillis: Bool = false) throws(Failure) -> String {
        // Work in whole milliseconds so floating-point noise cannot move a value across a second boundary.
        let totalMillis = Int64((date.timeIntervalSince1970 * 1000).rounded())
        var wholeSeconds = totalMillis / 1000
        var millis = Int(totalMillis % 1000)
        if millis < 0 {
            millis += 1000
            wholeSeconds -= 1
        }
        let instant = Date(timeIntervalSince1970: TimeInterval(wholeSeconds))
        
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        let c = calendar.dateComponents([.year, .month, .day, .hour, .minute, .second], from: instant)
        
        let offset = timeZone.secondsFromGMT(for: instant)
        guard offset % 60 == 0 else {
            throw .offsetNotWholeMinutes
        }
        let sign = offset >= 0 ? "+" : "-"
        let minutes = abs(offset) / 60
        
        var out = String(format: "%04d-%02d-%02dT%02d:%02d:%02d", c.year ?? 0, c.month ?? 0, c.day ?? 0, c.hour ?? 0, c.minute ?? 0, c.second ?? 0)
        if millis != 0 || alwaysMillis {
            out += String(format: ".%03d", millis)
        }
        out += String(format: "%@%02d:%02d", sign, minutes / 60, minutes % 60)
        return out
    }
}
