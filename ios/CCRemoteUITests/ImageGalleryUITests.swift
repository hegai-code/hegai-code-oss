import XCTest

final class ImageGalleryUITests: XCTestCase {
    func testPortraitAttachmentsStayCompactAndOpenAsPagedFullImages() throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["CC_IMAGE_LAYOUT_FIXTURE"] == "1")
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchEnvironment = ["CC_HUB_URL": "ws://127.0.0.1:18948/ui", "CC_TOKEN": "gallery-\(UUID())",
                                 "CC_OPEN": "m::s0", "CC_HW_KEYBOARD": "false",
                                 "CC_THEME": ProcessInfo.processInfo.environment["CC_TEST_THEME"] ?? "light"]
        if ProcessInfo.processInfo.environment["CC_TEST_LARGE"] == "1" {
            app.launchArguments += ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityM"]
        }
        app.launch()
        let first = app.buttons["transcript.image.photo#1"]
        let second = app.buttons["transcript.image.photo#2"]
        XCTAssertTrue(second.waitForExistence(timeout: 15))
        XCTAssertGreaterThan(first.frame.width, 120)
        XCTAssertEqual(first.frame.width, first.frame.height, accuracy: 1)
        XCTAssertEqual(first.frame.minY, second.frame.minY, accuracy: 1)
        XCTAssertGreaterThanOrEqual(second.frame.minX - first.frame.maxX, 7)
        let text = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Сравни эти два экрана.")).firstMatch
        XCTAssertTrue(text.exists)
        XCTAssertLessThan(first.frame.maxY, text.frame.minY, "Images sit above and outside the text bubble")
        shot(app, "01-two-portrait-attachments")
        let anchor = first.frame.minY
        tap(second)
        let count = app.staticTexts["transcript.gallery.count"]
        XCTAssertTrue(count.waitForExistence(timeout: 5))
        XCTAssertEqual(count.label, "2 / 2")
        XCTAssertTrue(viewer(app).waitForExistence(timeout: 5))
        shot(app, "02-full-portrait")
        viewer(app).swipeRight()
        expectation(for: NSPredicate(format: "label == %@", "1 / 2"), evaluatedWith: count)
        waitForExpectations(timeout: 5)
        viewer(app).pinch(withScale: 2, velocity: 1)
        shot(app, "03-zoomed-portrait")
        viewer(app).doubleTap()
        shot(app, "04-reset-portrait")
        tap(app.buttons["Закрыть"])
        XCTAssertEqual(first.frame.minY, anchor, accuracy: 2, "Closing the viewer preserves chat position")
        for session in ["s1", "mirror"] {
            tap(app.buttons["Сессии"]); tap(app.buttons["drawer.session.m::\(session)"])
            if session == "mirror" {
                let third = app.buttons["transcript.image.photo#3"]
                XCTAssertTrue(third.waitForExistence(timeout: 10))
                // The mirror opens at the latest text; large type puts the first row offscreen.
                for _ in 0..<3 where !first.exists {
                    let transcript = app.scrollViews.matching(NSPredicate(format: "identifier != %@", "drawer.sessions")).firstMatch
                    transcript.swipeDown()
                }
            }
            XCTAssertTrue(first.waitForExistence(timeout: 10))
            if session == "s1" {
                XCTAssertGreaterThanOrEqual(first.frame.width, 220)
                XCTAssertFalse(text.exists)
                XCTAssertFalse(second.exists)
            } else {
                let third = app.buttons["transcript.image.photo#3"]
                XCTAssertTrue(third.waitForExistence(timeout: 10))
                XCTAssertEqual(first.frame.minX, third.frame.minX, accuracy: 1)
                XCTAssertGreaterThan(third.frame.minY, first.frame.maxY)
            }
            shot(app, "05-gallery-\(session)")
        }
    }
    private func viewer(_ app: XCUIApplication) -> XCUIElement {
        let pages = app.scrollViews.matching(identifier: "transcript.image.viewer")
        return pages.allElementsBoundByIndex.first { $0.isHittable } ?? pages.firstMatch
    }
    private func tap(_ item: XCUIElement) {
        XCTAssertTrue(item.waitForExistence(timeout: 8))
        item.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
    }
    private func shot(_ app: XCUIApplication, _ name: String) {
        let a = XCTAttachment(screenshot: app.screenshot()); a.name = name; a.lifetime = .keepAlways; add(a)
    }
}
