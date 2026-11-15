import XCTest

@MainActor
final class DictationSendUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
        try XCTSkipUnless(ProcessInfo.processInfo.environment["CC_SETTINGS_FIXTURE"] == "1")
    }

    func testRecordingHasStopAndSendAndSendsFinalWordsOnce() async throws {
        let app = launch()
        let before = try await inputs().count
        app.buttons["Начать запись"].tap()
        XCTAssertTrue(app.buttons["Остановить запись"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["Прервать"].exists)
        let send = app.buttons["composer.sendDictation"]
        XCTAssertTrue(send.isHittable)
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = "Recording stop and send"; shot.lifetime = .keepAlways; add(shot)
        send.tap()
        XCTAssertTrue(app.descendants(matching: .any)["composer.finalizingDictation"].firstMatch.waitForExistence(timeout: 2))
        let finishing = XCTAttachment(screenshot: app.screenshot())
        finishing.name = "Waiting for final words"; finishing.lifetime = .keepAlways; add(finishing)
        XCTAssertTrue(app.buttons["Начать запись"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["Отправить"].exists)
        // Inspect the actual frame reaching the fixture, not just the cleared field.
        let received = try await inputs()
        XCTAssertEqual(received.count, before + 1)
        XCTAssertEqual(received.last?["text"], "Проверка голосового сообщения и последние слова")
        XCTAssertEqual(received.last?["runId"], "r-s0")
        app.terminate()
        app.launch()
        XCTAssertTrue(app.buttons["Начать запись"].waitForExistence(timeout: 15))
        XCTAssertFalse(app.buttons["Отправить"].exists)
    }

    func testStopKeepsFinalWordsWithoutSending() async throws {
        let app = launch()
        let before = try await inputs().count
        app.buttons["Начать запись"].tap()
        app.buttons["Остановить запись"].tap()
        let field = app.textViews.firstMatch
        let final = NSPredicate(format: "value == %@", "Проверка голосового сообщения и последние слова")
        await fulfillment(of: [XCTNSPredicateExpectation(predicate: final, object: field)], timeout: 5)
        XCTAssertTrue(app.buttons["Отправить"].exists)
        let received = try await inputs()
        XCTAssertEqual(received.count, before)
    }

    func testCancelRestoresDraftAndCancelsPendingVoiceSend() async throws {
        let app = launch()
        let before = try await inputs().count
        app.buttons["Начать запись"].tap()
        let cancel = app.buttons["composer.cancelDictation"]
        XCTAssertTrue(cancel.waitForExistence(timeout: 5))
        cancel.tap()
        XCTAssertTrue(app.textViews.firstMatch.waitForExistence(timeout: 5))
        XCTAssertEqual(app.textViews.firstMatch.value as? String, "")
        XCTAssertFalse(app.buttons["Отправить"].exists)
        let original = "Мой черновик.\n\n"
        app.textViews.firstMatch.tap()
        app.textViews.firstMatch.typeText(original)
        app.buttons["Начать запись"].tap()
        app.buttons["composer.sendDictation"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["composer.finalizingDictation"].firstMatch.waitForExistence(timeout: 2))
        cancel.tap()
        XCTAssertEqual(app.textViews.firstMatch.value as? String, original)
        // Wait beyond the delayed final callback: it must neither send nor
        // replace the restored draft after cancellation.
        try await Task.sleep(for: .seconds(3))
        XCTAssertEqual(app.textViews.firstMatch.value as? String, original)
        let received = try await inputs()
        XCTAssertEqual(received.count, before)
    }

    func testPhotoAndTypedTextCanBeCompletedByVoiceAndSentTogether() async throws {
        let app = launch()
        app.buttons["Вложение"].tap()
        app.buttons["Медиатека"].tap()
        let photo = app.images.matching(identifier: "PXGGridLayout-Info").firstMatch
        XCTAssertTrue(photo.waitForExistence(timeout: 15), "Seed simulator Photos with simctl addmedia")
        let photoFrame = photo.frame
        app.coordinate(withNormalizedOffset: .zero)
            .withOffset(CGVector(dx: photoFrame.midX, dy: photoFrame.midY)).tap()
        for label in ["Add", "Добавить", "Done", "Готово"] where app.buttons[label].exists {
            app.buttons[label].tap()
            break
        }
        let attachment = app.descendants(matching: .any)["composer.attachment"].firstMatch
        XCTAssertTrue(attachment.waitForExistence(timeout: 15))
        XCTAssertTrue(app.buttons["Начать запись"].isHittable)
        app.textViews.firstMatch.tap()
        app.textViews.firstMatch.typeText("Посмотри фото.")
        XCTAssertTrue(app.buttons["Начать запись"].isHittable)
        let before = try await inputs().count
        app.buttons["Начать запись"].tap()
        XCTAssertTrue(app.buttons["composer.cancelDictation"].waitForExistence(timeout: 5))
        app.buttons["composer.cancelDictation"].tap()
        XCTAssertEqual(app.textViews.firstMatch.value as? String, "Посмотри фото.")
        XCTAssertTrue(attachment.exists)
        app.buttons["Начать запись"].tap()
        XCTAssertTrue(app.buttons["Остановить запись"].waitForExistence(timeout: 5))
        XCTAssertTrue(attachment.exists)
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = "Photo with voice and send"; shot.lifetime = .keepAlways; add(shot)
        app.buttons["Остановить запись"].tap()
        let finalText = "Посмотри фото. Проверка голосового сообщения и последние слова"
        await fulfillment(of: [XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "value == %@", finalText), object: app.textViews.firstMatch)], timeout: 5)
        XCTAssertTrue(attachment.exists)
        XCTAssertTrue(app.buttons["Начать запись"].isHittable)
        let afterStop = try await inputs()
        XCTAssertEqual(afterStop.count, before)
        app.buttons["Отправить"].tap()
        XCTAssertTrue(attachment.waitForNonExistence(timeout: 5))
        let received = try await inputs()
        XCTAssertEqual(received.count, before + 1)
        XCTAssertEqual(received.last?["text"], finalText)
        let images = try JSONSerialization.jsonObject(with: Data(try XCTUnwrap(received.last?["images"]).utf8)) as? [[String: Any]]
        XCTAssertEqual(images?.count, 1)
        XCTAssertFalse((images?.first?["data"] as? String ?? "").isEmpty)
    }

    func testRecognitionFailureKeepsTextWithoutSending() async throws {
        let app = launch(failure: true)
        let before = try await inputs().count
        app.buttons["Начать запись"].tap()
        app.buttons["composer.sendDictation"].tap()
        XCTAssertTrue(app.alerts["Диктовка"].waitForExistence(timeout: 5))
        app.alerts.buttons["OK"].tap()
        XCTAssertEqual(app.textViews.firstMatch.value as? String, "Проверка голосового сообщения и последние слова")
        XCTAssertTrue(app.buttons["Отправить"].exists)
        let received = try await inputs()
        XCTAssertEqual(received.count, before)
    }

    private func launch(failure: Bool = false) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchEnvironment = ["CC_HUB_URL": "ws://127.0.0.1:18768/ui", "CC_TOKEN": "fixture",
                                 "CC_OPEN": "m::s0", "CC_THEME": "dark", "CC_DICTATION_FIXTURE": "1",
                                 "CC_DICTATION_FINAL_FIXTURE": "1", "CC_DICTATION_SLOW_FINAL_FIXTURE": "1"]
        if failure { app.launchEnvironment["CC_DICTATION_ERROR_FIXTURE"] = "1" }
        app.launch()
        XCTAssertTrue(app.textViews.firstMatch.waitForExistence(timeout: 15))
        if app.buttons["Отправить"].exists { app.buttons["Отправить"].tap() }
        XCTAssertTrue(app.buttons["Начать запись"].waitForExistence(timeout: 5))
        return app
    }

    private func inputs() async throws -> [[String: String]] {
        let (data, _) = try await URLSession.shared.data(from: URL(string: "http://127.0.0.1:18768/test/inputs")!)
        return try JSONDecoder().decode([[String: String]].self, from: data)
    }
}
