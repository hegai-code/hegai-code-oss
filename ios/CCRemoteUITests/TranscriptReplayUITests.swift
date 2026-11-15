import XCTest

final class TranscriptReplayUITests: XCTestCase {
    func testHistoryArrivingAfterSendAndReconnectNeverDuplicateSpeech() throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["CC_REPLAY_FIXTURE"] == "1",
                          "requires scripts/transcript-replay-fixture.cjs")
        continueAfterFailure = false
        let port = ProcessInfo.processInfo.environment["CC_FIXTURE_PORT"] ?? "18788"
        let app = XCUIApplication()
        app.launchEnvironment = ["CC_HUB_URL": "ws://127.0.0.1:\(port)/ui", "CC_TOKEN": "replay-\(UUID())",
                                 "CC_OPEN": "m::s0", "CC_THEME": "light", "CC_HW_KEYBOARD": "false"]
        app.launch()
        let field = app.textViews.firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 15))
        field.tap()
        field.typeText("Почини и что с редизайном от фейбл?")
        let send = app.buttons["Отправить"]
        XCTAssertTrue(send.waitForExistence(timeout: 5))
        send.tap()
        let answer = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Рецензия Fable уже получена."))
        XCTAssertTrue(answer.firstMatch.waitForExistence(timeout: 10))
        XCTAssertTrue(waitUntil { !app.staticTexts["loading history…"].exists })
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.3)).tap()
        assertOneCopy(app)
        capture(app, name: "History and optimistic stream")

        let done = expectation(description: "Reconnect")
        URLSession.shared.dataTask(with: URL(string: "http://127.0.0.1:\(port)/test/reconnect")!) { _, response, error in
            XCTAssertNil(error)
            XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
            done.fulfill()
        }.resume()
        wait(for: [done], timeout: 5)
        // A new marker proves that the CLIENT applied the replay, rather
        // than just showing the transcript retained across the disconnect.
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@",
            "После переподключения ответ продолжается.")).firstMatch.waitForExistence(timeout: 15))
        assertOneCopy(app)
        capture(app, name: "Reconnected replay")
    }

    private func assertOneCopy(_ app: XCUIApplication) {
        for text in ["Почини и что с редизайном от фейбл?", "Исправлю сбой конвейера", "Рецензия Fable уже получена."] {
            let matches = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", text))
            XCTAssertEqual(matches.count, 1, "Duplicate or missing speech: \(text)")
        }
    }
    private func waitUntil(_ condition: @escaping () -> Bool) -> Bool {
        XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in condition() }, object: nil)], timeout: 15) == .completed
    }
    private func capture(_ app: XCUIApplication, name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name; shot.lifetime = .keepAlways; add(shot)
    }
}
