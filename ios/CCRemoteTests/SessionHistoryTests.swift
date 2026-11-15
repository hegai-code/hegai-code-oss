import XCTest
@testable import CCRemote
@testable import CCRemoteKit

@MainActor
final class SessionHistoryTests: XCTestCase {
    private func messages(_ id: String, count: Int = 1) throws -> [HistoryMessage] {
        let raw = (0..<count).map { ["type": "assistant", "uuid": "\(id)-\($0)", "blocks": []] as [String: Any] }
        let data = try JSONSerialization.data(withJSONObject: ["messages": raw])
        return try JSONDecoder().decode(SessionMessagesResult.self, from: data).messages
    }

    func testOldTruncatedCacheIsShownButMustBeRefetched() async throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: dir) }
        let transcripts = dir.appendingPathComponent("Transcripts")
        try FileManager.default.createDirectory(at: transcripts, withIntermediateDirectories: true)
        let key = TranscriptCache.key(machineId: "m", sessionId: "s")
        try JSONEncoder().encode([key: 123.0]).write(to: transcripts.appendingPathComponent("index.v2.json"))
        let payload = #"{"messages":[{"type":"assistant","uuid":"tail","blocks":[{"kind":"text","text":"Last answer"}]}]}"#
        try Data(payload.utf8).write(to: transcripts.appendingPathComponent("\(key).json"))
        let cache = TranscriptCache(directory: dir)
        let old = await cache.read(key)
        let freshness = await cache.cachedAt(key)
        XCTAssertEqual(old?.count, 1)
        XCTAssertNil(freshness)
        let state = SessionHistory()
        let restored = try messages("restored", count: 40)
        await state.load(cached: { old }, isFresh: { freshness == 123 }, read: { _ in restored })
        XCTAssertEqual(state.messages.count, 40)
    }

    func testLateReadCannotReplaceNewerHistory() async throws {
        let state = SessionHistory()
        state.select("m::s")
        let older = try messages("old")
        let newer = try messages("new", count: 2)
        var release: CheckedContinuation<[HistoryMessage], Never>?
        let started = expectation(description: "first read")
        let first = Task {
            await state.load(cached: { nil }, isFresh: { false }, read: { _ in
                await withCheckedContinuation { release = $0; started.fulfill() }
            })
        }
        await fulfillment(of: [started], timeout: 1)
        await state.load(cached: { nil }, isFresh: { false }, read: { _ in newer })
        release?.resume(returning: older)
        await first.value
        XCTAssertEqual(state.messages.count, 2)
    }

    func testLeavingSessionRejectsItsLateHistory() async throws {
        let state = SessionHistory()
        state.select("alice::m::s")
        let privateHistory = try messages("alice")
        var release: CheckedContinuation<[HistoryMessage], Never>?
        let started = expectation(description: "read")
        let first = Task {
            await state.load(cached: { nil }, isFresh: { false }, read: { _ in
                await withCheckedContinuation { release = $0; started.fulfill() }
            })
        }
        await fulfillment(of: [started], timeout: 1)
        state.select("bob::m::s")
        release?.resume(returning: privateHistory)
        await first.value
        XCTAssertTrue(state.messages.isEmpty)
        XCTAssertFalse(state.loading)
    }

    func testBusyAttachmentKeepsInitialHistoryAcrossAsyncCacheRead() async throws {
        let state = SessionHistory()
        state.select("m::s")
        let token = state.beginFocusRead()
        let transcript = try messages("initial", count: 4)
        var release: CheckedContinuation<[HistoryMessage]?, Never>?
        let started = expectation(description: "cache read")
        let load = Task {
            await state.load(cached: {
                await withCheckedContinuation { release = $0; started.fulfill() }
            }, isFresh: { false }, read: { _ in transcript })
        }
        await fulfillment(of: [started], timeout: 1)
        state.cancelForTurnStart()
        release?.resume(returning: nil)
        await load.value
        state.endFocusRead(token)
        XCTAssertEqual(state.messages.map(\.uuid), transcript.map(\.uuid))
    }

    func testOldCompletedPageCannotClearTurnStartedDuringFocusRead() async throws {
        let state = SessionHistory()
        let token = state.beginFocusRead()
        let oldCompletedTurn = try messages("old-answer")
        var release: CheckedContinuation<[HistoryMessage], Never>?
        let started = expectation(description: "initial history read")
        let load = Task {
            await state.load(cached: { nil }, isFresh: { false }, read: { _ in
                await withCheckedContinuation { release = $0; started.fulfill() }
            })
        }
        await fulfillment(of: [started], timeout: 1)
        state.cancelForTurnStart()
        // The new turn has already ended when this earlier page arrives.
        release?.resume(returning: oldCompletedTurn)
        await load.value
        XCTAssertTrue(SessionHistory.caughtUp(state.messages))
        XCTAssertFalse(state.endFocusRead(token), "only idle convergence may clear the new live answer")
    }

    func testIdleWaitsForInitialHistoryAndFailedConvergenceKeepsIt() async throws {
        let state = SessionHistory()
        let token = state.beginFocusRead()
        let transcript = try messages("base", count: 4)
        var release: CheckedContinuation<[HistoryMessage], Never>?
        let started = expectation(description: "initial read")
        let load = Task {
            await state.load(cached: { nil }, isFresh: { false }, read: { _ in
                await withCheckedContinuation { release = $0; started.fulfill() }
            })
        }
        await fulfillment(of: [started], timeout: 1)
        state.cancelForTurnStart()
        XCTAssertTrue(state.isFocusReading, "idle must defer convergence until this read finishes")
        release?.resume(returning: transcript)
        await load.value
        XCTAssertFalse(state.endFocusRead(token))
        XCTAssertFalse(state.isFocusReading)
        let converged = await state.converge(read: { _ in
            throw ClientError.connectionClosed
        }, pause: {})
        XCTAssertFalse(converged)
        XCTAssertEqual(state.messages.map(\.uuid), transcript.map(\.uuid))
    }

    func testAlreadyBusyReconnectCannotClearLiveAnswerWithOldPage() async throws {
        let state = SessionHistory()
        let token = state.beginFocusRead()
        // Reconnecting preserves busy=true, so there is no busy-change callback.
        state.cancelForTurnStart()
        let oldCompletedTurn = try messages("old-answer")
        await state.load(cached: { nil }, isFresh: { false }, read: { _ in oldCompletedTurn })
        XCTAssertTrue(SessionHistory.caughtUp(state.messages))
        XCTAssertFalse(state.endFocusRead(token), "the reconnect read must leave live lines to convergence")
    }

    func testReplacementFocusReadInheritsUnconvergedTurn() async throws {
        let state = SessionHistory()
        let firstToken = state.beginFocusRead()
        state.cancelForTurnStart()
        // The socket changes after idle, before the original read completes.
        let replacementToken = state.beginFocusRead()
        state.endFocusRead(firstToken)
        let oldCompletedTurn = try messages("old-answer")
        await state.load(cached: { nil }, isFresh: { false }, read: { _ in oldCompletedTurn })
        XCTAssertTrue(SessionHistory.caughtUp(state.messages))
        XCTAssertFalse(state.endFocusRead(replacementToken))
    }

    func testLaterTurnStillRejectsAnOutstandingRead() async throws {
        let state = SessionHistory()
        let token = state.beginFocusRead()
        state.endFocusRead(token)
        let transcript = try messages("old")
        var release: CheckedContinuation<[HistoryMessage], Never>?
        let started = expectation(description: "history read")
        let load = Task {
            await state.load(cached: { nil }, isFresh: { false }, read: { _ in
                await withCheckedContinuation { release = $0; started.fulfill() }
            })
        }
        await fulfillment(of: [started], timeout: 1)
        state.cancelForTurnStart()
        release?.resume(returning: transcript)
        await load.value
        XCTAssertTrue(state.messages.isEmpty)
    }

    func testLeavingDuringInitialReadStillCancelsPrivateHistory() async throws {
        let state = SessionHistory()
        state.select("alice::m::s")
        let token = state.beginFocusRead()
        let transcript = try messages("alice")
        var release: CheckedContinuation<[HistoryMessage], Never>?
        let started = expectation(description: "initial read")
        let load = Task {
            await state.load(cached: { nil }, isFresh: { false }, read: { _ in
                await withCheckedContinuation { release = $0; started.fulfill() }
            })
        }
        await fulfillment(of: [started], timeout: 1)
        state.select("bob::m::s")
        let nextToken = state.beginFocusRead()
        state.endFocusRead(token)
        state.cancelForTurnStart()
        release?.resume(returning: transcript)
        await load.value
        XCTAssertTrue(state.messages.isEmpty)
        state.endFocusRead(nextToken)
    }

    func testFailedRefreshKeepsVisibleHistory() async throws {
        let state = SessionHistory()
        let cached = try messages("cached")
        await state.load(cached: { cached }, isFresh: { false }, read: { _ in throw ClientError.connectionClosed })
        XCTAssertEqual(state.messages.count, 1)
        XCTAssertFalse(state.loading)
        XCTAssertFalse(state.confirmedCurrent, "a readable cache is not a confirmed current answer")
    }

    func testHistoryConfirmationRequiresFreshCacheOrSuccessfulRead() async throws {
        let state = SessionHistory()
        let cached = try messages("cached")
        await state.load(cached: { cached }, isFresh: { true }, read: { _ in
            XCTFail("fresh cache needs no read")
            return []
        })
        XCTAssertTrue(state.confirmedCurrent)
        await state.load(cached: { nil }, isFresh: { false }, read: { _ in throw ClientError.connectionClosed })
        XCTAssertFalse(state.confirmedCurrent)
        await state.load(cached: { nil }, isFresh: { false }, read: { _ in cached })
        XCTAssertTrue(state.confirmedCurrent)
        state.cancel()
        XCTAssertFalse(state.confirmedCurrent)
    }

    func testExpandedWindowSurvivesConvergenceAndStopsAtServerLimit() async throws {
        let state = SessionHistory()
        let tail = try messages("tail", count: 1000)
        let full = try messages("expanded", count: 2000)
        await state.load(cached: { nil }, isFresh: { false }, read: { _ in tail })
        XCTAssertTrue(state.expand())
        await state.load(cached: { nil }, isFresh: { false }, read: { limit in
            XCTAssertEqual(limit, 2000)
            return full
        })
        XCTAssertFalse(state.canLoadEarlier)
        var limits: [Int?] = []
        let converged = await state.converge(read: { limit in
            limits.append(limit)
            return limit == 2000 ? full : Array(full.suffix(SessionHistory.probeTail))
        })
        XCTAssertTrue(converged)
        XCTAssertEqual(limits, [SessionHistory.probeTail, 2000], "a small probe first, the expanded window once")
        XCTAssertEqual(state.messages.count, 2000)
        XCTAssertFalse(state.expand())
    }

    func testFailedExpansionCanBeRetried() async throws {
        let state = SessionHistory()
        let tail = try messages("tail", count: 1000)
        await state.load(cached: { nil }, isFresh: { false }, read: { _ in tail })
        XCTAssertTrue(state.expand())
        await state.load(cached: { nil }, isFresh: { false }, read: { _ in throw ClientError.connectionClosed })
        XCTAssertEqual(state.messages.count, 1000)
        XCTAssertTrue(state.canLoadEarlier)
        XCTAssertTrue(state.expand())
    }

    func testEarlierPageFailurePreservesConfirmationButExpandedReconnectDoesNot() async throws {
        let state = SessionHistory()
        let tail = try messages("tail", count: 1000)
        await state.load(cached: { nil }, isFresh: { false }, read: { _ in tail })
        XCTAssertTrue(state.expand())
        await state.load(preservingConfirmedTail: true, cached: { nil }, isFresh: { false },
                         read: { _ in throw ClientError.connectionClosed })
        XCTAssertTrue(state.confirmedCurrent)
        XCTAssertTrue(state.expand())
        await state.load(preservingConfirmedTail: true, cached: { nil }, isFresh: { false },
                         readPage: { _ in HistoryPage(messages: tail, stale: true) })
        XCTAssertTrue(state.confirmedCurrent, "ignored older page cannot invalidate the current tail")
        XCTAssertTrue(state.expand())
        await state.load(cached: { nil }, isFresh: { false }, read: { limit in
            XCTAssertEqual(limit, 2000)
            throw ClientError.connectionClosed
        })
        XCTAssertFalse(state.confirmedCurrent, "refresh must not inherit old confirmation just because the window is expanded")
    }

    /// 26.09.2026: the hub answered a slow machine's read from its 18-hour-old
    /// copy. That page's last pair is an old one, and accepting it as "caught
    /// up" cleared the live answer and put the old copy in its place.
    func testStaleReadNeverConvergesAndNeverReplacesShownHistory() async throws {
        let state = SessionHistory()
        let live = try messages("live", count: 3)
        await state.load(cached: { nil }, isFresh: { false }, read: { _ in live })
        let old = try messages("old", count: 2)
        var reads = 0
        let converged = await state.converge(readPage: { _ in
            reads += 1
            return HistoryPage(messages: old, stale: true)
        }, pause: {})
        XCTAssertFalse(converged, "a stale page must not let the caller drop live lines")
        XCTAssertEqual(reads, 7, "six cheap probes, then the last full read")
        XCTAssertEqual(state.messages.map(\.uuid), live.map(\.uuid))
        XCTAssertFalse(state.stale)

        XCTAssertFalse(state.confirmedCurrent)

        await state.load(cached: { nil }, isFresh: { false },
                         readPage: { _ in HistoryPage(messages: old, stale: true) })
        XCTAssertEqual(state.messages.map(\.uuid), live.map(\.uuid), "shown history outranks an old copy")
    }

    func testStalePageStillBeatsABlankScreenAndIsFlagged() async throws {
        let state = SessionHistory()
        state.select("m::s")
        let old = try messages("old", count: 2)
        await state.load(cached: { nil }, isFresh: { false },
                         readPage: { _ in HistoryPage(messages: old, stale: true) })
        XCTAssertEqual(state.messages.count, 2)
        XCTAssertTrue(state.stale)
        XCTAssertFalse(state.confirmedCurrent)
        let fresh = try messages("fresh", count: 4)
        let converged = await state.converge(readPage: { _ in HistoryPage(messages: fresh) }, pause: {})
        XCTAssertTrue(converged)
        XCTAssertEqual(state.messages.count, 4)
        XCTAssertFalse(state.stale)
        XCTAssertTrue(state.confirmedCurrent)
    }

    /// Review of the 26.09 fix: an older CACHE on screen that a stale page
    /// cannot beat is kept — and the read still reports that it confirmed
    /// nothing, so the caller does not clear live lines against the cache.
    func testStaleReadOverOlderCacheStillReportsStale() async throws {
        let state = SessionHistory()
        state.select("m::s")
        let cache = try messages("cache", count: 3)
        let old = try messages("old", count: 2)
        await state.load(cached: { cache }, isFresh: { false },
                         readPage: { _ in HistoryPage(messages: old, stale: true) })
        XCTAssertEqual(state.messages.map(\.uuid), cache.map(\.uuid))
        XCTAssertFalse(state.stale, "what is shown is the cache")
        XCTAssertTrue(state.lastReadStale, "but the read confirmed nothing")
        await state.load(cached: { nil }, isFresh: { false }, read: { _ in cache })
        XCTAssertFalse(state.lastReadStale)
    }

    private struct ReadFailed: Error {}

    func testTwoFailedReadsWithNothingShownReportFailure() async throws {
        let state = SessionHistory()
        state.select("m::s")
        var reads = 0
        await state.load(cached: { nil }, isFresh: { false }, read: { _ in
            reads += 1
            throw ReadFailed()
        }, retryPause: {})
        XCTAssertEqual(reads, 2, "one silent retry before giving up")
        XCTAssertTrue(state.failed)
        XCTAssertFalse(state.loading)
        XCTAssertTrue(state.messages.isEmpty)
    }

    func testSilentRetryRecoversWithoutReportingFailure() async throws {
        let state = SessionHistory()
        state.select("m::s")
        let page = try messages("ok", count: 3)
        var reads = 0
        await state.load(cached: { nil }, isFresh: { false }, read: { _ in
            reads += 1
            if reads == 1 { throw ReadFailed() }
            return page
        }, retryPause: {})
        XCTAssertFalse(state.failed)
        XCTAssertEqual(state.messages.count, 3)
    }

    func testFailedReadKeepsShownTranscriptAndReportsNothing() async throws {
        let state = SessionHistory()
        state.select("m::s")
        let shown = try messages("shown", count: 2)
        await state.load(cached: { nil }, isFresh: { false }, read: { _ in shown }, retryPause: {})
        var reads = 0
        await state.load(cached: { nil }, isFresh: { false }, read: { _ in
            reads += 1
            throw ReadFailed()
        }, retryPause: {})
        XCTAssertEqual(reads, 1, "no retry while a transcript is on screen")
        XCTAssertFalse(state.failed)
        XCTAssertEqual(state.messages.count, 2)
    }

    func testRetryAfterFailureClearsTheFlag() async throws {
        let state = SessionHistory()
        state.select("m::s")
        await state.load(cached: { nil }, isFresh: { false }, read: { _ in throw ReadFailed() }, retryPause: {})
        XCTAssertTrue(state.failed)
        let page = try messages("later")
        await state.load(cached: { nil }, isFresh: { false }, read: { _ in page }, retryPause: {})
        XCTAssertFalse(state.failed)
        XCTAssertEqual(state.messages.count, 1)
    }

    func testSwitchingSessionClearsFailure() async throws {
        let state = SessionHistory()
        state.select("m::s")
        await state.load(cached: { nil }, isFresh: { false }, read: { _ in throw ReadFailed() }, retryPause: {})
        XCTAssertTrue(state.failed)
        state.select("m::other")
        XCTAssertFalse(state.failed)
    }

    func testConvergenceThatNeverReadsReportsFailureOnBlankPage() async throws {
        let state = SessionHistory()
        state.select("m::s")
        let caughtUp = await state.converge(read: { _ in throw ReadFailed() }, pause: {})
        XCTAssertFalse(caughtUp)
        XCTAssertTrue(state.failed)
    }
    /// 24.10.2026 (iOS audit 8): end-of-turn convergence re-read the whole
    /// 1-2k-message window up to six times. It probes a small tail instead and
    /// reads the window once when the tail shows the answer.
    func testConvergenceProbesASmallTailAndReadsTheWindowOnce() async throws {
        let state = SessionHistory()
        // `before`: the question is saved, the answer is not yet.
        let before = [HistoryMessage(role: .assistant, uuid: "a0", blocks: []),
                      HistoryMessage(role: .user, uuid: "u1", blocks: [])]
        await state.load(cached: { nil }, isFresh: { false }, read: { _ in before })
        let after = before + [HistoryMessage(role: .assistant, uuid: "a1", blocks: [])]
        var calls: [Int?] = []
        var probes = 0
        let converged = await state.converge(readPage: { limit in
            calls.append(limit)
            if limit == SessionHistory.probeTail {
                probes += 1
                // The file has not caught up for the first two probes.
                return HistoryPage(messages: probes < 3 ? before : after)
            }
            return HistoryPage(messages: after)
        }, pause: {})
        XCTAssertTrue(converged)
        XCTAssertEqual(calls, [40, 40, 40, nil], "three cheap probes, ONE full read")
        XCTAssertEqual(state.messages.map(\.uuid), after.map(\.uuid))
        XCTAssertTrue(state.confirmedCurrent)
    }

    func testProbeThatNeverCatchesUpFallsBackToOneFullRead() async throws {
        let state = SessionHistory()
        state.select("m::s")
        var calls: [Int?] = []
        let converged = await state.converge(readPage: { limit in
            calls.append(limit)
            return HistoryPage(messages: [HistoryMessage(role: .user, uuid: "u", blocks: [])])
        }, pause: {})
        XCTAssertFalse(converged)
        XCTAssertEqual(calls.filter { $0 == nil }.count, 1, "the full window is read once, not per attempt")
        XCTAssertEqual(calls.count, 7)
        XCTAssertFalse(state.failed, "something answered, it just never showed an answer")
    }

    /// A history kept on the shelf: reopening an unchanged session reads
    /// nothing; a moved one is read again, the kept copy shown meanwhile.
    func testKeptHistoryOfAnUnchangedSessionNeedsNoRead() async throws {
        let shelf = SessionHistoryShelf()
        let state = shelf.history(for: "account-a::m::s")
        let first = try messages("first", count: 3)
        var reads = 0
        await state.load(mtime: 5, cached: { nil }, isFresh: { false }, read: { _ in reads += 1; return first })
        XCTAssertEqual(reads, 1)
        state.cancel()   // the screen was left
        let again = shelf.history(for: "account-a::m::s")
        XCTAssertTrue(again === state, "the same session gets its kept history back")
        XCTAssertEqual(again.messages.count, 3, "on screen before any read")
        await again.load(mtime: 5, cached: { nil }, isFresh: { false }, read: { _ in reads += 1; return first })
        XCTAssertEqual(reads, 1, "unchanged since it was confirmed: nothing to read")
        XCTAssertTrue(again.confirmedCurrent)
        let moved = try messages("moved", count: 4)
        await again.load(mtime: 6, cached: { nil }, isFresh: { false }, read: { _ in reads += 1; return moved })
        XCTAssertEqual(reads, 2)
        XCTAssertEqual(again.messages.count, 4)
    }

    func testShelfIsBoundedAndForgetsAnotherAccount() {
        let shelf = SessionHistoryShelf()
        let mine = shelf.history(for: "account-a::m::s0")
        for i in 1...SessionHistoryShelf.capacity { _ = shelf.history(for: "account-a::m::s\(i)") }
        XCTAssertFalse(shelf.history(for: "account-a::m::s0") === mine, "the least recently used one is dropped")
        let kept = shelf.history(for: "account-a::m::s6")
        _ = shelf.history(for: "account-b::m::s6")
        XCTAssertFalse(shelf.history(for: "account-a::m::s6") === kept, "another account's histories are not kept")
    }
}
