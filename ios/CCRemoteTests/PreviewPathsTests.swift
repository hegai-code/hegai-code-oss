import XCTest
@testable import CCRemoteKit

/// Какие пути из ответа агента получают превью. Правила — в `PreviewPaths`.
final class PreviewPathsTests: XCTestCase {
    private func find(_ text: String) -> [String] { PreviewPaths.find(in: text) }

    func testScratchpadScreenshotAfterLabel() {
        let path = "/tmp/agents-0/-srv-shop-app/296c3cd6-4e13-4628-b670-8e8d7d23976f/scratchpad/mail.png"
        XCTAssertEqual(find("Готово.\n\nСкриншот: \(path)"), [path])
        XCTAssertEqual(find("Скриншот:\(path)"), [path], "метка без пробела не липнет к пути")
    }

    func testBackticksLinksAndTrailingPunctuation() {
        XCTAssertEqual(find("Смотри `/srv/a/shot.PNG`."), ["/srv/a/shot.PNG"])
        XCTAssertEqual(find("[скрин](/srv/a/b.png)"), ["/srv/a/b.png"])
        XCTAssertEqual(find("![](/srv/a/b.webp)"), ["/srv/a/b.webp"])
        XCTAssertEqual(find("(см. /srv/a/NOTES.md)"), ["/srv/a/NOTES.md"])
        XCTAssertEqual(find("«/srv/a/b.jpg», потом /srv/a/c.gif;"), ["/srv/a/b.jpg", "/srv/a/c.gif"])
        XCTAssertEqual(find("**/srv/a/b.markdown**"), ["/srv/a/b.markdown"])
        XCTAssertEqual(find("файл /srv/a/b.md: готов"), ["/srv/a/b.md"])
    }

    func testRelativeNeedsASlash() {
        XCTAssertEqual(find("см. docs/README.md и ./shots/a.jpeg и ../x/y.png"), ["docs/README.md", "./shots/a.jpeg", "../x/y.png"])
        XCTAssertEqual(find("прочитай README.md и logo.png"), [], "голое имя в прозе — слово, не ссылка")
    }

