import XCTest
@testable import CCRemoteKit

final class UserTurnTests: XCTestCase {
    func testOldestEchoConfirmedAndDuplicateIgnored() {
        var lines = [TranscriptLine(id: 1, kind: .user, text: " Да \n"),
                     TranscriptLine(id: 2, kind: .user, text: "Да")]
        for _ in 0..<2 {
            TranscriptUpdates.userTurn(&lines, id: 3, turnId: "one", text: "Да", truncated: false, ts: 10, images: 0, files: [])
        }
        XCTAssertEqual(lines.map(\.id), [1, 2]); XCTAssertEqual(lines.map(\.turnId), ["one", nil])
        TranscriptUpdates.userTurn(&lines, id: 4, turnId: "two", text: "Да", truncated: false, ts: 20, images: 0, files: [])
        XCTAssertEqual(lines.map(\.turnId), ["one", "two"])
    }

    func testForeignLongTurnEmptyTurnAndAttachments() {
        var lines: [TranscriptLine] = []
        TranscriptUpdates.userTurn(&lines, id: 1, turnId: "empty", text: " \n", truncated: false, ts: nil, images: 0, files: [])
        XCTAssertTrue(lines.isEmpty)
        TranscriptUpdates.userTurn(&lines, id: 2, turnId: "remote", text: "Начало", truncated: true, ts: 123, images: 0, files: [])
        XCTAssertEqual(lines.first?.text, "Начало…"); XCTAssertEqual(lines.first?.ts, 123)
        XCTAssertEqual(lines.first?.truncated, true)
        TranscriptUpdates.userTurn(&lines, id: 3, turnId: "files", text: "", truncated: false, ts: nil, images: 2, files: ["plan.md"])
        XCTAssertEqual(lines.last?.text, "[2 картинки, plan.md]")
        XCTAssertNotNil(lines.last?.ts)
        XCTAssertEqual(TranscriptLine.attachmentLabel(images: 1, files: []), "[картинка]")
    }

    func testLongLocalEchoAndPhotoOnlyKeepBytesAndIdentity() {
        let full = String(repeating: "Ж", count: 20_000)
        let photo = ImageAttachment(mediaType: "image/png", data: Data([1, 2, 3]))
        var lines = [TranscriptLine(id: 1, kind: .user, text: full, ts: 1),
                     TranscriptLine(id: 2, kind: .user, text: "", images: [photo], ts: 2)]
        TranscriptUpdates.userTurn(&lines, id: 3, turnId: "paste", text: String(full.prefix(16_384)), truncated: true, ts: 3, images: 0, files: [])
        TranscriptUpdates.userTurn(&lines, id: 4, turnId: "photo", text: "", truncated: false, ts: 4, images: 1, files: [])
        XCTAssertEqual(lines.count, 2); XCTAssertEqual(lines.map(\.id), [1, 2])
        XCTAssertEqual(lines[0].text, full); XCTAssertFalse(lines[0].truncated)
        XCTAssertEqual(lines[1].images, [photo]); XCTAssertEqual(lines[1].text, "")
        XCTAssertEqual(lines.map(\.turnId), ["paste", "photo"])
        TranscriptUpdates.userTurn(&lines, id: 5, turnId: "otherPhoto", text: "", truncated: false, ts: 5, images: 2, files: [])
        XCTAssertEqual(lines.count, 3)
    }

    func testReplayKeepsSteerInWireOrderAndMatchesIdenticalPendingFromEnd() {
        let echo = TranscriptLine(id: 7, kind: .user, text: "Да", ts: 200)
        var replay: [TranscriptLine] = []
        TranscriptUpdates.userTurn(&replay, id: 10, turnId: "first", text: "Да", truncated: false, ts: 100, images: 0, files: [])
        replay.append(TranscriptLine(id: 11, kind: .assistant, text: "Ответ"))
        TranscriptUpdates.userTurn(&replay, id: 12, turnId: "steer", text: "Да", truncated: false, ts: 201, images: 0, files: [])
        let merged = TranscriptUpdates.finishReplay(lines: replay, echoes: [echo], pendingIDs: [7])
        XCTAssertEqual(merged.map(\.text), ["Да", "Ответ", "Да"])
        XCTAssertEqual(merged.map(\.id), [10, 11, 7]); XCTAssertEqual(merged.last?.turnId, "steer")
        let unmatched = TranscriptLine(id: 8, kind: .user, text: "Ещё")
        XCTAssertEqual(TranscriptUpdates.finishReplay(lines: replay, echoes: [echo, unmatched], pendingIDs: [7, 8]).last?.id, unmatched.id)
    }

