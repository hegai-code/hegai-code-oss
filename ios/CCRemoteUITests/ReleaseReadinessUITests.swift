import XCTest

final class ReleaseReadinessUITests: XCTestCase {
    private func launch(settings: Bool = false) throws -> XCUIApplication {
        let data: Data
        do { data = try Data(contentsOf: URL(string: "http://127.0.0.1:18842/credentials")!) }
        catch { throw XCTSkip("Requires release-readiness-fixture.mjs and a throwaway hub") }
        let credentials = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: String])
        let app = XCUIApplication()
        app.launchEnvironment = ["CC_HUB_URL":"ws://127.0.0.1:18841/ui", "CC_TOKEN":try XCTUnwrap(credentials["token"]), "CC_THEME":"light", "CC_HW_KEYBOARD":"false", "CC_DRAWER":"0"]
        if settings { app.launchEnvironment["CC_SCREEN"] = "settings:account" }
        else { app.launchEnvironment["CC_OPEN"] = "\(credentials["machineId"]!)::sample-chat" }
        app.launch(); continueAfterFailure = false
        return app
    }
    private func reveal(_ element: XCUIElement, in app: XCUIApplication) {
        for _ in 0..<12 {
            if element.exists && element.isHittable { return }
            app.swipeUp()
        }
        XCTAssertTrue(element.isHittable)
    }
    private func capture(_ app: XCUIApplication, _ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot()); attachment.name=name; attachment.lifetime = .keepAlways; add(attachment)
    }
    private func sentCalls() throws -> Int {
        let data=try Data(contentsOf: URL(string:"http://127.0.0.1:18842/state")!)
        return try XCTUnwrap((JSONSerialization.jsonObject(with:data) as? [String:Int])?["calls"])
    }
    private func send(_ app: XCUIApplication) {
        app.buttons.matching(NSPredicate(format: "label == %@ OR label == %@", "Отправить", "Продолжить")).firstMatch.tap()
    }

    func testAIConsentPreservesDraftAndNeverAutomaticallySends() throws {
        let app=try launch(); defer { app.terminate() }
        let editor=app.textViews.firstMatch
        XCTAssertTrue(editor.waitForExistence(timeout:15))
        editor.tap(); editor.typeText("Private review draft")
        send(app)
        let decline=app.buttons["privacy.declineAI"]
        XCTAssertTrue(decline.waitForExistence(timeout:5))
        capture(app,"AI consent disclosure")
        reveal(decline,in:app); decline.tap()
        XCTAssertEqual(editor.value as? String,"Private review draft")
        XCTAssertEqual(try sentCalls(),0)
        send(app)
        let allow=app.buttons["privacy.allowAI"]
        reveal(allow,in:app); allow.tap()
        XCTAssertTrue(allow.waitForNonExistence(timeout:5))
        XCTAssertEqual(editor.value as? String,"Private review draft")
        XCTAssertEqual(try sentCalls(),0)
        send(app)
        XCTAssertTrue(app.staticTexts["Тестовое сообщение получено."].waitForExistence(timeout:10))
        XCTAssertEqual(try sentCalls(),1)
        capture(app,"Message sent only after explicit second tap")
    }

    func testAccountDeletionConfirmationAndReceipt() throws {
        let app=try launch(settings:true); defer { app.terminate() }
        let privacy=app.buttons["settings.privacy"]
        reveal(privacy,in:app); privacy.tap()
        let remove=app.buttons["settings.deleteAccount"]
        reveal(remove,in:app); remove.tap()
        let confirm=app.buttons["account.confirmDelete"]
        XCTAssertTrue(confirm.waitForExistence(timeout:10))
        XCTAssertFalse(confirm.isEnabled)
        let input=app.textFields["account.deleteConfirmation"]
        reveal(input,in:app)
        input.tap(); input.typeText("УДАЛИТЬ\n")
        capture(app,"Account deletion explicit confirmation")
        reveal(confirm,in:app); confirm.tap()
        let pending=app.staticTexts["Удаление аккаунта выполняется"]
        XCTAssertTrue(pending.waitForExistence(timeout:10))
        capture(app,"Signed out with deletion receipt")
        // Apple's native button is present; real authorization is a separate
        // device/provider test, never faked by this fixture.
        XCTAssertTrue(app.buttons["auth.apple"].exists)
    }
}
