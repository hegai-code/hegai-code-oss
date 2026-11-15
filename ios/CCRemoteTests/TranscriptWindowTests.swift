import XCTest
@testable import CCRemote

final class TranscriptWindowTests: XCTestCase {
    func testAppendAndPrependKeepTheReadersFirstMessage() {
        var window = TranscriptWindow()
        let ids = (0..<1000).map(String.init)
        window.retainStart(in: ids)
        XCTAssertEqual(window.startIndex(in: ids), 970)
        XCTAssertEqual(window.startIndex(in: ids + ["1000"]), 970)
        window.revealEarlier(in: ids)
        XCTAssertEqual(window.startIndex(in: ids), 940)
        XCTAssertEqual(window.startIndex(in: ["older"] + ids), 941)
        XCTAssertEqual(window.firstID, "940")
    }

    func testHistoryReplacementAndEmptyLoadRemainReachable() {
        var window = TranscriptWindow()
        window.retainStart(in: [])
        XCTAssertNil(window.firstID)
        let ids = (0..<31).map(String.init)
        window.retainStart(in: ids)
        window.revealEarlier(in: ids)
        XCTAssertEqual(window.startIndex(in: ids), 0)
        window.retainStart(in: ["replacement"])
        XCTAssertEqual(window.firstID, "replacement")
    }

    func testFollowingTheTailCutsAGrownWindowBackToOnePage() {
        var window = TranscriptWindow()
        var ids = (0..<100).map(String.init)
        window.retainStart(in: ids)
        XCTAssertEqual(window.startIndex(in: ids), 70)
        // Small growth: the reader's anchor stays put, nothing is cut.
        ids += (100..<150).map(String.init)
        window.trimToTail(in: ids)
        XCTAssertEqual(window.startIndex(in: ids), 70)
        XCTAssertEqual(ids.count - 70, 80)
        // Past the limit: back to one page at the tail.
        ids += (150..<165).map(String.init)
        XCTAssertGreaterThan(ids.count - window.startIndex(in: ids), TranscriptWindow.trimLimit)
        window.trimToTail(in: ids)
        XCTAssertEqual(window.startIndex(in: ids), 135)
        XCTAssertEqual(window.firstID, "135")
        // And the window keeps following that row as replies arrive.
        XCTAssertEqual(window.startIndex(in: ids + ["165"]), 135)
        window.trimToTail(in: [])
    }
}
