import XCTest
@testable import CCRemote

/// The reader-facing half of the transcript cleanup. Agents strip this at the
/// source, but the hub still serves months of transcripts with it inline, so the
/// client rule has to hold on its own. Mirrors `agent/test/history-noise.test.ts`.
final class HarnessNoiseTests: XCTestCase {
    func testProseSurvivesAroundAStrippedBlock() {
        let text = "сделай ревью\n<system-reminder>\nThis is a reminder.\n</system-reminder>\nи потом задеплой"
        XCTAssertEqual(stripHarnessNoise(text), "сделай ревью\n\nи потом задеплой")
    }

    func testATurnThatIsOnlyNoiseBecomesEmpty() {
        let only = "<task-notification>\n<task-id>a1</task-id>\n<status>completed</status>\n</task-notification>"
        XCTAssertEqual(stripHarnessNoise(only), "")
    }

    func testEveryWrapperTheCLIInjectsIsCovered() {
        for tag in ["task-notification", "system-reminder", "local-command-stdout",
                    "local-command-caveat", "command-name", "command-message", "command-args"] {
            XCTAssertEqual(stripHarnessNoise("<\(tag)>noise</\(tag)>"), "", tag)
        }
    }

    func testTextThatMerelyContainsAngleBracketsIsUntouched() {
        let prose = "use <div> and a < b comparison"
        XCTAssertEqual(stripHarnessNoise(prose), prose)
    }

    func testMultipleBlocksInOneTurn() {
        let text = "первое<system-reminder>x</system-reminder>второе<task-notification>y</task-notification>третье"
        XCTAssertEqual(stripHarnessNoise(text), "первоевтороетретье")
    }
}
