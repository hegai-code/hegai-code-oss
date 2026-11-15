import XCTest
@testable import CCRemoteKit

@MainActor
final class PushDecisionSenderTests: XCTestCase {
    private var decision: ClientMessage {
        .toolDecision(runId: "r", requestId: "q", allow: true,
                      updatedInput: nil, permissionMode: nil, message: nil)
    }
    func testSilentHandshakeTimesOutAndClosesSocket() async {
        let socket = TestSocket()
        let failed = expectation(description: "timeout")
        let sender = PushDecisionSender(factory: { _, _, _ in socket }, grace: NoBackgroundGrace(), timeout: .milliseconds(20))
        sender.send(decision, endpoint: "ws://test.invalid/ui", token: "alice", workspace: "team") { _ in failed.fulfill() }
        await fulfillment(of: [failed], timeout: 1)
        XCTAssertTrue(socket.cancelled)
        XCTAssertTrue(socket.sent.isEmpty)
    }
    func testSigningOutCancelsBeforeAnyDecisionIsSent() async {
        let socket = TestSocket()
        let sender = PushDecisionSender(factory: { _, _, _ in socket }, grace: NoBackgroundGrace())
        sender.send(decision, endpoint: "ws://test.invalid/ui", token: "alice", workspace: nil) { _ in XCTFail("cancel is not an error") }
        await Task.yield()
        sender.cancelAll()
        socket.feed(#"{"type":"snapshot","machines":[]}"#)
        for _ in 0..<20 { await Task.yield() }
        XCTAssertTrue(socket.cancelled)
        XCTAssertTrue(socket.sent.isEmpty)
    }
    func testWorkspaceIsIncludedAndDecisionWaitsForAuthenticatedFrame() async {
        let socket = TestSocket()
        var url: URL?
        let sender = PushDecisionSender(factory: { target, _, _ in url = target; return socket }, grace: NoBackgroundGrace())
        defer { sender.cancelAll() }
        sender.send(decision, endpoint: "ws://test.invalid/ui", token: "alice", workspace: "team") { _ in XCTFail() }
        await Task.yield()
        XCTAssertTrue(socket.sent.isEmpty)
        XCTAssertTrue(url?.query?.contains("workspaceId=team") == true)
        socket.feed(#"{"type":"snapshot","machines":[]}"#)
        for _ in 0..<30 { await Task.yield() }
        XCTAssertEqual(socket.frames(of: "tool_decision").count, 1)
    }
}
