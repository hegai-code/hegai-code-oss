import XCTest

final class ToolActivityUITests: XCTestCase {
    func testApprovalRemovedByServerDoesNotLeaveAnEmptySheet() throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["CC_APPROVAL_FIXTURE"] == "1",
                          "requires CC_APPROVAL_FIXTURE=1 scripts/run-settings-fixture.cjs")
        continueAfterFailure = false
        let app = launchApprovalFixture()
        try approvalEvent("show")
        XCTAssertTrue(app.buttons["Allow"].waitForExistence(timeout: 5))
        try approvalEvent("clear")
        XCTAssertTrue(waitUntil { !app.buttons["Allow"].exists })
        assertComposerIsAccessible(app)
    }

    func testApprovalDecisionsAndSwipeDismissKeepChatAccessible() throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["CC_APPROVAL_FIXTURE"] == "1",
                          "requires CC_APPROVAL_FIXTURE=1 scripts/run-settings-fixture.cjs")
        continueAfterFailure = false
        let app = launchApprovalFixture()
        for choice in ["Allow", "Deny"] {
            try approvalEvent("show")
            XCTAssertTrue(app.buttons[choice].waitForExistence(timeout: 5))
            app.buttons[choice].tap()
            XCTAssertTrue(waitUntil { !app.buttons[choice].exists })
            assertComposerIsAccessible(app)
            app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.3)).tap()
        }
        try approvalEvent("show")
        XCTAssertTrue(app.buttons["Allow"].waitForExistence(timeout: 5))
        let sheet = app.navigationBars["Подтверждение"]
        sheet.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0))
            .press(forDuration: 0.1, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.98)))
        let reopen = app.buttons.matching(NSPredicate(format: "label CONTAINS 'Ждёт подтверждения инструмента'")).firstMatch
        XCTAssertTrue(reopen.waitForExistence(timeout: 5))
        reopen.tap()
        XCTAssertTrue(app.buttons["Allow"].waitForExistence(timeout: 5))
        app.buttons["Allow"].tap()
        XCTAssertTrue(waitUntil { !app.buttons["Allow"].exists })
        assertComposerIsAccessible(app)
    }

    func testQuestionDismissesAfterSubmittingAnswer() throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["CC_APPROVAL_FIXTURE"] == "1",
                          "requires CC_APPROVAL_FIXTURE=1 scripts/run-settings-fixture.cjs")
        continueAfterFailure = false
        let app = launchApprovalFixture()
        try approvalEvent("question")
        let choice = app.buttons.matching(NSPredicate(format: "label CONTAINS 'Проверить закрытие окна'")).firstMatch
        XCTAssertTrue(choice.waitForExistence(timeout: 5))
        choice.tap()
        app.buttons["Submit"].tap()
        XCTAssertTrue(waitUntil { !app.buttons["Submit"].exists })
        assertComposerIsAccessible(app)
    }

    private func launchApprovalFixture() -> XCUIApplication {
        let app = XCUIApplication()
        let port = ProcessInfo.processInfo.environment["CC_FIXTURE_PORT"] ?? "18779"
        app.launchEnvironment = ["CC_HUB_URL": "ws://127.0.0.1:\(port)/ui", "CC_TOKEN": "fixture",
                                 "CC_OPEN": "m::s0", "CC_THEME": "light", "CC_HW_KEYBOARD": "false"]
        app.launch()
        XCTAssertTrue(app.textViews.firstMatch.waitForExistence(timeout: 15))
        return app
    }

    private func approvalEvent(_ action: String) throws {
        let port = ProcessInfo.processInfo.environment["CC_FIXTURE_PORT"] ?? "18779"
        let done = expectation(description: action)
        URLSession.shared.dataTask(with: URL(string: "http://127.0.0.1:\(port)/test/approval/\(action)")!) { _, response, error in
            XCTAssertNil(error)
            XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
            done.fulfill()
        }.resume()
        wait(for: [done], timeout: 5)
    }

    private func assertComposerIsAccessible(_ app: XCUIApplication) {
        let field = app.textViews.firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        field.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 3), "An empty approval sheet must not block the chat")
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = "Chat accessible after approval"
        shot.lifetime = .keepAlways
        add(shot)
    }

    private func waitUntil(_ condition: @escaping () -> Bool) -> Bool {
        let result = XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in condition() }, object: nil)], timeout: 5)
        return result == .completed
    }

    func testStreamToolsStayBesideMessageAndExpand() throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["CC_TOOL_FIXTURE"] == "1",
                          "requires CC_TOOL_FIXTURE=1 scripts/run-settings-fixture.cjs")
        continueAfterFailure = false
        let app = XCUIApplication()
        let port = ProcessInfo.processInfo.environment["CC_FIXTURE_PORT"] ?? "18768"
        app.launchEnvironment = ["CC_HUB_URL": "ws://127.0.0.1:\(port)/ui", "CC_TOKEN": "fixture",
                                 "CC_OPEN": "m::s0", "CC_THEME": "light"]
        app.launch()
        let finished = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'Проверка завершена.'")).firstMatch
        XCTAssertTrue(finished.waitForExistence(timeout: 15))
        let count = ProcessInfo.processInfo.environment["CC_TOOL_SINGLE_CALLS"] == "1" ? 8 : 12
        let marks = app.links.matching(identifier: "⚙︎\u{00A0}\(count)")
        XCTAssertTrue(marks.firstMatch.waitForExistence(timeout: 5))
        XCTAssertEqual(marks.count, 1)
        let mark = marks.firstMatch
        XCTAssertFalse(app.staticTexts["→ completed"].exists)
        XCTAssertFalse(app.staticTexts["0    0\n→ completed"].exists)
        // Named tool cards belong inside details, never in the chat itself.
        for name in ["Read", "Bash", "Edit", "AskUserQuestion", "PowerShell", "Skill"] {
            XCTAssertFalse(app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", name)).firstMatch.exists)
        }
        XCTAssertLessThanOrEqual(mark.frame.height, 28)
        XCTAssertEqual(mark.frame.midY, finished.frame.midY, accuracy: 8)
        XCTAssertLessThan(mark.frame.minX, finished.frame.maxX)
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = "Compact tool activity beside message"
        shot.lifetime = .keepAlways
        add(shot)
        // Transcript actions must still work on the first tap with the keyboard up.
        let field = app.textViews.firstMatch
        field.tap()
        field.typeText("Черновик")
        let draft = field.value as? String
        XCTAssertTrue(app.keyboards.firstMatch.exists)
        mark.tap()
        XCTAssertTrue(app.navigationBars["Действия"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["\(count) действий"].exists)
        XCTAssertTrue(app.buttons.matching(NSPredicate(format: "label CONTAINS 'Read'")).firstMatch.exists)
        app.buttons["toolActivity.done"].tap()
        XCTAssertTrue(mark.waitForExistence(timeout: 5))
        XCTAssertEqual(field.value as? String, draft)
    }
}
