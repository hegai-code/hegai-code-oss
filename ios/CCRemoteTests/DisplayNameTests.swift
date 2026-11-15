import XCTest
@testable import CCRemoteKit

/// Как сессия называется на экране.
///
/// Тесты здесь, а не в пакете: у `CCRemoteKit` нет тестового таргета (см. его
/// `Package.swift` — манифест намеренно древний ради CI), и протокольный слой
/// уже проверяется отсюда же (`ProtocolDecodingTests`).
///
/// Случаи выбраны не из головы: ровно их назвал владелец, увидев в шапке
/// `https://acme.test/m/36804d5d8c1b…`.
final class DisplayNameTests: XCTestCase {
    func testFallbackNeverSilentlyDropsTheSubject() {
        let title = "Создать веб-сервис для управления проектами"
        XCTAssertEqual(compactSessionName(title: title), title)
        XCTAssertEqual(compactSessionName(title: "Короткий заголовок"), "Короткий заголовок")
        XCTAssertEqual(compactSessionName(title: "Пересборка iPhone-приложения: фаза 0 подготовки"),
                       "Пересборка iPhone-приложения: фаза 0 подготовки")
    }

    // MARK: Ссылка

    func testURLBecomesHostAndShortTail() {
        let got = sessionDisplayName(title: "https://acme.test/m/36804d5d8c1b4e2fa9", sessionId: "abc123456")
        XCTAssertEqual(got, "acme.test/m/36804d…")
    }

    func testURLKeepsShortTailIntact() {
        // Хвост короткий — резать нечего, и многоточие было бы враньём.
        XCTAssertEqual(sessionDisplayName(title: "https://acme.test/m/abc"), "acme.test/m/abc")
    }

    func testURLWithoutPathIsJustHost() {
        XCTAssertEqual(sessionDisplayName(title: "https://acme.test"), "acme.test")
        XCTAssertEqual(sessionDisplayName(title: "https://acme.test/"), "acme.test")
    }

    func testProtocolIsAlwaysDropped() {
        // `https://` одинаков у всех и не различает ничего.
        XCTAssertFalse(sessionDisplayName(title: "http://example.com/x/yyyyyyyyyyyy").contains("http"))
    }

    func testNonURLTextIsNotTreatedAsLink() {
        // Слово «https» внутри фразы — не ссылка.
        let got = sessionDisplayName(title: "как работает https в проксях")
        XCTAssertEqual(got, "как работает https в проксях")
    }

    // MARK: Путь

    func testSlashWrappedPathLosesItsSlashes() {
        XCTAssertEqual(sessionDisplayName(title: "/hegai-smm/"), "hegai-smm")
    }

    func testPathWithSpacesIsLeftAlone() {
        // Это не путь, а фраза, начинающаяся со слэша.
        XCTAssertEqual(sessionDisplayName(title: "/ разобраться с этим"), "/ разобраться с этим")
    }

    // MARK: Пусто

    func testEmptyTitleFallsBackToProject() {
        XCTAssertEqual(sessionDisplayName(title: "", project: "hegai-smm", cwd: "/srv/x", sessionId: "zz"),
                       "hegai-smm")
    }

    func testEmptyTitleAndProjectFallBackToFolder() {
        XCTAssertEqual(sessionDisplayName(title: nil, project: nil, cwd: "/home/devbox/work/growth", sessionId: "zz"),
                       "growth")
    }

    func testLastResortIsShortSessionId() {
        XCTAssertEqual(sessionDisplayName(title: nil, sessionId: "36804d5d8c1b4e2f"), "36804d5d")
    }

    func testNothingAtAllStillNamesSomething() {
        // Пустая строка в списке — это строка, по которой нельзя попасть.
        XCTAssertEqual(sessionDisplayName(title: nil), "Сессия")
    }

    func testWhitespaceOnlyTitleCountsAsEmpty() {
        XCTAssertEqual(sessionDisplayName(title: "   \n  ", project: "growth"), "growth")
    }

    // MARK: Очень длинное

    func testVeryLongTitleIsClamped() {
        let long = String(repeating: "очень длинное имя ", count: 40)
        let got = sessionDisplayName(title: long)
        XCTAssertLessThanOrEqual(got.count, 60)
        XCTAssertTrue(got.hasSuffix("…"), "обрезка должна быть ВИДНА: «\(got)»")
    }

    func testTitleAtTheLimitIsNotTouched() {
        let exact = String(repeating: "a", count: 60)
        XCTAssertEqual(sessionDisplayName(title: exact), exact)
    }

    // MARK: Наследство cleanTitle

    func testInjectedMarkupIsStillStripped() {
        // Функция не заменяет `cleanTitle`, а стоит на нём: псевдо-теги и
        // маркеры заголовков снимаются до всех остальных решений.
        XCTAssertEqual(sessionDisplayName(title: "## Починить **сборку**"), "Починить сборку")
    }
}
