import XCTest

/// Reproducible button/gesture sequence against a populated local inventory.
/// CC_DRAWER_METRICS records display-link callbacks inside the app, after the
/// actual button action. XCTest tap duration includes automation/idleness work
/// and MUST NOT be presented as app latency (nor subtracted from an idle tap).
/// Export Documents/drawer-metrics.json after this test; use Animation Hitches
/// on a physical phone to measure actual presentation/render hitches.
final class DrawerTimingUITests: XCTestCase {

    private var hub = ""
    private var token = ""

    override func setUpWithError() throws {
        continueAfterFailure = true
        let env = ProcessInfo.processInfo.environment
        hub = env["CC_LIVE_HUB"] ?? ""
        token = env["CC_LIVE_TOKEN"] ?? ""
        try XCTSkipIf(hub.isEmpty || token.isEmpty,
                      "нужен живой хаб: список шторки меряется на настоящем инвентаре")
    }

    func testDrawerOpenTiming() {
        let app = XCUIApplication()
        app.launchEnvironment = [
            "CC_HUB_URL": hub, "CC_TOKEN": token, "CC_THEME": "light", "CC_HW_KEYBOARD": "false",
            "CC_DRAWER_METRICS": "1",
        ]
        app.launch()

        // Меряем на ЖИВОМ инвентаре: пустая шторка строится мгновенно и
        // показала бы время, которого у человека нет.
        XCTAssertTrue(waitFor(90) {
            (app.buttons["start.project"].value as? String)?.contains("Fixture Mac") == true
        }, "флот не приехал — мерить нечего")

        let burger = app.buttons["Сессии"]
        XCTAssertTrue(burger.waitForExistence(timeout: 20), "нет кнопки ☰")

        Thread.sleep(forTimeInterval: 3)
        for i in 0..<5 {
            burger.tap()
            XCTAssertTrue(waitFor(4) { self.drawerVisible(app) }, "drawer did not open on pass \(i)")
            Thread.sleep(forTimeInterval: 0.7)
            closeDrawer(app)
            Thread.sleep(forTimeInterval: 1)
        }
    }

    // MARK: - Опоры

