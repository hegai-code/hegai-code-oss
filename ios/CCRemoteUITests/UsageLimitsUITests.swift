import XCTest

final class UsageLimitsUITests: XCTestCase {
    func testLimitsOnNewSessionAndSettingsPreserveDraft() throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["CC_LIMITS_FIXTURE"] == "1")
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchEnvironment = ["CC_HUB_URL": "ws://127.0.0.1:18768/ui", "CC_TOKEN": "fixture",
                                 "CC_SCREEN": "start", "CC_THEME": "light", "CC_HW_KEYBOARD": "false"]
        app.launch()
        let open = app.buttons["usage.open"]
        XCTAssertTrue(open.waitForExistence(timeout: 15))
        let field = app.textViews.firstMatch
        field.tap()
        field.typeText("Черновик с лимитами")
        let draft = field.value as? String
        open.tap()
        XCTAssertTrue(app.navigationBars["Лимиты"].waitForExistence(timeout: 5))
        app.swipeUp()
        XCTAssertTrue(app.staticTexts["Шлюз"].waitForExistence(timeout: 10))
        shot(app, "All subscription limits")
        app.swipeDown()
        XCTAssertTrue(app.staticTexts["Мой лимит"].waitForExistence(timeout: 5))
        shot(app, "Personal and Claude limits")
        app.buttons["usage.done"].tap()
        XCTAssertEqual(field.value as? String, draft)
        app.terminate()
        app.launchEnvironment["CC_SCREEN"] = "settings:account"
        app.launchEnvironment["CC_THEME"] = "dark"
        app.launch()
        XCTAssertTrue(app.buttons["usage.open"].waitForExistence(timeout: 15))
        app.buttons["usage.open"].tap()
        XCTAssertTrue(app.staticTexts["Использовано от каждого лимита"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Claude"].exists)
        shot(app, "Limits in account settings")
    }
    private func shot(_ app: XCUIApplication, _ name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot()); shot.name = name; shot.lifetime = .keepAlways; add(shot)
    }
}
