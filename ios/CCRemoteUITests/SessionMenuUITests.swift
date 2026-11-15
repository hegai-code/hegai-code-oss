import XCTest

final class SessionMenuUITests: XCTestCase {
    func testSessionActionsForClaudeAndCodex() throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["CC_MENU_FIXTURE"] == "1")
        continueAfterFailure = false
        for id in ["s0", "s1"] {
            let app = XCUIApplication()
            app.launchEnvironment = ["CC_HUB_URL": "ws://127.0.0.1:18768/ui", "CC_TOKEN": "menu-\(UUID())",
                                     "CC_OPEN": "m::\(id)", "CC_THEME": id == "s0" ? "light" : "dark"]
            app.launch()
            let title = app.descendants(matching: .any)["session.title"]
            XCTAssertTrue(title.waitForExistence(timeout: 15))
            title.tap()
            XCTAssertTrue(app.buttons["session.rename"].waitForExistence(timeout: 5))
            shot(app, "Session actions \(id)")
            app.buttons["session.rename"].tap()
            let field = app.alerts.textFields.firstMatch
            XCTAssertTrue(field.waitForExistence(timeout: 3))
            field.doubleTap()
            let selectAll = app.menuItems["Select All"].exists ? app.menuItems["Select All"] : app.menuItems["Выбрать всё"]
            if selectAll.waitForExistence(timeout: 2) {
                selectAll.tap()
            } else {
                field.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.5)).tap()
                let old = field.value as? String ?? ""
                field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: old.count))
            }
            field.typeText("Меню \(id)")
            app.alerts.buttons["Сохранить"].tap()
            XCTAssertTrue(app.staticTexts["Меню \(id)"].waitForExistence(timeout: 5))
            app.buttons["session.copy"].tap()
            XCTAssertTrue(app.buttons["Скопировано"].exists || app.buttons["session.copy"].label.contains("Скопировано"))
            app.buttons["session.search"].tap()
            let search = app.textFields["session.query"]
            XCTAssertTrue(search.waitForExistence(timeout: 4))
            search.tap(); search.typeText("уникальную")
            let result = app.buttons["session.searchResult.history-menu-u"]
            XCTAssertTrue(result.waitForExistence(timeout: 4))
            result.tap()
            XCTAssertTrue(app.navigationBars["Фрагмент разговора"].waitForExistence(timeout: 4))
            shot(app, "Search result with context \(id)")
            app.navigationBars["Фрагмент разговора"].buttons.element(boundBy: 0).tap()
            app.navigationBars["Поиск по разговору"].buttons["BackButton"].tap()
            app.buttons["session.projectSessions"].tap()
            XCTAssertTrue(app.buttons["session.related.m::\(id == "s0" ? "s1" : "s0")"].waitForExistence(timeout: 4))
            app.navigationBars["Demo"].buttons["BackButton"].tap()
            app.swipeUp()
            let end = app.buttons["session.end"]
            XCTAssertTrue(end.waitForExistence(timeout: 4)); end.tap()
            XCTAssertTrue(app.buttons["Отмена"].waitForExistence(timeout: 3))
            shot(app, "End run confirmation \(id)")
            app.buttons["Отмена"].tap()
            XCTAssertTrue(app.buttons["session.end"].exists)
            app.swipeDown()
            app.buttons["session.export"].tap()
            XCTAssertTrue(app.navigationBars["Move"].waitForExistence(timeout: 3)
                || app.buttons["Export"].exists || app.buttons["Сохранить"].exists || app.buttons["Save"].exists)
            shot(app, "Markdown file export \(id)")
            let save = app.buttons["Save"].exists ? app.buttons["Save"] : app.buttons["Сохранить"]
            if save.exists {
                save.tap()
                let replace = app.buttons["Replace"].exists ? app.buttons["Replace"] : app.buttons["Заменить"]
                if replace.waitForExistence(timeout: 2) { replace.tap() }
                XCTAssertTrue(app.buttons["session.export"].waitForExistence(timeout: 5))
            }
            app.buttons["session.projectSessions"].tap()
            let other = id == "s0" ? "s1" : "s0"
            app.buttons["session.related.m::\(other)"].tap()
            XCTAssertTrue(app.descendants(matching: .any)["session.title"].waitForExistence(timeout: 5))
            app.descendants(matching: .any)["session.title"].tap()
            app.swipeUp()
            app.buttons["session.end"].tap()
            app.alerts.buttons["Завершить запуск"].tap()
            XCTAssertTrue(app.descendants(matching: .any)["session.title"].waitForExistence(timeout: 5))
            app.terminate()
        }
    }
    private func shot(_ app: XCUIApplication, _ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name; attachment.lifetime = .keepAlways; add(attachment)
    }
}
