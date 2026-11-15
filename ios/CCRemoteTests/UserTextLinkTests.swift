import XCTest
import SwiftUI
@testable import CCRemote

/// Адреса в реплике человека должны нажиматься: `Text(String)` их не распознаёт.
final class UserTextLinkTests: XCTestCase {
    func testBareURLBecomesALink() {
        let s = UserText.linkified("глянь https://code.acme.test/w/board и скажи")
        let links = s.runs.compactMap(\.link)
        XCTAssertEqual(links, [URL(string: "https://code.acme.test/w/board")!])
        let linked = s.runs.first { $0.link != nil }!
        XCTAssertEqual(String(s[linked.range].characters), "https://code.acme.test/w/board")
        XCTAssertEqual(linked.underlineStyle, .single)
    }

    func testPlainTextStaysPlain() {
        let s = UserText.linkified("без ссылок, просто текст")
        XCTAssertTrue(s.runs.allSatisfy { $0.link == nil })
        XCTAssertEqual(String(s.characters), "без ссылок, просто текст")
    }
}
