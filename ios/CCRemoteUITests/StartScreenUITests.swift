import XCTest

final class StartScreenUITests: XCTestCase {
    func testProjectPickerKeepsDraftsAndStartsChosenProject() throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["CC_START_FIXTURE"] == "1")
        continueAfterFailure = false
        let env = ProcessInfo.processInfo.environment
        let port = env["CC_FIXTURE_PORT"] ?? "18772"
        let app = XCUIApplication()
        app.launchEnvironment = ["CC_HUB_URL": "ws://127.0.0.1:\(port)/ui", "CC_TOKEN": "start-\(UUID())",
                                 "CC_THEME": env["CC_TEST_THEME"] ?? "dark", "CC_HW_KEYBOARD": "false"]
        app.launch()
        let project = app.buttons["start.project"]
        XCTAssertTrue(project.waitForExistence(timeout: 15))
        XCTAssertTrue(app.staticTexts["start.welcome"].exists)
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["composer.settings"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["Отправить"].exists)
        XCTAssertFalse(app.buttons["Прервать"].exists)
        shot(app, "Minimal new session")
        project.tap()
        let search = app.searchFields.firstMatch
        XCTAssertTrue(search.waitForExistence(timeout: 5))
        search.tap(); search.typeText("Website")
        XCTAssertTrue(app.buttons["start.project.m::/projects/website"].exists)
        XCTAssertFalse(app.buttons["start.project.m::/projects/demo"].exists)
        app.buttons["start.customFolder"].tap()
        XCTAssertTrue(app.navigationBars["Другая папка"].waitForExistence(timeout: 5))
        app.buttons["Отмена"].tap()
        XCTAssertTrue(project.waitForExistence(timeout: 5))
        pick(app, "demo")
        let field = app.textViews.firstMatch
        field.tap(); field.typeText("Черновик Demo")
        shot(app, "New session with keyboard")
        pick(app, "website")
        XCTAssertEqual(field.value as? String, "")
        field.tap(); field.typeText("Черновик Website")
        pick(app, "demo")
        XCTAssertEqual(field.value as? String, "Черновик Demo")
        pick(app, "website")
        XCTAssertEqual(field.value as? String, "Черновик Website")
        app.buttons["composer.settings"].tap()
        XCTAssertTrue(app.buttons["Codex"].waitForExistence(timeout: 5))
        app.buttons["Codex"].tap()
        app.buttons["runSettings.done"].tap()
        XCTAssertEqual(field.value as? String, "Черновик Website")
        app.buttons["usage.open"].tap()
        XCTAssertTrue(app.navigationBars["Лимиты"].waitForExistence(timeout: 5))
        app.buttons["usage.done"].tap()
        XCTAssertEqual(field.value as? String, "Черновик Website")
        app.buttons["Отправить"].tap()
        XCTAssertTrue(app.buttons["header.newChat"].waitForExistence(timeout: 5))
        let received = expectation(description: "Chosen project reaches new_session")
        URLSession.shared.dataTask(with: URL(string: "http://127.0.0.1:\(port)/test/inputs")!) { data, _, _ in
            let rows = (try? JSONSerialization.jsonObject(with: data ?? Data())) as? [[String: Any]]
            let last = rows?.last { $0["action"] as? String == "new_session" }
            XCTAssertEqual(last?["cwd"] as? String, "/projects/website")
            XCTAssertEqual(last?["source"] as? String, "codex")
            XCTAssertEqual(last?["message"] as? String, "Черновик Website")
            received.fulfill()
        }.resume()
        wait(for: [received], timeout: 5)
        app.terminate()
    }

    private func pick(_ app: XCUIApplication, _ name: String) {
        app.buttons["start.project"].tap()
        let row = app.buttons["start.project.m::/projects/\(name)"]
        XCTAssertTrue(row.waitForExistence(timeout: 5))
        shot(app, "Project selection")
        row.tap()
        XCTAssertTrue(app.buttons["start.project"].waitForExistence(timeout: 5))
    }

    private func shot(_ app: XCUIApplication, _ name: String) {
        let a = XCTAttachment(screenshot: app.screenshot()); a.name = name; a.lifetime = .keepAlways; add(a)
    }
}
