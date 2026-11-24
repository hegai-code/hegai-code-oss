import XCTest
@testable import CCRemoteKit
@testable import CCRemote

@MainActor
final class ClientLifecycleTests: XCTestCase {
    func testExternallyStartedToolOnlyTurnDoesNotReusePreviousAnswer() async {
        let h = ClientHarness(); defer { h.clean() }
        await h.connect()
        let socket = h.sockets.last!
        socket.feed(#"{"type":"snapshot","machines":[],"activeRuns":[{"runId":"r","machineId":"m","sessionId":"s","state":"idle","since":2}]}"#)
        for _ in 0..<100 where h.client.activeRuns.isEmpty { await h.settle() }
        h.client.focusSession(machineId: "m", sessionId: "s")
        socket.feed(#"{"type":"opened","runId":"r","machineId":"m","sessionId":"s"}"#)
        socket.feed(#"{"type":"stream","runId":"r","sessionId":"s","event":{"kind":"assistant","text":"Ответ A"}}"#)
        for _ in 0..<100 where !h.client.hasCurrentAssistantLines { await h.settle() }
        XCTAssertTrue(h.client.hasCurrentAssistantLines)
        socket.feed(#"{"type":"run_status","runId":"r","sessionId":"s","state":"started"}"#)
        for _ in 0..<100 where h.client.lines.last?.text != "session resumed" { await h.settle() }
        XCTAssertTrue(h.client.busy, "started hides completion before activity arrives")
        XCTAssertFalse(h.client.hasCurrentAssistantLines)
        socket.feed(#"{"type":"stream","runId":"r","sessionId":"s","event":{"kind":"tool_use","text":"Read"}}"#)
        socket.feed(#"{"type":"run_status","runId":"r","sessionId":"s","state":"idle"}"#)
        for _ in 0..<100 where h.client.busy { await h.settle() }
        XCTAssertFalse(TurnCompletion.isComplete(history: [], lines: h.client.lines, busy: h.client.busy,
            connected: true, state: .idle, linesConfirmed: h.client.hasCurrentAssistantLines))
    }

    func testReplacementSocketPreservesAnswerUntilCatchUpFindsANewerTurn() async {
        let h = ClientHarness(); defer { h.clean() }
        await h.connect()
        let first = h.sockets.last!
        first.feed(#"{"type":"snapshot","machines":[],"activeRuns":[{"runId":"r","machineId":"m","sessionId":"s","state":"idle","since":2}]}"#)
        for _ in 0..<100 where h.client.activeRuns.isEmpty { await h.settle() }
        h.client.focusSession(machineId: "m", sessionId: "s")
        first.feed(#"{"type":"opened","runId":"r","machineId":"m","sessionId":"s"}"#)
        first.feed(#"{"type":"stream","runId":"r","sessionId":"s","event":{"kind":"assistant","text":"Ответ A"}}"#)
        for _ in 0..<100 where !h.client.hasCurrentAssistantLines { await h.settle() }
        h.client.appDidBecomeActive(fromBackground: true)
        first.pongs.last?(ClientError.connectionClosed)
        for _ in 0..<100 where h.sockets.count < 2 { await h.settle() }
        XCTAssertEqual(h.sockets.count, 2)
        let second = h.sockets.last!
        second.feed(#"{"type":"snapshot","machines":[],"activeRuns":[{"runId":"r","machineId":"m","sessionId":"s","state":"idle","since":2}]}"#)
        for _ in 0..<100 where h.client.status != .open { await h.settle() }
        XCTAssertTrue(h.client.pendingCatchUp)
        XCTAssertTrue(h.client.hasCurrentAssistantLines, "unchanged idle turn retains its answer")
        second.feed(#"{"type":"activity","runs":[{"runId":"r","machineId":"m","sessionId":"s","state":"idle","since":4}]}"#)
        for _ in 0..<100 where h.client.pendingCatchUp { await h.settle() }
        XCTAssertFalse(h.client.hasCurrentAssistantLines, "a newer turn must invalidate the retained answer")
    }

    func testReconnectRetainsProseWithoutTreatingItAsCurrentAssistantOutput() async {
        let h = ClientHarness(); defer { h.clean() }
        await h.connect()
        let first = h.sockets.last!
        first.feed(#"{"type":"snapshot","machines":[],"activeRuns":[{"runId":"r","machineId":"m","sessionId":"s","state":"working","since":1}]}"#)
        for _ in 0..<100 where h.client.activeRuns.isEmpty { await h.settle() }
        h.client.focusSession(machineId: "m", sessionId: "s")
        first.feed(#"{"type":"opened","runId":"r","machineId":"m","sessionId":"s"}"#)
        first.feed(#"{"type":"stream","runId":"r","sessionId":"s","event":{"kind":"assistant","text":"Ответ A"}}"#)
        first.feed(#"{"type":"activity","runs":[{"runId":"r","machineId":"m","sessionId":"s","state":"idle","since":2}]}"#)
        for _ in 0..<100 where h.client.lines.last?.text != "Ответ A" || h.client.busy { await h.settle() }
        XCTAssertTrue(h.client.hasCurrentAssistantLines)
        XCTAssertEqual(h.client.lines.last?.text, "Ответ A")

        h.client.appWillBackground()
        let previousEpoch = h.client.connectionEpoch
        h.client.appDidBecomeActive(fromBackground: true)
        XCTAssertTrue(h.client.pendingCatchUp, "completion must wait even before the foreground pong")
        first.pongs.last?(nil)
        for _ in 0..<100 where first.frames(of: "resume").isEmpty { await h.settle() }
        first.feed(#"{"type":"activity","runs":[{"runId":"r","machineId":"m","sessionId":"s","state":"idle","since":4,"taskStartedAt":3}]}"#)
        for _ in 0..<100 where h.client.pendingCatchUp { await h.settle() }
        XCTAssertFalse(h.client.pendingCatchUp)
        XCTAssertGreaterThan(h.client.connectionEpoch, previousEpoch)
        XCTAssertFalse(h.client.hasCurrentAssistantLines)

        h.client.connect(endpoint: h.endpoint, token: "alice")
        let second = h.sockets.last!
        second.feed(#"{"type":"snapshot","machines":[],"activeRuns":[{"runId":"r","machineId":"m","sessionId":"s","state":"idle","since":4,"taskStartedAt":3}]}"#)
        for _ in 0..<100 where h.client.activeRuns.first?.since != 4 { await h.settle() }
        XCTAssertEqual(h.client.lines.last?.text, "Ответ A", "old speech remains readable until history catches up")
        XCTAssertFalse(h.client.hasCurrentAssistantLines, "idle for turn B does not confirm retained turn A")
        second.feed(#"{"type":"stream","runId":"r","sessionId":"s","event":{"kind":"assistant","text":"Ответ B"}}"#)
        for _ in 0..<100 where !h.client.hasCurrentAssistantLines { await h.settle() }
        XCTAssertTrue(h.client.hasCurrentAssistantLines)
        h.client.clearLines()
        XCTAssertFalse(h.client.hasCurrentAssistantLines)
    }

    func testMirrorRefreshRejectsOldSnapshotAndClosesItsLateHandle() async throws {
        let h = ClientHarness(); defer { h.clean() }
        await h.connect()
        let socket = h.sockets.last!
        let mirror = MirrorModel(); defer { mirror.stop() }
        mirror.start(client: h.client, machineId: "m", sessionId: "s", cwd: "/demo", revision: "working")
        for _ in 0..<100 where socket.frames(of: "mirror_open").isEmpty { await h.settle() }
        let oldID = try XCTUnwrap(socket.frames(of: "mirror_open").first?["mirrorId"] as? String)
        mirror.start(client: h.client, machineId: "m", sessionId: "s", cwd: "/demo", revision: "idle", confirmTail: true)
        for _ in 0..<100 where socket.frames(of: "mirror_open").count < 2 { await h.settle() }
        let newID = try XCTUnwrap(socket.frames(of: "mirror_open").last?["mirrorId"] as? String)
        XCTAssertNotEqual(oldID, newID)
        socket.feed(#"{"type":"mirror_opened","mirrorId":"\#(oldID)","machineId":"m"}"#)
        socket.feed(#"{"type":"mirror_data","mirrorId":"\#(oldID)","replace":true,"messages":[{"type":"assistant","uuid":"old","blocks":[{"kind":"text","text":"Old"}]}]}"#)
        for _ in 0..<100 where socket.frames(of: "mirror_close").isEmpty { await h.settle() }
        XCTAssertEqual(socket.frames(of: "mirror_close").first?["mirrorId"] as? String, oldID)
        XCTAssertFalse(mirror.connected)
        XCTAssertNil(mirror.confirmedRevision)
        socket.feed(#"{"type":"mirror_opened","mirrorId":"\#(newID)","machineId":"m"}"#)
        socket.feed(#"{"type":"mirror_data","mirrorId":"\#(newID)","replace":true,"messages":[{"type":"assistant","uuid":"new","blocks":[{"kind":"text","text":"New"}]}]}"#)
        for _ in 0..<100 where !mirror.connected { await h.settle() }
        XCTAssertEqual(mirror.messages.map(\.uuid), ["new"])
        XCTAssertNil(mirror.confirmedRevision, "the first mirror chunk does not prove the tail")
        for _ in 0..<100 where socket.frames(of: "rpc_request").isEmpty { await h.settle() }
        let request = try XCTUnwrap(socket.frames(of: "rpc_request").first { $0["method"] as? String == "session.messages" })
        let requestID = try XCTUnwrap(request["requestId"] as? String)
        socket.feed(#"{"type":"rpc_response","requestId":"\#(requestID)","ok":true,"result":{"messages":[{"type":"assistant","uuid":"tail","blocks":[{"kind":"text","text":"Last chunk"}]}]}}"#)
        await h.settle()
        XCTAssertNil(mirror.confirmedRevision, "history confirms a tail that the mirror has not received yet")
        socket.feed(#"{"type":"mirror_data","mirrorId":"\#(newID)","replace":false,"messages":[{"type":"assistant","uuid":"tail","blocks":[{"kind":"text","text":"Last chunk"}]}]}"#)
        for _ in 0..<100 where mirror.confirmedRevision == nil { await h.settle() }
        XCTAssertEqual(mirror.confirmedRevision, "idle")
        socket.feed(#"{"type":"mirror_data","mirrorId":"\#(newID)","replace":false,"messages":[{"type":"user","uuid":"next","blocks":[{"kind":"text","text":"Next turn"}]}]}"#)
        for _ in 0..<100 where mirror.messages.last?.uuid != "next" { await h.settle() }
        XCTAssertNil(mirror.confirmedRevision, "later chunks or a new user turn invalidate the confirmed tail")
    }

    func testCompletionReadsKeepPersistenceWhenSelectingCurrentWorkspace() async throws {
        let h = ClientHarness()
        defer { h.clean() }
        await h.connect()
        h.sockets.last!.feed(#"{"type":"snapshot","machines":[],"viewer":{"userId":"alice","platformAdmin":false,"email":"a@example.test","workspace":{"workspaceId":"w","name":"W","kind":"personal","role":"owner"},"workspaces":[]},"activeRuns":[{"runId":"r","machineId":"m","sessionId":"s","ownerUserId":"alice","state":"working","since":1}]}"#)
        for _ in 0..<100 where h.client.activeRuns.isEmpty { await h.settle() }
        XCTAssertEqual(h.client.activeRuns.first?.state, .working)
        let scope = h.client.storageScope
        // nil and explicit "w" are bindings for the same verified storage scope.
        await h.connect(workspace: "w")
        XCTAssertEqual(h.client.storageScope, scope)
        h.sockets.last!.feed(#"{"type":"snapshot","machines":[],"viewer":{"userId":"alice","platformAdmin":false,"email":"a@example.test","workspace":{"workspaceId":"w","name":"W","kind":"personal","role":"owner"},"workspaces":[]},"activeRuns":[{"runId":"r","machineId":"m","sessionId":"s","ownerUserId":"alice","state":"idle","since":2}]}"#)
        for _ in 0..<100 where h.client.completionReads.unread.isEmpty { await h.settle() }
        XCTAssertEqual(h.client.completionReads.unread, ["m::s": 2])
        let directory = h.root.appendingPathComponent("Accounts").appendingPathComponent(scope)
        XCTAssertEqual(SessionCompletionReads(directory: directory).unread, ["m::s": 2])
    }

    func testLegacyQueueRequiresVerifiedOwnerAndExplicitRecovery() async throws {
        let h = ClientHarness()
        defer { h.clean() }
        let old = PendingMessage(machineId: "m", sessionId: "s", text: "legacy")
        try OfflineOutboxStore(directory: h.root).save([old])
        await h.connect()
        XCTAssertTrue(h.client.pending.isEmpty)
        XCTAssertThrowsError(try h.client.recoverLegacyPending())
        h.sockets.last!.feed(#"{"type":"snapshot","machines":[],"viewer":{"userId":"alice","platformAdmin":false,"email":"a@example.test","workspace":{"workspaceId":"w","name":"W","kind":"personal","role":"owner"},"workspaces":[]}}"#)
        for _ in 0..<50 where h.client.viewer == nil { await h.settle() }
        XCTAssertTrue(h.client.pending.isEmpty)
        try h.client.recoverLegacyPending()
        try h.client.recoverLegacyPending()
        XCTAssertEqual(h.client.pending.map(\.id), [old.id])
        XCTAssertEqual(try h.client.legacyPendingCount(), 0)
        XCTAssertTrue(FileManager.default.fileExists(atPath: h.root.appendingPathComponent("PendingMessages.pre-account-backup.json").path))
    }

    func testDisconnectRejectsRequestsWithoutWaitingForTimeout() async {
        let h = ClientHarness()
        defer { h.clean() }
        await h.connect()
        let finished = expectation(description: "RPC settled on disconnect")
        let request = Task {
            defer { finished.fulfill() }
            do {
                _ = try await h.client.rpc(machineId: "m", method: "projects.list", params: .null)
                XCTFail("disconnected request succeeded")
            } catch { XCTAssertTrue(error is ClientError) }
        }
        await h.settle()
        XCTAssertEqual(h.sockets[0].frames(of: "rpc_request").count, 1)
        h.client.disconnect()
        await fulfillment(of: [finished], timeout: 1)
        request.cancel()
    }

    func testExplicitReconnectRejectsRequestsAndOldPongCannotDropNewSocket() async {
        let h = ClientHarness()
        defer { h.clean() }
        await h.connect()
        let first = h.sockets[0]
        h.client.appDidBecomeActive(fromBackground: true)
        XCTAssertEqual(first.pongs.count, 1)
        let finished = expectation(description: "RPC settled on replacement")
        let request = Task {
            defer { finished.fulfill() }
            _ = try? await h.client.rpc(machineId: "m", method: "projects.list", params: .null)
        }
        await h.settle()
        await h.connect()
        first.pongs[0](ClientError.connectionClosed)
        await h.settle()
        XCTAssertEqual(h.sockets.count, 2)
        XCTAssertFalse(h.sockets[1].cancelled)
        await fulfillment(of: [finished], timeout: 1)
        request.cancel()
    }

    func testFrameFinishingDecodeAfterDisconnectIsIgnored() async {
        let h = ClientHarness()
        var release: CheckedContinuation<HubMessage?, Never>?
        let started = expectation(description: "decode started")
        let client = h.makeClient(decode: { _ in
            await withCheckedContinuation { release = $0; started.fulfill() }
        })
        defer { client.disconnect(); h.clean() }
        client.connect(endpoint: h.endpoint, token: "alice")
        h.sockets[0].feed("delayed frame")
        await fulfillment(of: [started], timeout: 1)
        client.disconnect()
        release?.resume(returning: .error(message: "old account"))
        await h.settle()
        XCTAssertNil(client.lastError)
        XCTAssertEqual(client.status, .closed)
    }

    func testOldSendFailureDoesNotQueueTextUnderAnotherAccount() async {
        let h = ClientHarness()
        defer { h.clean() }
        await h.connect()
        h.sockets[0].autoComplete = false
        XCTAssertTrue(h.client.open(machineId: "m", sessionId: "s", message: "alice private text"))
        let completion = h.sockets[0].completions[0]
        await h.connect(token: "bob")
        completion(ClientError.connectionClosed)
        await h.settle()
        XCTAssertTrue(h.client.pending.isEmpty)
        XCTAssertNil(h.client.active)
        XCTAssertTrue(h.client.lines.isEmpty)
        await h.connect(token: "alice")
        XCTAssertEqual(h.client.pending.map(\.text), ["alice private text"])
    }

    func testQueueAndCacheStayWithTheirAccountAndWorkspace() async throws {
        let h = ClientHarness()
        defer { h.clean() }
        await h.connect(workspace: "one")
        let aliceScope = h.client.storageScope
        XCTAssertTrue(h.client.queuePending(machineId: "m", sessionId: "s", text: "alice"))
        await h.client.transcripts.write("m__s", payload: .object(["messages": .array([])]), lastModified: 12)
        h.client.focusSession(machineId: "m", sessionId: "s")
        await h.connect(token: "bob", workspace: "one")
        XCTAssertNotEqual(h.client.storageScope, aliceScope)
        XCTAssertTrue(h.client.pending.isEmpty)
        XCTAssertNil(h.client.active)
        let bobMtime = await h.client.transcripts.cachedAt("m__s")
        XCTAssertNil(bobMtime)
        await h.connect(workspace: "two")
        XCTAssertTrue(h.client.pending.isEmpty)
        await h.connect(workspace: "one")
        XCTAssertEqual(h.client.pending.map(\.text), ["alice"])
        h.client.disconnect()
        XCTAssertTrue(h.client.pending.isEmpty)
        XCTAssertEqual(h.client.storageScope, "signed-out")
        h.client.appDidBecomeActive(fromBackground: true)
        XCTAssertEqual(h.sockets.count, 4, "sign out must not reconnect")
    }

    func testVerifiedIdentitySurvivesTokenRotationWithoutSharingWithAnotherViewer() async throws {
        let h = ClientHarness()
        defer { h.clean() }
        await h.connect()
        let viewer = #"{"userId":"alice-id","platformAdmin":false,"email":"alice@example.test","workspace":{"workspaceId":"w","name":"W","kind":"personal","role":"owner"},"workspaces":[]}"#
        XCTAssertTrue(h.client.queuePending(machineId: "m", sessionId: "s", text: "before verification"))
        h.sockets.last!.feed("{\"type\":\"snapshot\",\"machines\":[],\"viewer\":\(viewer)}")
        for _ in 0..<50 where !h.client.storageScope.hasPrefix("account-") { await h.settle() }
        let scope = h.client.storageScope
        XCTAssertTrue(scope.hasPrefix("account-"))
        XCTAssertEqual(h.client.pending.map(\.text), ["before verification"])
        h.client.removePending(h.client.pending[0].id)
        XCTAssertTrue(h.client.queuePending(machineId: "m", sessionId: "s", text: "private"))
        await h.connect(token: "new-alice-token")
        XCTAssertTrue(h.client.pending.isEmpty, "unverified credentials cannot borrow a cache")
        h.sockets.last!.feed("{\"type\":\"snapshot\",\"machines\":[],\"viewer\":\(viewer)}")
        for _ in 0..<50 where h.client.storageScope != scope { await h.settle() }
        XCTAssertEqual(h.client.storageScope, scope)
        XCTAssertEqual(h.client.pending.map(\.text), ["private"])
    }

    func testPendingInputWaitsForSendCompletionAndPreservesFIFO() async {
        let h = ClientHarness()
        defer { h.clean() }
        await h.connect()
        XCTAssertTrue(h.client.queuePending(machineId: "m", sessionId: "s", text: "first"))
        XCTAssertTrue(h.client.queuePending(machineId: "m", sessionId: "s", text: "second"))
        let socket = h.sockets[0]
        socket.autoComplete = false
        let snapshot = #"{"type":"snapshot","machines":[{"machine":{"machineId":"m","name":"M","os":"mac","agentVersion":"1"},"online":true,"lastSeen":1,"sessions":[{"sessionId":"s","title":"S","cwd":"/p","lastModified":1}]}],"activeRuns":[{"runId":"r","machineId":"m","sessionId":"s","state":"working","since":1}]}"#
        socket.feed(snapshot)
        for _ in 0..<100 where socket.frames(of: "input").isEmpty { await h.settle() }
        XCTAssertEqual(socket.frames(of: "input").count, 1)
        XCTAssertEqual(h.client.pending.count, 2)
        socket.feed(snapshot)
        await h.settle()
        XCTAssertEqual(socket.frames(of: "input").count, 1)
        guard !socket.completions.isEmpty else { return XCTFail("no send") }
        socket.completions.removeFirst()(nil)
        await h.settle()
        XCTAssertEqual(h.client.pending.map(\.text), ["second"])
        XCTAssertEqual(socket.frames(of: "input").count, 2)
        guard !socket.completions.isEmpty else { return XCTFail("no second send") }
        socket.completions.removeFirst()(ClientError.connectionClosed)
        XCTAssertEqual(h.client.pending.map(\.text), ["second"])
    }

    func testTerminalAndMirrorExitOnceOnExplicitDisconnect() async {
        let h = ClientHarness()
        defer { h.clean() }
        await h.connect()
        var exits = 0
        let terminal = Task {
            try? await h.client.openTerminal(machineId: "m", cwd: "/p", onData: { _ in }, onExit: { _ in exits += 1 })
        }
        await h.settle()
        guard let id = h.sockets[0].frames(of: "term_open").first?["termId"] as? String else {
            terminal.cancel(); return XCTFail("no terminal open")
        }
        h.sockets[0].feed("{\"type\":\"term_opened\",\"termId\":\"\(id)\",\"machineId\":\"m\"}")
        _ = await terminal.value
        h.client.disconnect()
        h.client.disconnect()
        XCTAssertEqual(exits, 1)
    }

    /// A subscribe to a working run replays the whole turn frame by frame. The
    /// transcript must change once, not per frame: per-frame writes redrew the
    /// reply as if retyped and counted the ⚙ badge up again from one.
    func testTurnReplayIsPublishedInOneStep() async throws {
        let h = ClientHarness()
        defer { h.clean() }
        await h.connect()
        let socket = h.sockets[0]
        socket.feed(#"{"type":"snapshot","machines":[{"machine":{"machineId":"m","name":"M","os":"mac","agentVersion":"1"},"online":true,"lastSeen":1,"sessions":[{"sessionId":"s","title":"S","cwd":"/p","lastModified":1}]}],"activeRuns":[{"runId":"r","machineId":"m","sessionId":"s","state":"working","since":1}]}"#)
        for _ in 0..<100 where h.client.activeRuns.isEmpty { await h.settle() }
        h.client.focusSession(machineId: "m", sessionId: "s")
        await h.settle()
        var writes = 0
        func observe() {
            withObservationTracking { _ = h.client.lines } onChange: {
                Task { @MainActor in writes += 1; observe() }
            }
        }
        observe()
        socket.feed(#"{"type":"opened","runId":"r","machineId":"m","sessionId":"s"}"#)
        // What the hub really sends before the backlog (server-rs/src/hub.rs).
        socket.feed(#"{"type":"run_mode","runId":"r","sessionId":"s","mode":"default"}"#)
        socket.feed(#"{"type":"run_settings","runId":"r","sessionId":"s","model":"opus"}"#)
        let stream = { (event: String) in #"{"type":"stream","runId":"r","sessionId":"s","event":"# + event + "}" }
        socket.feed(stream(#"{"kind":"partial","text":"Смотрю "}"#))
        socket.feed(stream(#"{"kind":"partial","text":"код."}"#))
        socket.feed(stream(#"{"kind":"assistant","text":"Смотрю код."}"#))
        for n in 1...5 { socket.feed(stream(#"{"kind":"tool_use","text":"Read \#(n)"}"#)) }
        await h.settle()
        XCTAssertEqual(h.client.lines.count, 0, "replay leaked onto the screen frame by frame")
        try await Task.sleep(for: .seconds(CentralClient.replayMaxHold + 0.2))
        await h.settle()
        XCTAssertEqual(h.client.lines.map(\.text), ["Смотрю код."] + (1...5).map { "Read \($0)" })
        XCTAssertEqual(writes, 1)
        // Live frames after the replay flow straight through.
        // Decoding hops to the cooperative pool: Task.yield() a fixed number
        // of times does not guarantee it has finished on a busy CI machine.
        let liveUpdate = expectation(description: "live frame published after replay")
        withObservationTracking { _ = h.client.lines } onChange: {
            liveUpdate.fulfill()
        }
        socket.feed(stream(#"{"kind":"tool_use","text":"Read 6"}"#))
        await fulfillment(of: [liveUpdate], timeout: 1)
        XCTAssertEqual(h.client.lines.last?.text, "Read 6")
    }

    /// A long turn's backlog is up to 400 frames / 256 KB (server-rs/src/hub.rs).
    /// On a phone it does not land in one burst: the radio trickles it, and the
    /// main actor is busy laying out the history that is opening at the same
    /// time. Frames that arrive later than `replayMaxHold`, or after a pause
    /// longer than `replayQuietGap`, must still join the one write — otherwise
    /// the rest of the turn is "retyped" frame by frame and every frame redraws
    /// the whole transcript (23.11.2026: «печатает много текста, подвисает»).
    func testSlowTurnReplayIsStillPublishedInOneStep() async throws {
        let h = ClientHarness()
        defer { h.clean() }
        await h.connect()
        let socket = h.sockets[0]
        socket.feed(#"{"type":"snapshot","machines":[{"machine":{"machineId":"m","name":"M","os":"mac","agentVersion":"1"},"online":true,"lastSeen":1,"sessions":[{"sessionId":"s","title":"S","cwd":"/p","lastModified":1}]}],"activeRuns":[{"runId":"r","machineId":"m","sessionId":"s","state":"working","since":1}]}"#)
        for _ in 0..<100 where h.client.activeRuns.isEmpty { await h.settle() }
        h.client.focusSession(machineId: "m", sessionId: "s")
        await h.settle()
        var writes = 0
        func observe() {
            withObservationTracking { _ = h.client.lines } onChange: {
                Task { @MainActor in writes += 1; observe() }
            }
        }
        observe()
        let frames = 12
        // The hub counts the person's `user_turn` in its window too.
        socket.feed(#"{"type":"opened","runId":"r","machineId":"m","sessionId":"s","backlog":\#(frames + 1)}"#)
        socket.feed(#"{"type":"run_settings","runId":"r","sessionId":"s","model":"opus"}"#)
        socket.feed(#"{"type":"user_turn","runId":"r","sessionId":"s","turnId":"t1","text":"Посмотри","ts":1}"#)
        let stream = { (event: String) in #"{"type":"stream","runId":"r","sessionId":"s","event":"# + event + "}" }
        for n in 1...frames {
            socket.feed(stream(#"{"kind":"tool_use","text":"Read \#(n)"}"#))
            await h.settle()
            // One radio stall past the quiet gap, the rest a steady trickle
            // that outlasts the hold: 1.0 s in all.
            try await Task.sleep(for: .seconds(n == 3 ? CentralClient.replayQuietGap * 2 : 0.07))
            await h.settle()
        }
        try await Task.sleep(for: .seconds(CentralClient.replayQuietGap * 2))
        await h.settle()
        XCTAssertEqual(h.client.lines.map(\.text), ["Посмотри"] + (1...frames).map { "Read \($0)" })
        XCTAssertEqual(writes, 1, "the backlog reached the screen in \(writes) writes")
    }

    /// A counted backlog with a frame that never comes (undecodable, or sealed
    /// and unreadable) must not hold the turn off screen for good.
    func testCountedReplayMissingAFrameIsPublishedAfterAStall() async throws {
        let h = ClientHarness()
        defer { h.clean() }
        await h.connect()
        let socket = h.sockets[0]
        socket.feed(#"{"type":"snapshot","machines":[{"machine":{"machineId":"m","name":"M","os":"mac","agentVersion":"1"},"online":true,"lastSeen":1,"sessions":[{"sessionId":"s","title":"S","cwd":"/p","lastModified":1}]}],"activeRuns":[{"runId":"r","machineId":"m","sessionId":"s","state":"working","since":1}]}"#)
        for _ in 0..<100 where h.client.activeRuns.isEmpty { await h.settle() }
        h.client.focusSession(machineId: "m", sessionId: "s")
        await h.settle()
        socket.feed(#"{"type":"opened","runId":"r","machineId":"m","sessionId":"s","backlog":3}"#)
        let stream = { (event: String) in #"{"type":"stream","runId":"r","sessionId":"s","event":"# + event + "}" }
        socket.feed(stream(#"{"kind":"tool_use","text":"Read 1"}"#))
        socket.feed(stream(#"{"kind":"tool_use","text":"Read 2"}"#))
        try await Task.sleep(for: .seconds(CentralClient.replayMaxHold + 0.2))
        await h.settle()
        XCTAssertEqual(h.client.lines.count, 0, "published before the stall gap")
        try await Task.sleep(for: .seconds(CentralClient.replayStallGap))
        await h.settle()
        XCTAssertEqual(h.client.lines.map(\.text), ["Read 1", "Read 2"])
    }
}
