import XCTest
@testable import CCRemote
@testable import CCRemoteKit

final class TranscriptReconciliationTests: XCTestCase {
    private let prompt = "Почини и что с редизайном от фейбл?"
    private let opening = "Исправлю сбой конвейера, проверю регрессионным тестом и доставлю фикс на production."
    private let continuation = "Рецензия Fable уже получена."

    func testEchoedPromptAndGrowingAnswerAppearOnlyOnce() {
        let history = [
            HistoryMessage(role: .user, uuid: "u", blocks: [.text(prompt)]),
            HistoryMessage(role: .assistant, uuid: "a", blocks: [.text(opening)])
        ]
        let lines = [TranscriptLine(id: 1, kind: .user, text: prompt),
            TranscriptLine(id: 2, kind: .assistant, text: opening + "\n\n" + continuation)]
        let merged = TranscriptReconciler().reconcile(history: history, lines: lines)
        let rows = transcriptRows(history: TranscriptMemo().items(for: history),
                                  live: groupLive(merged), busy: true)
        let text = rows.compactMap { row -> String? in
            switch row.content {
            case .history(let message, _): return message.blocks.compactMap {
                if case .text(let text) = $0 { return text }; return nil
            }.joined(separator: "\n\n")
            case .live(let line, _): return line.text
            default: return nil
            }
        }.joined(separator: "\n\n")
        XCTAssertEqual(text.components(separatedBy: prompt).count - 1, 1)
        XCTAssertEqual(text.components(separatedBy: opening).count - 1, 1)
        XCTAssertTrue(text.contains(continuation))
    }
    private func message(_ id: String, _ role: MessageRole, _ text: String, ts: Double? = nil) -> HistoryMessage {
        HistoryMessage(role: role, uuid: id, blocks: [.text(text)], ts: ts)
    }
    private func line(_ id: Int, _ kind: TranscriptLine.Kind, _ text: String, streaming: Bool = false,
                      ts: Double? = nil) -> TranscriptLine {
        TranscriptLine(id: id, kind: kind, text: text, streaming: streaming, ts: ts)
    }
    private func remaining(_ history: [HistoryMessage], _ lines: [TranscriptLine]) -> [String] {
        TranscriptReconciler().reconcile(history: history, lines: lines).map(\.text)
    }

    func testStreamingPrefixAndContinuedAnswerAreNotDuplicated() {
        let history = [message("u", .user, "Вопрос"), message("a", .assistant, "Первый ответ")]
        XCTAssertEqual(remaining(history, [line(1, .assistant, "Первый", streaming: true)]), [])
        XCTAssertEqual(remaining(history, [line(1, .assistant, "Первый ответ\n\nПродолжение", streaming: true)]), ["Продолжение"])
    }
    func testDifferentParagraphSegmentation() {
        let history = [message("u", .user, "Вопрос"), message("a", .assistant, "Один"), message("b", .assistant, "Два")]
        XCTAssertEqual(remaining(history, [line(1, .assistant, "Один\n\nДва\n\nТри")]), ["Три"])
        let combined = [message("u", .user, "Вопрос"), message("a", .assistant, "Один\n\nДва")]
        XCTAssertEqual(remaining(combined, [line(1, .assistant, "Один"), line(2, .assistant, "Два"),
                                           line(3, .assistant, "Три")]), ["Три"])
    }
    func testShortReplayPreservesSavedContinuation() {
        let history = [message("u", .user, "Вопрос"), message("a", .assistant, "Один"), message("b", .assistant, "Два")]
        let doc = ConversationDocument(history: history, lines: [line(1, .assistant, "Один")], limited: false)
        XCTAssertEqual(doc.entries.map(\.text), ["Вопрос", "Один", "Два"])
    }
    func testRepeatedNewPromptRemainsEvenWithIdenticalAnswer() {
        let history = [message("u", .user, "Да", ts: 10_000), message("a", .assistant, "Готово", ts: 11_000)]
        XCTAssertEqual(remaining(history, [line(1, .user, "Да", ts: 30_000), line(2, .assistant, "Готово")]), ["Да", "Готово"])
        XCTAssertEqual(remaining([message("u", .user, "Да")], [line(1, .user, "Да")]), ["Да"])
    }
    func testAmbiguousUserOnlyReplayIsRetained() {
        XCTAssertEqual(remaining([message("u", .user, "Да", ts: 10_000)],
                                 [line(1, .user, "Да", ts: 10_200)]), ["Да"])
    }

