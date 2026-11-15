import XCTest

final class NewSessionContinuityUITests: XCTestCase {
    func testNewSessionKeepsFollowupThroughIdAssignmentAndReopening() throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["CC_NEW_RUN_FIXTURE"] == "1")
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchEnvironment = ["CC_HUB_URL": "ws://127.0.0.1:18768/ui",
                                 "CC_TOKEN": "new-run-\(UUID().uuidString)", "CC_THEME": "light"]
        app.launch()
        let field = app.textViews.firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 15))
        field.tap()
        field.typeText("Проверка нового разговора")
        app.buttons["Отправить"].tap()
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        field.tap()
        field.typeText("Не потеряй этот черновик")
        Thread.sleep(forTimeInterval: 11)
        XCTAssertEqual(field.value as? String, "Не потеряй этот черновик")
        XCTAssertTrue(app.buttons["composer.settings"].exists)
        XCTAssertTrue(app.buttons["Сессии"].exists)
        app.buttons["composer.settings"].tap()
        XCTAssertTrue(app.buttons["runSettings.done"].waitForExistence(timeout: 5))
        app.buttons["runSettings.done"].tap()
        XCTAssertEqual(field.value as? String, "Не потеряй этот черновик")
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = "New session retains draft and bottom settings"
        shot.lifetime = .keepAlways
        add(shot)
        app.buttons["Сессии"].tap()
        let row = app.buttons["drawer.session.m::created"]
        XCTAssertTrue(row.waitForExistence(timeout: 5))
        XCTAssertTrue(row.label.contains("Проверка нового разговора"))
        // A different conversation must not inherit the new run's draft.
        let other = app.buttons["drawer.session.m::s0"]
        XCTAssertTrue(other.waitForExistence(timeout: 5))
        other.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        XCTAssertEqual(field.value as? String, "")
        app.buttons["Сессии"].tap()
        row.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        XCTAssertEqual(field.value as? String, "Не потеряй этот черновик")
    }

    func testDictationSurvivesPermanentSessionId() throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["CC_NEW_RUN_FIXTURE"] == "1")
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchEnvironment = ["CC_HUB_URL": "ws://127.0.0.1:18768/ui",
                                 "CC_TOKEN": "new-voice-\(UUID().uuidString)", "CC_THEME": "dark",
                                 "CC_DICTATION_FIXTURE": "1", "CC_DICTATION_FINAL_FIXTURE": "1"]
        app.launch()
        let field = app.textViews.firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 15))
        field.tap()
        field.typeText("Новая голосовая сессия")
        app.buttons["Отправить"].tap()
        XCTAssertTrue(app.buttons["Начать запись"].waitForExistence(timeout: 5))
        app.buttons["Начать запись"].tap()
        Thread.sleep(forTimeInterval: 11)
        XCTAssertTrue(app.buttons["Остановить запись"].exists)
        app.buttons["Остановить запись"].tap()
        let final = NSPredicate(format: "value == %@", "Проверка голосового сообщения и последние слова")
        expectation(for: final, evaluatedWith: field)
        waitForExpectations(timeout: 5)
        app.buttons["Сессии"].tap()
        let row = app.buttons["drawer.session.m::created"]
        XCTAssertTrue(row.waitForExistence(timeout: 5))
        row.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        XCTAssertEqual(field.value as? String, "Проверка голосового сообщения и последние слова")
    }
}
