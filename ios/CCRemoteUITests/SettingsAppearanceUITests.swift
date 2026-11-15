import XCTest

final class SettingsAppearanceUITests: XCTestCase {
    func testSettingsTabsAndMemoryNavigation() throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["CC_SETTINGS_TABS_FIXTURE"] == "1")
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchEnvironment = ["CC_HUB_URL": "ws://127.0.0.1:18785/ui", "CC_TOKEN": "settings-\(UUID())",
                                 "CC_SCREEN": "settings:account",
                                 "CC_THEME": ProcessInfo.processInfo.environment["CC_TEST_THEME"] ?? "light"]
        app.launch()
        XCTAssertTrue(app.buttons["settings.account"].waitForExistence(timeout: 10))
        for (key, content) in [("account", "Подключено"), ("hardware", "Fixture Mac"), ("memory", "MEMORY.md")] {
            let row = app.buttons["settings.\(key)"]
            for _ in 0..<5 { if row.isHittable { break }; app.swipeUp() }
            row.tap()
            XCTAssertTrue(app.staticTexts.matching(identifier: content).firstMatch.waitForExistence(timeout: 10))
            let shot = XCTAttachment(screenshot: app.screenshot())
            shot.name = "Settings \(key)"; shot.lifetime = .keepAlways; add(shot)
            app.navigationBars.buttons.element(boundBy: 0).tap()
        }
        app.buttons["settings.memory"].tap()
        app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "MEMORY.md")).firstMatch.tap()
        XCTAssertTrue(app.navigationBars["Заметка"].waitForExistence(timeout: 5))
    }
}
