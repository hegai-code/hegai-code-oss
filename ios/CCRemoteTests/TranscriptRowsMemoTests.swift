import XCTest
@testable import CCRemoteKit
@testable import CCRemote

/// `TranscriptRowsMemo` кладёт в кэш всё до последнего сообщения человека и пересобирает
/// только текущий ход. Это допустимо, лишь пока результат совпадает со сквозным
/// `transcriptRows` на тех же входах: «Ход работы», «Что сделано» и склейка механики с
/// прозой не смотрят через границу хода.
final class TranscriptRowsMemoTests: XCTestCase {
    /// Детерминированный генератор: тест воспроизводим.
    private struct Rng {
        var state: UInt64
        mutating func next(_ n: Int) -> Int {
            state = state &* 6364136223846793005 &+ 1442695040888963407
            return Int((state >> 33) % UInt64(n))
        }
    }

    private func history(_ rng: inout Rng, messages: Int) -> [HistoryMessage] {
        var out: [HistoryMessage] = []
        var ts = 1_700_000_000_000.0
        var tool = 0
        for i in 0..<messages {
            ts += rng.next(4) == 0 ? 86_400_000 : 60_000
            switch rng.next(5) {
            case 0:
                out.append(HistoryMessage(role: .user, uuid: "u\(i)", blocks: [.text("вопрос \(i)")], ts: ts))
            case 1, 2:
                out.append(HistoryMessage(role: .assistant, uuid: "a\(i)", blocks: [.text("ответ \(i)")], ts: ts))
            case 3:
                tool += 1
                out.append(HistoryMessage(role: .assistant, uuid: "t\(i)", blocks: [
                    .toolUse(id: "tu\(tool)", name: "Read", input: .object(["file_path": .string("/a/\(tool).ts")])),
                ], ts: ts))
            default:
                out.append(HistoryMessage(role: .user, uuid: "r\(i)", blocks: [
                    .toolResult(toolUseId: "tu\(tool)", text: "ok", isError: false),
                ], ts: ts))
            }
        }
        return out
    }

    private func live(_ rng: inout Rng, lines: Int, firstId: Int, reuseTool: Int) -> [TranscriptLine] {
        var out: [TranscriptLine] = []
        for i in 0..<lines {
            let id = firstId + i
            switch rng.next(5) {
            case 0:
                out.append(TranscriptLine(id: id, kind: .user, text: "живой вопрос \(id)"))
            case 1, 2:
                out.append(TranscriptLine(id: id, kind: .assistant, text: "живой ответ \(id)", streaming: i == lines - 1))
            case 3:
                var line = TranscriptLine(id: id, kind: .tool_use, text: "Read {\"file_path\":\"/b/\(id).ts\"}")
                // Часть вызовов повторяет историю: «один шаг, а не два».
                if reuseTool > 0, rng.next(2) == 0 { line.toolUseId = "tu\(1 + rng.next(reuseTool))" }
                out.append(line)
            default:
                out.append(TranscriptLine(id: id, kind: .status, text: "статус \(id)"))
            }
        }
        return out
    }

    func testMemoMatchesTheStraightPassOnRandomTranscripts() {
        var rng = Rng(state: 42)
        for round in 0..<60 {
            let items = groupHistory(history(&rng, messages: 4 + rng.next(40)))
            let memo = TranscriptRowsMemo()
            var lines: [TranscriptLine] = []
            // Стрим: живой хвост растёт, одни и те же входы приходят повторно.
            for step in 0..<6 {
                lines += live(&rng, lines: 1 + rng.next(4), firstId: lines.count + 1, reuseTool: 6)
                let grouped = groupLive(lines)
                for busy in [true, false, true] {
                    for recaps in [true, false] {
                        let expected = transcriptRows(history: items, live: grouped, busy: busy, recaps: recaps)
                        let got = memo.rows(history: items, live: grouped, busy: busy, recaps: recaps)
                        XCTAssertEqual(got, expected, "round \(round) step \(step) busy \(busy) recaps \(recaps)")
                    }
                }
            }
        }
    }

    func testChangedHistoryInvalidatesTheCachedPrefix() {
        var rng = Rng(state: 7)
        let first = history(&rng, messages: 20)
        let memo = TranscriptRowsMemo()
        let a = groupHistory(first)
        _ = memo.rows(history: a, live: [], busy: false, recaps: true)
        var more = first
        more.insert(HistoryMessage(role: .user, uuid: "u-new", blocks: [.text("новый")], ts: 1_700_000_000_000 + 5_000), at: 3)
        let b = groupHistory(more)
        XCTAssertEqual(memo.rows(history: b, live: [], busy: false, recaps: true),
                       transcriptRows(history: b, live: [], busy: false, recaps: true))
    }
}