    /// 10.10.2026, web (shop-app): a question sent mid-turn, then a reconnect.
    /// The web kept the question at the head and the replay put the whole turn
    /// under it. Here the replay is rebuilt and the kept question lands at its
    /// wire position, once.
    @MainActor
    func testMidTurnQuestionKeptAcrossReconnectLandsInTurnOnce() {
        let before = [TranscriptLine(id: 1, kind: .user, text: "сделай аудит", ts: 100, turnId: "u1"),
                      TranscriptLine(id: 2, kind: .tool_use, text: "Agent"),
                      TranscriptLine(id: 3, kind: .user, text: "а по апи есть доступ?", ts: 200, turnId: "u2")]
        let echoes = before.filter { $0.kind == .user }
        let pending = Set(CentralClient.keepUnansweredTail(before).map(\.id))
        XCTAssertEqual(pending, [3])
        var replay: [TranscriptLine] = []
        TranscriptUpdates.userTurn(&replay, id: 10, turnId: "u1", text: "сделай аудит", truncated: false,
                                   ts: 100, images: 0, files: [], matchEcho: false)
        replay.append(TranscriptLine(id: 11, kind: .tool_use, text: "Agent"))
        TranscriptUpdates.userTurn(&replay, id: 12, turnId: "u2", text: "а по апи есть доступ?", truncated: false,
                                   ts: 200, images: 0, files: [], matchEcho: false)
        replay.append(TranscriptLine(id: 13, kind: .tool_use, text: "Bash"))
        let merged = TranscriptUpdates.finishReplay(lines: replay, echoes: echoes, pendingIDs: pending)
        XCTAssertEqual(merged.map(\.text), ["сделай аудит", "Agent", "а по апи есть доступ?", "Bash"])
        XCTAssertEqual(merged.filter { $0.kind == .user }.map(\.turnId), ["u1", "u2"])
    }

    /// Same, but the question was still an unconfirmed echo when the link dropped.
    @MainActor
    func testUnconfirmedMidTurnEchoKeptAcrossReconnectLandsInTurnOnce() {
        let before = [TranscriptLine(id: 1, kind: .user, text: "сделай аудит", ts: 100, turnId: "u1"),
                      TranscriptLine(id: 2, kind: .tool_use, text: "Agent"),
                      TranscriptLine(id: 3, kind: .user, text: "а по апи?", ts: 200)]
        var replay: [TranscriptLine] = []
        TranscriptUpdates.userTurn(&replay, id: 10, turnId: "u1", text: "сделай аудит", truncated: false,
                                   ts: 100, images: 0, files: [], matchEcho: false)
        replay.append(TranscriptLine(id: 11, kind: .tool_use, text: "Agent"))
        TranscriptUpdates.userTurn(&replay, id: 12, turnId: "u2", text: "а по апи?", truncated: false,
                                   ts: 201, images: 0, files: [], matchEcho: false)
        let merged = TranscriptUpdates.finishReplay(lines: replay, echoes: before.filter { $0.kind == .user },
                                                    pendingIDs: Set(CentralClient.keepUnansweredTail(before).map(\.id)))
        XCTAssertEqual(merged.map(\.text), ["сделай аудит", "Agent", "а по апи?"])
        XCTAssertEqual(merged.last?.id, 3); XCTAssertEqual(merged.last?.turnId, "u2")
    }

    func testConfirmedFullLocalMessageSurvivesTruncatedReplay() {
        let full = String(repeating: "x", count: 20_000)
        let echo = TranscriptLine(id: 1, kind: .user, text: full, turnId: "u")
        var replay: [TranscriptLine] = []
        TranscriptUpdates.userTurn(&replay, id: 2, turnId: "u", text: String(full.prefix(16_384)), truncated: true, ts: 1, images: 0, files: [])
        let result = TranscriptUpdates.finishReplay(lines: replay, echoes: [echo], pendingIDs: [])
        XCTAssertEqual(result.first?.text, full); XCTAssertEqual(result.first?.id, 1)
        XCTAssertEqual(result.first?.truncated, false)
    }

