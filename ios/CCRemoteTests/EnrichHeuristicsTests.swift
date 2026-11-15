import XCTest
@testable import CCRemoteKit

/// The heuristic layer runs on every tail turn with no model behind it, so a
/// wrong guess here is a wrong BUTTON on the screen — the cases pin both what
/// it offers and, just as deliberately, what it refuses to guess. Mirrors
/// `web/test/enrich.test.ts`, plus the Swift-side edges.
final class EnrichHeuristicsTests: XCTestCase {
    private func labels(_ text: String) -> [String]? {
        EnrichHeuristics.enrichment(for: text)?.quickReplies?.map(\.label)
    }
    private func sends(_ text: String) -> [String]? {
        EnrichHeuristics.enrichment(for: text)?.quickReplies?.map(\.send)
    }

    func testClosingYesNoQuestionEarnsDaNet() {
        XCTAssertEqual(labels("Изменение в одном файле, восемь строк. Раскатывать?"), ["Да", "Нет"])
    }

    func testOrQuestionAndMenuGetOnlyDaNetNeverTheirOwnProse() {
        // These used to become clipped buttons that SENT a whole sentence or list
        // item — the button said one thing and sent another (13.10.2026).
        XCTAssertEqual(labels("Готово. Делаем сейчас или после ревью?"), ["Да", "Нет"])
        XCTAssertEqual(labels("Deploy now or later?"), ["Да", "Нет"])
        let menu = ["Варианты:", "1) Только веб", "2) Веб и хаб", "3) Отложить", "Берём?"].joined(separator: "\n")
        XCTAssertEqual(labels(menu), ["Да", "Нет"])
        XCTAssertEqual(sends(menu), ["Да", "Нет"])
        // …and an open question over a list still gets nothing.
        XCTAssertNil(EnrichHeuristics.enrichment(for: ["1) Только веб", "2) Веб и хаб", "Какой берём?"].joined(separator: "\n")))
    }

    func testLabelIsAlwaysWhatATapSends() {
        for text in ["Раскатывать?", "Сейчас или после ревью?", "Deploy now or later?"] {
            let replies = EnrichHeuristics.enrichment(for: text)?.quickReplies ?? []
            XCTAssertFalse(replies.isEmpty)
            for r in replies {
                XCTAssertEqual(r.label, r.send)
                XCTAssertNil(r.kind)
            }
        }
    }

    func testOpenQuestionGetsNoButtons() {
        XCTAssertNil(EnrichHeuristics.enrichment(for: "Починил. Какой порог тишины поставить?"))
        XCTAssertNil(EnrichHeuristics.enrichment(for: "Что, раскатывать?"))
        XCTAssertNil(EnrichHeuristics.enrichment(for: "Which one?"))
    }

    func testQuestionTheAgentMovedPastDoesNotQualify() {
        XCTAssertNil(EnrichHeuristics.enrichment(for: "Раскатывать? Пока проверяю тесты.\nТесты зелёные."))
    }

    func testParagraphLongQuestionIsProse() {
        let long = "Может быть, стоит " + String(repeating: "очень ", count: 40) + "подумать?"
        XCTAssertNil(EnrichHeuristics.enrichment(for: long))
    }

    func testMarkdownEmphasisDoesNotHideTheQuestionMark() {
        XCTAssertEqual(labels("Готово. **Раскатывать?**"), ["Да", "Нет"])
    }

    // MARK: Which voice the strip hears (Enrichment.shown)

    private let heuristic = Enrichment(quickReplies: [.init(label: "Да", send: "Да"), .init(label: "Нет", send: "Нет")])

    func testNothingShowsWhilePending() {
        XCTAssertNil(Enrichment.shown(state: .pending, heuristic: heuristic))
    }

    func testAModelThatSaidNothingIsFinalAndTheHeuristicStaysDown() {
        XCTAssertNil(Enrichment.shown(state: .success(Enrichment()), heuristic: heuristic))
        // Notes without buttons are still "no buttons".
        XCTAssertNil(Enrichment.shown(state: .success(Enrichment(decisions: ["Итог"], handoff: "done")), heuristic: heuristic))
    }

    func testTheModelsRepliesWinAndCarryTheVerdict() {
        let model = Enrichment(quickReplies: [.init(label: "Да, раскатывай", send: "Да, раскатывай", kind: "answer")],
                               handoff: "question")
        let shown = Enrichment.shown(state: .success(model), heuristic: heuristic)
        XCTAssertEqual(shown?.quickReplies?.map(\.send), ["Да, раскатывай"])
        XCTAssertEqual(shown?.headline, "Ждёт твоего ответа:")
    }

    func testHeuristicOnlyWhereTheModelCouldNotSpeak() {
        for state in [EnrichState.failed, .unavailable] {
            let shown = Enrichment.shown(state: state, heuristic: heuristic)
            XCTAssertEqual(shown?.quickReplies?.map(\.send), ["Да", "Нет"])
            XCTAssertNil(shown?.headline, "a verdict must not ride on buttons the model never proposed")
            XCTAssertNil(Enrichment.shown(state: state, heuristic: nil))
        }
    }

    func testTheButtonShowsWhatItSendsAndNoMoreThanThree() {
        let model = Enrichment(quickReplies: [
            .init(label: "Совсем другая подпись", send: "Раскатай на прод"),
            .init(label: "b", send: "Запусти тесты"),
            .init(label: "c", send: "Запусти тесты"),          // duplicate
            .init(label: "d", send: "  "),                     // blank
            .init(label: "e", send: "Проверь миграцию"),
            .init(label: "f", send: "Закоммить"),
            .init(label: "g", send: "Лишнее четвёртое"),
        ])
        let replies = Enrichment.shown(state: .success(model), heuristic: nil)?.quickReplies ?? []
        XCTAssertEqual(replies.map(\.send), ["Раскатай на прод", "Запусти тесты", "Проверь миграцию"])
        XCTAssertEqual(replies.map(\.label), replies.map(\.send))
    }

    func testAParagraphSizedSendIsDroppedNotShownTruncated() {
        let paragraph = String(repeating: "а", count: Enrichment.maxSendLength + 1)
        let model = Enrichment(quickReplies: [.init(label: "Обрезано…", send: paragraph),
                                              .init(label: "Ок", send: "Ок")])
        XCTAssertEqual(Enrichment.shown(state: .success(model), heuristic: nil)?.quickReplies?.map(\.send), ["Ок"])
    }

    func testIdeasAreDroppedWhereThereIsNoComposer() {
        let model = Enrichment(quickReplies: [
            .init(label: "Раскатай", send: "Раскатай", kind: "next"),
            .init(label: "Подумать о кэше", send: "Подумать о кэше", kind: "idea"),
        ])
        XCTAssertEqual(Enrichment.shown(state: .success(model), heuristic: nil)?.quickReplies?.map(\.send),
                       ["Раскатай", "Подумать о кэше"])
        XCTAssertEqual(Enrichment.shown(state: .success(model), heuristic: nil, allowIdeas: false)?.quickReplies?.map(\.send),
                       ["Раскатай"])
        let onlyIdea = Enrichment(quickReplies: [.init(label: "x", send: "Идея", kind: "idea")])
        XCTAssertNil(Enrichment.shown(state: .success(onlyIdea), heuristic: nil, allowIdeas: false))
    }
}
