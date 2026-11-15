import XCTest

final class StartActiveSessionsUITests: XCTestCase {
    func testLongWorkingListScrollsWithoutCoveringComposer() throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["CC_ACTIVE_START_FIXTURE"] == "1")
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchEnvironment = ["CC_HUB_URL": "ws://127.0.0.1:18783/ui", "CC_TOKEN": "many-\(UUID())",
                                 "CC_THEME": ProcessInfo.processInfo.environment["CC_TEST_THEME"] ?? "light",
                                 "CC_HW_KEYBOARD": "false"]
        app.launch()
        XCTAssertTrue(app.buttons["start.active.m::s0"].waitForExistence(timeout: 15))
        _ = try Data(contentsOf: URL(string: "http://127.0.0.1:18783/test/active/many")!)
        XCTAssertTrue(app.buttons["start.active.m::many-0"].waitForExistence(timeout: 5))
        let list = app.scrollViews["start.activeList"]
        tap(app.buttons["start.active.toggle"])
        let last = app.buttons["start.active.m::many-11"]
        for _ in 0..<8 {
            if last.exists && last.isHittable { break }
            list.swipeUp()
        }
        XCTAssertTrue(last.isHittable)
        XCTAssertLessThanOrEqual(list.frame.maxY, app.buttons["start.project"].frame.minY)
        shot(app, "Long active list scrolls above the composer")
        tap(last)
        XCTAssertTrue(app.buttons["session.titleIsland"].waitForExistence(timeout: 5))
        XCTAssertEqual(app.descendants(matching: .any)["session.title"].label, "Работа над задачей 12")
    }

    func testWorkingSessionsOpenBothProvidersAndPreserveNewChatDraft() throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["CC_ACTIVE_START_FIXTURE"] == "1")
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchEnvironment = ["CC_HUB_URL": "ws://127.0.0.1:18783/ui", "CC_TOKEN": "active-\(UUID())",
                                 "CC_THEME": ProcessInfo.processInfo.environment["CC_TEST_THEME"] ?? "light",
                                 "CC_HW_KEYBOARD": "false"]
        app.launch()
        let claude = app.buttons["start.active.m::s0"]
        let codex = app.buttons["start.active.m::s1"]
        XCTAssertTrue(claude.waitForExistence(timeout: 15))
        XCTAssertTrue(codex.exists)
        XCTAssertTrue(claude.label.contains("Настройка мобильного приложения"))
        XCTAssertTrue(codex.label.contains("Проверка новой версии сайта"))
        XCTAssertFalse(app.staticTexts["start.welcome"].exists)
        for id in ["idle", "team"] {
            XCTAssertFalse(app.buttons["start.active.m::\(id)"].exists)
        }
        let field = app.textViews.firstMatch
        field.tap()
        if let existing = field.value as? String, !existing.isEmpty {
            field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: existing.count))
        }
        shot(app, "Active sessions above focused new chat")
        let draft = "Черновик новой задачи"
        field.typeText(draft)
        tap(claude)
        let title = app.descendants(matching: .any)["session.title"]
        XCTAssertTrue(title.waitForExistence(timeout: 5))
        XCTAssertEqual(title.label, "Настройка мобильного приложения")
        shot(app, "Claude activity in the session title")
        tap(app.buttons["Сессии"])
        shot(app, "Both provider marks inside drawer titles")
        tap(app.buttons["drawer.newChat"])
        XCTAssertTrue(claude.waitForExistence(timeout: 5))
        XCTAssertEqual(field.value as? String, draft)
        tap(codex)
        XCTAssertTrue(title.waitForExistence(timeout: 5))
        XCTAssertEqual(title.label, "Проверка новой версии сайта")
        shot(app, "OpenAI activity in the session title")
        tap(app.buttons["header.newChat"])
        XCTAssertTrue(codex.waitForExistence(timeout: 5))
        XCTAssertEqual(field.value as? String, draft)
        _ = try Data(contentsOf: URL(string: "http://127.0.0.1:18783/test/active/idle")!)
        XCTAssertTrue(app.staticTexts["Готово"].waitForExistence(timeout: 5))
        XCTAssertTrue(claude.exists)
        XCTAssertTrue(codex.exists)
        XCTAssertFalse(app.staticTexts["В работе"].exists)
        XCTAssertTrue(field.isHittable)
        XCTAssertEqual(field.value as? String, draft)
        shot(app, "No stale sessions after work finishes")
    }

    private func tap(_ element: XCUIElement) {
        XCTAssertTrue(element.waitForExistence(timeout: 5))
        element.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
    }

    private func shot(_ app: XCUIApplication, _ name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name; shot.lifetime = .keepAlways; add(shot)
    }
}