    func testConfirmedQuestionWithOnlyToolsIsNotDrawnTwice() {
        for delay: Double in [0, 250, 30_000] {
            let history = [message("u", .user, prompt, ts: 100_000 + delay),
                HistoryMessage(role: .assistant, uuid: "tools", blocks: [
                    .toolUse(id: "t", name: "Read", input: .null)], ts: 131_000)]
            let lines = [TranscriptLine(id: 1, kind: .user, text: prompt, ts: 100_000, turnId: "hub"),
                         line(2, .tool_use, "Bash {}")]
            let merged = TranscriptReconciler().reconcile(history: history, lines: lines)
            XCTAssertEqual(merged.map(\.id), [2])
            let rows = transcriptRows(history: groupHistory(history), live: groupLive(merged), busy: true)
            let speech = rows.filter { if case .day = $0.content { return false }; return true }
            XCTAssertEqual(speech.count, 2, "The saved question once, then one gear")
            // The agent has not said anything yet: the saved commands and the
            // live ones are one run of their own, not a gear on the question.
            XCTAssertFalse(speech[0].hasActivity)
            XCTAssertEqual(speech.last?.blocks.count, 1)
            XCTAssertEqual(speech.last?.lines.map(\.id), [2])
            XCTAssertEqual(ConversationDocument(history: history, lines: lines, limited: false).entries.map(\.text), [prompt])
        }
    }

    /// 10.10.2026, web (shop-app): history hangs a helper's
    /// `<task-notification>` on its Agent result. Read as speech it broke the
    /// web's seam and the turn was drawn twice. iOS strips it; pin that.
    func testHelperNotificationOnAgentResultDoesNotBreakSeam() {
        let notified = HistoryMessage(role: .user, uuid: "n", blocks: [
            .toolResult(toolUseId: "a1", text: "Async agent launched", isError: false),
            .text("<task-notification><tool-use-id>a1</tool-use-id><status>completed</status><result>отчёт</result></task-notification>"),
        ], ts: 160_000)
        let history = [message("old", .user, "раньше", ts: 1_000), message("oa", .assistant, "давно", ts: 2_000),
                       message("u1", .user, "сделай аудит", ts: 100_000),
                       message("a1", .assistant, "Берусь.", ts: 110_000),
                       notified,
                       message("u2", .user, "а по апи есть доступ?", ts: 200_000),
                       message("a2", .assistant, "Проверю.", ts: 210_000)]
        let lines = [TranscriptLine(id: 1, kind: .user, text: "сделай аудит", ts: 100_000, turnId: "u1"),
                     line(2, .assistant, "Берусь."),
                     line(3, .tool_use, "Agent"),
                     TranscriptLine(id: 4, kind: .user, text: "а по апи есть доступ?", ts: 200_000, turnId: "u2"),
                     line(5, .assistant, "Проверю."),
                     line(6, .tool_use, "Bash")]
        let merged = TranscriptReconciler().reconcile(history: history, lines: lines)
        XCTAssertEqual(merged.map(\.id), [3, 6], "speech the file already has is drawn once, machinery stays")
        let text = ConversationDocument(history: history, lines: lines, limited: false).entries.map(\.text)
        XCTAssertEqual(text.filter { $0 == "а по апи есть доступ?" }.count, 1)
        XCTAssertEqual(text.filter { $0 == "сделай аудит" }.count, 1)
    }

