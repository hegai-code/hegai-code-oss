import XCTest

final class RunSettingsUITests: XCTestCase {
    func testDormantSessionNamesModelAndCanChangeBeforeSending() throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["CC_MODEL_DORMANT_FIXTURE"] == "1")
        let app = launch(session: "s1", isolated: true)
        let control = app.buttons["composer.settings"]
        XCTAssertTrue(wait { (control.value as? String)?.contains("6 Astra") == true })
        control.tap()
        let sol = modelRow(in: app)
        XCTAssertTrue(sol.waitForExistence(timeout: 5))
        XCTAssertTrue(sol.isEnabled)
        sol.tap()
        XCTAssertTrue(app.descendants(matching: .any)["runSettings.changingModel"].waitForExistence(timeout: 3))
        XCTAssertTrue(wait { sol.isEnabled })
        app.buttons["runSettings.done"].tap()
        XCTAssertTrue(wait { (control.value as? String)?.contains("6 Sol") == true })
        app.textViews.firstMatch.tap()
        app.textViews.firstMatch.typeText("Первое сообщение после выбора модели")
        screenshot(app, "Dormant session model chosen before the first message")
        app.buttons["Отправить"].tap()
    }

    func testDictationPreviewUpdatesBeforeStopAndCancelPreservesDraft() throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["CC_DICTATION_LIVE_FIXTURE"] == "1")
        let app = launch(session: "s0", dictationFixture: true)
        let field = app.textViews.firstMatch
        field.typeText("Исходный черновик")
        let draft = field.value as? String
        app.buttons["Начать запись"].tap()
        let preview = app.descendants(matching: .any)["composer.dictationPreview"]
        XCTAssertTrue(preview.waitForExistence(timeout: 5))
        XCTAssertTrue(wait { (preview.value as? String)?.contains("Последние слова видны") == true })
        XCTAssertTrue(app.buttons["Остановить запись"].exists)
        XCTAssertLessThan(preview.frame.maxY, app.otherElements["composer.island"].frame.maxY)
        XCTAssertLessThan(preview.frame.height, 250)
        screenshot(app, "Live dictation text above the recording island")
        app.buttons["Отменить запись"].tap()
        XCTAssertTrue(wait { !preview.exists })
        XCTAssertEqual(field.value as? String, draft)
        app.buttons["Начать запись"].tap()
        XCTAssertTrue(preview.waitForExistence(timeout: 5))
        app.buttons["Остановить запись"].tap()
        XCTAssertTrue(wait { !preview.exists })
        XCTAssertTrue((field.value as? String)?.contains("Проверка голосового сообщения") == true)
        XCTAssertTrue((field.value as? String)?.hasPrefix(draft ?? "") == true)
    }
    override func setUpWithError() throws {
        continueAfterFailure = false
        try XCTSkipUnless(ProcessInfo.processInfo.environment["CC_SETTINGS_FIXTURE"] == "1",
                          "requires scripts/run-settings-fixture.cjs")
    }

    func testSettingsInComposerPreserveDraftAndUpdateRuntime() {
        let app = launch(session: "s0")
        let control = app.buttons["composer.settings"]
        XCTAssertTrue(control.waitForExistence(timeout: 15))
        XCTAssertTrue(wait { (control.value as? String)?.contains("Среднее") == true })
        assertSessionTitle(app)
        let field = app.textViews.firstMatch
        field.tap()
        let draft = "Draft \(Int(Date().timeIntervalSince1970))\n"
            + (1...8).map { "Строка черновика \($0)" }.joined(separator: "\n")
        field.typeText(draft)
        let saved = field.value as? String
        XCTAssertGreaterThan(control.frame.minY, field.frame.minY)
        XCTAssertLessThan(control.frame.maxY, app.keyboards.firstMatch.frame.minY)
        screenshot(app, "Composer model and effort above keyboard")
        control.tap()
        XCTAssertTrue(app.staticTexts["Модель и задача"].waitForExistence(timeout: 5))
        screenshot(app, "Model settings sheet")
        modelRow(in: app).tap()
        app.buttons["runSettings.effort"].tap()
        app.buttons["Высокое"].tap()
        app.buttons["runSettings.done"].tap()
        XCTAssertTrue(wait { (control.value as? String)?.contains("6 Sol, Высокое") == true })
        XCTAssertEqual(field.value as? String, saved)
        XCTAssertFalse(app.navigationBars.staticTexts["6 Sol"].exists)
        assertSessionTitle(app)
        app.terminate()
        app.launch()
        XCTAssertTrue(field.waitForExistence(timeout: 15))
        XCTAssertEqual(field.value as? String, saved)
        assertSessionTitle(app)
        let burger = app.buttons["Сессии"]
        XCTAssertGreaterThanOrEqual(burger.frame.width, 56)
        XCTAssertGreaterThanOrEqual(burger.frame.height, 44 - 0.01)
        XCTAssertLessThanOrEqual(burger.frame.maxX, app.descendants(matching: .any)["session.title"].frame.minX)
        // Tap the visible island: UIKit clips toolbar hit testing outside its host.
        burger.tap()
        let row = app.buttons["drawer.session.m::s0"]
        XCTAssertTrue(row.waitForExistence(timeout: 5))
        XCTAssertTrue(row.label.contains("Настройки мобильного чата"))
        XCTAssertFalse(row.label.contains("Astra") || row.label.contains("Sol"))
        screenshot(app, "Session title remains in project drawer")
        row.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        assertSessionTitle(app)
        burger.tap()
        XCTAssertTrue(row.waitForExistence(timeout: 5))
        row.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        assertSessionTitle(app)
        screenshot(app, "Session header with expanded menu target")
        app.terminate()
        app.launchEnvironment.removeValue(forKey: "CC_OPEN")
        app.launch()
        XCTAssertTrue(burger.waitForExistence(timeout: 15))
        burger.tap()
        XCTAssertTrue(row.waitForExistence(timeout: 5))
    }

    func testCodexAndStartUseBottomSettings() {
        let app = launch(session: "s1")
        let control = app.buttons["composer.settings"]
        XCTAssertTrue(control.waitForExistence(timeout: 15))
        XCTAssertTrue(wait { (control.value as? String)?.contains("6 Astra") == true })
        control.tap()
        app.buttons["runSettings.effort"].tap()
        XCTAssertFalse(app.buttons["Ultracode"].exists)
        app.buttons["Низкое"].tap()
        app.buttons["runSettings.done"].tap()
        app.textViews.firstMatch.tap()
        XCTAssertTrue(wait { (control.value as? String)?.contains("Низкое") == true })
        app.terminate()
        app.launchEnvironment.removeValue(forKey: "CC_OPEN")
        app.launch()
        let field = app.textViews.firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 15))
        field.tap()
        XCTAssertTrue(control.waitForExistence(timeout: 5))
        XCTAssertGreaterThan(control.frame.minY, field.frame.minY)
        control.tap()
        XCTAssertTrue(modelRow(in: app).waitForExistence(timeout: 10))
        modelRow(in: app).tap()
        app.buttons["runSettings.done"].tap()
        XCTAssertTrue(control.label.contains("6 Sol"))
    }

    func testRuntimeBoltsInHeaderAndDrawerDisappearWhenIdle() throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["CC_ACTIVITY_FIXTURE"] == "1",
                          "requires activity fixture")
        let app = launch(session: "s0", focus: false)
        let bolt = app.descendants(matching: .any)["session.title"]
        XCTAssertTrue(bolt.waitForExistence(timeout: 15))
        XCTAssertEqual(bolt.value as? String, "Claude работает")
        XCTAssertFalse(app.staticTexts["session resumed"].exists)
        assertSessionTitle(app)
        screenshot(app, "Claude activity in header")
        app.buttons["Сессии"].tap()
        let claude = app.buttons["drawer.session.m::s0"]
        let codex = app.buttons["drawer.session.m::s1"]
        XCTAssertTrue(claude.waitForExistence(timeout: 5))
        XCTAssertTrue(claude.label.contains("Claude работает"))
        XCTAssertTrue(codex.label.contains("Codex работает"))
        screenshot(app, "Claude and Codex activity in drawer")
        // The translated drawer row has a valid visible frame even when
        // XCTest's accessibility hit test reports it as not hittable.
        codex.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        XCTAssertTrue(wait { bolt.exists && bolt.value as? String == "Codex работает" })
        assertSessionTitle(app)
        screenshot(app, "Codex activity in header")
        let field = app.textViews.firstMatch
        field.tap()
        if let existing = field.value as? String, !existing.isEmpty {
            field.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.95)).tap()
            field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: existing.count))
        }
        field.typeText("Уточнение к текущей задаче")
        XCTAssertTrue(app.buttons["Отправить"].exists)
        XCTAssertFalse(app.buttons["Прервать"].exists)
        screenshot(app, "Busy composer has only send with a draft")
        field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: "Уточнение к текущей задаче".count))
        XCTAssertEqual(field.value as? String, "")
        XCTAssertTrue(app.buttons["Прервать"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["Отправить"].exists)
        app.buttons["Прервать"].tap()
        XCTAssertTrue(wait { (bolt.value as? String ?? "").isEmpty })
        assertSessionTitle(app)
        app.buttons["Сессии"].tap()
        XCTAssertTrue(codex.waitForExistence(timeout: 5))
        XCTAssertFalse(codex.label.contains("работает"))
        XCTAssertTrue(claude.label.contains("Claude работает"))
    }

    func testSendAppearsOnlyWithContentAndRecordingUsesFullWidth() {
        let app = launch(session: "s0", dictationFixture: true, focus: false)
        let field = app.textViews.firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 15))
        let send = app.buttons["Отправить"]
        // Clear any persisted draft through the local fixture, independently of
        // the caret position restored by UITextView.
        if send.exists { send.tap() }
        XCTAssertTrue(wait { !send.exists })
        XCTAssertFalse(app.keyboards.firstMatch.exists)
        // Dictation can start directly from the compact island.
        app.buttons["Начать запись"].tap()
        XCTAssertTrue(app.otherElements["composer.waveform"].waitForExistence(timeout: 5))
        app.buttons["Остановить запись"].tap()
        XCTAssertTrue(wait { field.value as? String == "Проверка голосового сообщения" })
        send.tap()
        field.tap()
        XCTAssertFalse(send.exists)
        field.typeText("   ")
        XCTAssertFalse(send.exists)
        field.typeText("Текст")
        XCTAssertTrue(send.exists)
        XCTAssertTrue(send.isEnabled)
        field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 8))
        XCTAssertFalse(send.exists)
        screenshot(app, "Empty composer without send arrow")

        app.buttons["Начать запись"].tap()
        let waveform = app.otherElements["composer.waveform"]
        XCTAssertTrue(waveform.waitForExistence(timeout: 5))
        XCTAssertGreaterThan(waveform.frame.width, app.frame.width * 0.80)
        // Accessibility bounds enclose the actual bars, whose fixture peak is
        // slightly below the 44pt scale ceiling.
        XCTAssertGreaterThan(waveform.frame.height, 40)
        XCTAssertFalse(send.exists)
        XCTAssertTrue(app.buttons["Остановить запись"].exists)
        screenshot(app, "Full width recording waveform")
        app.buttons["Остановить запись"].tap()
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        XCTAssertTrue(wait { field.value as? String == "Проверка голосового сообщения" })
        XCTAssertTrue(send.exists)
        XCTAssertTrue(send.isEnabled)
        send.tap()
        XCTAssertTrue(wait { !send.exists })
        XCTAssertTrue(app.buttons["Начать запись"].exists)
    }

    func testContextRingCompactsAndPreservesDraft() throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["CC_CONTEXT_FIXTURE"] == "1")
        let app = launch(session: "s0")
        let ring = app.buttons["composer.context"]
        XCTAssertTrue(ring.waitForExistence(timeout: 15))
        XCTAssertEqual(ring.value as? String, "50%")
        let field = app.textViews.firstMatch
        field.tap()
        field.typeText("Черновик перед сжатием")
        let draft = field.value as? String
        let model = app.buttons["composer.settings"]
        XCTAssertLessThanOrEqual(ring.frame.maxX, model.frame.minX)
        XCTAssertEqual(ring.frame.midY, model.frame.midY, accuracy: 1)
        XCTAssertTrue(app.buttons["Отправить"].isHittable)
        screenshot(app, "Context ring beside model")
        ring.tap()
        let compact = app.buttons["context.compact"]
        XCTAssertTrue(compact.waitForExistence(timeout: 5))
        screenshot(app, "Context details and compact action")
        compact.tap()
        XCTAssertTrue(wait { !compact.isEnabled })
        XCTAssertTrue(app.staticTexts["Контекст сжат. Можно продолжать разговор."].waitForExistence(timeout: 10))
        XCTAssertTrue(compact.isEnabled)
        let title = app.staticTexts["Контекст"]
        title.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
            .press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.98)))
        XCTAssertTrue(wait { ring.exists && ring.isHittable })
        XCTAssertEqual(ring.value as? String, "10%")
        XCTAssertEqual(field.value as? String, draft)
        app.terminate()
        let codex = launch(session: "s1")
        XCTAssertTrue(codex.buttons["composer.context"].waitForExistence(timeout: 15))
        XCTAssertEqual(codex.buttons["composer.context"].value as? String, "50%")
    }

    private func modelRow(in app: XCUIApplication) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "label == %@ AND identifier != %@",
                                        "6 Sol", "composer.settings")).firstMatch
    }

    private func assertSessionTitle(_ app: XCUIApplication) {
        let title = app.descendants(matching: .any)["session.title"]
        XCTAssertTrue(title.waitForExistence(timeout: 5))
        XCTAssertEqual(title.label, "Настройки мобильного чата")
    }

    private func launch(session: String, dictationFixture: Bool = false, focus: Bool = true, isolated: Bool = false) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchEnvironment = ["CC_HUB_URL": "ws://127.0.0.1:\(ProcessInfo.processInfo.environment["CC_FIXTURE_PORT"] ?? "18768")/ui", "CC_TOKEN": isolated ? "fixture-\(UUID().uuidString)" : "fixture",
                                 "CC_OPEN": "m::\(session)",
                                 "CC_THEME": ProcessInfo.processInfo.environment["CC_TEST_THEME"] ?? "dark",
                                 "CC_HW_KEYBOARD": "false"]
        if dictationFixture {
            app.launchEnvironment["CC_DICTATION_FIXTURE"] = "1"
            app.launchEnvironment["CC_DICTATION_LIVE_FIXTURE"] = ProcessInfo.processInfo.environment["CC_DICTATION_LIVE_FIXTURE"]
        }
        app.launch()
        let field = app.textViews.firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 15))
        if focus { field.tap() }
        return app
    }
    private func wait(_ condition: () -> Bool) -> Bool {
        let end = Date().addingTimeInterval(8)
        repeat {
            if condition() { return true }
            RunLoop.current.run(until: Date().addingTimeInterval(0.1))
        } while Date() < end
        return condition()
    }
    private func screenshot(_ app: XCUIApplication, _ name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }
}
