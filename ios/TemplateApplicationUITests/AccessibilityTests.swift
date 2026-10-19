//
// This source file is part of the Spezi POC capture app, adapted from the Stanford Spezi Template Application
//
// SPDX-FileCopyrightText: 2023 Stanford University and the project authors (see CONTRIBUTORS.md)
//
// SPDX-License-Identifier: MIT
//

import XCTest


/// Xcode's built-in accessibility audit (contrast, Dynamic Type, hit regions, element descriptions, clipped text, traits)
/// run on every screen a person reaches without signing in. No package is involved.
///
/// It is a RATCHET, not a claim of zero findings. A contrast result of "failed" is never accepted. The borderline
/// ("nearly passed") contrast results and the Dynamic Type results that remain are counted per screen and may not grow.
/// What is left, as far as it can be traced:
///  - the template's onboarding tiles (SpeziOnboarding) draw their descriptions in iOS's own secondary gray, about 3.3:1;
///  - system list section headers, in the same gray;
///  - Dynamic Type "partially unsupported" on a few system-styled list rows. The app sets no fixed font size anywhere
///    (a unit test scans for it), so these are the audit's judgement of SwiftUI list rows, not a fixed-size font.
/// The audit gives no element for most of them, so the causes above are inferred, not confirmed. Lower a baseline when a
/// fix lands.
final class AccessibilityTests: XCTestCase {
    private struct Findings: Equatable {
        var failedContrast = 0
        var nearContrast = 0
        var dynamicTypePartial = 0
        var dynamicTypeUnsupported = 0
        var other = 0
    }
    
    /// The most each screen may report. Observed 2026-10-17 after the contrast fixes in M19.
    private static let baseline: [String: Findings] = [
        "Orientation": Findings(nearContrast: 3),
        "Data source": Findings(),
        "Home": Findings(nearContrast: 4, dynamicTypePartial: 4),
        "Simulator controls": Findings(nearContrast: 3, dynamicTypeUnsupported: 1),
    ]
    
    override func setUp() {
        continueAfterFailure = true
    }
    
    /// Runs the audit and counts what it found by kind, keeping a readable line per issue for the failure message.
    @MainActor
    private func audit(_ app: XCUIApplication, screen: String) throws -> (Findings, [String]) {
        var findings = Findings()
        var lines: [String] = []
        try app.performAccessibilityAudit(for: .all) { issue in
            let summary = issue.compactDescription
            let element = issue.element?.label ?? issue.element?.identifier ?? "(no element)"
            lines.append("\(screen): \"\(element)\": \(summary) | \(issue.detailedDescription)")
            switch issue.auditType {
            case .contrast:
                if summary.contains("failed") { findings.failedContrast += 1 } else { findings.nearContrast += 1 }
            case .dynamicType:
                if summary.contains("partially") { findings.dynamicTypePartial += 1 } else { findings.dynamicTypeUnsupported += 1 }
            default:
                findings.other += 1
            }
            return true // keep going: count every issue on the screen instead of stopping at the first
        }
        return (findings, lines)
    }
    
    private func check(_ found: Findings, against allowed: Findings, screen: String, lines: [String]) {
        let report = lines.joined(separator: "\n")
        XCTAssertEqual(found.failedContrast, 0, "\(screen): contrast failed\n\(report)")
        XCTAssertEqual(found.other, 0, "\(screen): an issue that is neither contrast nor Dynamic Type\n\(report)")
        XCTAssertLessThanOrEqual(found.nearContrast, allowed.nearContrast, "\(screen): more borderline-contrast results than the baseline\n\(report)")
        XCTAssertLessThanOrEqual(found.dynamicTypePartial, allowed.dynamicTypePartial, "\(screen): more partial Dynamic Type results than the baseline\n\(report)")
        XCTAssertLessThanOrEqual(found.dynamicTypeUnsupported, allowed.dynamicTypeUnsupported, "\(screen): more unsupported Dynamic Type results than the baseline\n\(report)")
    }
    
    @MainActor
    func testScreensDoNotRegressOnTheAccessibilityAudit() throws {
        let onboarding = XCUIApplication()
        onboarding.launchArguments = ["--showOnboarding"]
        onboarding.launch()
        XCTAssertTrue(onboarding.staticTexts["Spezi POC Capture"].waitForExistence(timeout: 10))
        var (found, lines) = try audit(onboarding, screen: "Orientation")
        check(found, against: Self.baseline["Orientation"] ?? Findings(), screen: "Orientation", lines: lines)
        onboarding.buttons["Continue"].tap()
        XCTAssertTrue(onboarding.staticTexts["Data source"].waitForExistence(timeout: 5))
        (found, lines) = try audit(onboarding, screen: "Data source")
        check(found, against: Self.baseline["Data source"] ?? Findings(), screen: "Data source", lines: lines)
        onboarding.terminate()
        
        let home = XCUIApplication()
        home.launchArguments = ["--skipOnboarding"]
        home.launch()
        XCTAssertTrue(home.navigationBars["Capture"].waitForExistence(timeout: 10))
        (found, lines) = try audit(home, screen: "Home")
        check(found, against: Self.baseline["Home"] ?? Findings(), screen: "Home", lines: lines)
        
        let simulator = home.buttons["Simulator controls"]
        XCTAssertTrue(simulator.waitForExistence(timeout: 5))
        simulator.tap()
        XCTAssertTrue(home.navigationBars.firstMatch.waitForExistence(timeout: 5))
        (found, lines) = try audit(home, screen: "Simulator controls")
        check(found, against: Self.baseline["Simulator controls"] ?? Findings(), screen: "Simulator controls", lines: lines)
    }
}