    /// 16.10.2026: a second message sent while the agent was still only
    /// launching helpers. No prose in the turn, two questions — the phone drew
    /// both questions and every helper card a second time under the saved turn.
    func testMidTurnSteerInToolOnlyTurnIsNotDrawnTwice() {
        let steer = "можешь использовать браузер"
        let history = [message("q", .user, prompt, ts: 100_100),
                       HistoryMessage(role: .assistant, uuid: "t1", blocks: [
                           .toolUse(id: "t1", name: "Agent", input: .null)], ts: 105_000),
                       message("s", .user, steer, ts: 131_000),
                       HistoryMessage(role: .assistant, uuid: "t2", blocks: [
                           .toolUse(id: "t2", name: "Agent", input: .null)], ts: 140_000)]
        let lines = [TranscriptLine(id: 1, kind: .user, text: prompt, ts: 100_000, turnId: "q"),
                     line(2, .tool_use, "Agent {}"),
                     TranscriptLine(id: 3, kind: .user, text: steer, ts: 130_900, turnId: "s"),
                     line(4, .tool_use, "Agent {}")]
        XCTAssertEqual(TranscriptReconciler().reconcile(history: history, lines: lines).map(\.id), [2, 4])
        // Not yet absorbed into the file: only the first question is proven.
        XCTAssertEqual(TranscriptReconciler().reconcile(history: Array(history.prefix(2)), lines: lines).map(\.id), [2, 3, 4])
        // An unconfirmed or out-of-window steer is no proof for the run.
        var echo = lines; echo[2].turnId = nil
        XCTAssertEqual(TranscriptReconciler().reconcile(history: history, lines: echo).map(\.id), [1, 2, 3, 4])
        var late = lines; late[2].ts = 90_000
        XCTAssertEqual(TranscriptReconciler().reconcile(history: history, lines: late).map(\.id), [1, 2, 3, 4])
    }

    func testToolOnlySeamKeepsRepeatedUndatedAndTruncatedQuestions() {
        let live = [TranscriptLine(id: 1, kind: .user, text: "Да", ts: 100_000, turnId: "new"),
                    line(2, .tool_use, "Read {}")]
        for time: Double? in [nil, 99_999, 130_001] {
            XCTAssertEqual(remaining([message("old", .user, "Да", ts: time)], live), live.map(\.text))
        }
        let truncated = TranscriptLine(id: 1, kind: .user, text: "Начало…", ts: 100_000, turnId: "new", truncated: true)
        XCTAssertEqual(remaining([message("u", .user, "Начало другого вопроса", ts: 100_000)], [truncated]), ["Начало…"])
        let unconfirmed = [line(1, .user, "Да", ts: 100_000), line(2, .tool_use, "Read {}")]
        XCTAssertEqual(remaining([message("u", .user, "Да", ts: 100_000)], unconfirmed), unconfirmed.map(\.text))
        let history = [message("u", .user, "Да", ts: 100_000)]
        XCTAssertEqual(remaining(history, live + [TranscriptLine(id: 3, kind: .user, text: "Да", ts: 100_200, turnId: "later")]), ["Read {}", "Да"])
    }
    func testOldIdenticalAnswerIsNotMatchedAcrossHumanTurn() {
        let history = [message("u1", .user, "Один"), message("a1", .assistant, "Готово"), message("u2", .user, "Два")]
        XCTAssertEqual(remaining(history, [line(1, .assistant, "Готово")]), ["Готово"])
    }
    func testNewFollowupAndUnmatchedReplayAreRetained() {
        let history = [message("u", .user, "Вопрос"), message("a", .assistant, "Ответ")]
        XCTAssertEqual(remaining(history, [line(1, .user, "Вопрос"), line(2, .assistant, "Ответ"),
                                           line(3, .user, "Ещё"), line(4, .assistant, "Продолжаю")]), ["Ещё", "Продолжаю"])
        XCTAssertEqual(remaining(history, [line(1, .assistant, "Другое")]), ["Другое"])
    }
    func testMultipleOverlappingTurnsAreRemovedOnlyAtSeam() {
        let history = [message("u1", .user, "Да"), message("a1", .assistant, "Готово"),
                       message("u2", .user, "Да"), message("a2", .assistant, "Готово")]
        XCTAssertEqual(remaining(history, [line(1, .user, "Да"), line(2, .assistant, "Готово"),
                                           line(3, .user, "Да"), line(4, .assistant, "Готово")]), [])
    }
    func testToolsErrorsAndAttachmentOnlyTurnsArePreserved() {
        let history = [message("u", .user, "Вопрос"),
                       HistoryMessage(role: .assistant, uuid: "a", blocks: [.text("Ответ"), .toolUse(id: "t", name: "Read", input: .null)]),
                       HistoryMessage(role: .user, uuid: "t", blocks: [.toolResult(toolUseId: "t", text: "Результат", isError: false)])]
        let lines = [line(1, .assistant, "Ответ"), line(2, .tool_use, "Bash {}"), line(3, .error, "Ошибка")]
        let merged = TranscriptReconciler().reconcile(history: history, lines: lines)
        XCTAssertEqual(merged.map(\.id), [2, 3])
        let rows = transcriptRows(history: groupHistory(history), live: groupLive(merged))
        XCTAssertEqual(rows.flatMap(\.blocks).count, 2)
        XCTAssertEqual(rows.flatMap(\.lines).map(\.id), [2])
        let photo = HistoryMessage(role: .user, uuid: "photo", blocks: [.image(ref: nil)])
        XCTAssertEqual(remaining(history + [photo], [line(1, .assistant, "Ответ")]), ["Ответ"])
    }
    func testHistoryArrivalAndCacheInvalidation() {
        let reconciler = TranscriptReconciler()
        let lines = [line(1, .user, "Вопрос"), line(2, .assistant, "Ответ")]
        let history = [message("u", .user, "Вопрос"), message("a", .assistant, "Ответ")]
        XCTAssertEqual(reconciler.reconcile(history: [], lines: lines), lines)
        XCTAssertTrue(reconciler.reconcile(history: history, lines: lines).isEmpty)
        XCTAssertTrue(reconciler.reconcile(history: history, lines: lines).isEmpty)
        XCTAssertEqual(reconciler.reconcile(history: [], lines: lines), lines)
    }
    func testExportUsesSameReconciliationForGrowingAnswer() {
        let history = [message("u", .user, prompt), message("a", .assistant, opening)]
        let doc = ConversationDocument(history: history, lines: [line(1, .user, prompt),
            line(2, .assistant, opening + "\n\n" + continuation)], limited: false)
        XCTAssertEqual(doc.entries.map(\.text), [prompt, opening, continuation])
    }

