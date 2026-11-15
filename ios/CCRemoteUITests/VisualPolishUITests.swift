import XCTest

/// Run with run-settings-fixture.cjs on :18947, CC_HOME_POLISH_FIXTURE=1.
final class VisualPolishUITests: XCTestCase {
    private func launch(_ screen: String = "start") throws -> XCUIApplication {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["CC_HOME_POLISH_FIXTURE"] == "1")
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchEnvironment = ["CC_HUB_URL": "ws://127.0.0.1:18947/ui", "CC_TOKEN": "polish-\(UUID())",
                                 "CC_THEME": ProcessInfo.processInfo.environment["CC_TEST_THEME"] ?? "light",
                                 "CC_HW_KEYBOARD": "false", "CC_SCREEN": screen]
        if ProcessInfo.processInfo.environment["CC_TEST_LARGE"] == "1" {
            app.launchArguments += ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityM"]
        }
        app.launch()
        let spring = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        if spring.alerts.firstMatch.waitForExistence(timeout: 2) {
            let allow = spring.alerts.buttons["Allow"]
            if allow.exists { allow.tap() }
        }
        return app
    }

    func testHomeReadStateLogoDraftAndSheets() throws {
        let app = try launch()
        XCTAssertTrue(app.buttons["usage.open"].waitForExistence(timeout: 15))
        let field = app.textViews.firstMatch
        tap(field)
        if let existing = field.value as? String, !existing.isEmpty {
            // A centre tap may place the caret inside a restored draft.
            field.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.95)).tap()
            field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: existing.count))
            XCTAssertEqual(field.value as? String, "")
        }
        let draft = "Проверить новый интерфейс"
        field.typeText(draft)
        let project = app.buttons["start.project"].value as? String
        shot(app, "01-home-keyboard")
        home(app)
        XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 5))
        XCTAssertEqual(field.value as? String, draft)
        XCTAssertEqual(app.buttons["start.project"].value as? String, project)
        XCTAssertTrue(app.buttons["start.active.m::waiting"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["start.active.m::team"].exists)
        let limits = app.buttons["usage.open"]
        XCTAssertEqual(app.buttons.matching(identifier: "usage.open").count, 1)
        XCTAssertGreaterThanOrEqual(limits.frame.minX, app.buttons["Сессии"].frame.maxX)
        XCTAssertLessThanOrEqual(app.frame.maxX - limits.frame.maxX, 24, "Limits must stay at the trailing screen edge")
        XCTAssertLessThanOrEqual(limits.frame.maxY, app.staticTexts["Сейчас в работе"].frame.minY)
        let limitsValue = limits.value as? String ?? ""
        XCTAssertTrue(limitsValue.contains("Claude: неделя, использовано 81%"))
        XCTAssertTrue(limitsValue.contains("использовано 61%"), "Gateway must also show used allowance")
        XCTAssertFalse(limitsValue.contains("32%"), "The header must omit Claude's 5-hour value")
        XCTAssertTrue(app.staticTexts["Сейчас в работе"].exists)
        XCTAssertTrue(app.staticTexts["Недавно завершены"].exists)
        shot(app, "02-home")
        tap(app.buttons["usage.open"])
        XCTAssertTrue(app.navigationBars["Лимиты"].waitForExistence(timeout: 5))
        shot(app, "03-limits")
        app.swipeUp(); shot(app, "04-limits-lower")
        tap(app.buttons["usage.done"])
        XCTAssertEqual(field.value as? String, draft)
        XCTAssertTrue(app.navigationBars["Лимиты"].waitForNonExistence(timeout: 5))
        tap(app.buttons["start.project"])
        XCTAssertTrue(app.navigationBars["Проекты"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.staticTexts["Режим"].exists)
        shot(app, "05-projects")
        tap(app.buttons["Закрыть"])
        tap(app.buttons["composer.settings"])
        XCTAssertTrue(app.buttons["runSettings.done"].waitForExistence(timeout: 5))
        shot(app, "06-model")
        tap(app.buttons["runSettings.done"])
        home(app)
        _ = try Data(contentsOf: URL(string: "http://127.0.0.1:18947/test/home/complete")!)
        let recent = app.buttons["start.recent.toggle"]
        if (recent.value as? String ?? "").hasPrefix("Свёрнуто") { tap(recent) }
        let done = app.buttons["start.active.m::s0"]
        expectation(for: NSPredicate(format: "value CONTAINS %@", "Непрочитанный ответ. Новый интерфейс готов, проверки пройдены."), evaluatedWith: done)
        waitForExpectations(timeout: 5)
        for _ in 0..<6 { if done.exists && done.isHittable { break }; app.scrollViews["start.activeList"].swipeUp() }
        XCTAssertTrue(done.waitForExistence(timeout: 5))
        XCTAssertTrue((done.value as? String ?? "").contains("Непрочитанный ответ. Новый интерфейс готов, проверки пройдены."))
        shot(app, "07-completed")
        tap(done)
        XCTAssertTrue(app.buttons["session.titleIsland"].waitForExistence(timeout: 5))
        shot(app, "08-chat")
        home(app)
        XCTAssertTrue(done.waitForExistence(timeout: 5), "A read result must remain in recent sessions")
        XCTAssertTrue((done.value as? String ?? "").hasPrefix("Завершена."))
        XCTAssertEqual(field.value as? String, draft)
        shot(app, "09-home-after-reading")
        tap(app.buttons["Сессии"])
        let createChat = app.buttons["drawer.newChat"]
        XCTAssertTrue(createChat.waitForExistence(timeout: 5))
        XCTAssertEqual(createChat.label, "Создать чат")
        shot(app, "09a-drawer-chat-action")
        tap(createChat)
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        XCTAssertEqual(field.value as? String, draft)
        home(app)
        _ = try Data(contentsOf: URL(string: "http://127.0.0.1:18947/test/active/many")!)
        tap(app.buttons["start.active.toggle"])
        let last = app.buttons["start.active.m::many-11"]
        for _ in 0..<12 { if last.exists && last.isHittable { break }; app.scrollViews["start.activeList"].swipeUp() }
        XCTAssertTrue(last.isHittable)
        XCTAssertLessThanOrEqual(app.scrollViews["start.activeList"].frame.maxY, app.buttons["start.project"].frame.minY)
        shot(app, "10-many")
        _ = try Data(contentsOf: URL(string: "http://127.0.0.1:18947/test/home/empty")!)
        XCTAssertTrue(app.staticTexts["Здесь появятся ваши задачи и результаты"].waitForExistence(timeout: 5))
        shot(app, "11-empty")
    }

    func testSettingsHierarchyAndDiagnostics() throws {
        let app = try launch("settings:account")
        XCTAssertTrue(app.buttons["settings.account"].waitForExistence(timeout: 15))
        XCTAssertFalse(app.buttons["auth.apple"].exists)
        XCTAssertFalse(app.segmentedControls["settings.tabs"].exists)
        shot(app, "20-settings-root")
        for (key, title) in [("account", "Управление аккаунтом"), ("appearance", "Внешний вид"),
                             ("notifications", "Уведомления"), ("defaults", "Новые чаты"),
                             ("hardware", "Серверы и устройства"), ("memory", "Память"),
                             ("privacy", "Конфиденциальность"), ("advanced", "Дополнительно")] {
            let row = app.buttons["settings.\(key)"]
            for _ in 0..<6 { if row.exists && row.isHittable { break }; app.swipeUp() }
            tap(row)
            XCTAssertTrue(app.navigationBars[title].waitForExistence(timeout: 5))
            shot(app, "21-settings-\(key)")
            if key == "account" {
                XCTAssertFalse(app.buttons["auth.apple"].exists)
                tap(app.buttons["Моя активность"])
                XCTAssertTrue(app.navigationBars["Моя активность"].waitForExistence(timeout: 5))
                shot(app, "22-activity")
                back(app)
            }
            if key == "hardware" {
                XCTAssertFalse(app.staticTexts["CPU"].exists)
                tap(app.buttons["hardware.machine.m"])
                XCTAssertTrue(app.staticTexts["CPU"].waitForExistence(timeout: 5))
                shot(app, "23-hardware-details")
            }
            if key == "privacy" {
                XCTAssertTrue(app.buttons["settings.deleteAccount"].exists)
                XCTAssertTrue(app.buttons["settings.aiConsent"].exists)
            }
            back(app)
            for _ in 0..<6 { if app.buttons["settings.account"].isHittable { break }; app.swipeDown() }
        }
        tap(app.buttons["usage.open"])
        XCTAssertTrue(app.navigationBars["Лимиты"].waitForExistence(timeout: 5))
        tap(app.buttons["usage.done"])
        XCTAssertTrue(app.buttons["settings.account"].waitForExistence(timeout: 5))
    }
    private func home(_ app: XCUIApplication) {
        tap(app.buttons["Сессии"])
        tap(app.buttons["drawer.brand"])
    }
    private func back(_ app: XCUIApplication) { app.navigationBars.buttons.element(boundBy: 0).tap() }
    private func tap(_ element: XCUIElement) {
        XCTAssertTrue(element.waitForExistence(timeout: 8))
        element.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
    }
    private func shot(_ app: XCUIApplication, _ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name; attachment.lifetime = .keepAlways; add(attachment)
    }
}
