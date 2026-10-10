//
// This source file is part of the Spezi POC capture app, adapted from the Stanford Spezi Template Application
//
// SPDX-FileCopyrightText: 2023 Stanford University and the project authors (see CONTRIBUTORS.md)
//
// SPDX-License-Identifier: MIT
//

import XCTest


final class OnboardingTests: XCTestCase {
    @MainActor
    override func setUp() async throws {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["--showOnboarding"]
        // --showOnboarding forces the flow regardless of stored state, so the app need not be deleted first.
        app.launch()
    }
    
    
    @MainActor
    func testOrientationAndSourceSelection() throws {
        let app = XCUIApplication()
        
        // Orientation: what data, where it goes, synthetic versus real.
        XCTAssertTrue(app.staticTexts["Spezi POC Capture"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["What it collects"].exists)
        XCTAssertTrue(app.staticTexts["Where it goes"].exists)
        XCTAssertTrue(app.staticTexts["Synthetic or real"].exists)
        // No account, consent or permission screens.
        XCTAssertFalse(app.staticTexts["Your Account"].exists)
        XCTAssertFalse(app.staticTexts["Consent"].exists)
        XCTAssertFalse(app.staticTexts["HealthKit Access"].exists)
        app.buttons["Continue"].tap()
        
        // Source selection: synthetic is selected; Apple Health exists but cannot be chosen.
        XCTAssertTrue(app.staticTexts["Data source"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["Synthetic"].exists || app.staticTexts["Synthetic"].exists)
        let appleHealth = app.buttons.containing(NSPredicate(format: "label CONTAINS 'Apple Health'")).firstMatch
        XCTAssertTrue(appleHealth.exists)
        XCTAssertFalse(appleHealth.isEnabled)
        app.buttons["Continue"].tap()
        
        // Home.
        XCTAssertTrue(app.navigationBars["Capture"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Synthetic"].exists)
        // For the synthetic source the simulator is reachable from Home. (Account state is deliberately not asserted
        // here: a previous sign-in can persist in the Keychain, and this test is about onboarding.)
        XCTAssertTrue(app.buttons["Simulator controls"].waitForExistence(timeout: 5))
    }
}