    func testQuickRepeatedPromptAndOlderMatchingExchangeRemain() {
        let history = [message("u", .user, "Да", ts: 10_000), message("a", .assistant, "Готово", ts: 11_000)]
        XCTAssertEqual(remaining(history, [line(1, .user, "Да", ts: 12_000)]), ["Да"])
        XCTAssertEqual(remaining(history, [line(1, .user, "Да", ts: 12_000), line(2, .assistant, "Готово")]), ["Да", "Готово"])
        let older = [message("u1", .user, "Да"), message("a1", .assistant, "Готово"),
                     message("u2", .user, "Другой вопрос"), message("a2", .assistant, "Другой ответ")]
        XCTAssertEqual(remaining(older, [line(1, .user, "Да"), line(2, .assistant, "Готово")]), ["Да", "Готово"])
    }
    func testUnmatchedMarkdownRemainderKeepsCodeIndentation() {
        XCTAssertEqual(remaining([message("a", .assistant, "Intro")],
                                 [line(1, .assistant, "Intro\n\n    print(1)")]), ["    print(1)"])
        let doc = ConversationDocument(history: [message("a", .assistant, "Intro")],
            lines: [line(1, .assistant, "Intro\n\n    print(1)")], limited: false)
        XCTAssertEqual(doc.entries.last?.text, "    print(1)")
        XCTAssertEqual(remaining([message("a", .assistant, "Intro"), message("b", .assistant, "    print(1)")],
            [line(1, .assistant, "Intro\n\n    print(1)\n\nNext")]), ["Next"])
    }

    func testHubTurnAllowsDelayedRuntimeWriteWithoutLosingHistory() {
        for delay: Double in [0, 5_001, 30_000] {
            let history = [message("u", .user, "проверь CI", ts: 100_000 + delay),
                           message("a", .assistant, "Проверяю", ts: 131_000)]
            let live = [TranscriptLine(id: 1, kind: .user, text: "проверь CI", ts: 100_000, turnId: "hub"),
                        line(2, .assistant, "Проверяю\n\nПродолжение", streaming: true)]
            XCTAssertEqual(remaining(history, live), ["Продолжение"])
            XCTAssertEqual(ConversationDocument(history: history, lines: live, limited: false).entries.map(\.text),
                           ["проверь CI", "Проверяю", "Продолжение"])
        }
    }

