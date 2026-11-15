import XCTest

final class CompletionIndicatorUITests: XCTestCase {
    func testBurgerPriorityAndReadingAcknowledgement() throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["CC_COMPLETION_FIXTURE"] == "1")
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchEnvironment = ["CC_HUB_URL": "ws://127.0.0.1:\(port)/ui", "CC_TOKEN": "completion-fixture",
                                 "CC_HW_KEYBOARD": "false",
                                 "CC_THEME": ProcessInfo.processInfo.environment["CC_TEST_THEME"] ?? "light"]
        try action("work")
        try action("decision")
        app.launch()
        let burger = app.buttons["Сессии"]
        func badge(_ value: String) {
            let predicate = NSPredicate { _, _ in burger.exists && (burger.value as? String ?? "") == value }
            expectation(for: predicate, evaluatedWith: burger)
            waitForExpectations(timeout: 8)
        }
        let blue = "Есть непросмотренный запрос решения"
        let green = "Есть завершённые сессии с непрочитанным ответом"
        badge(blue)
        try action("finish")
        badge(blue)
        shot(app, "Burger blue has priority over unread completed answer")
        tap(burger)
        let waiting = app.buttons["drawer.session.m::waiting"]
        XCTAssertTrue(waiting.waitForExistence(timeout: 5))
        // Opening and dismissing only the menu must not acknowledge anything.
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.97, dy: 0.5)).tap()
        badge(blue)
        tap(burger)
        tap(waiting)
        badge(green)
        shot(app, "Viewed decision leaves green unread answer indicator")
        app.terminate()
        app.launch()
        badge(green)
        try action("replay")
        badge(green)
        tap(burger)
        XCTAssertTrue((waiting.value as? String ?? "").contains("ждёт ответа"))
        tap(app.buttons["drawer.session.m::s0"])
        badge("")
        shot(app, "All relevant chats viewed; burger has no dot")
        try action("decision")
        badge(blue)
        try action("resolve")
        badge("")
    }

    private var port: String { ProcessInfo.processInfo.environment["CC_FIXTURE_PORT"] ?? "18784" }

    func testFinishedAnswerSurvivesRelaunchAndClearsWhenOpened() throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["CC_COMPLETION_FIXTURE"] == "1")
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchEnvironment = ["CC_HUB_URL": "ws://127.0.0.1:\(port)/ui", "CC_TOKEN": "completion-fixture",
                                 "CC_DRAWER": "1", "CC_HW_KEYBOARD": "false",
                                 "CC_THEME": ProcessInfo.processInfo.environment["CC_TEST_THEME"] ?? "light"]
        try action("work")
        try action("decision")
        app.launch()
        let row = app.buttons["drawer.session.m::s0"]
        XCTAssertTrue(row.waitForExistence(timeout: 15))
        XCTAssertFalse(app.buttons["drawer.session.m::team"].exists)
        XCTAssertFalse(isUnread(row))
        try action("finish")
        waitUnread(row, true)
        XCTAssertGreaterThan(row.frame.minY, 60)
        XCTAssertLessThan(row.frame.maxY, app.buttons["drawer.newChat"].frame.minY)
        XCTAssertTrue((app.buttons["drawer.session.m::waiting"].value as? String ?? "").contains("ждёт ответа"))
        shot(app, "Green completion beside blue pending question")
        app.terminate()
        app.launch()
        XCTAssertTrue(row.waitForExistence(timeout: 15))
        waitUnread(row, true)
        tap(row)
        XCTAssertTrue(app.buttons["session.titleIsland"].waitForExistence(timeout: 5))
        tap(app.buttons["Сессии"])
        // The full project list uses the same read state as its compact preview.
        tap(app.buttons["drawer.project.m::/projects/mobile"])
        XCTAssertTrue(row.waitForExistence(timeout: 5))
        waitUnread(row, false)
        XCTAssertFalse(isUnread(app.buttons["drawer.session.m::old"]))
        shot(app, "Opened answer has no green dot; pending question stays blue")
        // A turn finishing while the app is stopped is discovered on reconnect.
        try action("work")
        let working = NSPredicate(format: "label CONTAINS %@", "Claude работает")
        expectation(for: working, evaluatedWith: row)
        waitForExpectations(timeout: 5)
        app.terminate()
        try action("finish")
        app.launch()
        XCTAssertTrue(row.waitForExistence(timeout: 15))
        waitUnread(row, true)
        shot(app, "Offline completion restored after launch")
    }

    private func action(_ name: String) throws {
        _ = try Data(contentsOf: URL(string: "http://127.0.0.1:\(port)/test/\(name)")!)
    }
    private func isUnread(_ row: XCUIElement) -> Bool {
        (row.value as? String ?? "").contains("не прочитано")
    }
    private func waitUnread(_ row: XCUIElement, _ unread: Bool) {
        let predicate = NSPredicate { [self] _, _ in row.exists && isUnread(row) == unread }
        expectation(for: predicate, evaluatedWith: row)
        waitForExpectations(timeout: 5)
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
