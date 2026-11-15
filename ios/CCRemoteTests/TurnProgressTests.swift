import XCTest
@testable import CCRemoteKit

final class TurnProgressTests: XCTestCase {
    func testRuntimeTotalsReplaceSnapshotsWithoutEstimatingText() throws {
        var progress = TurnProgress(startedAt: Date(timeIntervalSince1970: 100))
        progress.receive(StreamEvent(kind: .assistant, text: String(repeating: "x", count: 10000)))
        XCTAssertNil(progress.totalTokens)
        let event = try JSONDecoder().decode(StreamEvent.self, from: Data(#"{"kind":"status","code":"turn_usage","data":{"totalTokens":48240}}"#.utf8))
        progress.receive(event)
        progress.receive(event)
        XCTAssertEqual(progress.totalTokens, 48240)
        progress.receive(StreamEvent(kind: .status, text: nil, code: "turn_usage", data: .init(totalTokens: 52300)))
        XCTAssertEqual(progress.totalTokens, 52300)
        progress.receive(StreamEvent(kind: .status, text: nil, code: "turn_usage", data: .init(totalTokens: -1)))
        XCTAssertEqual(progress.totalTokens, 52300)
        XCTAssertEqual(progress.elapsed(at: Date(timeIntervalSince1970: 99)), "0:00")
        XCTAssertEqual(progress.elapsed(at: Date(timeIntervalSince1970: 183)), "1:23")
        XCTAssertEqual(progress.elapsed(at: Date(timeIntervalSince1970: 3761)), "1:01:01")
    }

    @MainActor
    func testLiveLifecycleSteerIdleAndForeignRun() async {
        let h = ClientHarness()
        defer { h.clean() }
        await h.connect()
        let socket = h.sockets.last!
        let since = (Date().timeIntervalSince1970 - 83) * 1000
        socket.feed("""
        {"type":"snapshot","machines":[],"activeRuns":[{"runId":"r","machineId":"m","sessionId":"s","state":"working","since":\(since)}]}
        """)
        for _ in 0..<50 where h.client.activeRuns.isEmpty { await h.settle() }
        h.client.focusSession(machineId: "m", sessionId: "s")
        XCTAssertTrue(h.client.busy)
        let start = h.client.turnProgress!.startedAt
        XCTAssertEqual(start.timeIntervalSince1970, since / 1000, accuracy: 0.01)
        socket.feed(#"{"type":"stream","runId":"r","sessionId":"s","event":{"kind":"status","code":"turn_usage","data":{"totalTokens":2}}}"#)
        for _ in 0..<50 where h.client.turnProgress?.totalTokens != 2 { await h.settle() }
        XCTAssertEqual(h.client.turnProgress?.totalTokens, 2)
        // A fresh subscription replays its tail: count it once and keep time.
        h.client.connect(endpoint: h.endpoint, token: "alice")
        let reconnected = h.sockets.last!
        reconnected.feed("""
        {"type":"snapshot","machines":[],"activeRuns":[{"runId":"r","machineId":"m","sessionId":"s","state":"working","since":\(since)}]}
        """)
        for _ in 0..<50 where reconnected.frames(of: "subscribe").isEmpty { await h.settle() }
        reconnected.feed(#"{"type":"stream","runId":"r","sessionId":"s","event":{"kind":"status","code":"turn_usage","data":{"totalTokens":2}}}"#)
        for _ in 0..<50 where h.client.turnProgress?.totalTokens != 2 { await h.settle() }
        XCTAssertEqual(h.client.turnProgress?.startedAt, start)
        XCTAssertEqual(h.client.turnProgress?.totalTokens, 2)
        XCTAssertTrue(h.client.sendInput("Уточнение"))
        XCTAssertEqual(h.client.turnProgress?.startedAt, start)
        h.client.focusSession(machineId: "m", sessionId: "s")
        XCTAssertEqual(h.client.turnProgress?.totalTokens, 2)
        reconnected.feed(#"{"type":"stream","runId":"other","sessionId":"x","event":{"kind":"result"}}"#)
        await h.settle()
        XCTAssertTrue(h.client.busy)
        reconnected.feed(#"{"type":"stream","runId":"r","sessionId":"s","event":{"kind":"result"}}"#)
        for _ in 0..<50 where h.client.busy { await h.settle() }
        XCTAssertNil(h.client.turnProgress)
        XCTAssertTrue(h.client.sendInput("Следующий ответ"))
        XCTAssertNil(h.client.turnProgress?.totalTokens)
        XCTAssertGreaterThan(h.client.turnProgress!.startedAt, start)
        reconnected.feed(#"{"type":"activity","runs":[{"runId":"r","machineId":"m","sessionId":"s","state":"idle","since":1}]}"#)
        for _ in 0..<50 where h.client.busy { await h.settle() }
        XCTAssertFalse(h.client.busy)
        XCTAssertNil(h.client.turnProgress)
        h.client.focusSession(machineId: "m", sessionId: "other")
        XCTAssertNil(h.client.turnProgress)
    }
    @MainActor
    func testAuthoritativeTaskClockSurvivesApprovalAndNewSubscription() async {
        let h = ClientHarness()
        defer { h.clean() }
        await h.connect()
        let socket = h.sockets.last!
        let start = (Date().timeIntervalSince1970 - 600) * 1000
        let phase = start + 500_000
        func activity(_ state: String, _ task: Double) -> String {
            "{\"type\":\"activity\",\"runs\":[{\"runId\":\"r\",\"machineId\":\"m\",\"sessionId\":\"s\",\"state\":\"\(state)\",\"since\":\(phase),\"taskStartedAt\":\(task)}]}"
        }
        socket.feed(activity("working", start))
        for _ in 0..<50 where h.client.activeRuns.isEmpty { await h.settle() }
        h.client.focusSession(machineId: "m", sessionId: "s")
        XCTAssertEqual(h.client.turnProgress!.startedAt.timeIntervalSince1970, start / 1000, accuracy: 0.01)
        socket.feed(activity("needs_attention", start))
        for _ in 0..<10 { await h.settle() }
        h.client.focusSession(machineId: "m", sessionId: "other")
        h.client.focusSession(machineId: "m", sessionId: "s")
        XCTAssertEqual(h.client.turnProgress!.startedAt.timeIntervalSince1970, start / 1000, accuracy: 0.01)
        socket.feed(activity("working", start))
        for _ in 0..<10 { await h.settle() }
        XCTAssertEqual(h.client.turnProgress!.elapsed(at: Date(timeIntervalSince1970: start / 1000 + 601)), "10:01")
        socket.feed(activity("working", phase))
        for _ in 0..<10 { await h.settle() }
        XCTAssertEqual(h.client.turnProgress!.startedAt.timeIntervalSince1970, phase / 1000, accuracy: 0.01)
    }

}