    func testConfirmedRepeatedPromptSteerAndAmbiguousClockSkewRemain() {
        let live = [TranscriptLine(id: 1, kind: .user, text: "проверь CI", ts: 100_000, turnId: "new"),
                    line(2, .assistant, "Проверяю")]
        for fileTime: Double in [50_000, 95_000, 99_999, 130_001] {
            let history = [message("u", .user, "проверь CI", ts: fileTime),
                           message("a", .assistant, "Проверяю", ts: 131_000)]
            XCTAssertEqual(remaining(history, live), ["проверь CI", "Проверяю"])
        }
        let old = [message("u", .user, "проверь CI", ts: 99_000), message("a", .assistant, "Проверяю", ts: 99_100)]
        XCTAssertEqual(ConversationDocument(history: old, lines: live, limited: false).entries.count, 4)
    }

    func testTruncatedHubPrefixConvergesOnlyWithDatedMatchingTurn() {
        let prefix = String(repeating: "x", count: 16_384)
        let live = [TranscriptLine(id: 1, kind: .user, text: prefix + "…", ts: 100_000, turnId: "new", truncated: true),
                    line(2, .assistant, "Смотрю")]
        let same = [message("u", .user, prefix + "полный хвост", ts: 110_000),
                    message("a", .assistant, "Смотрю", ts: 111_000)]
        XCTAssertTrue(remaining(same, live).isEmpty)
        let old = [message("u", .user, prefix + "старый хвост", ts: 95_000),
                   message("a", .assistant, "Смотрю", ts: 111_000)]
        XCTAssertEqual(remaining(old, live), live.map(\.text), "An identical opener after a new steer does not identify the old turn")
        XCTAssertEqual(remaining([message("u", .user, prefix + "хвост"), message("a", .assistant, "Смотрю")], live), live.map(\.text))
    }

    /// 10.10.2026: a picture sent while the turn ran. The live tail is the
    /// question, the hub's «[картинка]» turn and the reply. The agent used to
    /// leave the mid-turn message (a `queued_command` record) out of history,
    /// so nothing lined up and the question, the bubble and the reply were all
    /// drawn a second time under the saved copy. History now carries it.
    func testMidTurnPictureConvergesOnceHistoryCarriesIt() {
        let question = "А почему у моделей иногда такое название?"
        let reply = "Веб это уже умеет, не хватало только iOS."
        let live = [
            TranscriptLine(id: 1, kind: .user, text: question, ts: 100_000, turnId: "q"),
            TranscriptLine(id: 2, kind: .user, text: "[картинка]", ts: 108_000, turnId: "p",
                           attachedImageCount: 1, attachmentOnly: true),
            line(3, .assistant, reply, ts: 140_000),
        ]
        let before = [message("u", .user, question, ts: 100_050), message("a", .assistant, reply, ts: 140_000)]
        XCTAssertEqual(remaining(before, live), [question, "[картинка]", reply],
                       "without the mid-turn message nothing can be proven — the whole tail stays")
        let picture = HistoryMessage(role: .user, uuid: "p", blocks: [.image(ref: "p#0")], ts: 108_020)
        XCTAssertEqual(remaining([before[0], picture, before[1]], live), [])
        // Text and picture in one mid-turn message.
        var captioned = live
        captioned[1] = TranscriptLine(id: 2, kind: .user, text: "И картинка не подтягивается", ts: 108_000,
                                      turnId: "p", attachedImageCount: 1)
        let both = HistoryMessage(role: .user, uuid: "p", blocks: [.text("И картинка не подтягивается"), .image(ref: "p#1")],
                                  ts: 108_020)
        XCTAssertEqual(remaining([before[0], both, before[1]], captioned), [])
    }

    func testRemotePhotoCountConvergesAndLiteralAttachmentLabelStaysText() {
        let photo = HistoryMessage(role: .user, uuid: "photo", blocks: [.image(ref: "photo#1")], ts: 101_000)
        let reply = message("a", .assistant, "Вижу", ts: 102_000)
        let imageLine = TranscriptLine(id: 1, kind: .user, text: "[картинка]", ts: 100_000, turnId: "u",
                                       attachedImageCount: 1, attachmentOnly: true)
        XCTAssertTrue(remaining([photo, reply], [imageLine, line(2, .assistant, "Вижу")]).isEmpty)
        var literal = imageLine; literal.attachmentOnly = false
        XCTAssertEqual(remaining([photo, reply], [literal, line(2, .assistant, "Вижу")]), ["[картинка]", "Вижу"])
    }

}
