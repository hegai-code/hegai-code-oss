import XCTest
@testable import CCRemoteKit
@testable import CCRemote

/// Generated pictures: the history block, the live `image_gen` card and the
/// rule that one picture is never drawn twice.
final class ImageGenTests: XCTestCase {
    private func decode<T: Decodable>(_ json: String) throws -> T {
        try JSONDecoder().decode(T.self, from: Data(json.utf8))
    }

    private func event(_ json: String) throws -> StreamEvent { try decode(json) }

    func testGeneratedBlockDecodesAndOldPayloadsStayImages() throws {
        let blocks: [RenderBlock] = try decode(#"""
        [{"kind":"image","ref":"gen:ig_1","generated":true,"prompt":" рыжий кот "},
         {"kind":"image","ref":"turn-1#0"},
         {"kind":"image","generated":true},
         {"kind":"image","ref":"gen:x","generated":false}]
        """#)
        XCTAssertEqual(blocks, [.generatedImage(ref: "gen:ig_1", prompt: "рыжий кот"),
                                .image(ref: "turn-1#0"),
                                .image(ref: nil),
                                .image(ref: "gen:x")])
    }

    func testImageGenEventDecodesAndBadFieldsDoNotDropTheFrame() throws {
        let e = try event(#"{"kind":"status","code":"image_gen","text":"🎨","data":{"id":"ig_1","state":"started","startedAt":1790000000000,"prompt":"кот"}}"#)
        XCTAssertEqual(e.data?.id, "ig_1")
        XCTAssertEqual(e.data?.state, "started")
        XCTAssertEqual(e.data?.startedAt, 1_790_000_000_000)
        XCTAssertEqual(e.data?.prompt, "кот")
        let bad = try event(#"{"kind":"status","code":"image_gen","data":{"id":"ig_1","state":"done","ref":7,"startedAt":"x"}}"#)
        XCTAssertEqual(bad.data?.state, "done")
        XCTAssertNil(bad.data?.ref)
        XCTAssertNil(bad.data?.startedAt)
    }

    func testCardIsUpsertedByIdAndNeverWalkedBack() throws {
        var lines: [TranscriptLine] = []
        func feed(_ json: String, id: Int) throws {
            TranscriptUpdates.imageGen(&lines, id: id, event: try event(json), now: 5_000)
        }
        let started = #"{"kind":"status","code":"image_gen","text":"","data":{"id":"a","state":"started","prompt":"кот"}}"#
        try feed(started, id: 1)
        try feed(started, id: 2)                       // replay
        XCTAssertEqual(lines.count, 1)
        XCTAssertEqual(lines[0].imageGen?.origin, 5_000)   // no startedAt: first seen
        try feed(#"{"kind":"status","code":"image_gen","data":{"id":"b","state":"started","startedAt":1000}}"#, id: 3)
        XCTAssertEqual(lines.count, 2)
        XCTAssertEqual(lines[1].imageGen?.origin, 1_000)
        try feed(#"{"kind":"status","code":"image_gen","data":{"id":"a","state":"done","ref":"gen:a"}}"#, id: 4)
        XCTAssertEqual(lines.count, 2)
        XCTAssertEqual(lines[0].imageGen?.state, .done)
        XCTAssertEqual(lines[0].imageGen?.ref, "gen:a")
        XCTAssertEqual(lines[0].imageGen?.prompt, "кот")  // kept from `started`
        try feed(started, id: 5)                       // late replay of `started`
        XCTAssertEqual(lines[0].imageGen?.state, .done)
        try feed(#"{"kind":"status","code":"image_gen","data":{"id":"b","state":"failed","error":"лимит"}}"#, id: 6)
        XCTAssertEqual(lines[1].imageGen?.state, .failed)
        XCTAssertEqual(lines[1].imageGen?.error, "лимит")
    }

    func testTurnEndClosesStartedCardsAsFailed() throws {
        var lines: [TranscriptLine] = []
        func feed(_ json: String, id: Int) throws {
            TranscriptUpdates.imageGen(&lines, id: id, event: try event(json), now: 5_000)
        }
        try feed(#"{"kind":"status","code":"image_gen","data":{"id":"a","state":"started"}}"#, id: 1)
        try feed(#"{"kind":"status","code":"image_gen","data":{"id":"b","state":"done","ref":"gen:b"}}"#, id: 2)
        try feed(#"{"kind":"status","code":"image_gen","data":{"id":"c","state":"started"}}"#, id: 3)
        TranscriptUpdates.closeLiveImageGen(&lines)
        XCTAssertEqual(lines[0].imageGen?.state, .failed)
        XCTAssertEqual(lines[0].imageGen?.error, "генерация прервана")
        XCTAssertEqual(lines[1].imageGen?.state, .done)
        XCTAssertNil(lines[1].imageGen?.error)
        XCTAssertEqual(lines[2].imageGen?.state, .failed)
    }

    func testProgressClockEasesTowardNinetyTwoPercent() {
        XCTAssertEqual(ImageGenCard.progress(elapsed: -3), 0, accuracy: 1e-9)
        XCTAssertEqual(ImageGenCard.progress(elapsed: 28), 0.92 * (1 - exp(-1.0)), accuracy: 1e-9)
        XCTAssertLessThan(ImageGenCard.progress(elapsed: 10_000), 0.9201)
        XCTAssertEqual(ImageGenCard.clock(elapsed: 83), "1:23")
    }

    func testHistoryRefMatchesCodexAndClaudeIds() {
        let card = ImageGenCard(id: "ig_9", state: .started, firstSeen: 0)
        XCTAssertTrue(card.matches(historyRef: "gen:ig_9"))
        XCTAssertTrue(card.matches(historyRef: "gen:ig_9#0"))
        XCTAssertFalse(card.matches(historyRef: "gen:ig_90"))
        XCTAssertFalse(card.matches(historyRef: "turn-1#0"))
        var done = card
        done.ref = "gen:other"
        XCTAssertTrue(done.matches(historyRef: "gen:other"))
    }

    func testLiveCardStaysARowAndHistoryCopyReplacesIt() throws {
        var lines: [TranscriptLine] = [TranscriptLine(id: 1, kind: .tool_use, text: "Bash {}")]
        TranscriptUpdates.imageGen(&lines, id: 2,
                                   event: try event(#"{"kind":"status","code":"image_gen","text":"","data":{"id":"ig_1","state":"done","ref":"gen:ig_1"}}"#),
                                   now: 1)
        // Not folded into the step list, even with an empty text.
        let live = groupLive(lines)
        XCTAssertEqual(live.count, 2)
        if case .line(let line, _) = live[1] { XCTAssertNotNil(line.imageGen) } else { XCTFail("card must be a line") }

        XCTAssertEqual(TranscriptReconciler.withoutPictured(lines, refs: []).count, 2)
        XCTAssertEqual(TranscriptReconciler.withoutPictured(lines, refs: ["gen:zzz"]).count, 2)
        XCTAssertEqual(TranscriptReconciler.withoutPictured(lines, refs: ["gen:ig_1"]).map(\.id), [1])
    }

    func testHistoryPictureIsATurnOfItsOwnAndNeverFoldsAway() {
        let picture = RenderBlock.generatedImage(ref: "gen:ig_1", prompt: "кот")
        let history = [
            HistoryMessage(role: .user, uuid: "u", blocks: [.text("нарисуй кота")]),
            HistoryMessage(role: .assistant, uuid: "a", blocks: [
                .text("Рисую."), .toolUse(id: "t", name: "Bash", input: .null), picture, .text("Готово."),
            ]),
        ]
        let items = groupHistory(history)
        let messages = items.compactMap { item -> HistoryMessage? in
            if case let .message(m, _) = item { return m }; return nil
        }
        XCTAssertEqual(messages.map(\.uuid), ["u", "a-p0", "a-g0", "a-p1"])
        XCTAssertEqual(messages[2].blocks, [picture])
        let rows = transcriptRows(history: items)
        XCTAssertTrue(rows.contains { $0.id == "m-a-g0" })
        XCTAssertFalse(rows.contains { if case .progress = $0.content { return true }; return false })
    }
}
