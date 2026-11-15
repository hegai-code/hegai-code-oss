import XCTest
@testable import CCRemoteKit

/// The enrich round trip on the wire: `enrich_result` decodes from the exact
/// shapes the hub emits (absent ≠ null), and `enrich_request` omits its
/// optionals rather than sending nulls.
final class EnrichProtocolTests: XCTestCase {
    private func decode(_ json: String) throws -> HubMessage {
        try JSONDecoder().decode(HubMessage.self, from: Data(json.utf8))
    }

    private func encode(_ msg: ClientMessage) throws -> [String: Any] {
        let data = try JSONEncoder().encode(msg)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    func testEnrichResultWithQuickRepliesDecodes() throws {
        let json = #"{"type":"enrich_result","requestId":"q1","ok":true,"enrichment":{"decisions":["Порог 420 мс"],"quickReplies":[{"label":"Да, раскатывай","send":"Да, раскатывай"}]}}"#
        guard case let .enrichResult(id, ok, enrichment, error) = try decode(json) else { return XCTFail("wrong case") }
        XCTAssertEqual(id, "q1")
        XCTAssertTrue(ok)
        XCTAssertNil(error)
        XCTAssertEqual(enrichment?.decisions, ["Порог 420 мс"])
        XCTAssertNil(enrichment?.digest)
        XCTAssertEqual(enrichment?.quickReplies?.first?.send, "Да, раскатывай")
    }

    func testEnrichResultCarriesTheHandoffVerdict() throws {
        let json = #"{"type":"enrich_result","requestId":"q4","ok":true,"enrichment":{"handoff":"question","quickReplies":[{"kind":"answer","label":"Разобраться с режимом «Сначала спрос»","send":"Разберись с режимом"}]}}"#
        guard case let .enrichResult(_, _, enrichment, _) = try decode(json) else { return XCTFail("wrong case") }
        XCTAssertEqual(enrichment?.handoff, "question")
        XCTAssertEqual(enrichment?.headline, "Ждёт твоего ответа:")
        XCTAssertEqual(enrichment?.quickReplies?.first?.label, "Разобраться с режимом «Сначала спрос»")
    }

    func testAnUnknownHandoffDecodesAndSaysNothing() throws {
        let json = #"{"type":"enrich_result","requestId":"q5","ok":true,"enrichment":{"handoff":"someday","quickReplies":[{"label":"Ок","send":"Ок"}]}}"#
        guard case let .enrichResult(_, _, enrichment, _) = try decode(json) else { return XCTFail("wrong case") }
        XCTAssertEqual(enrichment?.quickReplies?.count, 1, "an unknown verdict must not lose the buttons")
        XCTAssertNil(enrichment?.headline)
    }

    func testQuickReplyKindDecodesAndOldPayloadsStillDo() throws {
        let json = #"{"type":"enrich_result","requestId":"q6","ok":true,"enrichment":{"quickReplies":[{"kind":"idea","label":"Кэш","send":"Кэш"},{"label":"Ок","send":"Ок"},{"kind":"someday","label":"X","send":"X"}]}}"#
        guard case let .enrichResult(_, _, enrichment, _) = try decode(json) else { return XCTFail("wrong case") }
        let replies = try XCTUnwrap(enrichment?.quickReplies)
        XCTAssertEqual(replies.map(\.kind), ["idea", nil, "someday"])
        XCTAssertEqual(replies.map(\.isIdea), [true, false, false])
    }

    func testEnrichResultNotConfiguredCarriesNoEnrichment() throws {
        let json = #"{"type":"enrich_result","requestId":"q2","ok":false,"error":"enrichment not configured"}"#
        guard case let .enrichResult(_, ok, enrichment, error) = try decode(json) else { return XCTFail("wrong case") }
        XCTAssertFalse(ok)
        XCTAssertNil(enrichment)
        XCTAssertEqual(error, "enrichment not configured")
    }

    func testEnrichResultWithoutTheKeyMeansNothingToAdd() throws {
        let json = #"{"type":"enrich_result","requestId":"q3","ok":true}"#
        guard case let .enrichResult(_, ok, enrichment, _) = try decode(json) else { return XCTFail("wrong case") }
        XCTAssertTrue(ok)
        XCTAssertNil(enrichment)
    }

    func testEnrichRequestOmitsOptionalsWhenAbsent() throws {
        let bare = try encode(.enrichRequest(requestId: "q", machineId: "m", sessionId: "s", source: nil,
                                             uuid: "u", text: "Раскатывать?", userText: nil))
        XCTAssertEqual(bare["type"] as? String, "enrich_request")
        XCTAssertEqual(bare["uuid"] as? String, "u")
        XCTAssertNil(bare["source"])
        XCTAssertNil(bare["userText"])
        XCTAssertNil(bare["digest"])

        let full = try encode(.enrichRequest(requestId: "q", machineId: "m", sessionId: "s", source: "codex",
                                             uuid: "u", text: "Раскатывать?", userText: "Почини",
                                             digest: "USER TURN: …"))
        XCTAssertEqual(full["source"] as? String, "codex")
        XCTAssertEqual(full["userText"] as? String, "Почини")
        XCTAssertEqual(full["digest"] as? String, "USER TURN: …")
    }
}