    func testReplayReservesKnownTurnsAndEachPendingEchoConsumesOnePosition() {
        let first = TranscriptLine(id: 1, kind: .user, text: "Да")
        let second = TranscriptLine(id: 2, kind: .user, text: "Да")
        let replay = [TranscriptLine(id: 10, kind: .user, text: "Да", turnId: "A"),
                      TranscriptLine(id: 11, kind: .user, text: "Да", turnId: "B")]
        let result = TranscriptUpdates.finishReplay(lines: replay, echoes: [first, second], pendingIDs: [1, 2])
        XCTAssertEqual(result.map(\.id), [1, 2]); XCTAssertEqual(result.map(\.turnId), ["A", "B"])
        var known = first; known.turnId = "A"
        let stillPending = TranscriptUpdates.finishReplay(lines: [replay[0]], echoes: [known, second], pendingIDs: [2])
        XCTAssertEqual(stillPending.map(\.id), [1, 2]); XCTAssertNil(stillPending.last?.turnId)
    }

    func testLiteralAttachmentCaptionDoesNotConfirmPhotoOnlyTurn() {
        let photo = ImageAttachment(mediaType: "image/png", data: Data([1]))
        for (caption, announced) in [("[картинка]", ""), ("", "[картинка]")] {
            var lines = [TranscriptLine(id: 1, kind: .user, text: caption, images: [photo])]
            TranscriptUpdates.userTurn(&lines, id: 2, turnId: "other", text: announced, truncated: false, ts: 1, images: 1, files: [])
            XCTAssertEqual(lines.count, 2); XCTAssertNil(lines[0].turnId)
        }
    }
}

