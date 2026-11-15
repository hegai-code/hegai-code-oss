import XCTest

final class SessionHistoryScrollUITests: XCTestCase {
    func testLongHistoryStaysVisibleAfterOpenAndSessionSwitch() throws {
        continueAfterFailure = false
        try XCTSkipUnless(ProcessInfo.processInfo.environment["CC_HISTORY_FIXTURE"] == "1",
                          "requires CC_HISTORY_FIXTURE=1 runtime stand")
        let app = XCUIApplication()
        app.launchEnvironment = ["CC_HUB_URL": "ws://127.0.0.1:\(ProcessInfo.processInfo.environment["CC_FIXTURE_PORT"] ?? "18768")/ui",
                                 "CC_TOKEN": "history-\(UUID().uuidString)", "CC_OPEN": "m::s0",
                                 "CC_THEME": ProcessInfo.processInfo.environment["CC_TEST_THEME"] ?? "light", "CC_HW_KEYBOARD": "false"]
        app.launch()
        assertTail(app, session: "s0")
        for session in ["s1", "s0"] {
            app.buttons["Сессии"].tap()
            let row = app.buttons["drawer.session.m::\(session)"]
            XCTAssertTrue(row.waitForExistence(timeout: 5))
            row.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
            assertTail(app, session: session)
        }
        let from = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.3))
        let to = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.7))
        for _ in 0..<3 { from.press(forDuration: 0.05, thenDragTo: to) }
        XCTAssertTrue(app.buttons["Вниз"].waitForExistence(timeout: 5))
        let down = app.buttons["Вниз"]
        XCTAssertEqual(down.frame.midX, app.frame.midX, accuracy: 1)
        XCTAssertGreaterThanOrEqual(down.frame.width, 44)
        XCTAssertGreaterThanOrEqual(down.frame.height, 44)
        XCTAssertLessThanOrEqual(down.frame.maxY, app.otherElements["composer.island"].firstMatch.frame.minY)
        shot(app, "Reading earlier mixed-height history")
        app.buttons["Вниз"].tap()
        assertTail(app, session: "s0")
    }

    func testEarlierMessagesRevealFromMemoryWithoutLosingPlace() throws {
        continueAfterFailure = false
        try XCTSkipUnless(ProcessInfo.processInfo.environment["CC_HISTORY_FIXTURE"] == "1",
                          "requires CC_HISTORY_FIXTURE=1 runtime stand")
        let app = XCUIApplication()
        app.launchEnvironment = ["CC_HUB_URL": "ws://127.0.0.1:\(ProcessInfo.processInfo.environment["CC_FIXTURE_PORT"] ?? "18768")/ui",
                                 "CC_TOKEN": "pages-\(UUID().uuidString)", "CC_OPEN": "m::s2",
                                 "CC_THEME": "light"]
        app.launch()
        assertTail(app, session: "s2")
        XCTAssertFalse(app.staticTexts["Строка истории 34"].exists)
        let more = app.buttons["history.earlierLocal"]
        let from = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.25))
        let to = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.8))
        for _ in 0..<12 {
            if more.isHittable { break }
            from.press(forDuration: 0.05, thenDragTo: to)
        }
        XCTAssertTrue(more.isHittable)
        more.tap()
        XCTAssertTrue(app.staticTexts["Строка истории 34"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Строка истории 35"].isHittable)
        shot(app, "Earlier page keeps the previously visible message")
        app.buttons["Вниз"].tap()
        assertTail(app, session: "s2")
    }

    private func assertTail(_ app: XCUIApplication, session: String) {
        let tail = app.staticTexts["КОНЕЦ ИСТОРИИ \(session)"]
        XCTAssertTrue(tail.waitForExistence(timeout: 20))
        let composer = app.otherElements["composer.island"].firstMatch
        for _ in 0..<5 {
            XCTAssertTrue(tail.isHittable)
            XCTAssertGreaterThanOrEqual(tail.frame.minY, app.navigationBars.firstMatch.frame.maxY)
            XCTAssertLessThanOrEqual(tail.frame.maxY, composer.frame.minY)
            Thread.sleep(forTimeInterval: 0.5)
        }
        shot(app, "Stable tail \(session)")
    }

    private func shot(_ app: XCUIApplication, _ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
