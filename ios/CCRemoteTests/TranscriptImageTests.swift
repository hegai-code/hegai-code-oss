import XCTest
import UIKit
@testable import CCRemote
import CCRemoteKit

@MainActor
final class TranscriptImageTests: XCTestCase {
    func testHistoryKeepsOpaqueRefAndAcceptsOlderMarkers() throws {
        let blocks = try JSONDecoder().decode([RenderBlock].self, from: Data(#"[{"kind":"image","ref":"turn-123#2"},{"kind":"image"}]"#.utf8))
        XCTAssertEqual(blocks, [.image(ref: "turn-123#2"), .image(ref: nil)])
    }

    func testCacheSeparatesSessionAndAccountAndRetriesFailures() async throws {
        let store = TranscriptImageStore()
        let picture = try result()
        var requests = 0
        let fetch = { requests += 1; return picture }
        let a = key("a", session: "same")
        let image = await store.load(a, fetch: fetch)
        XCTAssertNotNil(image)
        let again = await store.load(a, fetch: fetch)
        XCTAssertTrue(image === again)
        XCTAssertEqual(requests, 1)
        _ = await store.load(key("a", session: "other"), fetch: fetch)
        XCTAssertEqual(requests, 2)
        _ = await store.load(key("b", session: "same"), fetch: fetch)
        XCTAssertEqual(requests, 3)
        let failed = key("b", session: "failed")
        let missing = await store.load(failed) { throw URLError(.notConnectedToInternet) }
        XCTAssertNil(missing)
        let retried = await store.load(failed, fetch: fetch)
        XCTAssertNotNil(retried)
        XCTAssertEqual(requests, 4)
    }

    func testAccountSwitchDiscardsPendingOldImage() async throws {
        let store = TranscriptImageStore()
        let picture = try result()
        let started = expectation(description: "Old account image is loading")
        var reply: CheckedContinuation<SessionImageResult, Error>?
        let old = Task {
            await store.load(key("old", session: "same")) {
                try await withCheckedThrowingContinuation { continuation in
                    reply = continuation; started.fulfill()
                }
            }
        }
        await fulfillment(of: [started], timeout: 3)
        let current = await store.load(key("new", session: "same")) { picture }
        XCTAssertNotNil(current)
        reply?.resume(returning: picture)
        let stale = await old.value
        XCTAssertNil(stale)
    }

    func testConcurrentViewsShareOneImageRequest() async throws {
        let store = TranscriptImageStore()
        let picture = try result()
        let started = expectation(description: "First request is pending")
        let joined = expectation(description: "Second view joins the request")
        let imageKey = key("account", session: "same")
        var reply: CheckedContinuation<SessionImageResult, Error>?
        let first = Task {
            await store.load(imageKey) {
                try await withCheckedThrowingContinuation { continuation in
                    reply = continuation; started.fulfill()
                }
            }
        }
        await fulfillment(of: [started], timeout: 3)
        let second = Task {
            joined.fulfill()
            return await store.load(imageKey) {
                XCTFail("A second view must share the pending request")
                return picture
            }
        }
        await fulfillment(of: [joined], timeout: 3)
        reply?.resume(returning: picture)
        let firstImage = await first.value
        let secondImage = await second.value
        XCTAssertNotNil(firstImage)
        XCTAssertTrue(firstImage === secondImage)
    }

    private func key(_ scope: String, session: String) -> TranscriptImageStore.Key {
        .init(scope: scope, source: .init(machineId: "m", sessionId: session, source: "codex"), ref: "photo#1")
    }
    private func result() throws -> SessionImageResult {
        let png = UIGraphicsImageRenderer(size: CGSize(width: 8, height: 8)).pngData { context in
            UIColor.blue.setFill(); context.fill(CGRect(x: 0, y: 0, width: 8, height: 8))
        }
        let json = try JSONSerialization.data(withJSONObject: ["mediaType": "image/png", "dataB64": png.base64EncodedString()])
        return try JSONDecoder().decode(SessionImageResult.self, from: json)
    }
}
