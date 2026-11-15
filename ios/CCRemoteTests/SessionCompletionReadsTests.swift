import XCTest
@testable import CCRemoteKit

@MainActor
final class SessionCompletionReadsTests: XCTestCase {
    private func run(_ state: AttentionState, since: Double, owner: String = "me", session: String = "s") -> ActiveRunInfo {
        ActiveRunInfo(runId: "r-\(session)", machineId: "m", sessionId: session,
                      state: state, since: since, ownerUserId: owner)
    }

    func testSettledPreviewSurvivesReadingReloadAndIdleReplayButNotNewWork() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        var reads = SessionCompletionReads(directory: root)
        var working = run(.working, since: 10)
        working.preview = "Waiting for a child"
        reads.ingest([working], viewerId: "me")
        XCTAssertTrue(reads.completed.isEmpty)
        var idle = run(.idle, since: 20)
        idle.preview = "Implemented the change.\nVerified the result."
        reads.ingest([idle], viewerId: "me")
        reads.setVisibleSession("m::s")
        reads = SessionCompletionReads(directory: root)
        XCTAssertTrue(reads.unread.isEmpty)
        XCTAssertEqual(reads.completed["m::s"]?.preview, "Implemented the change. Verified the result.")
        reads.ingest([run(.idle, since: 40)], viewerId: "me")
        XCTAssertEqual(reads.completed["m::s"]?.at, 20)
        reads.ingest([], viewerId: "me")
        XCTAssertNotNil(reads.completed["m::s"])
        reads.ingest([run(.working, since: 50)], viewerId: "me")
        XCTAssertTrue(reads.completed.isEmpty)
        _ = SessionCompletionReads(directory: root)
    }

    func testForeignRunCannotRetainCompletedPreview() {
        let reads = SessionCompletionReads()
        reads.ingest([run(.working, since: 10)], viewerId: "me")
        reads.ingest([run(.idle, since: 20)], viewerId: "me")
        reads.ingest([run(.idle, since: 30, owner: "other")], viewerId: "me")
        XCTAssertTrue(reads.completed.isEmpty)
        XCTAssertTrue(reads.unread.isEmpty)
    }

    func testTaskCompletedEntirelyOfflineReplacesPreviousResult() {
        let reads = SessionCompletionReads()
        var first = run(.idle, since: 20); first.preview = "Old answer"
        reads.ingest([first], viewerId: "me")
        var next = run(.idle, since: 40); next.preview = "New answer"; next.taskStartedAt = 30
        reads.ingest([next], viewerId: "me")
        XCTAssertEqual(reads.completed["m::s"]?.preview, "New answer")
        XCTAssertEqual(reads.unread["m::s"], 40)
        reads.setVisibleSession("m::s")
        reads.setVisibleSession(nil)
        reads.ingest([next], viewerId: "me")
        XCTAssertTrue(reads.unread.isEmpty)
    }

    func testLatePreviewBackfillsWithoutMovingOrRestoringReadState() {
        let reads = SessionCompletionReads()
        reads.ingest([run(.working, since: 10)], viewerId: "me")
        reads.ingest([run(.idle, since: 20)], viewerId: "me")
        reads.setVisibleSession("m::s")
        reads.setVisibleSession(nil)
        var idle = run(.idle, since: 30); idle.preview = "Final answer"
        reads.ingest([idle], viewerId: "me")
        XCTAssertEqual(reads.completed["m::s"]?.at, 20)
        XCTAssertEqual(reads.completed["m::s"]?.preview, "Final answer")
        XCTAssertTrue(reads.unread.isEmpty)
    }

    func testUnreadResultsDoNotEvictRecentReadHistory() {
        let reads = SessionCompletionReads()
        reads.ingest([run(.working, since: 10)], viewerId: "me")
        reads.ingest([run(.idle, since: 20)], viewerId: "me")
        reads.setVisibleSession("m::s")
        reads.setVisibleSession(nil)
        for i in 1...105 {
            reads.ingest([run(.working, since: Double(30 + i), session: "other-\(i)")], viewerId: "me")
            reads.ingest([run(.idle, since: Double(200 + i), session: "other-\(i)")], viewerId: "me")
        }
        XCTAssertEqual(reads.unread.count, 105)
        XCTAssertNotNil(reads.completed["m::s"])
    }

    func testDecisionIsReadOnlyByItsForegroundChatAndNewRequestReturns() {
        let reads = SessionCompletionReads()
        reads.ingest([run(.needs_attention, since: 10)], viewerId: "me")
        XCTAssertEqual(reads.unreadDecisions, ["m::s"])
        reads.setVisibleSession(nil) // Drawer / background.
        reads.setVisibleSession("m::other")
        XCTAssertEqual(reads.unreadDecisions, ["m::s"])
        reads.setVisibleSession("m::s")
        XCTAssertTrue(reads.unreadDecisions.isEmpty)
        reads.setVisibleSession(nil)
        reads.ingest([run(.needs_attention, since: 10)], viewerId: "me")
        XCTAssertTrue(reads.unreadDecisions.isEmpty, "Duplicate snapshots must not restore the dot")
        reads.ingest([run(.needs_attention, since: 20)], viewerId: "me")
        XCTAssertEqual(reads.unreadDecisions, ["m::s"])
        reads.ingest([run(.working, since: 15)], viewerId: "me")
        XCTAssertEqual(reads.unreadDecisions, ["m::s"], "A stale frame cannot hide a new decision")
        reads.ingest([run(.working, since: 30)], viewerId: "me")
        XCTAssertTrue(reads.unreadDecisions.isEmpty)
    }

    func testSeenDecisionPersistsAndRemovedOrForeignRunsDoNotRemainUnread() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        var reads = SessionCompletionReads(directory: root)
        reads.ingest([run(.needs_attention, since: 10)], viewerId: "me")
        reads = SessionCompletionReads(directory: root)
        XCTAssertEqual(reads.unreadDecisions, ["m::s"])
        reads.setVisibleSession("m::s")
        reads = SessionCompletionReads(directory: root)
        reads.ingest([run(.needs_attention, since: 10)], viewerId: "me")
        XCTAssertTrue(reads.unreadDecisions.isEmpty)
        reads.ingest([run(.needs_attention, since: 20)], viewerId: "me")
        XCTAssertEqual(reads.unreadDecisions, ["m::s"])
        reads.ingest([], viewerId: "me")
        reads = SessionCompletionReads(directory: root)
        XCTAssertTrue(reads.unreadDecisions.isEmpty)
        reads.ingest([run(.needs_attention, since: 30, owner: "colleague")], viewerId: "me")
        XCTAssertTrue(reads.unreadDecisions.isEmpty)
        reads.setVisibleSession("m::s")
        reads.ingest([run(.needs_attention, since: 40)], viewerId: "me")
        XCTAssertTrue(reads.unreadDecisions.isEmpty, "A visible incoming request is already viewed")
        _ = SessionCompletionReads(directory: root) // Drain disk writes before cleanup.
    }

    func testReplayedRequestKeepsReadIdentityDespiteNewTimestampAndTransientWorking() throws {
        let data = Data(#"{"runId":"r-s","machineId":"m","sessionId":"s","state":"needs_attention","since":10,"ownerUserId":"me","pendingRequestId":"request-1"}"#.utf8)
        let first = try JSONDecoder().decode(ActiveRunInfo.self, from: data)
        XCTAssertEqual(first.pendingRequestId, "request-1")
        let reads = SessionCompletionReads()
        reads.ingest([first], viewerId: "me")
        reads.setVisibleSession("m::s")
        reads.setVisibleSession(nil)
        reads.ingest([], viewerId: "me")
        reads.ingest([run(.working, since: 20)], viewerId: "me")
        var replay = run(.needs_attention, since: 30)
        replay.pendingRequestId = "request-1"
        reads.ingest([replay], viewerId: "me")
        XCTAssertTrue(reads.unreadDecisions.isEmpty)
        replay.pendingRequestId = "request-2"
        reads.ingest([replay], viewerId: "me")
        XCTAssertEqual(reads.unreadDecisions, ["m::s"], "New requests must appear even within the same phase timestamp")
    }

    func testDecisionFinishingAcrossMissingActivityStillCreatesUnreadAnswer() {
        let reads = SessionCompletionReads()
        reads.ingest([run(.needs_attention, since: 10)], viewerId: "me")
        reads.setVisibleSession("m::s")
        reads.setVisibleSession(nil)
        reads.ingest([], viewerId: "me")
        XCTAssertTrue(reads.unreadDecisions.isEmpty)
        reads.ingest([run(.needs_attention, since: 10)], viewerId: "me")
        XCTAssertTrue(reads.unreadDecisions.isEmpty, "Reconnect must preserve viewed decisions")
        reads.ingest([], viewerId: "me")
        reads.ingest([run(.idle, since: 20)], viewerId: "me")
        XCTAssertEqual(reads.unread, ["m::s": 20])
    }

    func testOldCompletionSnapshotStillLoads() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let data = Data(#"{"phases":{"m::s":{"runId":"r-s","state":"idle","since":20}},"unread":{"m::s":20}}"#.utf8)
        try data.write(to: root.appendingPathComponent("SessionCompletionReads.json"))
        let reads = SessionCompletionReads(directory: root)
        XCTAssertEqual(reads.unread, ["m::s": 20])
        XCTAssertTrue(reads.unreadDecisions.isEmpty)
    }

    func testOnlyNewFinishedTurnsBecomeUnreadAndReadDoesNotComeBack() {
        let reads = SessionCompletionReads()
        reads.ingest([run(.idle, since: 10)], viewerId: "me")
        XCTAssertTrue(reads.unread.isEmpty)
        reads.ingest([run(.working, since: 30)], viewerId: "me")
        reads.ingest([run(.idle, since: 40)], viewerId: "me")
        XCTAssertEqual(reads.unread, ["m::s": 40])
        reads.setVisibleSession("m::s")
        reads.setVisibleSession(nil)
        reads.ingest([run(.idle, since: 40)], viewerId: "me")
        XCTAssertTrue(reads.unread.isEmpty)
    }

    func testVisibleChatIsReadButBackgroundAndDrawerAreNot() {
        let reads = SessionCompletionReads()
        reads.setVisibleSession("m::s")
        reads.ingest([run(.working, since: 10)], viewerId: "me")
        reads.ingest([run(.idle, since: 20)], viewerId: "me")
        XCTAssertTrue(reads.unread.isEmpty)
        reads.setVisibleSession(nil)
        reads.ingest([run(.working, since: 30)], viewerId: "me")
        reads.ingest([run(.idle, since: 40)], viewerId: "me")
        XCTAssertNotNil(reads.unread["m::s"])
        reads.setVisibleSession("m::other")
        XCTAssertNotNil(reads.unread["m::s"])
        reads.setVisibleSession("m::s")
        XCTAssertTrue(reads.unread.isEmpty)
    }

    func testCompletionSurvivesRunRemovalAndDiskReload() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        var reads = SessionCompletionReads(directory: directory)
        reads.ingest([run(.working, since: 10)], viewerId: "me")
        reads = SessionCompletionReads(directory: directory)
        reads.ingest([run(.idle, since: 20)], viewerId: "me")
        reads.ingest([], viewerId: "me")
        reads = SessionCompletionReads(directory: directory)
        XCTAssertEqual(reads.unread, ["m::s": 20])
        reads.setVisibleSession("m::s")
        reads = SessionCompletionReads(directory: directory)
        XCTAssertTrue(reads.unread.isEmpty)
        reads.ingest([run(.idle, since: 20)], viewerId: "me")
        XCTAssertTrue(reads.unread.isEmpty)
    }

    func testDuplicateIdleTimestampDoesNotRestoreReadMarker() {
        let reads = SessionCompletionReads()
        reads.ingest([run(.working, since: 10)], viewerId: "me")
        reads.ingest([run(.idle, since: 20)], viewerId: "me")
        reads.setVisibleSession("m::s")
        reads.setVisibleSession(nil)
        reads.ingest([run(.idle, since: 30)], viewerId: "me")
        XCTAssertTrue(reads.unread.isEmpty)
        reads.ingest([run(.working, since: 15)], viewerId: "me")
        reads.ingest([run(.idle, since: 40)], viewerId: "me")
        XCTAssertTrue(reads.unread.isEmpty, "Stale working frame must not create a phantom completion")
    }

    func testFirstSeenIdleIsNotEvidenceOfNewAnswer() {
        let reads = SessionCompletionReads()
        reads.ingest([], viewerId: "me")
        reads.ingest([run(.idle, since: 50, session: "old"), run(.idle, since: 110, session: "other")], viewerId: "me")
        XCTAssertTrue(reads.unread.isEmpty)
    }

    func testNewWorkAttentionAndErrorsReplaceCompletion() {
        for state in [AttentionState.working, .needs_attention, .error] {
            let reads = SessionCompletionReads()
            reads.ingest([run(.working, since: 10)], viewerId: "me")
            reads.ingest([run(.idle, since: 20)], viewerId: "me")
            reads.ingest([run(state, since: 30)], viewerId: "me")
            XCTAssertTrue(reads.unread.isEmpty)
        }
    }

    func testOnlyOwnedRunsAndAccountDirectoriesAreUsed() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let reads = SessionCompletionReads(directory: root.appendingPathComponent("account-a"))
        reads.ingest([run(.working, since: 10)], viewerId: nil)
        reads.ingest([run(.idle, since: 20)], viewerId: "me")
        XCTAssertTrue(reads.unread.isEmpty)
        reads.ingest([run(.working, since: 40, owner: "colleague")], viewerId: "me")
        reads.ingest([run(.idle, since: 50, owner: "colleague")], viewerId: "me")
        XCTAssertTrue(reads.unread.isEmpty)
        reads.ingest([run(.working, since: 60)], viewerId: "me")
        reads.ingest([run(.idle, since: 70)], viewerId: "me")
        XCTAssertNotNil(reads.unread["m::s"])
        XCTAssertTrue(SessionCompletionReads(directory: root.appendingPathComponent("account-b")).unread.isEmpty)
        // Drains the final disk write before deleting the fixture directory.
        XCTAssertNotNil(SessionCompletionReads(directory: root.appendingPathComponent("account-a")).unread["m::s"])
    }

    /// 31.10.2026: the phone saw four runs working, slept, and the agent
    /// restarted at 06:54 taking the runs with it; the morning snapshot had no
    /// run to go idle. The hub's stored finish lights the dot instead.
    func testStoredFinishLightsTheDotWhenTheRunIsGone() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let reads = SessionCompletionReads(directory: root)
        reads.ingest([run(.working, since: 10)], viewerId: "me")
        reads.ingest([], viewerId: "me")
        XCTAssertTrue(reads.unread.isEmpty)
        let done = SessionCompletion(machineId: "m", sessionId: "s", at: 20)
        reads.applyCompletions([done])
        XCTAssertEqual(reads.unread["m::s"], 20)
        XCTAssertEqual(reads.completed["m::s"]?.at, 20)
        // Replayed on the next reconnect after reading: stays read.
        reads.setVisibleSession("m::s")
        reads.setVisibleSession(nil)
        reads.applyCompletions([done])
        XCTAssertTrue(reads.unread.isEmpty)
        // And after a relaunch.
        let reloaded = SessionCompletionReads(directory: root)
        reloaded.applyCompletions([done])
        XCTAssertTrue(reloaded.unread.isEmpty)
    }

    func testStoredFinishAlreadySeenLiveOrReadElsewhereStaysRead() {
        let reads = SessionCompletionReads()
        reads.ingest([run(.working, since: 10)], viewerId: "me")
        reads.ingest([run(.idle, since: 20)], viewerId: "me")
        reads.setVisibleSession("m::s")
        reads.setVisibleSession(nil)
        reads.applyCompletions([SessionCompletion(machineId: "m", sessionId: "s", at: 20)])
        XCTAssertTrue(reads.unread.isEmpty, "the same finish the live run showed")

        reads.applyRemoteReads([SessionRead(machineId: "m", sessionId: "t", at: 35)])
        reads.applyCompletions([SessionCompletion(machineId: "m", sessionId: "t", at: 30)])
        XCTAssertNil(reads.unread["m::t"], "read on another device after it finished")
        XCTAssertNotNil(reads.completed["m::t"])
    }

    func testLiveIdleRunOfAStoredFinishDoesNotReopenIt() {
        let reads = SessionCompletionReads()
        reads.applyCompletions([SessionCompletion(machineId: "m", sessionId: "s", at: 20)])
        XCTAssertEqual(reads.unread["m::s"], 20)
        reads.setVisibleSession("m::s")
        reads.setVisibleSession(nil)
        reads.ingest([run(.idle, since: 20)], viewerId: "me")
        XCTAssertTrue(reads.unread.isEmpty)
        // A newer turn on that run is news again.
        reads.ingest([run(.working, since: 30)], viewerId: "me")
        reads.ingest([run(.idle, since: 40)], viewerId: "me")
        XCTAssertEqual(reads.unread["m::s"], 40)
        // An older stored finish cannot override what the device saw since.
        reads.setVisibleSession("m::s")
        reads.setVisibleSession(nil)
        reads.applyCompletions([SessionCompletion(machineId: "m", sessionId: "s", at: 20)])
        XCTAssertTrue(reads.unread.isEmpty)
    }

    func testRemoteReadClearsUnreadAndBlocksReplay() {
        let reads = SessionCompletionReads()
        reads.ingest([run(.working, since: 10)], viewerId: "me")
        reads.ingest([run(.idle, since: 20)], viewerId: "me")
        XCTAssertEqual(reads.unread["m::s"], 20)
        XCTAssertTrue(reads.applyRemoteReads([SessionRead(machineId: "m", sessionId: "s", at: 15)]).isEmpty)
        XCTAssertEqual(reads.unread["m::s"], 20) // read before the finish: still unread
        XCTAssertEqual(reads.applyRemoteReads([SessionRead(machineId: "m", sessionId: "s", at: 25)]), ["m::s"])
        XCTAssertTrue(reads.unread.isEmpty)
        // A later older mark never lowers the stored one; the same finish stays read.
        reads.applyRemoteReads([SessionRead(machineId: "m", sessionId: "s", at: 5)])
        reads.ingest([run(.working, since: 10)], viewerId: "me")
        reads.ingest([run(.idle, since: 20)], viewerId: "me")
        XCTAssertTrue(reads.unread.isEmpty)
        // A newer finish is unread again.
        reads.ingest([run(.working, since: 30)], viewerId: "me")
        reads.ingest([run(.idle, since: 40)], viewerId: "me")
        XCTAssertEqual(reads.unread["m::s"], 40)
    }

    func testRemoteReadsPersistWithSnapshot() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        var reads = SessionCompletionReads(directory: root)
        reads.applyRemoteReads([SessionRead(machineId: "m", sessionId: "s", at: 100)])
        reads = SessionCompletionReads(directory: root)
        reads.ingest([run(.working, since: 10)], viewerId: "me")
        reads.ingest([run(.idle, since: 20)], viewerId: "me")
        XCTAssertTrue(reads.unread.isEmpty)
        _ = SessionCompletionReads(directory: root) // Drain disk writes before cleanup.
    }
}
