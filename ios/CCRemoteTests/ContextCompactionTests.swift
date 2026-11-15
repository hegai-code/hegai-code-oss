import XCTest
@testable import CCRemoteKit

@MainActor
final class ContextCompactionTests: XCTestCase {
    func testRepeatedStartsUpdateOneRussianLineAndDoneBeginsNextCycle() async throws {
        let h = ClientHarness(); defer { h.clean() }; await h.connect()
        let socket = h.sockets.last!
        socket.feed(#"{"type":"snapshot","machines":[],"activeRuns":[{"runId":"r","machineId":"m","sessionId":"s","state":"idle","since":1}]}"#)
        for _ in 0..<100 where h.client.activeRuns.isEmpty { await h.settle() }
        h.client.focusSession(machineId: "m", sessionId: "s")
        func event(_ code: String, _ text: String) throws {
            let frame: [String: Any] = ["type": "stream", "runId": "r", "sessionId": "s",
                "event": ["kind": "status", "code": code, "text": text]]
            socket.feed(String(decoding: try JSONSerialization.data(withJSONObject: frame), as: UTF8.self))
        }
        try event("compact_started", "compacting context… (queued behind the current turn)")
        await h.settle()
        XCTAssertEqual(h.client.lines.first?.text, "Сжимаю контекст — после текущего хода…")
        let firstID = h.client.lines.first?.id
        try event("progress", "Сохраняю")
        try event("compact_started", "compacting context…")
        try event("compact_started", "compacting context…")
        await h.settle()
        XCTAssertEqual(h.client.lines.filter { $0.code == "compact_started" }.count, 1)
        XCTAssertEqual(h.client.lines.first?.id, firstID)
        XCTAssertEqual(h.client.lines.first?.text, "Сжимаю контекст…")
        XCTAssertEqual(h.client.compactionState, .running)
        try event("compact_done", "context compacted: 746k → 10k tokens")
        await h.settle()
        XCTAssertEqual(h.client.lines.last?.text, "контекст сжат: 746k → 10k токенов")
        XCTAssertEqual(h.client.compactionState, .completed)
        try event("compact_started", "compacting")
        try event("compact_failed", "⚠ compaction failed: сеть недоступна")
        await h.settle()
        XCTAssertEqual(h.client.lines.filter { $0.code == "compact_started" }.count, 2)
        XCTAssertEqual(h.client.lines.last?.text, "Не удалось сжать контекст: сеть недоступна")
        XCTAssertEqual(h.client.compactionState, .failed)
        XCTAssertEqual(TranscriptUpdates.compactionWords(code: "compact_done", text: "done"), "контекст сжат")
        XCTAssertEqual(TranscriptUpdates.compactionWords(code: "compact_done", text: "context auto-compacted: 746k → 10k tokens"),
                       "контекст сжат: 746k → 10k токенов")
        try event("compact_started", "queued")
        await h.settle()
        XCTAssertEqual(h.client.lines.filter { $0.code == "compact_started" }.count, 3)
    }

    func testSendFailureAllowsRetryAndSwitchingRunClearsPending() async {
        let h = ClientHarness()
        defer { h.clean() }
        await h.connect()
        let socket = h.sockets.last!
        socket.feed(#"{"type":"snapshot","machines":[],"activeRuns":[{"runId":"r","machineId":"m","sessionId":"s","state":"idle","since":1}]}"#)
        for _ in 0..<50 where h.client.activeRuns.isEmpty { await h.settle() }
        h.client.focusSession(machineId: "m", sessionId: "s")
        socket.autoComplete = false
        h.client.compact()
        socket.completions.last?(ClientError.connectionClosed)
        await h.settle()
        XCTAssertEqual(h.client.compactionState, .failed)
        h.client.compact()
        XCTAssertEqual(h.client.compactionState, .requested)
        h.client.focusSession(machineId: "m", sessionId: "other")
        XCTAssertEqual(h.client.compactionState, .idle)
        socket.feed(#"{"type":"stream","runId":"r","sessionId":"s","event":{"kind":"status","code":"compact_done"}}"#)
        await h.settle()
        XCTAssertEqual(h.client.compactionState, .idle)
    }

    func testCompactionWaitsForRuntimeAndIgnoresOtherRuns() async {
        let h = ClientHarness()
        defer { h.clean() }
        await h.connect()
        let socket = h.sockets.last!
        socket.feed(#"{"type":"snapshot","machines":[],"activeRuns":[{"runId":"r","machineId":"m","sessionId":"s","state":"idle","since":1}]}"#)
        for _ in 0..<50 where h.client.activeRuns.isEmpty { await h.settle() }
        h.client.focusSession(machineId: "m", sessionId: "s")
        XCTAssertEqual(h.client.active?.runId, "r")
        h.client.compact()
        h.client.compact()
        XCTAssertEqual(socket.frames(of: "compact").count, 1)
        XCTAssertEqual(h.client.compactionState, .requested)
        socket.feed(#"{"type":"stream","runId":"other","sessionId":"x","event":{"kind":"status","code":"compact_done","text":"context compacted"}}"#)
        await h.settle()
        XCTAssertEqual(h.client.compactionState, .requested)
        socket.feed(#"{"type":"stream","runId":"r","sessionId":"s","event":{"kind":"status","code":"compact_started","text":"compacting"}}"#)
        for _ in 0..<50 where h.client.compactionState != .running { await h.settle() }
        XCTAssertEqual(h.client.compactionState, .running)
        socket.feed(#"{"type":"stream","runId":"r","sessionId":"s","event":{"kind":"status","code":"compact_done","text":"done"}}"#)
        for _ in 0..<50 where h.client.compactionState != .completed { await h.settle() }
        XCTAssertEqual(h.client.compactionState, .completed)
        h.client.compact()
        XCTAssertEqual(socket.frames(of: "compact").count, 2)
        socket.feed(#"{"type":"stream","runId":"r","sessionId":"s","event":{"kind":"status","code":"compact_failed","text":"failed"}}"#)
        for _ in 0..<50 where h.client.compactionState != .failed { await h.settle() }
        XCTAssertEqual(h.client.compactionState, .failed)
        h.client.unfocus()
        XCTAssertEqual(h.client.compactionState, .idle)
    }
}