    func testSessionTitleIsPrimaryHeader() throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["CC_DRAWER_FIXTURE"] == "1", "requires drawer fixture")
        let app = XCUIApplication()
        app.launchEnvironment = ["CC_HUB_URL": hub, "CC_TOKEN": token, "CC_OPEN": "m::s0", "CC_THEME": "light"]
        app.launch()
        let title = app.descendants(matching: .any)["session.title"]
        XCTAssertTrue(title.waitForExistence(timeout: 15))
        XCTAssertEqual(title.label, "Demo / Fixture Mac")
        XCTAssertTrue(title.isHittable)
    }

    func testSlowRightDrag() {
        let app = XCUIApplication()
        app.launchEnvironment = ["CC_HUB_URL": hub, "CC_TOKEN": token, "CC_THEME": "light", "CC_DRAWER_METRICS": "1"]
        app.launch()
        XCTAssertTrue(app.buttons["Сессии"].waitForExistence(timeout: 20))
        Thread.sleep(forTimeInterval: 3)
        let from = app.coordinate(withNormalizedOffset: CGVector(dx: 0.12, dy: 0.5))
        let to = app.coordinate(withNormalizedOffset: CGVector(dx: 0.8, dy: 0.5))
        from.press(forDuration: 0.05, thenDragTo: to, withVelocity: .slow, thenHoldForDuration: 0.5)
        XCTAssertTrue(waitFor(4) { self.drawerVisible(app) })
        let firstSession = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Session 0 '")).firstMatch
        XCTAssertTrue(firstSession.waitForExistence(timeout: 4))
        firstSession.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).press(forDuration: 1)
        app.buttons["В избранное"].tap()
        XCTAssertTrue(waitFor(4) { firstSession.value as? String == "Избранное" })
        // The optimized subtree still observes settings changes. Restore the
        // fixture preference before the next test/repeated run.
        firstSession.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).press(forDuration: 1)
        app.buttons["Убрать из избранного"].tap()
        let closeFrom = app.coordinate(withNormalizedOffset: CGVector(dx: 0.65, dy: 0.45))
        let closeTo = app.coordinate(withNormalizedOffset: CGVector(dx: 0.05, dy: 0.45))
        closeFrom.press(forDuration: 0.05, thenDragTo: closeTo, withVelocity: .slow, thenHoldForDuration: 0.2)
        XCTAssertTrue(waitFor(4) { !self.drawerVisible(app) })
        from.press(forDuration: 0.05, thenDragTo: to)
        XCTAssertTrue(waitFor(4) { self.drawerVisible(app) })
    }

    func testCachedDrawerSearchAndProjects() throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["CC_DRAWER_FIXTURE"] == "1",
                          "requires scripts/drawer-fixture.cjs")
        let app = XCUIApplication()
        app.launchEnvironment = ["CC_HUB_URL": hub, "CC_TOKEN": token, "CC_THEME": "light"]
        app.launch()
        XCTAssertTrue(waitFor(30) {
            (app.buttons["start.project"].value as? String)?.contains("Fixture Mac") == true
        })
        app.buttons["Сессии"].tap()
        XCTAssertTrue(waitFor(4) { self.drawerVisible(app) })
        app.buttons["Поиск"].tap()
        let search = app.textFields["Поиск сессий"]
        XCTAssertTrue(search.waitForExistence(timeout: 4))
        search.tap()
        search.typeText("Session 999")
        XCTAssertTrue(app.buttons.matching(NSPredicate(format: "label CONTAINS 'Session 999'")).firstMatch.waitForExistence(timeout: 4))
        closeDrawer(app)
        app.buttons["Сессии"].tap()
        XCTAssertTrue(waitFor(4) { self.drawerVisible(app) })
        XCTAssertTrue(app.buttons["Поиск"].exists)
        let project = app.buttons["drawer.project.m::/projects/demo"]
        XCTAssertTrue(project.waitForExistence(timeout: 4))
        project.tap()
        XCTAssertTrue(app.buttons["drawer.back"].waitForExistence(timeout: 4))
        XCTAssertTrue(app.buttons["drawer.session.m::s4"].exists)
        app.buttons["drawer.back"].tap()
        XCTAssertTrue(project.waitForExistence(timeout: 4))
        XCTAssertFalse(app.buttons["drawer.session.m::s4"].exists)
    }

    func testProjectDrawerReplacesDestinations() throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["CC_DRAWER_FIXTURE"] == "1", "requires drawer fixture")
        let app = XCUIApplication()
        app.launchEnvironment = ["CC_HUB_URL": hub, "CC_TOKEN": token, "CC_THEME": "dark", "CC_DRAWER": "1"]
        app.launch()
        XCTAssertTrue(app.buttons["drawer.project.m::/projects/demo"].waitForExistence(timeout: 20))
        for title in ["Память", "Проекты", "Flow", "Устройства", "Команда", "Уведомления"] {
            XCTAssertFalse(app.buttons[title].exists)
        }
        XCTAssertTrue(app.buttons["drawer.project.m::/projects/website"].exists)
        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = "Compact project drawer"
        screenshot.lifetime = .keepAlways
        add(screenshot)
        app.buttons["drawer.session.m::s0"].coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        XCTAssertTrue(app.descendants(matching: .any)["session.title"].waitForExistence(timeout: 5))
        app.buttons["Сессии"].tap()
        app.buttons["Настройки"].tap()
        XCTAssertTrue(app.navigationBars["Настройки"].waitForExistence(timeout: 5))
    }

    /// Шторка ВИДИМА (`t > 0`) — то есть ход начался.
    private func drawerVisible(_ app: XCUIApplication) -> Bool {
        app.descendants(matching: .any).matching(identifier: "shell.drawer").firstMatch.exists
    }

    private func closeDrawer(_ app: XCUIApplication) {
        // The visible strip belongs to the scrim; no offscreen accessibility
        // hit point lookup while the transformed drawer is settling.
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.5)).tap()
        _ = waitFor(3) { !self.drawerVisible(app) }
    }

    private func waitFor(_ seconds: TimeInterval, _ cond: () -> Bool) -> Bool {
        let deadline = Date().addingTimeInterval(seconds)
        repeat { if cond() { return true } } while Date() < deadline
        return cond()
    }
}
