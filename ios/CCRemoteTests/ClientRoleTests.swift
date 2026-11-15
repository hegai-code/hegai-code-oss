import XCTest
@testable import CCRemoteKit

@MainActor
final class ClientRoleTests: XCTestCase {
    func testPaneNeitherLoadsNorOverwritesTheOutbox() async throws {
        let h = ClientHarness()
        defer { h.clean() }
        await h.connect()
        XCTAssertTrue(h.client.queuePending(machineId: "m", sessionId: "s", text: "primary"))
        let scope = h.client.storageScope
        let pane = h.makeClient(role: .pane)
        defer { pane.disconnect() }
        pane.connect(endpoint: h.endpoint, token: "alice")
        XCTAssertTrue(pane.pending.isEmpty)
        XCTAssertFalse(pane.queuePending(machineId: "m", sessionId: "s", text: "pane"))
        let store = OfflineOutboxStore(directory: ClientStorage(root: h.root).directory(scope))
        XCTAssertEqual(try store.load().map(\.text), ["primary"])
    }

    func testPrimaryLoadsOnlyAfterCredentialsAreSelected() async {
        let h = ClientHarness()
        defer { h.clean() }
        await h.connect()
        XCTAssertTrue(h.client.queuePending(machineId: "m", sessionId: "s", text: "queued"))
        h.client.disconnect()
        let second = h.makeClient()
        defer { second.disconnect() }
        XCTAssertTrue(second.pending.isEmpty)
        second.connect(endpoint: h.endpoint, token: "alice")
        XCTAssertEqual(second.pending.map(\.text), ["queued"])
    }
}
