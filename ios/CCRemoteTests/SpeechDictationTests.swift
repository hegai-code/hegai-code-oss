import XCTest
@testable import CCRemote

@MainActor
final class SpeechDictationTests: XCTestCase {
    override func setUp() {
        super.setUp()
        setenv("CC_DICTATION_FIXTURE", "1", 1)
        setenv("CC_DICTATION_FINAL_FIXTURE", "1", 1)
    }
    override func tearDown() {
        unsetenv("CC_DICTATION_FIXTURE")
        unsetenv("CC_DICTATION_FINAL_FIXTURE")
        super.tearDown()
    }

    func testVoiceMeterKeepsSilenceQuietAndMakesSpeechVisible() {
        XCTAssertEqual(SpeechMeter.level(rms: 0), 0)
        XCTAssertEqual(SpeechMeter.level(rms: pow(10, -60 / 20)), 0)
        XCTAssertGreaterThan(SpeechMeter.level(rms: pow(10, -35 / 20)), 0.65)
        XCTAssertGreaterThan(SpeechMeter.level(rms: pow(10, -25 / 20)), 0.85)
        XCTAssertEqual(SpeechMeter.level(rms: 1), 1)
        XCTAssertEqual(SpeechMeter.level(rms: .nan), 0)
    }

    func testFinishWaitsForFinalWords() async {
        let dictation = SpeechDictation()
        dictation.toggle()
        let pending = Task { await dictation.finish() }
        try? await Task.sleep(for: .milliseconds(400))
        XCTAssertTrue(dictation.finalizing)
        XCTAssertEqual(dictation.transcript, "Проверка голосового сообщения")
        let result = await pending.value
        XCTAssertEqual(result, "Проверка голосового сообщения и последние слова")
        XCTAssertFalse(dictation.active)
        XCTAssertFalse(dictation.recording)
        XCTAssertFalse(dictation.finalizing)
    }

    func testCancelResolvesPendingSendAndOldFinalCannotChangeNewRecording() async throws {
        let dictation = SpeechDictation()
        dictation.toggle()
        let pending = Task { await dictation.finish() }
        await Task.yield()
        XCTAssertTrue(dictation.finalizing)
        dictation.cancel()
        let result = await pending.value
        XCTAssertNil(result)
        dictation.toggle()
        try await Task.sleep(for: .milliseconds(1200))
        XCTAssertTrue(dictation.recording)
        XCTAssertEqual(dictation.transcript, "Проверка голосового сообщения")
        dictation.cancel()
    }

    func testStopFinalizesWithoutSendAndCanRecordAgain() async throws {
        let dictation = SpeechDictation()
        dictation.toggle()
        dictation.stop()
        XCTAssertTrue(dictation.active)
        XCTAssertTrue(dictation.finalizing)
        XCTAssertFalse(dictation.recording)
        try await Task.sleep(for: .milliseconds(1200))
        XCTAssertEqual(dictation.transcript, "Проверка голосового сообщения и последние слова")
        XCTAssertFalse(dictation.active)
        dictation.toggle()
        XCTAssertTrue(dictation.recording)
        dictation.cancel()
    }
}
