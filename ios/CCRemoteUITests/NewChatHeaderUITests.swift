import XCTest

final class NewChatHeaderUITests: XCTestCase {
    private func launch(session: String? = nil, theme: String = "light") throws -> XCUIApplication {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["CC_NEW_RUN_FIXTURE"] == "1")
        continueAfterFailure = false
        let app = XCUIApplication()
        let port = ProcessInfo.processInfo.environment["CC_FIXTURE_PORT"] ?? "18768"
        app.launchEnvironment = ["CC_HUB_URL": "ws://127.0.0.1:\(port)/ui",
                                 "CC_TOKEN": "header-\(UUID())", "CC_THEME": theme, "CC_HW_KEYBOARD": "false"]
        if let session { app.launchEnvironment["CC_OPEN"] = "m::\(session)" }
        app.launch()
        XCTAssertTrue(app.textViews.firstMatch.waitForExistence(timeout: 15))
        return app
    }

    private func checkHeader(_ app: XCUIApplication) {
        let button = app.buttons["header.newChat"]
        let title = app.descendants(matching: .any)["session.title"]
        XCTAssertTrue(button.waitForExistence(timeout: 5))
        XCTAssertTrue(title.exists)
        XCTAssertTrue(button.isHittable)
        XCTAssertGreaterThanOrEqual(button.frame.width, 44)
        XCTAssertGreaterThanOrEqual(button.frame.height, 44)
        XCTAssertGreaterThanOrEqual(button.frame.minX, title.frame.maxX)
        XCTAssertLessThan(title.frame.height, 25)
        XCTAssertLessThanOrEqual(app.buttons["Сессии"].frame.minX, 24)
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = "Session header with new chat"; shot.lifetime = .keepAlways; add(shot)
    }

    private func checkComposerAboveKeyboard(_ app: XCUIApplication) {
        let keyboard = app.keyboards.firstMatch
        XCTAssertTrue(keyboard.waitForExistence(timeout: 5))
        let composer = app.otherElements["composer.island"]
        XCTAssertTrue(composer.waitForExistence(timeout: 5))
        XCTAssertLessThanOrEqual(composer.frame.maxY, keyboard.frame.minY + 1)
        XCTAssertLessThan(app.buttons["start.project"].frame.maxY, composer.frame.minY)
        XCTAssertTrue(app.textViews.firstMatch.isHittable)
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = "New chat input above keyboard"; shot.lifetime = .keepAlways; add(shot)
    }

    func testNewChatFromSessionPreservesDraft() throws {
        for theme in ["light", "dark"] {
            let app = try launch(session: "s0", theme: theme)
            checkHeader(app)
            let field = app.textViews.firstMatch
            let draft = "Черновик \(UUID())"
            field.tap(); field.typeText(draft)
            app.buttons["header.newChat"].tap()
            XCTAssertTrue(app.staticTexts["start.welcome"].waitForExistence(timeout: 5))
            XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
            checkComposerAboveKeyboard(app)
            XCTAssertFalse(app.buttons["header.newChat"].exists)
            XCTAssertEqual(field.value as? String, "")
            app.buttons["Сессии"].tap()
            let row = app.buttons["drawer.session.m::s0"]
            XCTAssertTrue(row.waitForExistence(timeout: 5))
            row.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
            XCTAssertTrue(app.buttons["header.newChat"].waitForExistence(timeout: 5))
            XCTAssertEqual(field.value as? String, draft)
            app.terminate()
        }
    }

    func testNewChatFromReadingAndDrawerKeepsInputAboveKeyboard() throws {
        let app = try launch(session: "s0")
        XCTAssertFalse(app.keyboards.firstMatch.exists)
        app.buttons["header.newChat"].tap()
        checkComposerAboveKeyboard(app)
        app.buttons["Сессии"].tap()
        let row = app.buttons["drawer.session.m::s0"]
        XCTAssertTrue(row.waitForExistence(timeout: 5))
        row.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        XCTAssertTrue(app.buttons["header.newChat"].waitForExistence(timeout: 5))
        app.buttons["Сессии"].tap()
        app.buttons["drawer.newChat"].tap()
        checkComposerAboveKeyboard(app)
    }

    func testNewChatFromJustStartedSessionPreservesDraft() throws {
        let app = try launch()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        checkComposerAboveKeyboard(app)
        let field = app.textViews.firstMatch
        field.tap(); field.typeText("Проверка нового разговора")
        app.buttons["Отправить"].tap()
        checkHeader(app)
        field.tap(); field.typeText("Сохранить продолжение")
        // The stand assigns the permanent id after ten seconds.
        Thread.sleep(forTimeInterval: 11)
        app.buttons["header.newChat"].tap()
        XCTAssertTrue(app.staticTexts["start.welcome"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        checkComposerAboveKeyboard(app)
        XCTAssertEqual(field.value as? String, "")
        app.buttons["Сессии"].tap()
        let row = app.buttons["drawer.session.m::created"]
        XCTAssertTrue(row.waitForExistence(timeout: 5))
        row.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        XCTAssertTrue(app.buttons["header.newChat"].waitForExistence(timeout: 5))
        XCTAssertEqual(field.value as? String, "Сохранить продолжение")
        app.terminate()
    }
}
