import XCTest
@testable import CCRemoteKit
@testable import CCRemote

@MainActor
final class PendingRegistryTests: XCTestCase {
    private enum TestError: Error { case timeout, closed }

    func testResolveReturnsValueAndClearsEntry() async throws {
        let registry = PendingRegistry<Int, String>(timeoutSeconds: 1)
        let task = Task {
            try await registry.wait(
                id: "one", context: "context", timeoutError: TestError.timeout,
                startError: TestError.closed, start: { true }
            )
        }
        await Task.yield()
        XCTAssertEqual(registry.context(for: "one"), "context")
        XCTAssertTrue(registry.resolve(id: "one", value: 42))
        let value = try await task.value
        XCTAssertEqual(value, 42)
        XCTAssertEqual(registry.count, 0)
    }

    func testRejectAllRunsCleanupAndRejectsEveryContinuation() async {
        let registry = PendingRegistry<Int, Void>(timeoutSeconds: 1)
        var cleanupCount = 0
        let tasks = (0..<2).map { index in
            Task {
                try await registry.wait(
                    id: "id-\(index)", context: (), timeoutError: TestError.timeout,
                    startError: TestError.closed, onReject: { cleanupCount += 1 },
                    start: { true }
                )
            }
        }
        await Task.yield()
        registry.rejectAll(error: TestError.closed)
        for task in tasks {
            do {
                _ = try await task.value
                XCTFail("expected rejection")
            } catch {
                XCTAssertTrue(error is TestError)
            }
        }
        XCTAssertEqual(cleanupCount, 2)
        XCTAssertEqual(registry.count, 0)
    }

    func testTimeoutRejectsAndRunsCleanup() async {
        let registry = PendingRegistry<Int, Void>(timeoutSeconds: 0.01)
        var cleaned = false
        do {
            _ = try await registry.wait(
                id: "slow", context: (), timeoutError: TestError.timeout,
                startError: TestError.closed, onReject: { cleaned = true },
                start: { true }
            )
            XCTFail("expected timeout")
        } catch {
            XCTAssertTrue(error is TestError)
        }
        XCTAssertTrue(cleaned)
        XCTAssertEqual(registry.count, 0)
    }

    func testCancellationSettlesAndCleansUpImmediately() async {
        let registry = PendingRegistry<Int, Void>(timeoutSeconds: 30)
        let started = expectation(description: "started")
        let settled = expectation(description: "cancelled")
        var cleanups = 0
        let task = Task {
            defer { settled.fulfill() }
            do {
                _ = try await registry.wait(id: "cancel", context: (),
                    timeoutError: TestError.timeout, startError: TestError.closed,
                    onReject: { cleanups += 1 }, start: { started.fulfill(); return true })
                XCTFail("cancelled wait succeeded")
            } catch { XCTAssertTrue(error is CancellationError) }
        }
        await fulfillment(of: [started], timeout: 1)
        task.cancel()
        await fulfillment(of: [settled], timeout: 1)
        XCTAssertEqual(cleanups, 1)
        XCTAssertEqual(registry.count, 0)
        XCTAssertFalse(registry.resolve(id: "cancel", value: 1))
    }

    func testAlreadyCancelledWaitStillCleansUpWithoutStarting() async {
        let registry = PendingRegistry<Int, Void>()
        var cleanups = 0
        let task = Task {
            withUnsafeCurrentTask { $0?.cancel() }
            do {
                _ = try await registry.wait(id: "cancelled", context: (),
                    timeoutError: TestError.timeout, startError: TestError.closed,
                    onReject: { cleanups += 1 }, start: { XCTFail("must not start"); return true })
                XCTFail("expected cancellation")
            } catch { XCTAssertTrue(error is CancellationError) }
        }
        await task.value
        XCTAssertEqual(cleanups, 1)
        XCTAssertEqual(registry.count, 0)
    }
}
