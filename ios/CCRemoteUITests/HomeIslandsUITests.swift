import XCTest

final class HomeIslandsUITests: XCTestCase {
    func testServerProjectIslandsKeepDraftsAndFoldCrowdedHome() throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["CC_HOME_TARGETS_FIXTURE"] == "1")
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchEnvironment = ["CC_HUB_URL": "ws://127.0.0.1:18947/ui", "CC_TOKEN": "targets-\(UUID())",
                                 "CC_SCREEN": "start", "CC_HW_KEYBOARD": "false",
                                 "CC_THEME": ProcessInfo.processInfo.environment["CC_TEST_THEME"] ?? "light"]
        if ProcessInfo.processInfo.environment["CC_TEST_LARGE"] == "1" {
            app.launchArguments += ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityM"]
        }
        app.launch()
        XCTAssertTrue(app.buttons["start.server"].waitForExistence(timeout: 15))
        server(app, "m")
        project(app, "m::/projects/demo")
        let field = app.textViews.firstMatch
        replace(field, "Черновик stage")
        let composer = app.otherElements["composer.island"].firstMatch
        let serverButton = app.buttons["start.server"]
        let projectButton = app.buttons["start.project"]
        XCTAssertLessThanOrEqual(serverButton.frame.maxX, projectButton.frame.minX)
        XCTAssertLessThanOrEqual(projectButton.frame.maxX, app.frame.maxX - 10)
        XCTAssertGreaterThanOrEqual(composer.frame.minY - projectButton.frame.maxY, 0)
        XCTAssertLessThanOrEqual(composer.frame.minY - projectButton.frame.maxY, 12)
        XCTAssertGreaterThanOrEqual(serverButton.frame.height, 44)
        XCTAssertTrue((app.buttons["start.active.toggle"].value as? String ?? "").contains("есть запросы решения"))
        shot(app, "01-compact-home-keyboard")

        project(app, "m::/projects/website")
        replace(field, "Черновик Website")
        server(app, "other")
        XCTAssertTrue((projectButton.value as? String ?? "").contains("/other/demo"))
        replace(field, "Черновик Mac")
        tap(projectButton)
        XCTAssertTrue(app.buttons["start.project.other::/other/demo"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["start.project.m::/projects/demo"].exists)
        shot(app, "02-projects-on-selected-server")
        tap(app.buttons["Закрыть"])
        server(app, "m")
        XCTAssertTrue((projectButton.value as? String ?? "").contains("/projects/website"))
        XCTAssertEqual(field.value as? String, "Черновик Website")
        project(app, "m::/projects/demo")
        XCTAssertEqual(field.value as? String, "Черновик stage")
        server(app, "empty")
        XCTAssertEqual(projectButton.value as? String, "Не выбран")
        replace(field, "Черновик до выбора папки")
        tap(projectButton)
        XCTAssertFalse(app.buttons["start.project.m::/projects/demo"].exists)
        XCTAssertTrue(app.buttons["start.customFolder"].exists)
        tap(app.buttons["start.customFolder"])
        let path = app.textFields["/absolute/path"]
        tap(path); path.typeText("/projects/first")
        tap(app.buttons["Выбрать"])
        XCTAssertEqual(field.value as? String, "Черновик до выбора папки")
        server(app, "m")
        XCTAssertEqual(field.value as? String, "Черновик stage")
        tap(serverButton)
        XCTAssertFalse(app.buttons["start.server.offline"].isEnabled)
        shot(app, "03-server-picker")
        tap(app.buttons["Закрыть"])

        _ = try Data(contentsOf: URL(string: "http://127.0.0.1:18947/test/active/many")!)
        tap(field)
        let toggle = app.buttons["start.active.toggle"]
        XCTAssertTrue(toggle.waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["start.active.m::many-11"].exists)
        XCTAssertLessThanOrEqual(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "start.active.m::")).count, 3)
        shot(app, "04-many-folded-keyboard")
        tap(toggle)
        let last = app.buttons["start.active.m::many-11"]
        for _ in 0..<14 { if last.exists && last.isHittable { break }; app.scrollViews["start.activeList"].swipeUp() }
        XCTAssertTrue(last.isHittable)
        shot(app, "05-many-expanded")
        XCTAssertEqual(field.value as? String, "Черновик stage")
        tap(field)
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["start.active.m::many-11"].exists)
        shot(app, "06-refocus-folds-list")
    }

    private func server(_ app: XCUIApplication, _ id: String) {
        tap(app.buttons["start.server"]); tap(app.buttons["start.server.\(id)"])
        XCTAssertTrue(app.navigationBars["Серверы"].waitForNonExistence(timeout: 5))
    }
    private func project(_ app: XCUIApplication, _ id: String) {
        tap(app.buttons["start.project"]); tap(app.buttons["start.project.\(id)"])
        XCTAssertTrue(app.navigationBars["Проекты"].waitForNonExistence(timeout: 5))
    }
    private func replace(_ field: XCUIElement, _ text: String) {
        tap(field)
        if let value = field.value as? String, !value.isEmpty {
            field.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.95)).tap()
            field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: value.count))
        }
        field.typeText(text)
    }
    private func tap(_ item: XCUIElement) {
        XCTAssertTrue(item.waitForExistence(timeout: 8))
        item.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
    }
    private func shot(_ app: XCUIApplication, _ name: String) {
        let a = XCTAttachment(screenshot: app.screenshot()); a.name = name; a.lifetime = .keepAlways; add(a)
    }
}
