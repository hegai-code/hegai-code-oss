import XCTest
import CCRemoteKit
@testable import CCRemote

/// 25.10.2026: a dictation went out as the phone's text with everything said
/// before a pause missing — the hub was out of reach and the recording was
/// deleted. These pin the two halves of the fix.
final class DictationRecoveryTests: XCTestCase {
    // MARK: UtteranceJoiner — the phone's text survives a restarted hypothesis

    func testGrowingAndRevisedHypothesesReplaceEachOther() {
        var j = UtteranceJoiner()
        XCTAssertEqual(j.take("Как"), "Как")
        XCTAssertEqual(j.take("Как много"), "Как много")
        XCTAssertEqual(j.take("Как много уязвимостей"), "Как много уязвимостей")
        // A revision that shortens but keeps the opening words is the same utterance.
        XCTAssertEqual(j.take("Как много уязвим"), "Как много уязвим")
        XCTAssertEqual(j.take("как много, уязвимостей появляется"), "как много, уязвимостей появляется")
    }

    func testRestartAfterPauseKeepsWhatWasSaid() {
        var j = UtteranceJoiner()
        _ = j.take("Напиши пост про октябрьский кибербез")
        // After a pause iOS reports only the new utterance.
        XCTAssertEqual(j.take("Как"), "Напиши пост про октябрьский кибербез Как")
        XCTAssertEqual(j.take("Как много уязвимостей"), "Напиши пост про октябрьский кибербез Как много уязвимостей")
        _ = j.take("Как много уязвимостей появляется ежемесячно")
        XCTAssertEqual(j.take("И в конце"),
                       "Напиши пост про октябрьский кибербез Как много уязвимостей появляется ежемесячно И в конце")
    }

    func testExplicitCommitStartsTheNextUtterance() {
        var j = UtteranceJoiner()
        _ = j.take("Первая фраза")
        j.commit()
        XCTAssertEqual(j.text, "Первая фраза")
        // A new task begins with words that may grow past the old ones.
        XCTAssertEqual(j.take("Первая"), "Первая фраза Первая")
        XCTAssertEqual(j.take("Первая фраза снова и дальше"), "Первая фраза Первая фраза снова и дальше")
    }

    func testOneWordHypothesisIsNeverTakenForARestart() {
        XCTAssertFalse(UtteranceJoiner.restarted(from: "Привет", to: "При"))
        XCTAssertFalse(UtteranceJoiner.restarted(from: "", to: "Привет"))
        XCTAssertTrue(UtteranceJoiner.restarted(from: "Раз два три", to: "Четыре"))
    }

    // MARK: TranscribeOutcome — which failures keep the recording

    private func body(_ text: String) -> Data { try! JSONSerialization.data(withJSONObject: ["text": text]) }

    func testTranscribeOutcomeMapping() {
        XCTAssertEqual(TranscribeOutcome.map(status: 200, body: body(" Деплой хаба. ")), .text("Деплой хаба."))
        XCTAssertEqual(TranscribeOutcome.map(status: 200, body: body("  ")), .silence)
        XCTAssertEqual(TranscribeOutcome.map(status: 200, body: Data("<html>".utf8)), .failed)
        // Out of reach or refused for now — keep the audio for «Повторить».
        XCTAssertEqual(TranscribeOutcome.map(status: nil, body: nil), .failed)
        for code in [429, 499, 500, 502, 504, 520] {
            XCTAssertEqual(TranscribeOutcome.map(status: code, body: nil), .failed, "\(code)")
        }
        // The same answer every time — retrying is pointless.
        for code in [400, 401, 403, 413, 415] {
            XCTAssertEqual(TranscribeOutcome.map(status: code, body: nil), .unavailable, "\(code)")
        }
        // 503 is final only when the hub itself says it has no engine.
        XCTAssertEqual(TranscribeOutcome.map(status: 503, body: Data("transcription not configured".utf8)), .unavailable)
        XCTAssertEqual(TranscribeOutcome.map(status: 503, body: Data("<html>Service Unavailable".utf8)), .failed)
        XCTAssertEqual(TranscribeOutcome.map(status: 503, body: nil), .failed)
    }
}
