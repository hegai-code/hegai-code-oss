import XCTest

final class ComposerWrappingUITests: XCTestCase {
    func testSingleTapOnChatDismissesKeyboardAndPreservesDraft() {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchEnvironment = ["CC_TRANSCRIPT": "turns", "CC_THEME": "light", "CC_HW_KEYBOARD": "false", "CC_EDITOR_GEOMETRY": "1",
                                 "CC_HUB_URL": "ws://127.0.0.1:1/ui", "CC_TOKEN": "wrapping-\(UUID())"]
        if let size = ProcessInfo.processInfo.environment["CC_TEST_CONTENT_SIZE"] {
            app.launchArguments += ["-UIPreferredContentSizeCategoryName", size]
        }
        if ProcessInfo.processInfo.environment["CC_TEST_SESSION"] == "1" {
            app.launchEnvironment["CC_OPEN"] = "m::s0"
        }
        app.launch()
        let field = app.textViews.firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        field.tap()
        field.typeText("Черновик остаётся")
        XCTAssertTrue(app.keyboards.firstMatch.exists)
        // A tap inside the editor must keep focus; only the transcript dismisses.
        field.tap()
        XCTAssertTrue(app.keyboards.firstMatch.exists)
        let chat = app.scrollViews["chat.transcript"]
        chat.coordinate(withNormalizedOffset: CGVector(dx: 0.02, dy: 0.5)).tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 2))
        XCTAssertEqual(field.value as? String, "Черновик остаётся")
        field.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        let message = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Понял. Правь и собери под SE.")).firstMatch
        XCTAssertTrue(message.isHittable)
        message.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 2))
        XCTAssertEqual(field.value as? String, "Черновик остаётся")
        shot(app, "Keyboard dismissed by one transcript tap")
    }

    func testTypingThroughSixLinesAndScrollingDraft() {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchEnvironment = ["CC_TRANSCRIPT": "turns", "CC_THEME": "light", "CC_HW_KEYBOARD": "false", "CC_EDITOR_GEOMETRY": "1",
                                 "CC_HUB_URL": "ws://127.0.0.1:1/ui", "CC_TOKEN": "wrapping-\(UUID())"]
        if let size = ProcessInfo.processInfo.environment["CC_TEST_CONTENT_SIZE"] {
            app.launchArguments += ["-UIPreferredContentSizeCategoryName", size]
        }
        if ProcessInfo.processInfo.environment["CC_TEST_SESSION"] == "1" {
            app.launchEnvironment["CC_OPEN"] = "m::s0"
        }
        app.launch()
        let field = app.textViews.firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        field.tap()
        var previousHeight = field.frame.height
        for line in 1...10 {
            field.typeText(line == 1 ? "Строка 1" : "\nСтрока \(line)")
            if (3...6).contains(line) {
                XCTAssertGreaterThan(field.frame.height, previousHeight + 10, "Line \(line)")
            }
            if line > 6 { XCTAssertEqual(field.frame.height, previousHeight, accuracy: 1) }
            previousHeight = field.frame.height
            assertEditorAndControls(app, field: field, step: line)
            if [4, 5, 6, 7, 10].contains(line) { shot(app, "Composer after line \(line)") }
        }
        XCTAssertEqual(field.value as? String, (1...10).map { "Строка \($0)" }.joined(separator: "\n"))
        field.swipeDown()
        shot(app, "Composer reading beginning of draft")
        XCTAssertTrue(app.buttons["Отправить"].isHittable)
    }

    /// A six-line draft restored on open used to show five lines over a blank
    /// sixth: the text container matched the field's bounds, and TextKit 2
    /// dropped the line that did not fit, never laying it out after the field grew.
    func testRestoredSixLineDraftShowsEveryLine() {
        continueAfterFailure = false
        let token = "restore-\(UUID())"
        func launch() -> XCUIApplication {
            let app = XCUIApplication()
            app.launchEnvironment = ["CC_TRANSCRIPT": "turns", "CC_THEME": "light", "CC_HW_KEYBOARD": "false", "CC_EDITOR_GEOMETRY": "1",
                                     "CC_HUB_URL": "ws://127.0.0.1:1/ui", "CC_TOKEN": token, "CC_OPEN": "m::s0"]
            app.launch()
            return app
        }
        var app = launch()
        var field = app.textViews.firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        field.tap()
        for _ in 1...6 { field.typeText("Пишу сообщение без ввода строки. ") }
        let typedHeight = field.frame.height
        app.terminate()
        app = launch()
        field = app.textViews.firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        XCTAssertEqual(field.frame.height, typedHeight, accuracy: 1)
        assertEveryLineLaidOut(field, "restored")
        field.tap()
        assertEveryLineLaidOut(field, "restored, focused")
        shot(app, "Restored six-line draft")
    }

    /// TextKit reports the dropped line as laid out, so look at the pixels:
    /// the bottom sixth of a full six-line field must contain dark (text) ink.
    private func assertEveryLineLaidOut(_ field: XCUIElement, _ step: String) {
        guard let image = field.screenshot().image.cgImage else { return XCTFail("No field image, \(step)") }
        let width = image.width, height = image.height
        var pixels = [UInt8](repeating: 0, count: width * height * 4)
        let drawn = pixels.withUnsafeMutableBytes { buffer -> Bool in
            guard let context = CGContext(data: buffer.baseAddress, width: width, height: height, bitsPerComponent: 8,
                                          bytesPerRow: width * 4, space: CGColorSpaceCreateDeviceRGB(),
                                          bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return false }
            context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
            return true
        }
        XCTAssertTrue(drawn)
        // Rows are stored top-down; the last sixth is the sixth line.
        var ink = 0
        for y in (height * 5 / 6)..<height {
            for x in 0..<width {
                let i = (y * width + x) * 4
                if Int(pixels[i]) + Int(pixels[i + 1]) + Int(pixels[i + 2]) < 240 { ink += 1 }
            }
        }
        XCTAssertGreaterThan(ink, width / 4, "Blank sixth line, \(step)")
    }

    func testAutomaticWrappingKeepsCaretAndActionsVisible() throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["CC_PROJECT_CARDS_FIXTURE"] == "1")
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchEnvironment = ["CC_HUB_URL": "ws://127.0.0.1:18783/ui", "CC_TOKEN": "wrap-\(UUID())",
                                 "CC_THEME": "light", "CC_HW_KEYBOARD": "false", "CC_EDITOR_GEOMETRY": "1"]
        if let size = ProcessInfo.processInfo.environment["CC_TEST_CONTENT_SIZE"] {
            app.launchArguments += ["-UIPreferredContentSizeCategoryName", size]
        }
        if ProcessInfo.processInfo.environment["CC_TEST_SESSION"] == "1" {
            app.launchEnvironment["CC_OPEN"] = "m::s0"
        }
        app.launch()
        let field = app.textViews.firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        field.tap()
        for step in 1...12 {
            field.typeText("Пишу сообщение без ввода. ")
            shot(app, "Soft wrap step \(step)")
            assertEditorAndControls(app, field: field, step: step)
        }
        // Keyboard accessibility excludes its prediction bar. A real tap must
        // send the draft, not hit a suggestion covering the button's center.
        app.buttons["Отправить"].coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        XCTAssertTrue(app.buttons["session.titleIsland"].waitForExistence(timeout: 5))
        XCTAssertEqual(field.value as? String, "")
    }

    private func assertEditorAndControls(_ app: XCUIApplication, field: XCUIElement, step: Int) {
        let geometry = try! JSONSerialization.jsonObject(with: Data(field.label.utf8)) as! [String: Double]
        XCTAssertLessThanOrEqual(geometry["caretBottom"]!, geometry["visibleBottom"]! + 1, "Hidden caret after chunk \(step): \(geometry)")
        XCTAssertGreaterThanOrEqual(geometry["caretTop"]!, geometry["visibleTop"]! - 1, "Hidden caret after chunk \(step): \(geometry)")
        XCTAssertLessThanOrEqual(geometry["contentWidth"]!, geometry["width"]! + 1)
        XCTAssertLessThanOrEqual(field.frame.maxY, app.buttons["Вложение"].frame.minY + 1,
                                 "Editor overlaps actions after chunk \(step)")
        for label in ["Вложение", "Отправить", "Начать запись"] {
            let button = app.buttons[label]
            XCTAssertGreaterThanOrEqual(button.frame.height, 44 - 0.01, "Clipped \(label), chunk \(step)")
            XCTAssertLessThanOrEqual(button.frame.maxY, app.keyboards.firstMatch.frame.minY)
            XCTAssertTrue(button.isHittable)
        }
    }

    private func shot(_ app: XCUIApplication, _ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
