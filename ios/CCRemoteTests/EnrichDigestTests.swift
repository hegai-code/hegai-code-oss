import XCTest
@testable import CCRemoteKit

/// The digest is what lets the model tell «the agent already deployed» from
/// «the agent suggests deploying» — so the cases pin what it must CARRY (the
/// ask, every action, every error, the exchanges before) and the budgets that
/// keep it inside the hub's 16 000. Mirrors `buildTurnDigest` in
/// `web/src/render/enrich.ts`.
final class EnrichDigestTests: XCTestCase {
    private func msg(_ role: MessageRole, _ uuid: String, _ blocks: [RenderBlock]) -> HistoryMessage {
        HistoryMessage(role: role, uuid: uuid, blocks: blocks)
    }
    private func call(_ name: String, _ input: [String: JSONValue]) -> RenderBlock {
        .toolUse(id: "t-\(name)", name: name, input: .object(input))
    }
    private func line(_ id: Int, _ kind: TranscriptLine.Kind, _ text: String) -> TranscriptLine {
        TranscriptLine(id: id, kind: kind, text: text)
    }
    private func digest(_ history: [HistoryMessage], live: [TranscriptLine] = [], cwd: String? = nil) -> String? {
        EnrichDigest.build(history: history, live: live, cwd: cwd) {
            $0.replacingOccurrences(of: "<noise/>", with: "")
        }
    }

    func testCarriesTheAskTheActionsAndTheProject() throws {
        let history = [
            msg(.user, "u1", [.text("Почини тест и раскатай")]),
            msg(.assistant, "a1", [call("Edit", ["file_path": .string("/srv/app/src/deep/dir/file.ts")]),
                                   call("Bash", ["command": .string("npm test")])]),
            msg(.assistant, "a2", [.text("Готово. Раскатывать?")]),
        ]
        let d = try XCTUnwrap(digest(history, cwd: "/srv/app"))
        XCTAssertTrue(d.hasPrefix("PROJECT: /srv/app\n\n"))
        XCTAssertTrue(d.contains("USER TURN (what the person asked):\nПочини тест и раскатай"))
        XCTAssertTrue(d.contains("WHAT THE AGENT DID THIS TURN (in order):\n- Edit deep/dir/file.ts\n- Bash: npm test"))
        XCTAssertFalse(d.contains("Раскатывать?"), "the final message travels as `text`, not in the digest")
    }

    func testAToolErrorIsMarkedAndAnswerOnlyTurnsSaySo() throws {
        let history = [
            msg(.user, "u1", [.text("Запусти")]),
            msg(.assistant, "a1", [call("Bash", ["command": .string("make")])]),
            msg(.user, "u2", [.toolResult(toolUseId: "t", text: "boom\n  at line 3", isError: true)]),
            msg(.assistant, "a2", [.text("Не вышло.")]),
        ]
        let d = try XCTUnwrap(digest(history))
        XCTAssertTrue(d.contains("- Bash: make\n- ✗ ERROR: boom at line 3"))

        let chat = [msg(.user, "u1", [.text("Что это?")]), msg(.assistant, "a1", [.text("Это X.")])]
        XCTAssertTrue(try XCTUnwrap(digest(chat)).hasSuffix("- (no tool calls — it only answered)"))
    }

    func testNothingBeyondTheFinalMessageIsNil() {
        XCTAssertNil(digest([msg(.assistant, "a1", [.text("Привет")])]))
        XCTAssertNil(digest([]))
    }

    func testRepeatedActionsCollapse() throws {
        let read = call("Read", ["file_path": .string("a.ts")])
        let history = [msg(.user, "u", [.text("Прочитай")]),
                       msg(.assistant, "a", [read, read, read, call("Grep", ["pattern": .string("x")])]),
                       msg(.assistant, "z", [.text("Ок")])]
        let d = try XCTUnwrap(digest(history))
        XCTAssertTrue(d.contains("- Read a.ts ×3\n- Grep x"))
    }

