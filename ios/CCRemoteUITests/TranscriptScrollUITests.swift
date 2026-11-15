import XCTest

final class TranscriptScrollUITests: XCTestCase {
    func testDelayedHistoryOpensAtEndAndReadingEarlierDoesNotJump() {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchEnvironment = ["CC_TRANSCRIPT": "scroll", "CC_THEME": "light"]
        app.launch()
        let last = app.staticTexts.matching(NSPredicate(format: "label CONTAINS 'ПОСЛЕДНЕЕ СООБЩЕНИЕ'")).firstMatch
        XCTAssertTrue(last.waitForExistence(timeout: 15))
        XCTAssertTrue(last.isHittable)
        let initial = XCTAttachment(screenshot: app.screenshot())
        initial.name = "Delayed history opens at last message"
        initial.lifetime = .keepAlways
        add(initial)
        let from = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.3))
        let to = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.75))
        from.press(forDuration: 0.05, thenDragTo: to)
        from.press(forDuration: 0.05, thenDragTo: to)
        XCTAssertTrue(app.buttons["Вниз"].waitForExistence(timeout: 5))
        // Кадр для глаза: строки под композером и под часами гаснут маской
        // (`chatEdgeFade`), а не обрезаются подложкой.
        let reading = XCTAttachment(screenshot: app.screenshot())
        reading.name = "Reading earlier: edges fade under clock and composer"
        reading.lifetime = .keepAlways
        add(reading)
        app.buttons["Добавить ответ"].tap()
        Thread.sleep(forTimeInterval: 0.5)
        let new = app.staticTexts.matching(NSPredicate(format: "label CONTAINS 'НОВЫЙ ОТВЕТ В КОНЦЕ'")).firstMatch
        XCTAssertFalse(new.isHittable)
        app.buttons["Вниз"].tap()
        XCTAssertTrue(new.waitForExistence(timeout: 5))
        XCTAssertTrue(new.isHittable)
        app.terminate()
        app.launch()
        XCTAssertTrue(last.waitForExistence(timeout: 15))
        XCTAssertTrue(last.isHittable)
    }
}
