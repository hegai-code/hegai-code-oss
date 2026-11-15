import XCTest

final class HeaderSpacingUITests: XCTestCase {
    func testLongTitleUsesSpaceBetweenIslandsWithoutCoveringTheirTapTargets() throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["CC_HEADER_WIDTH_FIXTURE"] == "1")
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchEnvironment = ["CC_HUB_URL": "ws://127.0.0.1:18784/ui", "CC_TOKEN": "header-\(UUID())",
                                 "CC_OPEN": "m::s0", "CC_THEME": ProcessInfo.processInfo.environment["CC_TEST_THEME"] ?? "light"]
        app.launch()
        let title = app.buttons["session.titleIsland"]
        XCTAssertTrue(title.waitForExistence(timeout: 15))
        let menu = app.buttons["Сессии"]
        let newChat = app.buttons["header.newChat"]
        XCTAssertTrue(title.label.contains("Оптимизация интерфейса"))
        let center = app.frame.midX
        let available = min(app.frame.width - 136,
                            2 * min(center - menu.frame.maxX - 4, newChat.frame.minX - center - 4))
        XCTAssertGreaterThanOrEqual(title.frame.width, available - 1)
        XCTAssertGreaterThanOrEqual(title.frame.minX, menu.frame.maxX + 4)
        XCTAssertGreaterThanOrEqual(newChat.frame.minX, title.frame.maxX + 4)
        XCTAssertGreaterThanOrEqual(menu.frame.width, 56 - 0.01)
        XCTAssertGreaterThanOrEqual(newChat.frame.width, 44 - 0.01)
        shot(app, "Wide title between separate tap targets")
        menu.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.5)).tap()
        let row = app.buttons["drawer.session.m::s0"]
        XCTAssertTrue(row.waitForExistence(timeout: 5))
        let project = app.staticTexts["drawer.projectTitle.m::/projects/demo"]
        XCTAssertLessThanOrEqual(project.frame.minX, 24.5)
        XCTAssertLessThanOrEqual(row.frame.minX, project.frame.minX)
        XCTAssertLessThanOrEqual(row.frame.height, 36.5)
        XCTAssertTrue(row.label.contains("Claude работает"))
        XCTAssertFalse(app.images["drawer.activity.m::s0"].exists)
        shot(app, "Inline activity and compact sidebar padding")
        row.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        newChat.coordinate(withNormalizedOffset: CGVector(dx: 0.05, dy: 0.5)).tap()
        XCTAssertTrue(app.buttons["start.project"].waitForExistence(timeout: 5))
    }

    private func shot(_ app: XCUIApplication, _ name: String) {
        let image = XCTAttachment(screenshot: app.screenshot())
        image.name = name; image.lifetime = .keepAlways; add(image)
    }
}
