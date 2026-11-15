import XCTest
@testable import CCRemote
@testable import CCRemoteKit

final class ConversationDocumentTests: XCTestCase {
    private func message(_ id: String, _ role: MessageRole, _ text: String) -> HistoryMessage {
        HistoryMessage(role: role, uuid: id, blocks: [.text(text)])
    }
    func testExportOmitsMachineryKeepsMarkdownAndPhotos() {
        let doc = ConversationDocument(history: [
            HistoryMessage(role: .user, uuid: "u", blocks: [.text("Проверь"), .image(ref: nil)]),
            HistoryMessage(role: .assistant, uuid: "a", blocks: [.thinking("private"),
                .text("## Ответ\n\n**Готово**"), .toolUse(id: "t", name: "Read", input: .null)])
        ], lines: [], limited: true)
        let markdown = doc.markdown(title: "Тест", agent: "Codex")
        XCTAssertTrue(markdown.contains("[Фото]"))
        XCTAssertTrue(markdown.contains("## Ответ\n\n**Готово**"))
        XCTAssertTrue(markdown.contains("2000"))
        XCTAssertFalse(markdown.contains("private"))
        XCTAssertFalse(markdown.contains("Read"))
        XCTAssertEqual(doc.matching("готово").count, 1)
        XCTAssertEqual(doc.matching("  ").count, 0)
    }
    func testReplayReplacesOnlyCurrentTurnAndPreservesOlderRepeatedReply() {
        let doc = ConversationDocument(history: [message("u1", .user, "Один"),
            message("a1", .assistant, "Готово"), message("u2", .user, "Два"),
            message("a2", .assistant, "Готово"), message("a3", .assistant, "Продолжение")],
            lines: [TranscriptLine(id: 1, kind: .assistant, text: "Готово"),
                    TranscriptLine(id: 2, kind: .assistant, text: "Продолжение")], limited: false)
        XCTAssertEqual(doc.entries.map(\.text), ["Один", "Готово", "Два", "Готово", "Продолжение"])
    }
    func testShortReplayNeverDropsHistoryBeyondItsBuffer() {
        let doc = ConversationDocument(history: [message("u", .user, "Вопрос"),
            message("a", .assistant, "Первый ответ"), message("b", .assistant, "Второй ответ")],
            lines: [TranscriptLine(id: 1, kind: .assistant, text: "Первый ответ")], limited: false)
        XCTAssertEqual(doc.entries.map(\.text), ["Вопрос", "Первый ответ", "Второй ответ"])
    }
    func testEchoedUserAndAnswerAtSeamAreNotDuplicated() {
        let doc = ConversationDocument(history: [message("u", .user, "Вопрос"), message("a", .assistant, "Ответ")],
            lines: [TranscriptLine(id: 1, kind: .user, text: "Вопрос"),
                    TranscriptLine(id: 2, kind: .assistant, text: "Ответ"),
                    TranscriptLine(id: 3, kind: .assistant, text: "Ещё")], limited: false)
        XCTAssertEqual(doc.entries.map(\.text), ["Вопрос", "Ответ", "Ещё"])
    }
}
