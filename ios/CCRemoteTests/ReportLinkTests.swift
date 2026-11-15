import XCTest
import CCRemoteKit

/// Какие ссылки приложение открывает само, а какие отдаёт Safari, и где в
/// странице встаёт политика. Граница здесь — токен: отчёт качается с хаба
/// приложения его сессией, поэтому чужой хост не должен совпасть никогда.
final class ReportLinkTests: XCTestCase {
    private let hub = "wss://code.acme.test/ui"
    private let id = "0123456789abcdef0123456789abcdef"

    private func link(_ s: String, hub: String? = nil) -> ReportLink? {
        ReportLink(URL(string: s)!, hubURL: hub ?? self.hub)
    }

    func testOwnHubReportOpensInApp() {
        let l = link("https://code.acme.test/w/reports/\(id)")
        XCTAssertEqual(l?.id, id)
        XCTAssertEqual(l?.contentPath, "api/reports/\(id)/content")
        // Второе имя того же хаба.
        XCTAssertEqual(link("https://claude.acme.test/w/reports/\(id)/")?.id, id)
        XCTAssertEqual(link("https://code.acme.test/w/reports/\(id.uppercased())")?.id, id)
    }

    func testEverythingElseGoesToSafari() {
        XCTAssertNil(link("https://evil.example/w/reports/\(id)"))
        XCTAssertNil(link("https://code.acme.test.evil.example/w/reports/\(id)"))
        XCTAssertNil(link("https://code.acme.test/w/reports"))
        XCTAssertNil(link("https://code.acme.test/w/reports/short"))
        XCTAssertNil(link("https://code.acme.test/w/reports/\(id)/content"))
        XCTAssertNil(link("https://code.acme.test/api/reports/\(id)/content"))
        XCTAssertNil(link("ftp://code.acme.test/w/reports/\(id)"))
        // Псевдоним не делает своим чужой хаб: dev-хаб на localhost не примет
        // ссылку с продового имени.
        XCTAssertNil(link("https://code.acme.test/w/reports/\(id)", hub: "ws://localhost:8080/ui"))
        XCTAssertEqual(link("http://localhost:8080/w/reports/\(id)", hub: "ws://localhost:8080/ui")?.id, id)
    }

    func testPolicyIsTheFirstNode() {
        let out = ReportLink.hardened("<!doctype html><html lang=ru><head><title>x</title><script>1</script></head><body></body></html>")
        XCTAssertTrue(out.hasPrefix("<!doctype html><meta http-equiv=\"Content-Security-Policy\""))
        XCTAssertTrue(out.contains("connect-src 'none'"))
        // Без doctype — в самое начало, а не после «первого <head» в тексте:
        // тот может стоять в комментарии или после скрипта.
        XCTAssertTrue(ReportLink.hardened("<script>fetch('x')</script><html><head></head></html>").hasPrefix("<meta http-equiv="))
        XCTAssertTrue(ReportLink.hardened("<!--<head>--><p>x</p>").hasPrefix("<meta http-equiv="))
        XCTAssertTrue(ReportLink.hardened("\n <!DOCTYPE html>\n<p>x</p>").hasPrefix("\n <!DOCTYPE html><meta http-equiv="))
    }
}