    func testALongTurnElidesTheMiddleKeepingStartAndEnd() throws {
        let calls = (0..<100).map { call("Bash", ["command": .string("step \($0)")]) }
        let history = [msg(.user, "u", [.text("Сделай")]), msg(.assistant, "a", calls),
                       msg(.assistant, "z", [.text("Готово")])]
        let d = try XCTUnwrap(digest(history))
        let actions = d.components(separatedBy: "\n").filter { $0.hasPrefix("- ") }
        XCTAssertEqual(actions.count, EnrichDigest.maxActions + 1)
        XCTAssertTrue(actions.first == "- Bash: step 0")
        XCTAssertTrue(actions.contains("- … 40 more actions …"))
        XCTAssertTrue(actions.last == "- Bash: step 99")
    }

    func testTwoEarlierExchangesAreKeptNewestLast() throws {
        let history = [
            msg(.user, "u0", [.text("Самый старый")]), msg(.assistant, "a0", [.text("Старый ответ")]),
            msg(.user, "u1", [.text("Первый")]), msg(.assistant, "a1", [.text("Ответ один")]),
            msg(.user, "u2", [.text("Второй")]), msg(.assistant, "a2", [.text("Ответ два")]),
            msg(.user, "u3", [.text("Текущий")]), msg(.assistant, "a3", [.text("Ответ")]),
        ]
        let d = try XCTUnwrap(digest(history))
        XCTAssertTrue(d.contains("EARLIER IN THE SESSION:\nUSER: Первый\nASSISTANT (last words): Ответ один\n\nUSER: Второй\nASSISTANT (last words): Ответ два"))
        XCTAssertFalse(d.contains("Самый старый"))
        XCTAssertTrue(d.contains("USER TURN (what the person asked):\nТекущий"))
    }

    func testLiveLinesFollowHistoryAndNoiseIsCleaned() throws {
        let history = [msg(.user, "u", [.text("Деплой<noise/>")])]
        let live = [line(1, .tool_use, "Bash {\"command\":\"npm run deploy\",\"run_in_background\":true}"),
                    line(2, .tool_use, "$ ls -la"),
                    line(3, .error, "exit 1"),
                    line(4, .status, "ignored"),
                    line(5, .assistant, "Готово.")]
        let d = try XCTUnwrap(digest(history, live: live))
        XCTAssertTrue(d.contains("USER TURN (what the person asked):\nДеплой\n"))
        XCTAssertTrue(d.contains("- Bash: npm run deploy [in background]\n- $ ls -la\n- ✗ ERROR: exit 1"))
        XCTAssertFalse(d.contains("ignored"))
    }

    func testBudgetHoldsForAHugeTurn() throws {
        let big = String(repeating: "слово ", count: 5_000)
        var history: [HistoryMessage] = []
        for i in 0..<4 {
            history.append(msg(.user, "u\(i)", [.text(big)]))
            history.append(msg(.assistant, "a\(i)", [.text(big)]))
        }
        history.append(msg(.assistant, "z", [.text("Конец")]))
        let d = try XCTUnwrap(digest(history, cwd: "/srv/app"))
        XCTAssertLessThanOrEqual(d.count, EnrichDigest.budget + 500)
        XCTAssertTrue(d.contains("USER TURN (what the person asked):"), "the ask outranks the earlier exchanges")
    }

    func testDescribeCallShapes() {
        XCTAssertEqual(EnrichDigest.describeCall("Task", .object(["description": .string("Найди баг"), "subagent_type": .string("Explore")])),
                       "Task(Explore): Найди баг")
        XCTAssertEqual(EnrichDigest.describeCall("WebFetch", .object(["url": .string("https://x.dev")])), "WebFetch https://x.dev")
        XCTAssertEqual(EnrichDigest.describeCall("Odd", .object(["a": .number(1)])), "Odd {\"a\":1}")
        XCTAssertEqual(EnrichDigest.describeCall("Bare", .object([:])), "Bare")
        XCTAssertEqual(EnrichDigest.describeCall("Raw", .string("text")), "Raw text")
        XCTAssertEqual(EnrichDigest.shortPath("C:\\a\\b\\c\\d.txt"), "b/c/d.txt")
    }

    func testParseToolLine() {
        XCTAssertEqual(EnrichDigest.parseToolLine("$ git status").input["command"]?.stringValue, "git status")
        XCTAssertEqual(EnrichDigest.parseToolLine("Read {\"file_path\":\"a\"}").name, "Read")
        XCTAssertEqual(EnrichDigest.parseToolLine("Read not json").input.stringValue, "not json")
        XCTAssertEqual(EnrichDigest.parseToolLine("Solo").name, "Solo")
    }
}
