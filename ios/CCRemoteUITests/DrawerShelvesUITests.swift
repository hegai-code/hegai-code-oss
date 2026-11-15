import XCTest

final class DrawerShelvesUITests: XCTestCase {
    func testShelvesSearchHideRestoreAndUnread() throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["CC_DRAWER_SHELVES_FIXTURE"] == "1")
        continueAfterFailure = false
        action("reset")
        let app = XCUIApplication()
        app.launchEnvironment = ["CC_HUB_URL": "ws://127.0.0.1:18791/ui", "CC_TOKEN": "shelves-\(UUID())",
                                 "CC_DRAWER": "1", "CC_THEME": ProcessInfo.processInfo.environment["CC_TEST_THEME"] ?? "light"]
        app.launch()
        let alert = XCUIApplication(bundleIdentifier: "com.apple.springboard").alerts.firstMatch
        if alert.waitForExistence(timeout: 2) { alert.buttons.firstMatch.tap() }
        let mobile = app.buttons["drawer.project.m::/projects/mobile"]
        XCTAssertTrue(mobile.waitForExistence(timeout: 20))
        XCTAssertLessThan(app.buttons["drawer.project.m::/projects/remote"].frame.minY,
                          app.buttons["drawer.project.m::/projects/site"].frame.minY)
        XCTAssertLessThan(app.buttons["drawer.project.m::/projects/site"].frame.minY, mobile.frame.minY)
        XCTAssertTrue(app.buttons["drawer.session.m::s1"].exists)
        XCTAssertFalse(app.buttons["drawer.session.m::s2"].exists)
        XCTAssertFalse(app.buttons["drawer.session.m::cron"].exists)
        XCTAssertFalse(app.buttons["drawer.session.m::tmp"].exists)
        let older = app.buttons["drawer.shelf.Раньше"]
        XCTAssertEqual(older.value as? String, "Свёрнуто")
        shot(app, "Recent projects, urgent first, two-row previews")
        tap(mobile)
        // Строки уходят под шапку и подвал меню и гаснут маской, а не режутся
        // краем safe area (09.10.2026) — кадр для глаза.
        let list = app.scrollViews["drawer.sessions"].firstMatch
        if list.waitForExistence(timeout: 5) { list.swipeUp(); list.swipeUp() }
        shot(app, "Project list scrolled: rows fade under the header and the footer")
        tap(app.buttons["drawer.search"])
        app.textFields["drawer.searchField"].typeText("s999")
        XCTAssertTrue(app.buttons["drawer.session.m::s999"].waitForExistence(timeout: 5))
        shot(app, "Search reaches the thousandth session with keyboard")
        tap(app.buttons["drawer.back"])
        mobile.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).press(forDuration: 1)
        tap(app.buttons["Скрыть проект"])
        XCTAssertTrue(mobile.waitForNonExistence(timeout: 5))
        app.terminate(); app.launch()
        let hidden = app.buttons["drawer.shelf.Скрытые"]
        XCTAssertTrue(hidden.waitForExistence(timeout: 15))
        XCTAssertFalse(mobile.exists, "Hidden choice survives relaunch")
        tap(hidden)
        let hiddenMobile = app.buttons["drawer.shelfRow.m::/projects/mobile"]
        XCTAssertTrue(hiddenMobile.waitForExistence(timeout: 5))
        shot(app, "Hidden projects remain reachable")
        hiddenMobile.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).press(forDuration: 1)
        tap(app.buttons["Вернуть в список"])
        XCTAssertTrue(mobile.waitForExistence(timeout: 5))
        action("work-old")
        XCTAssertTrue(app.buttons["drawer.project.m::/projects/archive"].waitForExistence(timeout: 5))
        action("complete")
        XCTAssertTrue(waitUntil { (older.value as? String ?? "").contains("Непрочитанный ответ") })
        tap(older)
        let archive = app.buttons["drawer.shelfRow.m::/projects/archive"]
        XCTAssertTrue(archive.waitForExistence(timeout: 5))
        XCTAssertTrue((archive.value as? String ?? "").contains("Непрочитанный ответ"))
        XCTAssertTrue(app.buttons["drawer.shelfRow.m::rootish"].exists)
        shot(app, "Older project points to unread completion")
        tap(archive)
        tap(app.buttons["drawer.session.m::old"])
        XCTAssertTrue(app.buttons["session.titleIsland"].waitForExistence(timeout: 5))
        tap(app.buttons["Сессии"])
        tap(app.buttons["drawer.back"])
        XCTAssertTrue(waitUntil { !(older.value as? String ?? "").contains("Непрочитанный ответ") })
    }

    private func tap(_ element: XCUIElement) {
        XCTAssertTrue(element.waitForExistence(timeout: 5))
        element.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
    }

    private func action(_ name: String) {
        let done = expectation(description: name)
        URLSession.shared.dataTask(with: URL(string: "http://127.0.0.1:18791/test/\(name)")!) { _, response, error in
            XCTAssertNil(error); XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200); done.fulfill()
        }.resume()
        wait(for: [done], timeout: 5)
    }
    private func waitUntil(_ condition: @escaping () -> Bool) -> Bool {
        XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in condition() }, object: nil)], timeout: 8) == .completed
    }
    private func shot(_ app: XCUIApplication, _ name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name; shot.lifetime = .keepAlways; add(shot)
    }
}