    func testWindowsPaths() {
        XCTAssertEqual(find(#"Сохранил C:\Users\owner\Desktop\shot.png."#), [#"C:\Users\owner\Desktop\shot.png"#])
        XCTAssertEqual(find("D:/tmp/a.md"), ["D:/tmp/a.md"])
    }

    func testIgnoresUrlsAndOtherExtensions() {
        XCTAssertEqual(find("https://example.com/a/b.png и [x](https://e.com/c.md)"), [])
        XCTAssertEqual(find("HTTP://E.com/a.png"), [])
        XCTAssertEqual(find("/srv/a/b.pdf /srv/a/c.png.bak /srv/a/.png /srv/a/d.txt"), [])
        XCTAssertEqual(find("//srv/a/b.png"), [])
    }

    // Та же таблица, что в web/test/file-paths.test.ts: правила меняются вместе.
    func testSpacesInsideDelimitedSpans() {
        XCTAssertEqual(find("Лежит в `/srv/my dir/скрин 1.png`."), ["/srv/my dir/скрин 1.png"])
        XCTAssertEqual(find("[скрин](</tmp/a b/c.png>)"), ["/tmp/a b/c.png"])
        XCTAssertEqual(find("Файл «/tmp/a b/plan.md» и \"docs/my notes/x.md\""), ["/tmp/a b/plan.md", "docs/my notes/x.md"])
        XCTAssertEqual(find("«смотри /tmp/x.png»"), ["/tmp/x.png"])
        XCTAssertEqual(find("`npm run shot -- out/a.png`"), ["out/a.png"])
    }

    func testOneSpaceAfterARootedFragmentIsBridged() {
        XCTAssertEqual(find("Скриншот: /srv/my dir/a.png"), ["/srv/my dir/a.png"])
        XCTAssertEqual(find("/srv/my dir/a.png"), ["/srv/my dir/a.png"])
        XCTAssertEqual(find("в /srv/x и docs/a.png"), ["docs/a.png"])
        XCTAssertEqual(find("/tmp/a.png docs/b.png"), ["/tmp/a.png", "docs/b.png"])
        XCTAssertEqual(find("см. /srv/x, docs/a.png"), ["docs/a.png"])
        XCTAssertEqual(find("Сохранил в web/dist screenshots/home.png"), ["screenshots/home.png"])
        XCTAssertEqual(find("Папка: /srv/app\ndocs/plan.md"), ["docs/plan.md"])
        XCTAssertEqual(find("`//host/a b.png`"), [])
        XCTAssertEqual(find("Скрин C:\\Users\\John Doe\\shot.png"), ["C:\\Users\\John Doe\\shot.png"])
    }

    func testDedupeKeepsOrderAndCapsAtSix() {
        XCTAssertEqual(find("/a/1.png /a/2.png /a/1.png `/a/2.png`"), ["/a/1.png", "/a/2.png"])
        let many = (1...9).map { "/a/\($0).png" }.joined(separator: " ")
        XCTAssertEqual(find(many), (1...6).map { "/a/\($0).png" })
    }

    /// Таблица `web/test/file-paths.test.ts`: копия расходится молча, если её не держит общая таблица.
    func testWebTable() {
        XCTAssertEqual(find("Обновил README.md и CHANGELOG.md"), [])
        XCTAssertEqual(find("См. docs/plan.md и web/shots/a.png, ещё ./notes/x.md"), ["docs/plan.md", "web/shots/a.png", "./notes/x.md"])
        XCTAssertEqual(find("[скрин](/tmp/a/b.png) и ![x](shots/c.webp)"), ["/tmp/a/b.png", "shots/c.webp"])
        XCTAssertEqual(find("[Image: source: /tmp/q/p.jpeg]"), ["/tmp/q/p.jpeg"])
        for tail in [".", ",", ";", ":", ")", "»", "\"", "'", "!", "?"] {
            XCTAssertEqual(find("Смотри /tmp/x/shot.png\(tail)"), ["/tmp/x/shot.png"], tail)
        }
        XCTAssertEqual(find("(см. /tmp/x/shot.png)."), ["/tmp/x/shot.png"])
        XCTAssertEqual(find("https://x.com/a/b.png и http://h/c/d.md"), [])
        XCTAssertEqual(find("[a](https://x.com/a/b.png) но /tmp/ok.png"), ["/tmp/ok.png"])
        XCTAssertEqual(find("www.example.com/a/b.png"), [])
        XCTAssertEqual(find(#"Файл C:\Users\p\shots\a.PNG готов"#), [#"C:\Users\p\shots\a.PNG"#])
        XCTAssertEqual(find("D:/out/plan.md."), ["D:/out/plan.md"])
        XCTAssertEqual(find("/a/b.txt /a/b.pdf /a/b.png.bak /a/b.pngx /a/B.MD /a/c.markdown"), ["/a/B.MD", "/a/c.markdown"])
        XCTAssertEqual(find("/tmp/отчёт/итог.md и снова /tmp/отчёт/итог.md"), ["/tmp/отчёт/итог.md"])
    }

    func testKindAndName() {
        XCTAssertTrue(PreviewPaths.isImage("/a/b.JPG"))
        XCTAssertFalse(PreviewPaths.isImage("/a/b.md"))
        XCTAssertTrue(PreviewPaths.isAbsolute("/a/b.md"))
        XCTAssertTrue(PreviewPaths.isAbsolute(#"C:\a\b.md"#))
        XCTAssertFalse(PreviewPaths.isAbsolute("a/b.md"))
        XCTAssertEqual(PreviewPaths.fileName("/a/b/c.png"), "c.png")
        XCTAssertEqual(PreviewPaths.fileName(#"C:\a\b.md"#), "b.md")
    }
}
