import XCTest

final class TurnCompletionUITests: XCTestCase {
    func testFinishedSubtaskCanBeContinuedWithoutLosingDraft() throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["CC_COMPLETION_FIXTURE"] == "1",
                          "requires scripts/turn-completion-fixture.cjs")
        continueAfterFailure = false
        let port = ProcessInfo.processInfo.environment["CC_FIXTURE_PORT"] ?? "18792"
        _ = try request(port, path: "app")
        let app = XCUIApplication()
        app.launchEnvironment = ["CC_HUB_URL": "ws://127.0.0.1:\(port)/ui", "CC_TOKEN": "completion-\(UUID())",
                                 "CC_OPEN": "m::s0", "CC_THEME": "light", "CC_HW_KEYBOARD": "false"]
        app.launch()
        let working = app.descendants(matching: .any)["chat.working"].firstMatch
        XCTAssertTrue(working.waitForExistence(timeout: 15))
        XCTAssertFalse(app.staticTexts["turn.completed"].exists)
        _ = try request(port, path: "finish")
        let completed = app.staticTexts["turn.completed"]
        XCTAssertTrue(completed.waitForExistence(timeout: 15))
        XCTAssertFalse(working.exists)
        capture(app, name: "Answer finished, task can continue")

        let field = app.textViews.firstMatch
        field.tap(); field.typeText("Мой черновик")
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.25)).tap()
        let button = app.buttons["turn.continue"]
        XCTAssertTrue(button.waitForExistence(timeout: 5))
        button.tap()
        let allow = app.buttons["privacy.allowAI"]
        if allow.waitForExistence(timeout: 2) {
            XCTAssertEqual((try request(port, path: "state"))["inputs"] as? [String], [])
            app.scrollViews.containing(.button, identifier: "privacy.allowAI").firstMatch.swipeUp()
            allow.tap()
            XCTAssertTrue(button.waitForExistence(timeout: 5))
            XCTAssertEqual((try request(port, path: "state"))["inputs"] as? [String], [],
                           "consent must not auto-submit the continuation")
            button.tap()
        }
        XCTAssertTrue(working.waitForExistence(timeout: 10))
        XCTAssertFalse(completed.exists)
        XCTAssertFalse(button.exists)
        XCTAssertEqual(field.value as? String, "Мой черновик")
        let state = try request(port, path: "state")
        let inputs = try XCTUnwrap(state["inputs"] as? [String])
        XCTAssertEqual(inputs.count, 1)
        XCTAssertTrue(inputs[0].hasPrefix("Продолжи текущую задачу"))
        capture(app, name: "Continuation working, draft preserved")
    }

    private func request(_ port: String, path: String) throws -> [String: Any] {
        let done = expectation(description: path)
        var data: Data?
        URLSession.shared.dataTask(with: URL(string: "http://127.0.0.1:\(port)/test/\(path)")!) { body, response, error in
            XCTAssertNil(error)
            XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
            data = body; done.fulfill()
        }.resume()
        wait(for: [done], timeout: 5)
        return try JSONSerialization.jsonObject(with: XCTUnwrap(data)) as? [String: Any] ?? [:]
    }

    func testMirroredEditorReportsWorkAndCompletionWithoutAnAppRun() throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["CC_COMPLETION_FIXTURE"] == "1",
                          "requires scripts/turn-completion-fixture.cjs")
        continueAfterFailure = false
        let port = ProcessInfo.processInfo.environment["CC_FIXTURE_PORT"] ?? "18792"
        _ = try request(port, path: "editor")
        let app = XCUIApplication()
        app.launchEnvironment = ["CC_HUB_URL": "ws://127.0.0.1:\(port)/ui", "CC_TOKEN": "mirror-\(UUID())",
                                 "CC_OPEN": "m::s0", "CC_THEME": "light"]
        app.launch()
        let title = app.descendants(matching: .any)["session.title"].firstMatch
        XCTAssertTrue(title.waitForExistence(timeout: 15))
        XCTAssertEqual(title.value as? String, "Codex работает")
        XCTAssertFalse(app.staticTexts["turn.completed"].exists)
        capture(app, name: "External editor working without an app run")
        _ = try request(port, path: "finish")
        XCTAssertTrue(app.staticTexts["turn.completed"].waitForExistence(timeout: 10))
        XCTAssertNotEqual(title.value as? String, "Codex работает")
        XCTAssertFalse(app.buttons["turn.continue"].exists, "a mirror must never silently take over its writer")
        capture(app, name: "External editor answer finished")
    }

    private func capture(_ app: XCUIApplication, name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name; shot.lifetime = .keepAlways; add(shot)
    }
}
