import XCTest

final class TranscriptImageUITests: XCTestCase {
    func testImagesLoadForBothProvidersAndMirrorAndReuseCache() throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["CC_IMAGE_FIXTURE"] == "1")
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchEnvironment = ["CC_HUB_URL": "ws://127.0.0.1:18948/ui", "CC_TOKEN": "images-\(UUID())",
                                 "CC_OPEN": "m::s0", "CC_THEME": ProcessInfo.processInfo.environment["CC_TEST_THEME"] ?? "light",
                                 "CC_HW_KEYBOARD": "false"]
        app.launch()
        let image = app.buttons["transcript.image.photo#1"]
        XCTAssertTrue(image.waitForExistence(timeout: 15))
        XCTAssertTrue(app.buttons["Изображение недоступно"].exists)
        shot(app, "01-Claude-image-preview")
        tap(image)
        XCTAssertTrue(app.staticTexts["transcript.gallery.count"].waitForExistence(timeout: 5))
        let viewer = app.scrollViews["transcript.image.viewer"]
        XCTAssertTrue(viewer.waitForExistence(timeout: 5))
        XCTAssertGreaterThan(viewer.frame.width, 100)
        XCTAssertGreaterThan(viewer.frame.height, 100)
        viewer.pinch(withScale: 2, velocity: 1)
        shot(app, "02-image-zoom")
        tap(app.buttons["Закрыть"])
        for session in ["s1", "mirror", "s0"] {
            tap(app.buttons["Сессии"])
            tap(app.buttons["drawer.session.m::\(session)"])
            XCTAssertTrue(image.waitForExistence(timeout: 10))
            shot(app, "03-image-\(session)")
        }
        let data = try Data(contentsOf: URL(string: "http://127.0.0.1:18948/test/inputs")!)
        let rows = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [[String: Any]])
        let requests = rows.filter { $0["action"] as? String == "image" }
        XCTAssertEqual(requests.filter { $0["sessionId"] as? String == "s0" }.count, 1, "Reopening uses the memory cache")
        XCTAssertEqual(requests.first { $0["sessionId"] as? String == "s1" }?["source"] as? String, "codex")
        XCTAssertEqual(requests.first { $0["sessionId"] as? String == "mirror" }?["source"] as? String, "claude")
        XCTAssertTrue(requests.allSatisfy { $0["ref"] as? String == "photo#1" && $0["machineId"] as? String == "m" })
    }
    private func tap(_ item: XCUIElement) {
        XCTAssertTrue(item.waitForExistence(timeout: 8))
        item.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
    }
    private func shot(_ app: XCUIApplication, _ name: String) {
        let a = XCTAttachment(screenshot: app.screenshot()); a.name = name; a.lifetime = .keepAlways; add(a)
    }
}
