import XCTest

final class FormattingUITests: XCTestCase {
    func testActivityFollowsFinalParagraphAndOpensDetails() {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchEnvironment = ["CC_TRANSCRIPT": "formatting", "CC_THEME": "light"]
        app.launch()
        let final = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'Проверено на'")).firstMatch
        XCTAssertTrue(final.waitForExistence(timeout: 10))
        let gear = app.links.matching(NSPredicate(format: "label BEGINSWITH %@", "⚙︎")).firstMatch
        XCTAssertTrue(gear.waitForExistence(timeout: 5))
        XCTAssertGreaterThan(gear.frame.midY, final.frame.minY)
        XCTAssertLessThanOrEqual(gear.frame.maxY, final.frame.maxY + 4)
        gear.tap()
        XCTAssertTrue(app.navigationBars["Действия"].waitForExistence(timeout: 5))
        app.buttons["toolActivity.done"].tap()
        XCTAssertTrue(gear.waitForExistence(timeout: 5))
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = "Full width prose with inline activity"; shot.lifetime = .keepAlways; add(shot)
        app.terminate()
    }

    func testCodexOffersAdvertisedNoPromptsAndRetainsSelection() throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["CC_PERMISSION_FIXTURE"] == "1")
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchEnvironment = ["CC_HUB_URL": "ws://127.0.0.1:18769/ui", "CC_TOKEN": "permissions-\(UUID())",
                                 "CC_OPEN": "m::s1", "CC_THEME": "light"]
        app.launch()
        let field = app.textViews.firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 15))
        field.tap()
        let control = app.buttons["composer.settings"]
        XCTAssertTrue(control.waitForExistence(timeout: 15))
        control.tap()
        app.buttons["runSettings.permissions"].tap()
        let option = app.buttons["No prompts"]
        XCTAssertTrue(option.waitForExistence(timeout: 5))
        option.tap()
        XCTAssertTrue(app.buttons["runSettings.permissions"].label.contains("No prompts"))
        app.buttons["runSettings.done"].tap()
        control.tap()
        XCTAssertTrue(app.buttons["runSettings.permissions"].label.contains("No prompts"))
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = "Codex permissions"; shot.lifetime = .keepAlways; add(shot)
        app.terminate()
    }

    func testSessionMenuHasOneSheetAndCompactHeader() throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["CC_SEMANTIC_FIXTURE"] == "1")
        continueAfterFailure = false
        for theme in ["light", "dark"] {
            let app = XCUIApplication()
            app.launchEnvironment = ["CC_HUB_URL": "ws://127.0.0.1:18768/ui", "CC_TOKEN": "semantic-title-ui",
                                     "CC_OPEN": "m::s0", "CC_THEME": theme]
            app.launch()
            let title = app.descendants(matching: .any)["session.title"]
            XCTAssertTrue(title.waitForExistence(timeout: 15))
            title.tap()
            let menuTitle = app.staticTexts["session.menuTitle"]
            XCTAssertTrue(menuTitle.waitForExistence(timeout: 5))
            XCTAssertLessThan(menuTitle.frame.height, 30)
            XCTAssertTrue(app.buttons["session.rename"].isHittable)
            let shot = XCTAttachment(screenshot: app.screenshot())
            shot.name = "Single session sheet \(theme)"; shot.lifetime = .keepAlways; add(shot)
            app.buttons["session.menuClose"].tap()
            XCTAssertTrue(title.waitForExistence(timeout: 3))
            title.tap()
            XCTAssertTrue(menuTitle.waitForExistence(timeout: 3))
            app.swipeDown()
            XCTAssertTrue(title.waitForExistence(timeout: 3))
            app.terminate()
        }
    }

    func testProgressCanBeReadAndFoldedAgain() {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchEnvironment = ["CC_TRANSCRIPT": "formatting", "CC_THEME": "light"]
        app.launch()
        let progress = app.buttons["transcript.progress"]
        XCTAssertTrue(progress.waitForExistence(timeout: 10))
        if !progress.isHittable { app.swipeDown() }
        let before = XCTAttachment(screenshot: app.screenshot())
        before.name = "Compact answer"; before.lifetime = .keepAlways; add(before)
        progress.tap()
        let text = app.staticTexts.matching(NSPredicate(format: "label CONTAINS 'Я здесь. Уплотнил строки'")).firstMatch
        XCTAssertTrue(text.waitForExistence(timeout: 5))
        for _ in 0..<4 where !progress.isHittable { app.swipeDown() }
        XCTAssertTrue(progress.isHittable)
        progress.tap()
        XCTAssertFalse(text.exists)
        app.terminate()
    }

    func testSemanticTitleAppearsInDrawerAndSurvivesRelaunch() throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["CC_SEMANTIC_FIXTURE"] == "1")
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchEnvironment = ["CC_HUB_URL": "ws://127.0.0.1:18768/ui", "CC_TOKEN": "semantic-title-ui",
                                 "CC_OPEN": "m::s0", "CC_THEME": "dark"]
        app.launch()
        let title = app.descendants(matching: .any)["session.title"]
        XCTAssertTrue(title.waitForExistence(timeout: 15))
        XCTAssertEqual(title.label, "Demo / Fixture Mac")
        app.buttons["Сессии"].tap()
        let row = app.buttons["drawer.session.m::s0"]
        XCTAssertTrue(row.waitForExistence(timeout: 5))
        expectation(for: NSPredicate(format: "label == %@", "Доработка iOS-приложения"), evaluatedWith: row)
        waitForExpectations(timeout: 15)
        let second = app.buttons["drawer.session.m::s1"]
        expectation(for: NSPredicate(format: "label == %@", "Модалка и клавиатура"), evaluatedWith: second)
        waitForExpectations(timeout: 15)
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = "Semantic session titles"; shot.lifetime = .keepAlways; add(shot)
        app.terminate(); app.launch()
        XCTAssertTrue(title.waitForExistence(timeout: 15))
        XCTAssertEqual(title.label, "Demo / Fixture Mac")
        app.buttons["Сессии"].tap()
        XCTAssertTrue(row.waitForExistence(timeout: 5))
        XCTAssertEqual(row.label, "Доработка iOS-приложения")
        app.terminate()
    }
}
