import XCTest

final class FloatingChromeUITests: XCTestCase {
    func testTranscriptBehindIslandsAndKeyboardKeepsDraft() throws {
        continueAfterFailure = false
        try XCTSkipUnless(ProcessInfo.processInfo.environment["CC_SETTINGS_FIXTURE"] == "1",
                          "requires CC_CHROME_FIXTURE=1 runtime stand")
        let app = XCUIApplication()
        app.launchEnvironment = ["CC_HUB_URL": "ws://127.0.0.1:18768/ui", "CC_TOKEN": "chrome-\(UUID().uuidString)",
                                 "CC_OPEN": "m::s0", "CC_HW_KEYBOARD": "false",
                                 "CC_THEME": ProcessInfo.processInfo.environment["CC_TEST_THEME"] ?? "light"]
        app.launch()
        let field = app.textViews.firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 15))
        let tail = app.staticTexts.matching(NSPredicate(format: "label CONTAINS 'Сообщение 24.'")).firstMatch
        XCTAssertTrue(tail.waitForExistence(timeout: 10))
        XCTAssertTrue(tail.isHittable)
        shot(app, "Session tail with floating islands")
        let chat = app.scrollViews["chat.transcript"]
        chat.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.25))
            .press(forDuration: 0.05, thenDragTo: chat.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.75)))
        XCTAssertTrue(app.buttons["Вниз"].waitForExistence(timeout: 5))
        shot(app, "Earlier messages behind top and bottom islands")
        app.buttons["Вниз"].tap()
        XCTAssertTrue(tail.isHittable)
        let island = app.otherElements["composer.island"].firstMatch
        XCTAssertLessThanOrEqual(tail.frame.maxY, island.frame.minY)
        field.tap()
        field.typeText("Черновик прозрачной панели")
        XCTAssertTrue(app.keyboards.firstMatch.exists)
        XCTAssertLessThanOrEqual(island.frame.maxY, app.keyboards.firstMatch.frame.minY - 4)
        shot(app, "Floating composer with keyboard")
        // Unclipped ScrollView's AX frame includes overflow; target the actual
        // reading area between navigation controls and the composer.
        let titleBottom = app.navigationBars.firstMatch.frame.maxY
        app.coordinate(withNormalizedOffset: .zero)
            .withOffset(CGVector(dx: 8, dy: (titleBottom + island.frame.minY) / 2)).tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 3))
        XCTAssertEqual(field.value as? String, "Черновик прозрачной панели")
    }

    private func shot(_ app: XCUIApplication, _ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
