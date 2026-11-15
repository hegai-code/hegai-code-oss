import XCTest
@testable import CCRemoteKit

final class RateLimitNoticeTests: XCTestCase {
    func testWirePayloadAndFormatting() throws {
        let frame = #"{"type":"stream","runId":"r","sessionId":"s","event":{"kind":"status","code":"rate_limit","text":"raw","data":{"status":"allowed_warning","rateLimitType":"seven_day","utilization":0.919,"resetsAt":1790858400}}}"#
        guard case let .stream(_, _, event) = try JSONDecoder().decode(HubMessage.self, from: Data(frame.utf8)) else { return XCTFail("stream") }
        let notice = try XCTUnwrap(RateLimitNotice(data: event.data))
        XCTAssertEqual(notice.percent, 91)
        XCTAssertEqual(notice.resetsAt, 1_790_858_400_000)
        XCTAssertEqual(notice.message, "Использовано 91% недельного лимита")
        let now = Date(timeIntervalSince1970: 1_790_858_400 - 7200)
        XCTAssertEqual(notice.resetText(now: now), "Сброс через 2 ч")
        XCTAssertFalse(notice.isCurrent(now: now.addingTimeInterval(7200)))
        let ms = RateLimitNotice(data: .init(status: "allowed_warning", utilization: 91.9, resetsAt: 1_790_858_400_000))!
        XCTAssertEqual(ms.percent, 91); XCTAssertEqual(ms.resetsAt, notice.resetsAt)
    }

