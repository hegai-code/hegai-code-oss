import XCTest
@testable import CCRemoteKit

@MainActor
final class SessionModelTests: XCTestCase {
    func testDormantChangeWaitsForRuntimeAndReadbackBeforeFirstInput() async {
        let h = ClientHarness()
        defer { h.clean() }
        await h.connect()
        let socket = h.sockets.last!
        h.client.focusSession(machineId: "m", sessionId: "s")
        XCTAssertTrue(h.client.changeSessionModel(machineId: "m", sessionId: "s", model: "sol"))
        XCTAssertTrue(h.client.isChangingModel)
        XCTAssertNil(socket.frames(of: "open").first?["message"])
        XCTAssertTrue(socket.frames(of: "set_model").isEmpty)
        XCTAssertFalse(h.client.sendInput("first"))
        socket.feed(#"{"type":"opened","machineId":"m","sessionId":"s","runId":"r"}"#)
        for _ in 0..<100 where h.client.active?.runId == nil { await h.settle() }
        XCTAssertTrue(socket.frames(of: "set_model").isEmpty)
        socket.feed(#"{"type":"run_settings","runId":"r","sessionId":"s","activeModel":"astra"}"#)
        for _ in 0..<100 where socket.frames(of: "set_model").isEmpty { await h.settle() }
        XCTAssertEqual(socket.frames(of: "set_model").first?["model"] as? String, "sol")
        XCTAssertFalse(h.client.sendInput("first"))
        socket.feed(#"{"type":"run_settings","runId":"other","sessionId":"s","model":"sol"}"#)
        await h.settle()
        XCTAssertTrue(h.client.isChangingModel)
        socket.feed(#"{"type":"run_settings","runId":"r","sessionId":"s","model":"sol","activeModel":"astra"}"#)
        for _ in 0..<100 where h.client.isChangingModel { await h.settle() }
        XCTAssertFalse(h.client.isChangingModel)
        XCTAssertTrue(h.client.sendInput("first"))
        XCTAssertEqual(socket.frames(of: "input").count, 1)
        XCTAssertEqual(socket.frames(of: "set_model").count, 1)
        XCTAssertEqual(h.client.sessionSettings.settings(machineId: "m", sessionId: "s")?.model, "sol")
    }

    func testSwitchingFocusCancelsChoiceAndNeverAppliesItToAnotherSession() async {
        let h = ClientHarness()
        defer { h.clean() }
        await h.connect()
        let socket = h.sockets.last!
        h.client.focusSession(machineId: "m", sessionId: "s")
        h.client.changeSessionModel(machineId: "m", sessionId: "s", model: "sol")
        h.client.focusSession(machineId: "m", sessionId: "other")
        XCTAssertFalse(h.client.isChangingModel)
        socket.feed(#"{"type":"opened","machineId":"m","sessionId":"s","runId":"r"}"#)
        socket.feed(#"{"type":"run_settings","runId":"r","sessionId":"s","model":"astra"}"#)
        await h.settle()
        XCTAssertTrue(socket.frames(of: "set_model").isEmpty)
        XCTAssertEqual(h.client.active?.sessionId, "other")
        XCTAssertNil(h.client.runSettings)
    }

    func testCurrentDefaultNeedsNoControlOrNewAcknowledgement() async {
        let h = ClientHarness()
        defer { h.clean() }
        await h.connect()
        h.client.focusSession(machineId: "m", sessionId: "s")
        h.client.changeSessionModel(machineId: "m", sessionId: "s", model: "default")
        let socket = h.sockets.last!
        socket.feed(#"{"type":"opened","machineId":"m","sessionId":"s","runId":"r"}"#)
        socket.feed(#"{"type":"run_settings","runId":"r","sessionId":"s","activeModel":"astra"}"#)
        for _ in 0..<100 where h.client.isChangingModel { await h.settle() }
        XCTAssertFalse(h.client.isChangingModel)
        XCTAssertTrue(socket.frames(of: "set_model").isEmpty)
        XCTAssertTrue(h.client.sendInput("first"))
        h.client.changeSessionModel(machineId: "m", sessionId: "s", model: nil)
        XCTAssertFalse(h.client.isChangingModel)
    }

    func testFailureAndDisconnectReleasePickerWithoutInventingSuccess() async {
        let h = ClientHarness()
        defer { h.clean() }
        await h.connect()
        let socket = h.sockets.last!
        h.client.focusSession(machineId: "m", sessionId: "s")
        socket.feed(#"{"type":"opened","machineId":"m","sessionId":"s","runId":"r"}"#)
        socket.feed(#"{"type":"run_settings","runId":"r","sessionId":"s","model":"astra"}"#)
        for _ in 0..<100 where h.client.runSettings == nil { await h.settle() }
        h.client.changeSessionModel(machineId: "m", sessionId: "s", model: "astra")
        XCTAssertFalse(h.client.isChangingModel)
        XCTAssertTrue(socket.frames(of: "set_model").isEmpty)
        h.client.changeSessionModel(machineId: "m", sessionId: "s", model: "sol")
        socket.feed(#"{"type":"stream","runId":"r","sessionId":"s","event":{"kind":"status","code":"control_failed","text":"model unavailable"}} "#)
        for _ in 0..<100 where h.client.isChangingModel { await h.settle() }
        XCTAssertFalse(h.client.isChangingModel)
        XCTAssertEqual(h.client.runSettings?.model, "astra")
        XCTAssertNotNil(h.client.lastError)
        h.client.changeSessionModel(machineId: "m", sessionId: "s", model: "sol")
        h.client.disconnect()
        XCTAssertFalse(h.client.isChangingModel)
        XCTAssertTrue(socket.frames(of: "input").isEmpty)
    }

    func testRememberedSettingsAreScopedAndNeverSentOnFocus() async {
        let h = ClientHarness()
        defer { h.clean() }
        await h.connect()
        h.client.sessionSettings.remember(.init(model: "sol", activeModel: "sol", effort: .high, ultracode: false),
                                         machineId: "m", sessionId: "s")
        h.client.focusSession(machineId: "m", sessionId: "s")
        XCTAssertTrue(h.sockets.last!.frames(of: "set_model").isEmpty)
        XCTAssertNil(h.client.sessionSettings.settings(machineId: "other", sessionId: "s"))
        await h.connect(token: "bob")
        XCTAssertNil(h.client.sessionSettings.settings(machineId: "m", sessionId: "s"))
        await h.connect(token: "alice")
        XCTAssertEqual(h.client.sessionSettings.settings(machineId: "m", sessionId: "s")?.model, "sol")
    }

    func testModelNamesResolveDefaultAndPreserveUnknownExplicitIds() throws {
        let models = try JSONDecoder().decode([ModelInfoLite].self, from: Data(#"""
        [{"id":"default","name":"По умолчанию","resolved":"astra-v1"},
         {"id":"astra","name":"Astra","resolved":"astra-v1"},
         {"id":"sol","name":"Sol","resolved":"sol-v1"}]
        """#.utf8))
        XCTAssertEqual(ModelLabel.name(models: models, model: "default", activeModel: "sol-v1"), "Sol")
        XCTAssertEqual(ModelLabel.name(models: models, model: nil), "Astra")
        XCTAssertEqual(ModelLabel.name(models: models, model: "sol", activeModel: "astra-v1"), "Sol")
        XCTAssertEqual(ModelLabel.name(models: models, model: "custom"), "custom")
        XCTAssertEqual(ModelLabel.name(models: [], model: nil), "Модель аккаунта")
    }
}