@MainActor
final class UserTurnClientTests: XCTestCase {
    func testReplayGapMovesLateConfirmedSteerAfterRemainingBacklog() async throws {
        let h = ClientHarness(); defer { h.clean() }; await h.connect()
        let socket = h.sockets.last!
        socket.feed(#"{"type":"snapshot","machines":[],"activeRuns":[{"runId":"r","machineId":"m","sessionId":"s","state":"working","since":1}]}"#)
        for _ in 0..<100 where h.client.activeRuns.isEmpty { await h.settle() }
        h.client.focusSession(machineId: "m", sessionId: "s")
        XCTAssertTrue(h.client.sendInput("Уточнение"))
        socket.feed(#"{"type":"user_turn","runId":"r","turnId":"steer","text":"Уточнение"}"#)
        await h.settle()
        let localID = h.client.lines.first?.id
        socket.feed(#"{"type":"opened","runId":"r","machineId":"m","sessionId":"s"}"#)
        socket.feed(#"{"type":"user_turn","runId":"r","turnId":"first","text":"Начальный вопрос"}"#)
        socket.feed(#"{"type":"stream","runId":"r","sessionId":"s","event":{"kind":"partial","text":"Начало "}}"#)
        try await Task.sleep(for: .seconds(CentralClient.replayMaxHold + 0.1))
        XCTAssertEqual(h.client.lines.last?.text, "Уточнение")
        socket.feed(#"{"type":"stream","runId":"r","sessionId":"s","event":{"kind":"partial","text":"ответа"}}"#)
        socket.feed(#"{"type":"stream","runId":"r","sessionId":"s","event":{"kind":"assistant","text":"Начало ответа"}}"#)
        socket.feed(#"{"type":"user_turn","runId":"r","turnId":"steer","text":"Уточнение"}"#)
        await h.settle()
        XCTAssertEqual(h.client.lines.map(\.text), ["Начальный вопрос", "Начало ответа", "Уточнение"])
        XCTAssertFalse(h.client.lines.contains { $0.streaming })
        XCTAssertEqual(h.client.lines.last?.id, localID)
    }

    /// The backlog shares the socket with the rest of the world. A history
    /// read's `rpc_response` or a fleet `activity` between its frames used to
    /// publish the stage early, and the rest of the turn then landed frame by
    /// frame — the steps played back on every open (24.10.2026).
    func testUnrelatedFramesMidReplayDoNotPublishTheStageEarly() async throws {
        let h = ClientHarness(); defer { h.clean() }; await h.connect()
        let socket = h.sockets.last!
        let working = #"{"type":"activity","runs":[{"runId":"r","machineId":"m","sessionId":"s","state":"working","since":1}]}"#
        socket.feed(#"{"type":"snapshot","machines":[],"activeRuns":[{"runId":"r","machineId":"m","sessionId":"s","state":"working","since":1}]}"#)
        for _ in 0..<100 where h.client.activeRuns.isEmpty { await h.settle() }
        h.client.focusSession(machineId: "m", sessionId: "s")
        socket.feed(#"{"type":"opened","runId":"r","machineId":"m","sessionId":"s"}"#)
        socket.feed(#"{"type":"user_turn","runId":"r","turnId":"u","text":"Вопрос"}"#)
        socket.feed(#"{"type":"stream","runId":"r","sessionId":"s","event":{"kind":"tool_use","text":"Read a.md"}}"#)
        socket.feed(#"{"type":"rpc_response","requestId":"nobody","ok":true,"result":{}}"#)
        socket.feed(working)
        socket.feed(#"{"type":"stream","runId":"r","sessionId":"s","event":{"kind":"tool_use","text":"Bash ls"}}"#)
        await h.settle()
        XCTAssertTrue(h.client.lines.isEmpty, "unrelated frames must not publish half a replay")
        try await Task.sleep(for: .seconds(CentralClient.replayMaxHold + 0.1))
        XCTAssertEqual(h.client.lines.map(\.text), ["Вопрос", "Read a.md", "Bash ls"])
    }

    /// Leaving a session mid-turn and coming back shows the turn as it was left
    /// until the replay replaces it — not an empty screen that the card
    /// recounts from (24.10.2026). Only while that run is still mid-turn.
    func testReopeningASessionMidTurnShowsTheParkedTurnFirst() async throws {
        let h = ClientHarness(); defer { h.clean() }; await h.connect()
        let socket = h.sockets.last!
        socket.feed(#"{"type":"snapshot","machines":[],"activeRuns":[{"runId":"r","machineId":"m","sessionId":"s","state":"working","since":1}]}"#)
        for _ in 0..<100 where h.client.activeRuns.isEmpty { await h.settle() }
        h.client.focusSession(machineId: "m", sessionId: "s")
        socket.feed(#"{"type":"opened","runId":"r","machineId":"m","sessionId":"s"}"#)
        socket.feed(#"{"type":"user_turn","runId":"r","turnId":"u","text":"Вопрос"}"#)
        socket.feed(#"{"type":"stream","runId":"r","sessionId":"s","event":{"kind":"tool_use","text":"Read a.md"}}"#)
        try await Task.sleep(for: .seconds(CentralClient.replayMaxHold + 0.1))
        XCTAssertEqual(h.client.lines.map(\.text), ["Вопрос", "Read a.md"])
        // Straight to another chat (drawer, push): no `unfocus` in between.
        h.client.focusSession(machineId: "m", sessionId: "other")
        XCTAssertTrue(h.client.lines.isEmpty)
        h.client.focusSession(machineId: "m", sessionId: "s")
        XCTAssertEqual(h.client.lines.map(\.text), ["Вопрос", "Read a.md"], "the turn as it was left, at once")
        // The replay still replaces it in one step.
        socket.feed(#"{"type":"opened","runId":"r","machineId":"m","sessionId":"s"}"#)
        socket.feed(#"{"type":"user_turn","runId":"r","turnId":"u","text":"Вопрос"}"#)
        socket.feed(#"{"type":"stream","runId":"r","sessionId":"s","event":{"kind":"tool_use","text":"Read a.md"}}"#)
        socket.feed(#"{"type":"stream","runId":"r","sessionId":"s","event":{"kind":"tool_use","text":"Bash ls"}}"#)
        await h.settle()
        XCTAssertEqual(h.client.lines.map(\.text), ["Вопрос", "Read a.md"], "no half replay on top of the parked turn")
        try await Task.sleep(for: .seconds(CentralClient.replayMaxHold + 0.1))
        XCTAssertEqual(h.client.lines.map(\.text), ["Вопрос", "Read a.md", "Bash ls"])
        // The next turn of the same run does not get this turn's lines.
        h.client.unfocus()
        socket.feed(#"{"type":"activity","runs":[{"runId":"r","machineId":"m","sessionId":"s","state":"working","since":1,"taskStartedAt":3}]}"#)
        for _ in 0..<100 where h.client.activeRuns.first?.taskStartedAt != 3 { await h.settle() }
        h.client.focusSession(machineId: "m", sessionId: "s")
        XCTAssertTrue(h.client.lines.isEmpty, "a later turn starts from its own replay")
        // A turn that ended while away is the history's to show.
        socket.feed(#"{"type":"opened","runId":"r","machineId":"m","sessionId":"s"}"#)
        socket.feed(#"{"type":"stream","runId":"r","sessionId":"s","event":{"kind":"tool_use","text":"Read b.md"}}"#)
        try await Task.sleep(for: .seconds(CentralClient.replayMaxHold + 0.1))
        h.client.unfocus()
        socket.feed(#"{"type":"activity","runs":[{"runId":"r","machineId":"m","sessionId":"s","state":"idle","since":2}]}"#)
        for _ in 0..<100 where h.client.activeRuns.first?.state != .idle { await h.settle() }
        h.client.focusSession(machineId: "m", sessionId: "s")
        XCTAssertTrue(h.client.lines.isEmpty)
    }

    func testSameRunReplayStagesUserTurnAndLocalSendAndIgnoresOtherRun() async throws {
        let h = ClientHarness(); defer { h.clean() }; await h.connect()
        let socket = h.sockets.last!
        socket.feed(#"{"type":"snapshot","machines":[],"activeRuns":[{"runId":"r","machineId":"m","sessionId":"s","state":"working","since":1}]}"#)
        for _ in 0..<100 where h.client.activeRuns.isEmpty { await h.settle() }
        h.client.focusSession(machineId: "m", sessionId: "s")
        socket.feed(#"{"type":"opened","runId":"r","machineId":"m","sessionId":"s"}"#)
        socket.feed(#"{"type":"user_turn","runId":"r","turnId":"u","text":"С десктопа"}"#)
        socket.feed(#"{"type":"stream","runId":"r","sessionId":"s","event":{"kind":"assistant","text":"Ответ"}}"#)
        await h.settle()
        XCTAssertTrue(h.client.lines.isEmpty, "user_turn must not publish an incomplete replay")
        h.client.sendInput("С телефона")
        XCTAssertTrue(h.client.lines.isEmpty, "A local send during staging must wait for its wire position")
        try await Task.sleep(for: .seconds(CentralClient.replayMaxHold + 0.1))
        XCTAssertEqual(h.client.lines.map(\.text), ["С десктопа", "Ответ", "С телефона"])
        socket.feed(#"{"type":"user_turn","runId":"other","turnId":"foreign","text":"Не этот чат"}"#)
        socket.feed(#"{"type":"user_turn","runId":"r","turnId":"phone","text":"С телефона"}"#)
        for _ in 0..<100 where h.client.lines.last?.turnId != "phone" { await h.settle() }
        XCTAssertEqual(h.client.lines.count, 3); XCTAssertEqual(h.client.lines.last?.turnId, "phone")
        for _ in 0..<2 {
            socket.feed(#"{"type":"opened","runId":"r","machineId":"m","sessionId":"s"}"#)
            socket.feed(#"{"type":"user_turn","runId":"r","turnId":"u","text":"С десктопа"}"#)
            socket.feed(#"{"type":"stream","runId":"r","sessionId":"s","event":{"kind":"assistant","text":"Ответ"}}"#)
            socket.feed(#"{"type":"user_turn","runId":"r","turnId":"phone","text":"С телефона"}"#)
            try await Task.sleep(for: .seconds(CentralClient.replayMaxHold + 0.1))
            XCTAssertEqual(h.client.lines.map(\.text), ["С десктопа", "Ответ", "С телефона"])
        }
    }
}
