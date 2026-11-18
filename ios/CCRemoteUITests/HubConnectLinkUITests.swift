import XCTest

/// A self-hosted hub hands the app its address with `ccremote://connect?hub=…`
/// (its `/app` page, «Открыть в приложении»). Against a LIVE external-edition hub:
/// signed-out screen shows «Сервер», the link asks before switching, and after
/// «Подключиться» the login screen belongs to that hub (its own «Войти», no
/// Google / Telegram / Apple). Needs network, so it runs only when asked:
/// `CC_SELFHOST_HUB=code.example.com`.
final class HubConnectLinkUITests: XCTestCase {
    func testConnectLinkSwitchesToSelfHostedHub() throws {
        guard let raw = ProcessInfo.processInfo.environment["CC_SELFHOST_HUB"] else {
            throw XCTSkip("set CC_SELFHOST_HUB to a live external-edition hub host")
        }
        // A bare host means https; a full origin is taken as is (http only for
        // loopback — a local relay when the Simulator has no DNS).
        let origin = raw.contains("://") ? raw : "https://\(raw)"
        let parsed = try XCTUnwrap(URL(string: origin))
        let host = parsed.port.map { "\(parsed.host ?? ""):\($0)" } ?? (parsed.host ?? raw)
        let encoded = try XCTUnwrap(origin.addingPercentEncoding(withAllowedCharacters: .alphanumerics))
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchEnvironment = ["CC_HUB_URL": "https://code.acme.test", "CC_TOKEN": "",
                                 "CC_THEME": "light", "CC_HW_KEYBOARD": "false"]
        app.launch()
        dismissNotificationPrompt()

        let change = app.buttons["settings.changeServer"]
        XCTAssertTrue(change.waitForExistence(timeout: 15))
        capture(app, "1-login-default-hub")

        app.open(URL(string: "ccremote://connect?hub=\(encoded)")!)
        let alert = app.alerts.firstMatch
        XCTAssertTrue(alert.waitForExistence(timeout: 10))
        XCTAssertTrue(alert.label.contains(host), "alert names the proposed host: \(alert.label)")
        capture(app, "2-connect-prompt")
        alert.buttons["Подключиться"].tap()

        let row = app.staticTexts["Сервер: \(host)"]
        let switched = row.waitForExistence(timeout: 20)
        capture(app, "2b-after-connect")
        if !switched, app.alerts.firstMatch.exists {
            XCTFail("switch refused: \(app.alerts.firstMatch.label) — \(app.alerts.firstMatch.staticTexts.allElementsBoundByIndex.map(\.label))")
        }
        XCTAssertTrue(switched, "login screen shows the new server")
        let signIn = app.buttons["Войти"]
        XCTAssertTrue(signIn.waitForExistence(timeout: 20), "external hub shows its own «Войти»")
        XCTAssertFalse(app.buttons["Войти через Google"].exists)
        XCTAssertFalse(app.buttons["Войти через Telegram"].exists)
        capture(app, "3-login-selfhosted")

        change.tap()
        XCTAssertTrue(app.buttons["Сканировать QR-код"].waitForExistence(timeout: 10))
        capture(app, "4-server-sheet")
    }

    private func dismissNotificationPrompt() {
        let alert = XCUIApplication(bundleIdentifier: "com.apple.springboard").alerts.firstMatch
        if alert.waitForExistence(timeout: 3) {
            alert.buttons.matching(NSPredicate(format: "label IN %@",
                ["Allow", "Разрешить", "Don’t Allow", "Не разрешать"])).firstMatch.tap()
        }
    }

    private func capture(_ app: XCUIApplication, _ name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name; shot.lifetime = .keepAlways; add(shot)
    }
}
