import XCTest
@testable import CCRemote

final class TranscriptScrollStateTests: XCTestCase {
    func testLayoutGrowthDoesNotDetachButVerticalReadingDoes() {
        var state = TranscriptScrollState()
        state.moved(gap: 5000)
        XCTAssertTrue(state.followsTail)
        state.drag(dx: 100, dy: 5)
        XCTAssertTrue(state.followsTail)
        state.drag(dx: 3, dy: 100)
        state.moved(gap: 600)
        state.endDrag()
        XCTAssertFalse(state.followsTail)
        state.moved(gap: 900)
        XCTAssertFalse(state.followsTail)
        state.moved(gap: 0)
        XCTAssertTrue(state.followsTail)
    }
}
