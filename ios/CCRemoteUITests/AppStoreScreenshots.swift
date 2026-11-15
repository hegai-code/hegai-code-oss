import XCTest

final class AppStoreScreenshots: XCTestCase {
    func testCaptureChatDrawerAndActiveSessions() throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["CC_APP_STORE_SHOTS"] == "1",
                          "requires scripts/app-store-fixture.cjs")
        continueAfterFailure = false
        let chat = launch(["CC_OPEN": "sample-mac::s0"])
        XCTAssertTrue(chat.staticTexts.matching(NSPredicate(format: "label CONTAINS %@",
            "Сейчас проверяю поиск")).firstMatch.waitForExistence(timeout: 15))
        capture(chat, "01-conversation")
        chat.terminate()

        let drawer = launch(["CC_OPEN": "sample-mac::s0", "CC_DRAWER": "1"])
        XCTAssertTrue(drawer.buttons["drawer.brand"].waitForExistence(timeout: 15))
        XCTAssertTrue(drawer.buttons["drawer.session.sample-mac::s2"].waitForExistence(timeout: 10))
        capture(drawer, "02-projects")
        drawer.terminate()

        let start = launch([:])
        XCTAssertTrue(start.buttons["start.active.sample-mac::s0"].waitForExistence(timeout: 15))
        let usage = start.buttons["usage.open"]
        let loadedUsage = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            let value = usage.value as? String ?? ""
            return value.contains("32%") && value.contains("24%")
        }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [loadedUsage], timeout: 10), .completed)
        capture(start, "03-active-sessions")
        start.terminate()

        let settings = launch(["CC_SCREEN": "settings:account"])
        let policy = settings.descendants(matching: .any).matching(identifier: "settings.privacy").firstMatch
        let support = settings.descendants(matching: .any).matching(identifier: "settings.support").firstMatch
        for _ in 0..<8 {
            if support.exists && support.isHittable { break }
            settings.swipeUp()
        }
        XCTAssertTrue(policy.isHittable)
        XCTAssertTrue(support.isHittable)
        capture(settings, "qa-settings-legal-links")
    }

    private func launch(_ extra: [String: String]) -> XCUIApplication {
        let app = XCUIApplication()
        let port = ProcessInfo.processInfo.environment["CC_FIXTURE_PORT"] ?? "18789"
        app.launchEnvironment = ["CC_HUB_URL": "ws://127.0.0.1:\(port)/ui", "CC_TOKEN": "store-\(UUID())",
                                 "CC_THEME": "light", "CC_HW_KEYBOARD": "false"]
            .merging(extra) { _, new in new }
        app.launch()
        let notificationAlert = XCUIApplication(bundleIdentifier: "com.apple.springboard").alerts.firstMatch
        if notificationAlert.waitForExistence(timeout: 2) {
            let allow = notificationAlert.buttons.matching(NSPredicate(
                format: "label IN %@", ["Allow", "Разрешить"])).firstMatch
            XCTAssertTrue(allow.exists, "Unexpected system alert during screenshot capture")
            allow.tap()
        }
        return app
    }
    private func capture(_ app: XCUIApplication, _ name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name; shot.lifetime = .keepAlways; add(shot)
    }
}
