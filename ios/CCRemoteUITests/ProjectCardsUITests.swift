import XCTest

final class ProjectCardsUITests: XCTestCase {
    private func launch(session: Bool = false) throws -> XCUIApplication {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["CC_PROJECT_CARDS_FIXTURE"] == "1")
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchEnvironment = ["CC_HUB_URL": "ws://127.0.0.1:18783/ui", "CC_TOKEN": "cards-\(UUID())",
                                 "CC_THEME": ProcessInfo.processInfo.environment["CC_TEST_THEME"] ?? "light",
                                 "CC_HW_KEYBOARD": "false"]
        if session { app.launchEnvironment["CC_OPEN"] = "m::s0" }
        app.launch()
        XCTAssertTrue(app.textViews.firstMatch.waitForExistence(timeout: 15))
        return app
    }

    private func tap(_ element: XCUIElement) {
        XCTAssertTrue(element.waitForExistence(timeout: 5))
        element.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
    }

    private func assertHeaderSpacing(_ app: XCUIApplication) {
        let island = app.buttons["session.titleIsland"].frame
        XCTAssertGreaterThanOrEqual(island.minX, app.buttons["Сессии"].frame.maxX + 4)
        XCTAssertGreaterThanOrEqual(app.buttons["header.newChat"].frame.minX, island.maxX + 4)
    }

    private func screenshot(_ app: XCUIApplication, _ name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name; shot.lifetime = .keepAlways; add(shot)
    }

    func testCardsFullSearchBackAndExactTarget() throws {
        let app = try launch(session: true)
        let title = app.descendants(matching: .any)["session.title"]
        XCTAssertEqual(title.label, "Обсуждение задачи 0")
        assertHeaderSpacing(app)
        tap(app.buttons["Сессии"])
        let local = app.buttons["drawer.project.m::/projects/demo"]
        XCTAssertTrue(local.waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["drawer.project.server::/projects/demo"].exists)
        XCTAssertTrue(app.buttons["drawer.project.m::/other/demo"].exists)
        XCTAssertTrue(app.buttons["drawer.session.m::s3"].exists)
        XCTAssertFalse(app.buttons["drawer.session.m::s4"].exists)
        screenshot(app, "Project cards with separate machines and directories")
        tap(local)
        XCTAssertTrue(app.buttons["drawer.back"].exists)
        tap(app.buttons["drawer.search"])
        let search = app.textFields["drawer.searchField"]
        search.typeText("задачи 999")
        XCTAssertTrue(app.buttons["drawer.session.m::s999"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["drawer.session.server::remote"].exists)
        screenshot(app, "Search reaches the thousandth session")
        tap(app.buttons["drawer.back"])
        XCTAssertTrue(local.exists)
        tap(app.buttons["drawer.add.server::/projects/demo"])
        let project = app.buttons["start.project"]
        XCTAssertTrue(project.waitForExistence(timeout: 5))
        XCTAssertEqual(project.value as? String, "Production, /projects/demo")
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        let field = app.textViews.firstMatch
        let draft = "draft-\(UUID())"
        field.typeText(draft)
        tap(app.buttons["Сессии"])
        tap(app.buttons["drawer.add.m::/other/demo"])
        XCTAssertEqual(project.value as? String, "Fixture Mac, /other/demo")
        XCTAssertEqual(field.value as? String, "")
        field.typeText("Другой черновик")
        tap(app.buttons["Сессии"])
        XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 3))
        tap(app.buttons["drawer.add.server::/projects/demo"])
        XCTAssertEqual(project.value as? String, "Production, /projects/demo")
        XCTAssertEqual(field.value as? String, draft)
        tap(app.buttons["Отправить"])
        XCTAssertTrue(title.waitForExistence(timeout: 5))
        XCTAssertTrue(title.label.hasPrefix("draft-"), title.label)
        assertHeaderSpacing(app)
        XCTAssertGreaterThanOrEqual(app.buttons["header.newChat"].frame.minX, title.frame.maxX)
        XCTAssertLessThan(title.frame.height, 25)
        screenshot(app, "Session subject before permanent ID")
        let data = try Data(contentsOf: URL(string: "http://127.0.0.1:18783/test/inputs")!)
        let inputs = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [[String: Any]])
        let sent = try XCTUnwrap(inputs.last { $0["message"] as? String == draft })
        XCTAssertEqual(sent["machineId"] as? String, "server")
        XCTAssertEqual(sent["cwd"] as? String, "/projects/demo")
    }

    func testProjectNavigationRetainsSelectionAndCardScrollPosition() throws {
        let app = try launch(session: true)
        tap(app.buttons["Сессии"])
        let from = app.coordinate(withNormalizedOffset: CGVector(dx: 0.35, dy: 0.75))
        let to = app.coordinate(withNormalizedOffset: CGVector(dx: 0.35, dy: 0.3))
        from.press(forDuration: 0.1, thenDragTo: to)
        let candidates = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "drawer.project.m::/projects/extra-"))
        let project = try XCTUnwrap(candidates.allElementsBoundByIndex.first {
            $0.frame.midY > 120 && $0.frame.midY < app.frame.height - 120
        })
        let before = project.frame.minY
        tap(project)
        XCTAssertTrue(app.buttons["drawer.back"].waitForExistence(timeout: 5))
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.5)).tap()
        tap(app.buttons["Сессии"])
        XCTAssertTrue(app.buttons["drawer.back"].waitForExistence(timeout: 5))
        tap(app.buttons["drawer.back"])
        XCTAssertEqual(project.frame.minY, before, accuracy: 2)
        screenshot(app, "Project cards return to the same scroll position")
    }

    func testDoneAcceptsTapsAcrossWholeButtonAndLimitsAreVisible() throws {
        let app = try launch(session: true)
        app.textViews.firstMatch.tap()
        for x in [0.1, 0.9, 0.5] {
            tap(app.buttons["composer.settings"])
            let done = app.buttons["runSettings.done"]
            XCTAssertTrue(done.waitForExistence(timeout: 5))
            done.coordinate(withNormalizedOffset: CGVector(dx: x, dy: 0.5)).tap()
            XCTAssertTrue(done.waitForNonExistence(timeout: 3))
        }
        tap(app.buttons["header.newChat"])
        let usage = app.buttons["usage.open"]
        XCTAssertTrue(usage.waitForExistence(timeout: 5))
        let values = usage.value as? String ?? ""
        for text in ["Claude", "5 ч 32%", "нед. 81%", "Шлюз", "61%"] {
            XCTAssertTrue(values.contains(text), values)
        }
        XCTAssertGreaterThanOrEqual(usage.frame.height, 44 - 0.01)
        screenshot(app, "New chat with visible limits")
        tap(usage)
        XCTAssertTrue(app.buttons["usage.done"].waitForExistence(timeout: 5))
        tap(app.buttons["usage.done"])
        for x in [0.1, 0.9] {
            tap(app.buttons["composer.settings"])
            let done = app.buttons["runSettings.done"]
            XCTAssertTrue(done.waitForExistence(timeout: 5))
            done.coordinate(withNormalizedOffset: CGVector(dx: x, dy: 0.5)).tap()
            XCTAssertTrue(done.waitForNonExistence(timeout: 3))
        }
    }
}
