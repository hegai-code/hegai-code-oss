import XCTest
@testable import CCRemote

/// Счётная форма. Тест держит не «работает», а ГРАНИЦЫ: 1, 2, 5, 11–14 и
/// возврат на 21 — ровно те места, где правило меняется и где его пишут
/// неправильно.
final class PluralTests: XCTestCase {

    private func s(_ n: Int) -> String { counted(n, "сессия", "сессии", "сессий") }

    /// Тот самый случай, ради которого всё: машина с одной сессией — обычное
    /// состояние парка, и до этого она подписывалась «1 сессий».
    func testOne() {
        XCTAssertEqual(s(1), "1 сессия")
        XCTAssertEqual(s(21), "21 сессия")
        XCTAssertEqual(s(101), "101 сессия")
    }

    /// Форма для двух-четырёх — отдельная, и это та, которую забывают: в
    /// английском форм две, и «few» просто некуда положить.
    func testFew() {
        XCTAssertEqual(s(2), "2 сессии")
        XCTAssertEqual(s(4), "4 сессии")
        XCTAssertEqual(s(22), "22 сессии")
        XCTAssertEqual(s(103), "103 сессии")
    }

    func testMany() {
        XCTAssertEqual(s(5), "5 сессий")
        XCTAssertEqual(s(20), "20 сессий")
        XCTAssertEqual(s(25), "25 сессий")
    }

    /// Подростковый десяток идёт против последней цифры: 11 кончается на 1, но
    /// это «сессий». Правило смотрит на две цифры, и проверка тоже.
    func testTeens() {
        XCTAssertEqual(s(11), "11 сессий")
        XCTAssertEqual(s(12), "12 сессий")
        XCTAssertEqual(s(13), "13 сессий")
        XCTAssertEqual(s(14), "14 сессий")
        XCTAssertEqual(s(111), "111 сессий")
        XCTAssertEqual(s(112), "112 сессий")
    }

    /// Ноль — «сессий», и пустое состояние подписывается им же.
    func testZero() {
        XCTAssertEqual(s(0), "0 сессий")
    }
}
