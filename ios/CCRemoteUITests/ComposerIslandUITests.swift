import XCTest

final class ComposerIslandUITests: XCTestCase {
    func testCompactIslandExpandsOnFirstTapAndKeepsDraft() {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchEnvironment = ["CC_TRANSCRIPT": "turns",
                                 "CC_THEME": ProcessInfo.processInfo.environment["CC_TEST_THEME"] ?? "light",
                                 "CC_HW_KEYBOARD": "false",
                                 "CC_HUB_URL": "ws://127.0.0.1:1/ui",
                                 "CC_TOKEN": "island-\(UUID())"]
        app.launch()
        let field = app.textViews.firstMatch
        let island = app.otherElements["composer.island"].firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        XCTAssertTrue(island.exists)
        let compactHeight = island.frame.height
        XCTAssertLessThanOrEqual(compactHeight, 56)
        XCTAssertGreaterThanOrEqual(island.frame.minX, 23)
        XCTAssertFalse(app.keyboards.firstMatch.exists)
        XCTAssertFalse(app.buttons["Отправить"].exists)
        XCTAssertTrue(app.buttons["Начать запись"].isHittable)
        shot(app, "Compact floating composer")
        field.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        XCTAssertGreaterThan(island.frame.height, compactHeight + 35)
        XCTAssertLessThanOrEqual(island.frame.maxY + 4, app.keyboards.firstMatch.frame.minY)
        shot(app, "Expanded floating composer above keyboard")
        let chat = app.scrollViews["chat.transcript"]
        chat.coordinate(withNormalizedOffset: CGVector(dx: 0.02, dy: 0.4)).tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 3))
        XCTAssertEqual(island.frame.height, compactHeight, accuracy: 1)
        field.tap()
        field.typeText("Черновик острова\nВторая строка")
        let draft = field.value as? String
        chat.coordinate(withNormalizedOffset: CGVector(dx: 0.02, dy: 0.4)).tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 3))
        XCTAssertEqual(field.value as? String, draft)
        XCTAssertGreaterThan(island.frame.height, compactHeight + 35)
        field.tap()
        field.typeText(" сохранена")
        XCTAssertEqual((field.value as? String)?.replacingOccurrences(of: " сохранена", with: ""), draft)
        shot(app, "Expanded draft preserved")
    }

    private func shot(_ app: XCUIApplication, _ name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }
}
