import XCTest
@testable import CCRemoteKit

/// «Новая папка» участника: правила имени — те же, что у хаба (`single_folder_name`).
final class MemberFolderTests: XCTestCase {
    func testNameRulesMirrorHub() {
        XCTAssertNil(MemberFolder.nameError(""))
        XCTAssertNil(MemberFolder.nameError("Дело 42"))
        XCTAssertNil(MemberFolder.nameError(String(repeating: "я", count: 64)))
        XCTAssertNotNil(MemberFolder.nameError(String(repeating: "я", count: 65)))
        XCTAssertNotNil(MemberFolder.nameError(" a"))
        XCTAssertNotNil(MemberFolder.nameError("a\n"))
        XCTAssertNotNil(MemberFolder.nameError(".git"))
        XCTAssertNotNil(MemberFolder.nameError(".."))
        XCTAssertNotNil(MemberFolder.nameError("a/b"))
        XCTAssertNotNil(MemberFolder.nameError("a\\b"))
        XCTAssertNotNil(MemberFolder.nameError("C:"))
        XCTAssertNotNil(MemberFolder.nameError("a\u{7}b"))
    }

    func testRootContainingPicksDeepest() {
        let roots = ["/srv/legal", "/srv/legal/projects/delo-1", "/root/member1/"]
        XCTAssertEqual(MemberFolder.root(containing: "/srv/legal/projects/delo-1/sub", roots: roots),
                       "/srv/legal/projects/delo-1")
        XCTAssertEqual(MemberFolder.root(containing: "/root/member1", roots: roots), "/root/member1/")
        XCTAssertNil(MemberFolder.root(containing: "/srv/legalese", roots: roots))
        XCTAssertEqual(MemberFolder.root(containing: "c:\\Work\\A", roots: ["C:\\work"]), "C:\\work")
    }

    func testJoinKeepsSeparator() {
        XCTAssertEqual(MemberFolder.join(root: "/root/member1/", name: "x"), "/root/member1/x")
        XCTAssertEqual(MemberFolder.join(root: "/srv/a", name: "x"), "/srv/a/x")
        XCTAssertEqual(MemberFolder.join(root: "C:\\work\\", name: "x"), "C:\\work\\x")
    }
}
