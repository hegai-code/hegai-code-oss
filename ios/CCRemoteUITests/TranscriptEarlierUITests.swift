import XCTest

/// «Показать более ранние»: нажатие обязано привести к более ранним строкам.
final class TranscriptEarlierUITests: XCTestCase {
    func testEarlierButtonRevealsEarlierRows() throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["CC_EARLIER_FIXTURE"] == "1",
                          "requires scripts/transcript-earlier-fixture.cjs")
        continueAfterFailure = true
        let port = ProcessInfo.processInfo.environment["CC_FIXTURE_PORT"] ?? "18793"
        let app = XCUIApplication()
        app.launchEnvironment = ["CC_HUB_URL": "ws://127.0.0.1:\(port)/ui", "CC_TOKEN": "earlier-\(UUID())",
                                 "CC_OPEN": "m::s0", "CC_THEME": "light", "CC_HW_KEYBOARD": "false"]
        app.launch()
        let more = app.buttons["history.earlierLocal"]
        XCTAssertTrue(more.waitForExistence(timeout: 20), "кнопки нет")
        let scroll = app.scrollViews["chat.transcript"]
        for _ in 0..<12 where !more.isHittable { scroll.swipeDown(velocity: .fast) }
        sleep(1)
        capture(app, "1 before tap")
        // Та же причина глушила и стрелку вниз: читатель ушёл вверх, а её нет.
        XCTAssertTrue(app.buttons["Вниз"].waitForExistence(timeout: 3), "стрелки вниз нет")
        let before = staticCount(app)
        print("[EARLIER] before: rows=\(before) visible=\(visible(app)) hittable=\(more.isHittable)")
        more.tap()
        sleep(1)
        capture(app, "2 after tap +1s")
        let after = staticCount(app)
        let shown = visible(app)
        print("[EARLIER] after: rows=\(after) visible=\(shown) hittable=\(more.exists && more.isHittable)")
        XCTAssertGreaterThan(after, before, "нажатие не смонтировало более ранние строки")
        XCTAssertTrue(shown.contains { $0.hasPrefix("Вопрос 52") }, "открытое не видно на экране: \(shown)")
        sleep(3)
        capture(app, "3 after tap +4s")
        print("[EARLIER] later: rows=\(staticCount(app)) visible=\(visible(app))")
    }

    private func staticCount(_ app: XCUIApplication) -> Int {
        app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'Вопрос '")).count
    }

    private func visible(_ app: XCUIApplication) -> [String] {
        app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'Вопрос '")).allElementsBoundByIndex
            .filter(\.isHittable).map(\.label)
    }

    private func capture(_ app: XCUIApplication, _ name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name; shot.lifetime = .keepAlways; add(shot)
    }
}
