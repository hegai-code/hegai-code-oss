import XCTest
@testable import CCRemote

final class ReportsListTests: XCTestCase {
    private func decode(_ json: String) throws -> ReportsResponse {
        try JSONDecoder().decode(ReportsResponse.self, from: Data(json.utf8))
    }

    func testDecodesWithAndWithoutFolder() throws {
        let id = String(repeating: "a", count: 32)
        let new = try decode("""
        {"reports":[{"id":"\(id)","title":"T","description":"D","sizeBytes":1,"createdAt":1,"updatedAt":2,
        "ownerName":"N","ownerEmail":"e@x","folder":"shop-app","url":"https://code.acme.test/w/reports/\(id)"}],"admin":true}
        """)
        XCTAssertEqual(new.reports.first?.folderName, "shop-app")
        XCTAssertEqual(new.reports.first?.changedAt, 2)
        let old = try decode("""
        {"reports":[{"id":"\(id)","title":"T","createdAt":5,"updatedAt":6}],"admin":false}
        """)
        XCTAssertEqual(old.reports.first?.folderName, "")
        XCTAssertNil(old.reports.first?.url)
    }

    private func item(_ id: String, folder: String?, at: Double) -> ReportItem {
        ReportItem(id: id, title: id, description: nil, sizeBytes: nil, createdAt: at, updatedAt: at,
                   ownerName: nil, ownerEmail: nil, folder: folder, url: nil)
    }

    func testGroupsRootFirstThenFoldersByNewest() {
        let groups = ReportsListView.group([
            item("a", folder: "old", at: 10),
            item("b", folder: "new", at: 30),
            item("c", folder: nil, at: 1),
            item("d", folder: "new", at: 40),
        ])
        XCTAssertEqual(groups.map(\.folder), ["", "new", "old"])
        XCTAssertEqual(groups[0].title, "Hegai Code")
        XCTAssertEqual(groups[1].reports.map(\.id), ["d", "b"])
    }
}
