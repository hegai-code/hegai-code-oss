import XCTest
@testable import CCRemoteKit
@testable import CCRemote

/// Locks the attention-transition diffing from useCentral.ts:211-278: notify only
/// on a genuine transition into needs_attention/idle/error, never for the focused
/// run, and never on the first frame after a (re)connect (`seeded`).
@MainActor
final class NotificationEngineTests: XCTestCase {
    private var idSeq = 0
    private func nextId() -> Int { idSeq += 1; return idSeq }

    private func run(_ id: String, _ state: AttentionState, owner: String = "me", since: Double = 0) -> ActiveRunInfo {
        ActiveRunInfo(runId: id, machineId: "m", machineName: "Mac", sessionId: "s-\(id)",
                      title: "Run \(id)", project: nil, state: state, preview: nil, since: since,
                      ownerUserId: owner)
    }

    /// The Inbox is owner-scoped, so every engine under test has to know who is
    /// looking — an engine with no viewer notifies about nothing.
    private func engine() -> NotificationEngine {
        let e = NotificationEngine()
        e.viewerId = "me"
        return e
    }

    /// A read mark from another device drops the session's error/decision entries
    /// (no unread dot behind them) up to the mark, and keeps a newer one.
    func testRemoteReadDismissesEntriesUpToMark() {
        let e = engine()
        e.ingest([run("a", .working), run("b", .working)], focusedRunId: nil, nextId: nextId)   // seed
        e.ingest([run("a", .error, since: 100), run("b", .needs_attention, since: 100)],
                 focusedRunId: nil, nextId: nextId)
        XCTAssertEqual(e.items.count, 2)
        XCTAssertEqual(e.items.first { $0.runId == "a" }?.since, 100)
        e.dismiss(machineId: "m", sessionId: "s-a", upTo: 99)       // mark older than the entry
        XCTAssertEqual(e.items.count, 2)
        e.dismiss(machineId: "m", sessionId: "s-a", upTo: 100)      // covers it
        XCTAssertEqual(e.items.map(\.runId), ["b"])                  // other session untouched
        XCTAssertEqual(e.unread, 1)
    }

    func testFirstFrameSeedsWithoutNotifying() {
        let e = engine()
        e.ingest([run("a", .needs_attention)], focusedRunId: nil, nextId: nextId)
        XCTAssertEqual(e.items.count, 0)   // seeded: no storm on first load
        XCTAssertEqual(e.unread, 0)
    }

    func testTransitionIntoNeedsAttentionNotifies() {
        let e = engine()
        e.ingest([run("a", .working)], focusedRunId: nil, nextId: nextId)       // seed
        e.ingest([run("a", .needs_attention)], focusedRunId: nil, nextId: nextId)
        XCTAssertEqual(e.items.count, 1)
        XCTAssertEqual(e.items.first?.state, .needs_attention)
        XCTAssertEqual(e.unread, 1)
    }

    func testTransitionIntoWorkingDoesNotNotify() {
        let e = engine()
        e.ingest([run("a", .idle)], focusedRunId: nil, nextId: nextId)          // seed
        e.ingest([run("a", .working)], focusedRunId: nil, nextId: nextId)
        XCTAssertEqual(e.items.count, 0)   // working is not a NOTIFY state
    }

    func testFocusedRunSuppressed() {
        let e = engine()
        e.ingest([run("a", .working)], focusedRunId: "a", nextId: nextId)       // seed
        e.ingest([run("a", .needs_attention)], focusedRunId: "a", nextId: nextId)
        XCTAssertEqual(e.items.count, 0)   // the run you're looking at never notifies
    }

    func testNoRepeatWhenStateUnchanged() {
        let e = engine()
        e.ingest([run("a", .working)], focusedRunId: nil, nextId: nextId)       // seed
        e.ingest([run("a", .error)], focusedRunId: nil, nextId: nextId)         // 1 notif
        e.ingest([run("a", .error)], focusedRunId: nil, nextId: nextId)         // same → no new
        XCTAssertEqual(e.items.count, 1)
    }

    func testResetSeedSuppressesNextFrame() {
        let e = engine()
        e.ingest([run("a", .working)], focusedRunId: nil, nextId: nextId)       // seed
        e.resetSeed()                                                           // reconnect
        e.ingest([run("a", .needs_attention)], focusedRunId: nil, nextId: nextId)
        XCTAssertEqual(e.items.count, 0)   // first frame after reconnect re-seeds silently
    }

    func testColleaguesRunNeverNotifies() {
        let e = engine()
        e.ingest([run("a", .working), run("b", .working, owner: "varya")], focusedRunId: nil, nextId: nextId)
        e.ingest([run("a", .idle), run("b", .needs_attention, owner: "varya")], focusedRunId: nil, nextId: nextId)
        XCTAssertEqual(e.items.count, 1)          // only the viewer's own run
        XCTAssertEqual(e.items.first?.runId, "a")
    }

    func testNoViewerNotifiesNothing() {
        let e = NotificationEngine()              // viewerId left nil
        e.ingest([run("a", .working)], focusedRunId: nil, nextId: nextId)
        e.ingest([run("a", .needs_attention)], focusedRunId: nil, nextId: nextId)
        XCTAssertEqual(e.items.count, 0)
    }

    func testCapsAtSixty() {
        let e = engine()
        e.ingest([run("x", .working)], focusedRunId: nil, nextId: nextId)       // seed
        for i in 0..<70 {
            // Alternate a distinct run into error each frame to force fresh notifs.
            e.ingest([run("r\(i)", .working)], focusedRunId: nil, nextId: nextId)
            e.ingest([run("r\(i)", .error)], focusedRunId: nil, nextId: nextId)
        }
        XCTAssertLessThanOrEqual(e.items.count, 60)
    }

    // MARK: - The bell clears itself (web pruneInbox, 78155a2)

    func testAnsweredPromptLeavesTheBell() {
        let e = engine()
        e.ingest([run("a", .working)], focusedRunId: nil, nextId: nextId)
        var waiting = run("a", .needs_attention)
        waiting.pendingRequestId = "q1"
        e.ingest([waiting], focusedRunId: nil, nextId: nextId)
        XCTAssertEqual(e.items.count, 1)
        e.ingest([waiting], focusedRunId: nil, nextId: nextId)
        XCTAssertEqual(e.items.count, 1, "still the same prompt")
        e.ingest([run("a", .working)], focusedRunId: nil, nextId: nextId)
        XCTAssertEqual(e.items.count, 0, "answered: nothing left to do")
        XCTAssertEqual(e.unread, 0)
    }

    func testFinishedRunStaysUntilItMovesOnOrIsOpened() {
        let e = engine()
        e.ingest([run("a", .working), run("b", .working)], focusedRunId: nil, nextId: nextId)
        e.ingest([run("a", .idle), run("b", .error)], focusedRunId: nil, nextId: nextId)
        XCTAssertEqual(e.items.count, 2)
        // A run that disappears keeps its entry: a result is still news.
        e.ingest([run("b", .error)], focusedRunId: nil, nextId: nextId)
        XCTAssertEqual(e.items.map(\.runId).sorted(), ["a", "b"])
        // Opening its session is reading it.
        e.ingest([run("b", .error)], focusedRunId: "b", nextId: nextId)
        XCTAssertEqual(e.items.map(\.runId), ["a"])
    }
}
