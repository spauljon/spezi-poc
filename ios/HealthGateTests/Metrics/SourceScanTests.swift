//
// This source file is part of the Spezi POC capture app, adapted from the Stanford Spezi Template Application
//
// SPDX-FileCopyrightText: 2023 Stanford University and the project authors (see CONTRIBUTORS.md)
//
// SPDX-License-Identifier: MIT
//

import Foundation
import Testing


/// The app never fixes a font size, so text follows the person's Dynamic Type setting. A scan of the sources, with a
/// positive control proving the scanner can see what it looks for.
@Suite("Dynamic Type: no fixed font sizes")
struct FixedFontSizeTests {
    static let patterns = [".font(.system(size:", "Font.system(size:", "UIFont.systemFont(ofSize:", ".font(.custom(\"", "ofSize:"]
    
    static func offences(in text: String) -> [String] {
        text.split(separator: "\n", omittingEmptySubsequences: false).enumerated().compactMap { index, line in
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            guard !trimmed.hasPrefix("//") else { return nil }
            return patterns.first { trimmed.contains($0) }.map { "line \(index + 1): \($0)" }
        }
    }
    
    @Test("the scanner sees a fixed size, and ignores a comment that mentions one (the control)")
    func scannerWorks() {
        #expect(Self.offences(in: "Text(\"x\").font(.system(size: 14))").count == 1)
        #expect(Self.offences(in: "// .font(.system(size: 14)) would be wrong").isEmpty)
        #expect(Self.offences(in: "Text(\"x\").font(.footnote)").isEmpty)
    }
    
    @Test("no source file of the app sets a fixed font size")
    func appHasNone() throws {
        let root = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent() // Metrics
            .deletingLastPathComponent() // HealthGateTests
            .deletingLastPathComponent() // ios
            .appending(path: "HealthGate")
        let enumerator = try #require(FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil))
        var scanned = 0
        for case let url as URL in enumerator where url.pathExtension == "swift" {
            scanned += 1
            let text = try String(contentsOf: url, encoding: .utf8)
            #expect(Self.offences(in: text).isEmpty, "\(url.lastPathComponent): \(Self.offences(in: text))")
        }
        #expect(scanned > 30, "the scan must actually have read the app's sources")
    }
}
