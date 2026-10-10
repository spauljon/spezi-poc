//
// This source file is part of the Spezi POC capture app, adapted from the Stanford Spezi Template Application
//
// SPDX-FileCopyrightText: 2023 Stanford University and the project authors (see CONTRIBUTORS.md)
//
// SPDX-License-Identifier: MIT
//

import XCTest


/// The simulator screen: reachable from Home for the synthetic source, runs the simulated device, shows what it emitted.
/// Needs neither the stack nor a sign-in: the synthetic source is entirely on the device.
final class SimulatorTests: XCTestCase {
    @MainActor
    override func setUp() async throws {
        continueAfterFailure = false
    }
    
    @MainActor
    func testSimulatorRunsAndShowsEmittedSamples() throws {
        let app = XCUIApplication()
        app.launchArguments = ["--skipOnboarding"]
        app.launch()
        
        // Reachable from Home because the source is synthetic.
        XCTAssertTrue(app.buttons["Simulator controls"].waitForExistence(timeout: 10))
        app.buttons["Simulator controls"].tap()
        XCTAssertTrue(app.navigationBars["Simulator"].waitForExistence(timeout: 5))
        
        // Positive control: before Start nothing has been emitted (the list says so).
        app.swipeUp()
        app.swipeUp()
        app.swipeUp()
        XCTAssertTrue(app.staticTexts["Nothing emitted yet."].waitForExistence(timeout: 5), "should start empty")
        XCTAssertFalse(app.staticTexts.matching(NSPredicate(format: "label ENDSWITH ' /min'")).firstMatch.exists)
        
        // Start (the button's label is "Start" until it runs).
        app.swipeDown()
        app.swipeDown()
        app.swipeDown()
        let startStop = app.buttons["simulatorStartStop"]
        var tries = 0
        while !startStop.isHittable && tries < 6 {
            app.swipeUp()
            tries += 1
        }
        XCTAssertTrue(startStop.waitForExistence(timeout: 5))
        XCTAssertEqual(startStop.label, "Start")
        startStop.tap()
        XCTAssertTrue(app.buttons["simulatorStartStop"].waitForExistence(timeout: 5))
        XCTAssertEqual(app.buttons["simulatorStartStop"].label, "Stop")
        
        // Samples arrive (virtual time runs 60x), and are listed with their values in /min.
        app.swipeUp()
        app.swipeUp()
        app.swipeUp()
        let sample = app.staticTexts.matching(NSPredicate(format: "label ENDSWITH ' /min'")).firstMatch
        XCTAssertTrue(sample.waitForExistence(timeout: 20), "no sample appeared in the latest-samples list")
        XCTAssertFalse(app.staticTexts["Nothing emitted yet."].exists)
        
        // Stop returns the button to Start and leaves the counts.
        app.swipeDown()
        app.swipeDown()
        app.swipeDown()
        var again = 0
        while !app.buttons["simulatorStartStop"].isHittable && again < 6 {
            app.swipeUp()
            again += 1
        }
        app.buttons["simulatorStartStop"].tap()
        XCTAssertEqual(app.buttons["simulatorStartStop"].label, "Start")
    }
}