    func testMalformedUnknownAndExhaustedQuota() throws {
        XCTAssertNil(RateLimitNotice(data: nil))
        XCTAssertNil(RateLimitNotice(data: .init(status: "allowed")))
        XCTAssertNil(RateLimitNotice(data: .init(status: "future")))
        for value in [Double.nan, .infinity, -1, 0] {
            let n = RateLimitNotice(data: .init(status: "allowed_warning", utilization: value, resetsAt: value))!
            XCTAssertNil(n.percent); XCTAssertNil(n.resetsAt)
        }
        let data = try JSONDecoder().decode(StreamUsageData.self, from: Data(#"{"status":"rejected","rateLimitType":17,"utilization":"bad","resetsAt":null}"#.utf8))
        XCTAssertEqual(RateLimitNotice(data: data)?.message, "Лимит подписки исчерпан")
        XCTAssertEqual(RateLimitNotice(data: .init(status: "allowed_warning", utilization: 900))?.percent, 100)
        XCTAssertEqual(RateLimitNotice(data: .init(status: "rejected", rateLimitType: "seven_day_opus"))?.message,
                       "Недельный лимит Opus исчерпан")
    }
}

@MainActor
final class RateLimitNoticeStoreTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_790_000_000)
    private func data(_ percent: Double = 0.91, reset: Double = 1_791_000_000, status: String = "allowed_warning") -> StreamUsageData {
        .init(status: status, rateLimitType: "seven_day", utilization: percent, resetsAt: reset)
    }
    func testClaimsPersistAcrossChatsAndRelaunchWithEscalation() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = RateLimitNotices(directory: directory)
        store.receive(data(), machineId: "m")
        let reloadedBeforeDisplay = RateLimitNotices(directory: directory)
        reloadedBeforeDisplay.receive(data(), machineId: "m")
        XCTAssertNotNil(reloadedBeforeDisplay.claim(machineId: "m", now: now), "Receipt alone must not claim a warning")
        let reloaded = RateLimitNotices(directory: directory)
        for percent in [0.91, 0.94, 0.99] {
            reloaded.receive(data(percent), machineId: "m")
            XCTAssertNil(reloaded.claim(machineId: "m", now: now))
        }
        reloaded.receive(data(status: "rejected"), machineId: "m")
        XCTAssertNotNil(reloaded.claim(machineId: "m", now: now))
        XCTAssertNil(reloaded.claim(machineId: "m", now: now))
        reloaded.receive(data(reset: 1_792_000_000), machineId: "m")
        XCTAssertNotNil(reloaded.claim(machineId: "m", now: now))
        reloaded.receive(data(), machineId: "other")
        XCTAssertNotNil(reloaded.claim(machineId: "other", now: now))
        let otherAccount = RateLimitNotices(directory: directory.appendingPathComponent("other-account"))
        otherAccount.receive(data(), machineId: "m")
        XCTAssertNotNil(otherAccount.claim(machineId: "m", now: now))
    }
    func testNextDecadeExpiryAllowedAndBoundedStorage() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = RateLimitNotices(directory: directory)
        for percent in [0.76, 0.80, 0.90] {
            store.receive(data(percent), machineId: "m")
            XCTAssertNotNil(store.claim(machineId: "m", now: now))
        }
        store.receive(data(reset: now.timeIntervalSince1970), machineId: "m")
        XCTAssertNil(store.claim(machineId: "m", now: now))
        store.receive(data(status: "allowed"), machineId: "m")
        XCTAssertNil(store.latest["m"])
        for i in 0..<40 {
            store.receive(data(), machineId: "m-\(i)")
            XCTAssertNotNil(store.claim(machineId: "m-\(i)", now: now))
        }
        let keys = try JSONDecoder().decode([String].self, from: Data(contentsOf: directory.appendingPathComponent("RateLimitNotices.json")))
        XCTAssertEqual(keys.count, RateLimitNotices.capacity)
    }

    func testReconnectToSameVerifiedAccountKeepsClaimsAndOtherAccountDoesNot() async {
        let h = ClientHarness(); defer { h.clean() }; await h.connect()
        h.sockets.last!.feed(#"{"type":"snapshot","machines":[],"viewer":{"userId":"alice","platformAdmin":false,"email":"a@example.test","workspace":{"workspaceId":"w","name":"W","kind":"personal","role":"owner"},"workspaces":[]}}"#)
        for _ in 0..<100 where h.client.viewer == nil { await h.settle() }
        let scope = h.client.storageScope
        h.client.rateLimitNotices.receive(data(), machineId: "m")
        XCTAssertNotNil(h.client.rateLimitNotices.claim(machineId: "m", now: now))
        await h.connect(workspace: "w")
        XCTAssertEqual(h.client.storageScope, scope)
        h.client.rateLimitNotices.receive(data(), machineId: "m")
        XCTAssertNil(h.client.rateLimitNotices.claim(machineId: "m", now: now))
        await h.connect(token: "bob")
        XCTAssertTrue(h.client.rateLimitNotices.latest.isEmpty)
        h.client.rateLimitNotices.receive(data(), machineId: "m")
        XCTAssertNotNil(h.client.rateLimitNotices.claim(machineId: "m", now: now))
    }

    func testClientRoutesWarningsOutOfTranscriptWithoutCommittingReplay() async throws {
        let h = ClientHarness(); defer { h.clean() }; await h.connect()
        let socket = h.sockets.last!
        socket.feed(#"{"type":"snapshot","machines":[],"activeRuns":[{"runId":"r","machineId":"m","sessionId":"s","state":"working","since":1}]}"#)
        for _ in 0..<100 where h.client.activeRuns.isEmpty { await h.settle() }
        h.client.focusSession(machineId: "m", sessionId: "s")
        socket.feed(#"{"type":"opened","runId":"r","machineId":"m","sessionId":"s"}"#)
        socket.feed(#"{"type":"user_turn","runId":"r","turnId":"u","text":"Вопрос"}"#)
        let warning = #"{"type":"stream","runId":"r","sessionId":"s","event":{"kind":"status","code":"rate_limit","text":"raw warning","data":{"status":"allowed_warning","rateLimitType":"seven_day","utilization":0.91}}}"#
        for _ in 0..<3 { socket.feed(warning) }
        for _ in 0..<100 where h.client.rateLimitNotices.latest.isEmpty { await h.settle() }
        XCTAssertEqual(h.client.rateLimitNotices.latest["m"]?.percent, 91)
        XCTAssertTrue(h.client.lines.isEmpty, "Quota receipt must not publish an incomplete replay")
        try await Task.sleep(for: .seconds(CentralClient.replayMaxHold + 0.1))
        XCTAssertEqual(h.client.lines.map(\.text), ["Вопрос"])
        socket.feed(warning.replacingOccurrences(of: "allowed_warning", with: "rejected"))
        socket.feed(warning.replacingOccurrences(of: "allowed_warning", with: "rejected"))
        for _ in 0..<100 where h.client.lines.count < 2 { await h.settle() }
        XCTAssertEqual(h.client.lines.map(\.text), ["Вопрос", "Недельный лимит исчерпан"])
        socket.feed(warning.replacingOccurrences(of: #""runId":"r""#, with: #""runId":"other""#))
        await h.settle()
        XCTAssertTrue(h.client.rateLimitNotices.latest["m"]!.rejected)
        socket.feed(#"{"type":"user_turn","runId":"r","turnId":"next","text":"Ещё вопрос"}"#)
        socket.feed(warning.replacingOccurrences(of: "allowed_warning", with: "rejected"))
        for _ in 0..<100 where h.client.lines.count < 4 { await h.settle() }
        XCTAssertEqual(h.client.lines.map(\.text), ["Вопрос", "Недельный лимит исчерпан", "Ещё вопрос", "Недельный лимит исчерпан"])
        h.client.disconnect()
        XCTAssertTrue(h.client.rateLimitNotices.latest.isEmpty)
    }
}
