import XCTest

final class ReadingLayoutUITests: XCTestCase {
    func testDrawerShowsOnlyMyHistoryAndNewRuns() throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["CC_OWNERSHIP_FIXTURE"] == "1")
        continueAfterFailure = false
        let app = launch("s0")
        XCTAssertTrue(app.buttons["Сессии"].waitForExistence(timeout: 15))
        app.buttons["Сессии"].tap()
        XCTAssertTrue(app.buttons["drawer.session.m::s0"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["drawer.session.m::new-mine"].exists)
        XCTAssertFalse(app.buttons["drawer.session.m::s1"].exists)
        XCTAssertFalse(app.buttons["drawer.session.m::new-team"].exists)
        XCTAssertFalse(app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "circle,")).firstMatch.exists)
        shot(app, "Only my sessions on shared machine")
        app.buttons["drawer.search"].tap()
        let field = app.textFields["Поиск сессий"]
        XCTAssertTrue(field.waitForExistence(timeout: 3))
        field.typeText("Разверни")
        XCTAssertTrue(app.staticTexts["Ничего не найдено"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["drawer.session.m::s1"].exists)
    }

    func testDrawerControlsStayAvailableWhileListScrollsUnderThem() throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["CC_DRAWER_CHROME_FIXTURE"] == "1")
        continueAfterFailure = false
        let app = launch("s0")
        XCTAssertTrue(app.buttons["Сессии"].waitForExistence(timeout: 15))
        app.buttons["Сессии"].tap()
        let search = app.buttons["drawer.search"]
        let settings = app.buttons["drawer.settings"]
        XCTAssertTrue(search.waitForExistence(timeout: 5))
        let searchFrame = search.frame
        let settingsFrame = settings.frame
        let list = app.scrollViews["drawer.sessions"]
        XCTAssertLessThanOrEqual(list.frame.minY, searchFrame.minY)
        XCTAssertGreaterThanOrEqual(list.frame.maxY, settingsFrame.maxY)
        XCTAssertEqual(searchFrame.height, 44, accuracy: 1)
        XCTAssertEqual(settingsFrame.height, 44, accuracy: 1)
        let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0.35, dy: 0.7))
        let end = app.coordinate(withNormalizedOffset: CGVector(dx: 0.35, dy: 0.3))
        start.press(forDuration: 0.1, thenDragTo: end)
        XCTAssertEqual(search.frame.minY, searchFrame.minY, accuracy: 1)
        XCTAssertEqual(settings.frame.minY, settingsFrame.minY, accuracy: 1)
        shot(app, "Drawer list beneath floating controls")
        // Unclipped rows expand AX hit frames. Tap the controls' visible
        // centers to verify UIKit routing rather than XCTest's chosen point.
        app.coordinate(withNormalizedOffset: .zero)
            .withOffset(CGVector(dx: searchFrame.midX, dy: searchFrame.midY)).tap()
        let field = app.textFields["Поиск сессий"]
        XCTAssertTrue(field.waitForExistence(timeout: 3))
        field.typeText("Сессия 40")
        XCTAssertTrue(app.buttons["drawer.session.m::s39"].waitForExistence(timeout: 5))
        shot(app, "Drawer search above list")
        app.buttons["Отменить поиск"].tap()
        app.coordinate(withNormalizedOffset: .zero)
            .withOffset(CGVector(dx: settingsFrame.midX, dy: settingsFrame.midY)).tap()
        XCTAssertTrue(app.navigationBars["Настройки"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["drawer.search"].isHittable)
    }

    func testSessionSubjectMatchesHeaderAndDrawer() throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["CC_TITLE_FIXTURE"] == "1")
        continueAfterFailure = false
        let app = launch("s0")
        let header = app.descendants(matching: .any)["session.title"]
        XCTAssertTrue(header.waitForExistence(timeout: 15))
        XCTAssertTrue(header.label.contains("Пересборка iPhone-приложения"))
        XCTAssertLessThanOrEqual(header.frame.height, 22)
        // Check the entire tappable island, not only its text: the old text
        // passed while the capsule and activity bolt overlapped the burger.
        let island = app.buttons["session.titleIsland"]
        XCTAssertGreaterThanOrEqual(island.frame.minX - app.buttons["Сессии"].frame.maxX, 4)
        XCTAssertGreaterThanOrEqual(app.buttons["header.newChat"].frame.minX - island.frame.maxX, 4)
        XCTAssertGreaterThan(header.frame.minX, app.buttons["Сессии"].frame.maxX)
        XCTAssertLessThan(header.frame.maxX, app.buttons["header.newChat"].frame.minX)
        shot(app, "Meaningful session header")
        app.buttons["Сессии"].tap()
        // Each row is one accessible button, including its inline activity.
        let title = app.buttons["drawer.session.m::s0"]
        XCTAssertTrue(title.waitForExistence(timeout: 5))
        XCTAssertTrue(title.label.contains("Пересборка iPhone-приложения"))
        XCTAssertTrue(app.buttons["drawer.session.m::s1"].label.contains("Оптимизация производительности"))
        XCTAssertLessThanOrEqual(title.frame.height, 44)
        shot(app, "Meaningful drawer titles")
    }

    func testStreamingAndFinalTextKeepParagraphsAndMarkdown() throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["CC_FORMAT_FIXTURE"] == "1")
        continueAfterFailure = false
        for session in ["s0", "s1"] {
            let app = launch(session)
            let heading = app.staticTexts["Проверка форматирования"]
            XCTAssertTrue(heading.waitForExistence(timeout: 15))
            let first = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Первый абзац:")).firstMatch
            let second = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Второй абзац отделён")).firstMatch
            XCTAssertTrue(first.exists)
            XCTAssertTrue(second.exists)
            XCTAssertGreaterThanOrEqual(second.frame.minY - first.frame.maxY, 12)
            XCTAssertFalse(first.label.contains("**"))
            XCTAssertTrue(app.staticTexts["Последний абзац ответа."].exists)
            shot(app, "Markdown paragraphs \(session)")
            app.terminate()
        }
    }

    func testDrawerTitlesStayCompactWithInlineActivity() throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["CC_FORMAT_FIXTURE"] == "1")
        continueAfterFailure = false
        let app = launch("s0")
        XCTAssertTrue(app.buttons["Сессии"].waitForExistence(timeout: 15))
        app.buttons["Сессии"].tap()
        let title = app.buttons["drawer.session.m::s0"]
        XCTAssertTrue(title.waitForExistence(timeout: 5))
        let project = app.staticTexts.matching(NSPredicate(format: "identifier BEGINSWITH %@", "drawer.projectTitle.")).firstMatch
        XCTAssertTrue(project.exists)
        XCTAssertLessThanOrEqual(project.frame.minX, 24.5)
        XCTAssertLessThanOrEqual(title.frame.minX, project.frame.minX)
        XCTAssertLessThanOrEqual(title.frame.height, 36.5)
        // Activity is an inline glyph, not a separate leading column.
        XCTAssertFalse(app.images["drawer.activity.m::s0"].exists)
        XCTAssertTrue(app.buttons["drawer.session.m::s0"].label.contains("Claude работает"))
        shot(app, "Single-line titles with leading activity")
        app.buttons["drawer.session.m::s1"].coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        XCTAssertTrue(app.descendants(matching: .any)["session.title"].waitForExistence(timeout: 5))
        XCTAssertLessThanOrEqual(app.descendants(matching: .any)["session.title"].frame.height, 22)
        app.buttons["Сессии"].tap()
        XCTAssertTrue(app.buttons["drawer.session.m::s0"].waitForExistence(timeout: 5))
        shot(app, "Reopened drawer after switching session")
    }

    private func launch(_ session: String) -> XCUIApplication {
        let app = XCUIApplication()
        let env = ProcessInfo.processInfo.environment
        let port = env["CC_FIXTURE_PORT"] ?? "18768"
        app.launchEnvironment = ["CC_HUB_URL": "ws://127.0.0.1:\(port)/ui", "CC_TOKEN": "format-\(UUID().uuidString)",
                                 "CC_OPEN": "m::\(session)", "CC_THEME": env["CC_TEST_THEME"] ?? (session == "s0" ? "light" : "dark")]
        app.launch()
        return app
    }
    private func shot(_ app: XCUIApplication, _ name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name; shot.lifetime = .keepAlways; add(shot)
    }
}
