import XCTest
@testable import CCRemoteKit

@MainActor
final class AIDataConsentTests: XCTestCase {
    private func verified(_ h: ClientHarness, user: String = "alice") async {
        h.sockets.last!.feed("""
        {"type":"snapshot","machines":[],"viewer":{"userId":"\(user)","platformAdmin":false,"workspace":{"workspaceId":"w","name":"W","kind":"personal","role":"owner"},"workspaces":[]}}
        """)
        for _ in 0..<100 where h.client.viewer?.userId != user { await h.settle() }
    }

    func testNoAIFrameOrAutomaticEnrichmentBeforeConsent() async throws {
        let h = ClientHarness(); defer { h.clean() }
        h.client.requiresAIConsent = true
        await h.connect(); await verified(h)
        XCTAssertFalse(h.client.newSession(machineId: "m", cwd: "/repo", message: "private draft"))
        XCTAssertTrue(h.client.aiConsentRequested)
        XCTAssertTrue(h.sockets.last!.frames(of: "new_session").isEmpty)
        let enrichment = try await h.client.enrich(machineId: "m", sessionId: "s", source: "codex", uuid: "u", text: "private reply")
        XCTAssertNil(enrichment)
        XCTAssertTrue(h.sockets.last!.frames(of: "enrich_request").isEmpty)
        XCTAssertTrue(h.client.lines.isEmpty)
        XCTAssertFalse(h.client.queuePending(machineId: "m", sessionId: "s", text: "private draft"),
                       "consent refusal must not masquerade as an offline send and clear the composer")
        XCTAssertTrue(h.client.pendingFor(machineId: "m", sessionId: "s").isEmpty)
        try h.client.acceptAIDataSharing()
        XCTAssertTrue(h.sockets.last!.frames(of: "new_session").isEmpty, "agreement must not auto-send")
        await verified(h)
        XCTAssertTrue(h.client.pendingFor(machineId: "m", sessionId: "s").isEmpty)
        XCTAssertTrue(h.sockets.last!.frames(of: "input").isEmpty)
        XCTAssertTrue(h.client.newSession(machineId: "m", cwd: "/repo", message: "private draft"))
        XCTAssertEqual(h.sockets.last!.frames(of: "new_session").count, 1)
        try h.client.withdrawAIDataSharing()
        XCTAssertFalse(h.client.newSession(machineId: "m", cwd: "/repo", message: "second draft"))
        XCTAssertEqual(h.sockets.last!.frames(of: "new_session").count, 1)
    }

    func testConsentPersistsForVerifiedAccountButNotAnotherAccount() async throws {
        let h = ClientHarness(); defer { h.clean() }
        h.client.requiresAIConsent = true
        await h.connect(); await verified(h)
        try h.client.acceptAIDataSharing()
        h.client.disconnect()
        await h.connect(); await verified(h)
        XCTAssertTrue(h.client.aiDataSharingAllowed)
        h.client.disconnect()
        h.client.connect(endpoint: h.endpoint, token: "bob")
        await h.settle(); await verified(h, user: "bob")
        XCTAssertFalse(h.client.aiDataSharingAllowed)
    }

    func testCompactionRefusalDoesNotLeavePendingState() async throws {
        let h = ClientHarness(); defer { h.clean() }
        h.client.requiresAIConsent = true
        await h.connect(); await verified(h)
        h.sockets.last!.feed(#"{"type":"snapshot","machines":[],"activeRuns":[{"runId":"r","machineId":"m","sessionId":"s","state":"idle","since":1}],"viewer":{"userId":"alice","platformAdmin":false,"workspace":{"workspaceId":"w","name":"W","kind":"personal","role":"owner"},"workspaces":[]}}"#)
        for _ in 0..<100 where h.client.activeRuns.isEmpty { await h.settle() }
        h.client.focusSession(machineId: "m", sessionId: "s")
        XCTAssertNotNil(h.client.active)
        h.client.compact()
        XCTAssertEqual(h.client.compactionState, .idle)
        XCTAssertTrue(h.client.aiConsentRequested)
        XCTAssertTrue(h.sockets.last!.frames(of: "compact").isEmpty)
        try h.client.acceptAIDataSharing()
        h.client.compact()
        XCTAssertEqual(h.client.compactionState, .requested)
        XCTAssertEqual(h.sockets.last!.frames(of: "compact").count, 1)
    }

    func testUnknownIdentityCannotGrantConsentAndPushCannotBypassIt() async {
        let h = ClientHarness(); defer { h.clean() }
        h.client.requiresAIConsent = true
        await h.connect()
        XCTAssertThrowsError(try h.client.acceptAIDataSharing())
        let sockets = h.sockets.count
        h.client.decidePush(runId: "r", requestId: "q", allow: true, endpoint: h.endpoint, token: "alice")
        XCTAssertEqual(h.sockets.count, sockets)
        XCTAssertTrue(h.client.aiConsentRequested)
    }
    func testAccountErasureRetiresCachesWithoutDeletingAnotherAccount() async throws {
        let h = ClientHarness(); defer { h.clean() }
        await h.connect(token: "bob"); await verified(h, user: "bob")
        let bobScope = h.client.storageScope
        XCTAssertTrue(h.client.queuePending(machineId: "m", sessionId: "s", text: "Bob draft"))
        h.client.disconnect()
        await h.connect(); await verified(h)
        let aliceScope = h.client.storageScope
        try h.client.acceptAIDataSharing()
        XCTAssertTrue(h.client.queuePending(machineId: "m", sessionId: "s", text: "Alice draft"))
        let oldCache = h.client.transcripts
        try await h.client.eraseLocalAccountData()
        await oldCache.write("late", payload: .object([:]), lastModified: 1)
        await oldCache.flush()
        let accounts = h.root.appendingPathComponent("Accounts")
        XCTAssertFalse(FileManager.default.fileExists(atPath: accounts.appendingPathComponent(aliceScope).path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: accounts.appendingPathComponent(bobScope).path))
        let storage = ClientStorage(root: h.root)
        XCTAssertTrue(storage.scope(endpoint: h.endpoint, token: "alice", workspace: nil).hasPrefix("credential-"))
        await h.connect(token: "bob"); await verified(h, user: "bob")
        XCTAssertEqual(h.client.pendingFor(machineId: "m", sessionId: "s").map(\.text), ["Bob draft"])
    }

}
