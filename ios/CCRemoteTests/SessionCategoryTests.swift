import XCTest
@testable import CCRemoteKit

/// Категории — то, чем стартовый экран переписывает первый ход.
///
/// Тесты «четыре ярлыка Главной» отсюда ушли вместе с Главной: они проверяли
/// `homeShortcuts`, который спрашивал «умеет ли хоть одна онлайн-машина» и вёл
/// на форму, где машину выбирали заново. Стартовый экран знает, КУДА начинает,
/// поэтому спрашивает точно — про ту машину, на которую нацелен композер.
final class SessionCategoryTests: XCTestCase {
    /// Предлагается одна — та, где надиктовываешь сумбур и получаешь внятную
    /// постановку. Остальные одиннадцать стали LEGACY: они всё ещё называются и
    /// чипуются там, где их несёт существующая сессия, но не предлагаются.
    func testOnlyRamblingIsOffered() {
        XCTAssertEqual(SessionCategory.pickable, [.rambling])
    }

    /// `nil` — это «агент старше бандла скиллов», то есть НЕИЗВЕСТНО, а не
    /// «ничего не умеет»: иначе весь флот теряет чипы в день обновления хаба.
    func testAbsentSkillListMeansUnknownNotNone() {
        XCTAssertTrue(SessionCategory.rambling.runnable(on: nil))
        XCTAssertFalse(SessionCategory.rambling.runnable(on: []))
        XCTAssertTrue(SessionCategory.rambling.runnable(on: ["rambling"]))
    }

    /// Id категории и имя скилла совпадают НЕ везде, поэтому сверять надо со
    /// `skill`, а не с `rawValue`. Иначе чип выглядит сработавшим, а в
    /// транскрипте остаётся бесхозная слэш-команда.
    func testSkillNameIsNotAlwaysTheCategoryId() {
        XCTAssertEqual(SessionCategory.ship.skill, "raskatai")
        XCTAssertEqual(SessionCategory.codex.skill, "codex-review")
        XCTAssertEqual(SessionCategory.tz.skill, "backend-tz")
        XCTAssertEqual(SessionCategory.rambling.skill, "rambling")
        XCTAssertFalse(SessionCategory.ship.runnable(on: ["ship"]))
        XCTAssertTrue(SessionCategory.ship.runnable(on: ["raskatai"]))
    }

    /// Выброшенная категория обязана продолжать НАЗЫВАТЬСЯ: сессии с ней живы.
    func testLegacyCategoriesStillResolveToALabel() {
        XCTAssertEqual(SessionCategory(rawValue: "bugs")?.label, "Баги")
        XCTAssertEqual(SessionCategory(rawValue: "tz")?.label, "ТЗ на бэкенд")
    }
}
