import XCTest

final class UserTurnUITests: XCTestCase {
    func testRemoteLongPasteShowsCappedText() throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["CC_USER_TURN_SMOKE"] == "1")
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchEnvironment = ["CC_HUB_URL": "ws://127.0.0.1:18949/ui", "CC_TOKEN": "dev-token",
                                 "CC_OPEN": "ios-user-turn-smoke::s-codex", "CC_THEME": "dark", "CC_HW_KEYBOARD": "false"]
        app.launch()
        XCTAssertTrue(text(app, "Принято: С десктопа: проверь CI").waitForExistence(timeout: 15))
        let paste = "Длинная вставка: " + String(repeating: "я", count: 20_000)
        _ = try control("remote", ["sessionId": "s-codex", "text": paste])
        let displayed = text(app, "Длинная вставка: ")
        XCTAssertTrue(displayed.waitForExistence(timeout: 10))
        XCTAssertEqual(displayed.label.count, 16_385)
        XCTAssertTrue(displayed.label.hasSuffix("…"))
        XCTAssertEqual(texts(app, "Длинная вставка: ").count, 1)
        shot(app, "07-capped-remote-paste")
    }

    func testOtherDeviceEchoLateSubscribeReconnectAndCompaction() throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["CC_USER_TURN_SMOKE"] == "1")
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchEnvironment = ["CC_HUB_URL": "ws://127.0.0.1:18949/ui", "CC_TOKEN": "dev-token",
                                 "CC_OPEN": "ios-user-turn-smoke::s-claude", "CC_THEME": "light", "CC_HW_KEYBOARD": "false"]
        app.launch()
        let opening = text(app, "С десктопа: проверь CI")
        XCTAssertTrue(opening.waitForExistence(timeout: 20))
        XCTAssertTrue(text(app, "Предыдущий ответ сохранён.").waitForExistence(timeout: 10))
        XCTAssertEqual(texts(app, "С десктопа: проверь CI").count, 1)
        XCTAssertEqual(texts(app, "Принято: С десктопа: проверь CI").count, 1)
        XCTAssertEqual(texts(app, "Предыдущий вопрос").count, 1)
        shot(app, "01-late-subscriber")
        let remote = "С компьютера: проверь сборку"
        _ = try control("remote", ["text": remote])
        XCTAssertTrue(text(app, remote).waitForExistence(timeout: 10))
        XCTAssertTrue(text(app, "Принято: " + remote).waitForExistence(timeout: 10))
        XCTAssertEqual(texts(app, remote).count, 1)
        XCTAssertLessThan(text(app, remote).frame.minY, text(app, "Принято: " + remote).frame.minY)
        shot(app, "02-live-other-device")
        let field = app.textViews.firstMatch
        field.tap(); field.typeText("С телефона: продолжай")
        app.buttons["Отправить"].tap()
        if app.buttons["privacy.allowAI"].waitForExistence(timeout: 2) {
            app.scrollViews.containing(.button, identifier: "privacy.allowAI").firstMatch.swipeUp()
            app.buttons["privacy.allowAI"].tap()
            XCTAssertTrue(app.buttons["Отправить"].waitForExistence(timeout: 5))
            app.buttons["Отправить"].tap()
        }
        XCTAssertTrue(text(app, "Принято: С телефона: продолжай").waitForExistence(timeout: 10))
        XCTAssertEqual(texts(app, "С телефона: продолжай").count, 1)
        let state = try control("state")
        let turns = state["userTurns"] as? [[String: Any]] ?? []
        XCTAssertEqual(turns.filter { $0["text"] as? String == "С телефона: продолжай" }.count, 1, "The desktop receives the phone's turn once")
        shot(app, "03-own-echo")
        app.terminate(); app.launch()
        XCTAssertTrue(text(app, "Предыдущий ответ сохранён.").waitForExistence(timeout: 10))
        XCTAssertTrue(text(app, "Принято: С телефона: продолжай").waitForExistence(timeout: 15))
        XCTAssertEqual(texts(app, "С телефона: продолжай").count, 1)
        XCTAssertEqual(texts(app, "Принято: С телефона: продолжай").count, 1)
        shot(app, "04-reconnected")
        _ = try control("compact")
        XCTAssertTrue(text(app, "Сжимаю контекст…").waitForExistence(timeout: 10))
        XCTAssertEqual(texts(app, "Сжимаю контекст…").count, 1)
        shot(app, "05-one-russian-compaction")
        _ = try control("compact-done")
        XCTAssertTrue(text(app, "контекст сжат: 746k → 10k токенов").waitForExistence(timeout: 10))
        app.terminate()
        app.launchEnvironment["CC_OPEN"] = "ios-user-turn-smoke::s-codex"
        app.launch()
        XCTAssertTrue(opening.waitForExistence(timeout: 15))
        XCTAssertTrue(text(app, "Предыдущий ответ сохранён.").waitForExistence(timeout: 10))
        XCTAssertEqual(texts(app, "С десктопа: проверь CI").count, 1)
        XCTAssertEqual(texts(app, "Принято: С десктопа: проверь CI").count, 1)
        XCTAssertEqual(texts(app, "Предыдущий вопрос").count, 1)
        shot(app, "06-codex-late-subscriber")
    }

    private func texts(_ app: XCUIApplication, _ value: String) -> XCUIElementQuery {
        app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", value))
    }
    private func text(_ app: XCUIApplication, _ value: String) -> XCUIElement { texts(app, value).firstMatch }
    private func control(_ action: String, _ body: [String: String] = [:]) throws -> [String: Any] {
        var request = URLRequest(url: URL(string: "http://127.0.0.1:18950/\(action)")!)
        request.httpMethod = "POST"; request.httpBody = try JSONSerialization.data(withJSONObject: body)
        let done = expectation(description: action)
        var response: Data?; var failure: Error?
        URLSession.shared.dataTask(with: request) { data, _, error in response = data; failure = error; done.fulfill() }.resume()
        wait(for: [done], timeout: 10)
        if let failure { throw failure }
        return try JSONSerialization.jsonObject(with: XCTUnwrap(response)) as? [String: Any] ?? [:]
    }
    private func shot(_ app: XCUIApplication, _ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name; attachment.lifetime = .keepAlways; add(attachment)
    }
}
