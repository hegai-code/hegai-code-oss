import XCTest

final class LimitNoticeUITests: XCTestCase {
    func testToolOnlyReplayAndQuotaPresentation() throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["CC_LIMIT_FIXTURE"] == "1",
                          "requires scripts/limit-notice-fixture.cjs")
        continueAfterFailure = false
        request("reset")
        let app = XCUIApplication()
        app.launchEnvironment = ["CC_HUB_URL": "ws://127.0.0.1:\(port)/ui", "CC_TOKEN": "limits-\(UUID())",
                                 "CC_OPEN": "m::s0", "CC_THEME": ProcessInfo.processInfo.environment["CC_NOTICE_THEME"] ?? "light",
                                 "CC_HW_KEYBOARD": "false", "CC_NOTIFICATIONS": "false"]
        app.launch()
        // A system permission sheet from an earlier test run can outlive its
        // process. This fixture never needs push permission.
        let systemAlert = XCUIApplication(bundleIdentifier: "com.apple.springboard").alerts.firstMatch
        if systemAlert.waitForExistence(timeout: 2) { systemAlert.buttons.firstMatch.tap() }
        let close = app.buttons["Скрыть предупреждение о лимите"]
        XCTAssertTrue(close.waitForExistence(timeout: 15))
        XCTAssertTrue(waitUntil { !app.staticTexts["loading history…"].exists && self.questions(app).count == 1 })
        XCTAssertFalse(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "raw quota warning")).firstMatch.exists)
        capture(app, "Quota outside transcript; one tool-only question")
        let field = app.textViews.firstMatch
        field.tap()
        field.typeText("Проверка")
        XCTAssertTrue(close.isHittable, "Notice stays above the keyboard")
        capture(app, "Quota with keyboard")
        close.tap()
        request("warning?percent=94")
        XCTAssertTrue(waitUntil { !close.exists })
        request("reconnect")
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Продолжаю после переподключения.")).firstMatch.waitForExistence(timeout: 15))
        XCTAssertTrue(waitUntil { self.questions(app).count == 1 })
        XCTAssertFalse(close.exists)
        app.terminate(); app.launch()
        XCTAssertTrue(questions(app).firstMatch.waitForExistence(timeout: 15))
        XCTAssertTrue(waitUntil { !app.staticTexts["loading history…"].exists })
        XCTAssertEqual(questions(app).count, 1)
        XCTAssertFalse(close.exists, "Same quota band stays silent after relaunch")
        request("warning?percent=100")
        XCTAssertTrue(close.waitForExistence(timeout: 5), "Exhaustion is new information")
        capture(app, "Exhausted quota")
    }
    private var port: String { ProcessInfo.processInfo.environment["CC_FIXTURE_PORT"] ?? "18789" }
    private func questions(_ app: XCUIApplication) -> XCUIElementQuery {
        app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Слушай, есть мысль сделать оркестрирующего агента"))
    }
    private func request(_ path: String) {
        let done = expectation(description: path)
        URLSession.shared.dataTask(with: URL(string: "http://127.0.0.1:\(port)/test/\(path)")!) { _, response, error in
            XCTAssertNil(error); XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200); done.fulfill()
        }.resume()
        wait(for: [done], timeout: 5)
    }
    private func waitUntil(_ condition: @escaping () -> Bool) -> Bool {
        XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in condition() }, object: nil)], timeout: 15) == .completed
    }
    private func capture(_ app: XCUIApplication, _ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name; attachment.lifetime = .keepAlways; add(attachment)
    }
}
