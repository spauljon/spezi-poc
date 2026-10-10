//
// This source file is part of the Spezi POC capture app, adapted from the Stanford Spezi Template Application
//
// SPDX-FileCopyrightText: 2023 Stanford University and the project authors (see CONTRIBUTORS.md)
//
// SPDX-License-Identifier: MIT
//

import XCTest


/// End to end: sign in as the synthetic capture user through Keycloak, then prove the server accepts the token.
///
/// Needs the stack running, the simulator trusting the POC CA (`scripts/ios-sim-trust.sh install`), and the password
/// of the synthetic capture user in the environment variable `POC_CAPTURE_PASSWORD`, which `scripts/ios-test.sh --ui`
/// takes from the git-ignored `idp/.env.local` (xcodebuild forwards `TEST_RUNNER_`-prefixed variables). The password is
/// typed by this test only: it is never printed, logged or committed. Without it the test is SKIPPED, loudly.
final class SignInTests: XCTestCase {
    private let username = "capture-user"
    
    @MainActor
    override func setUp() async throws {
        continueAfterFailure = false
    }
    
    @MainActor
    func testSignInShowsRolesAndServerAcceptsTheToken() throws {
        guard let password = ProcessInfo.processInfo.environment["POC_CAPTURE_PASSWORD"], !password.isEmpty else {
            throw XCTSkip("POC_CAPTURE_PASSWORD is not set: run scripts/ios-test.sh --ui (it reads idp/.env.local)")
        }
        
        let app = XCUIApplication()
        app.launchArguments = ["--skipOnboarding"]
        app.launch()
        
        // Start from signed out, whatever a previous run left behind.
        if app.buttons["Sign out"].waitForExistence(timeout: 3) {
            app.buttons["Sign out"].tap()
        }
        XCTAssertTrue(app.staticTexts["Not signed in"].waitForExistence(timeout: 5))
        
        XCTAssertTrue(app.buttons["Sign in"].exists)
        app.buttons["Sign in"].tap()
        
        // The Keycloak login page, in the system browser session (a separate process).
        let browser = XCUIApplication(bundleIdentifier: "com.apple.SafariViewService")
        let usernameField = browser.textFields["Username"].firstMatch
        XCTAssertTrue(usernameField.waitForExistence(timeout: 20), "Keycloak's login page did not appear")
        usernameField.tap()
        usernameField.typeText(username)
        
        let passwordField = browser.secureTextFields["Password"].firstMatch
        XCTAssertTrue(passwordField.waitForExistence(timeout: 5))
        passwordField.tap()
        passwordField.typeText(password)
        browser.buttons["Sign In"].firstMatch.tap()
        
        // Back in the app: signed in as the capture user, with the capture role, and no token on screen.
        XCTAssertTrue(app.staticTexts[username].waitForExistence(timeout: 20), "the app did not show the signed-in user")
        // LabeledContent merges "Roles" and its value into one accessibility element, so match on the label's content.
        let roles = app.staticTexts.matching(NSPredicate(format: "label CONTAINS 'capture-writer'")).firstMatch
        XCTAssertTrue(roles.exists, "the roles claim did not show capture-writer")
        XCTAssertFalse(app.staticTexts["Not signed in"].exists)
        XCTAssertFalse(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'eyJ'")).firstMatch.exists, "a token is on screen")
        
        // The server enforces what M4 built: public metadata, a refused anonymous request, a served authenticated one.
        app.buttons["Check server"].tap()
        // The results are below the fold, and a List does not render rows that are off screen.
        app.swipeUp()
        // Each row is a title plus a separate detail line ("HTTP 200, expected 200").
        func exists(_ text: String, timeout: TimeInterval = 5) -> Bool {
            app.staticTexts[text].waitForExistence(timeout: timeout)
        }
        XCTAssertTrue(exists("Capability statement, no token", timeout: 15))
        XCTAssertTrue(exists("Patient search, no token"))
        XCTAssertTrue(exists("Patient search, your token"))
        // Metadata and the authenticated search are served; the anonymous search is refused.
        XCTAssertEqual(app.staticTexts.matching(NSPredicate(format: "label == 'HTTP 200, expected 200'")).count, 2)
        XCTAssertEqual(app.staticTexts.matching(NSPredicate(format: "label == 'HTTP 401, expected 401'")).count, 1)
        
        // Sign out clears the state.
        app.swipeDown()
        XCTAssertTrue(app.buttons["Sign out"].waitForExistence(timeout: 5))
        app.buttons["Sign out"].tap()
        XCTAssertTrue(app.staticTexts["Not signed in"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.staticTexts[username].exists)
    }
}
