import XCTest

final class WorkingIndicatorUITests: XCTestCase {
    func testTimerAndActivityForBothRuntimes() throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["CC_PROGRESS_FIXTURE"] == "1")
        continueAfterFailure = false
        for session in ["s0", "s1"] {
            let app = XCUIApplication()
            app.launchEnvironment = ["CC_HUB_URL": "ws://127.0.0.1:18768/ui", "CC_TOKEN": "fixture",
                                     "CC_OPEN": "m::\(session)", "CC_THEME": session == "s0" ? "light" : "dark"]
            app.launch()
            let indicator = app.descendants(matching: .any)["chat.working"].firstMatch
            XCTAssertTrue(indicator.waitForExistence(timeout: 15))
            // С 08.10.2026 подпись — что делает ход (фикстура заканчивает ход на
            // `Read`), а расход в токенах не показывается вовсе.
            let named = NSPredicate { _, _ in indicator.label == "Читаю файл" }
            XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: named, object: nil)], timeout: 5), .completed)
            XCTAssertFalse(indicator.label.contains("ток."))
            XCTAssertFalse((indicator.value as? String)?.contains("ток.") ?? false)
            let before = indicator.value as? String
            XCTAssertTrue(before?.hasPrefix("1:") == true)
            let changed = NSPredicate { _, _ in indicator.value as? String != before }
            XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: changed, object: nil)], timeout: 4), .completed)
            XCTAssertLessThanOrEqual(indicator.frame.maxX, app.frame.maxX - 8)
            // С 20.10.2026 это карточка (заголовок, модель, три шага), а не строка.
            XCTAssertLessThan(indicator.frame.height, 220)
            let shot = XCTAttachment(screenshot: app.screenshot())
            shot.name = "Working progress \(session)"
            shot.lifetime = .keepAlways
            add(shot)
            app.terminate()
        }
    }
}
