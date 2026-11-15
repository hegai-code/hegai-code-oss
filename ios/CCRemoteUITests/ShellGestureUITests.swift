import XCTest

/// Жест шторки — НАСТОЯЩИМ касанием.
///
/// **Почему это отдельная цель, а не ещё один юнит-тест.** Юнит-тесты в
/// `ShellSwipeTests` проверяют арифметику порога и попадание точки в
/// прямоугольник — то есть правило на бумаге. Они ничего не говорят о том,
/// зарегистрировался ли прямоугольник вообще, в одной ли системе координат
/// лежат жест и регистр, и не отобрал ли `simultaneousGesture` тягу у
/// прокрутки. Каждая из этих трёх вещей ломает продукт молча: шторка либо
/// перестаёт открываться, либо начинает дёргаться на каждом протаскивании
/// широкого кода — а это самый заметный из возможных дефектов, потому что код
/// на телефоне читается ровно протаскиванием.
///
/// **Почему не рукой.** На этой машине синтетический ввод на уровне хоста
/// недоступен: `cliclick` сообщает «Accessibility privileges not enabled», и
/// курсор не двигается — привилегия выдаётся галочкой в системных настройках,
/// которую агент поставить не может. XCUITest ходит другим путём (канал
/// автоматизации самого приложения) и этой галочки не требует. Касание при
/// этом настоящее: последовательность touch down / move / up, а не вызов
/// замыкания мимо жеста.
///
/// Стенд — `CC_SCREEN=swipe-probe` (DEBUG), две мишени в известных местах.
final class ShellGestureUITests: XCTestCase {

    override func setUp() { continueAfterFailure = false }

    private func launchProbe() -> XCUIApplication {
        let app = XCUIApplication()
        // Хаб не нужен: стенд ничего у него не спрашивает. Но шелл показывается
        // только «настроенному» приложению (`AppSettings.isConfigured` — это
        // просто «есть адрес и токен»), поэтому и то и другое задаётся явно.
        // Адрес заведомо тупиковый — соединение не должно ни получиться, ни
        // потребоваться.
        app.launchEnvironment = [
            "CC_SCREEN": "swipe-probe",
            "CC_HUB_URL": "ws://127.0.0.1:1/ui",
            "CC_TOKEN": "ui-test",
            "CC_THEME": "light",
        ]
        app.launch()
        XCTAssertTrue(app.staticTexts["probe.state"].waitForExistence(timeout: 15),
                      "стенд не открылся")
        return app
    }

    /// Шторка смонтирована только пока открыта, поэтому её присутствие и есть
    /// состояние. Спрашивать у стенда ПОД ней нельзя: он в этот момент уехал,
    /// уменьшился и частично за краем экрана — его элементы недостижимы, и
    /// первая версия этого теста упала именно на этом, приняв сработавший жест
    /// за несработавший.
    private func drawerAppears(_ app: XCUIApplication, within: TimeInterval) -> Bool {
        app.descendants(matching: .any)["shell.drawer"].waitForExistence(timeout: within)
    }

    /// Тянем вправо ВНУТРИ код-блока: коробка едет сама, шторка молчит.
    func testSwipeInsideACodeBlockDoesNotOpenTheDrawer() {
        let app = launchProbe()
        XCTAssertFalse(drawerAppears(app, within: 1), "стенд должен начинаться с закрытой шторки")

        let code = app.descendants(matching: .any)["probe.code"]
        XCTAssertTrue(code.waitForExistence(timeout: 10))
        // Из левой трети блока далеко вправо — по всем порогам это был бы жест,
        // если бы его не глушила коробка.
        let from = code.coordinate(withNormalizedOffset: CGVector(dx: 0.15, dy: 0.5))
        let to = code.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.5))
        from.press(forDuration: 0.08, thenDragTo: to)

        XCTAssertFalse(drawerAppears(app, within: 2),
                       "свайп по код-блоку открыл шторку — правило «не красть у того, что едет вбок» не работает")
    }

    /// То же самое, но по коду ВНУТРИ прозы агента.
    ///
    /// Это не дубль предыдущего теста. Код в транскрипте приезжает двумя
    /// разными путями — `CodeBlock` служебной строки и `codeBlock` темы
    /// MarkdownUI, — и боковой ход у них включается в разных файлах. На
    /// телефоне чаще видят как раз второй, и до фазы 3 он не ехал вовсе.
    func testSwipeInsideMarkdownCodeDoesNotOpenTheDrawer() {
        let app = launchProbe()
        XCTAssertFalse(drawerAppears(app, within: 1))

        let code = app.descendants(matching: .any)["probe.mdcode"]
        XCTAssertTrue(code.waitForExistence(timeout: 10))
        let from = code.coordinate(withNormalizedOffset: CGVector(dx: 0.15, dy: 0.5))
        let to = code.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.5))
        from.press(forDuration: 0.08, thenDragTo: to)

        XCTAssertFalse(drawerAppears(app, within: 2),
                       "свайп по код-блоку из markdown открыл шторку")
    }

    /// Тот же жест РЯДОМ с блоком — открывает.
    ///
    /// Без этой половины первый тест ничего не доказывает: он одинаково зелёный
    /// и когда правило работает, и когда жест сломан целиком.
    func testTheSameSwipeBesideItOpensTheDrawer() {
        let app = launchProbe()
        XCTAssertFalse(drawerAppears(app, within: 1))

        let canvas = app.descendants(matching: .any)["probe.canvas"]
        XCTAssertTrue(canvas.waitForExistence(timeout: 10))
        let from = canvas.coordinate(withNormalizedOffset: CGVector(dx: 0.15, dy: 0.5))
        let to = canvas.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.5))
        from.press(forDuration: 0.08, thenDragTo: to)

        XCTAssertTrue(drawerAppears(app, within: 3), "свайп по обычному полотну не открыл шторку")
    }

    /// Возврат свайпом от левой кромки — ПОСЛЕ того, как системную кнопку
    /// «назад» спрятали и нарисовали свою.
    ///
    /// Прятать системную кнопку — исторически и есть тот способ, которым этот
    /// жест теряют: `UINavigationController` отключает
    /// `interactivePopGestureRecognizer` вместе с ней, и экран остаётся
    /// закрываемым только нажатием. Проверять это арифметикой нечем — только
    /// касанием, поэтому тест живёт здесь, рядом с жестом шторки.
    ///
    /// Заходим на экран Настроек (`CC_SCREEN=settings`), тянем от кромки и
    /// ждём, что собственная кнопка «назад» исчезла — то есть стек схлопнулся.
    func testSwipeBackStillPopsWithACustomBackButton() {
        let app = XCUIApplication()
        app.launchEnvironment = [
            "CC_SCREEN": "settings",
            "CC_HUB_URL": "ws://127.0.0.1:1/ui",
            "CC_TOKEN": "ui-test",
            "CC_THEME": "light",
        ]
        app.launch()

        let back = app.buttons["shell.back"]
        XCTAssertTrue(back.waitForExistence(timeout: 30), "экран Настроек не лёг на стек")

        // От САМОЙ кромки: системный жест возврата живёт там и только там.
        let from = app.coordinate(withNormalizedOffset: CGVector(dx: 0.002, dy: 0.5))
        let to = app.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.5))
        from.press(forDuration: 0.05, thenDragTo: to)

        let popped = NSPredicate(format: "exists == false")
        expectation(for: popped, evaluatedWith: back)
        waitForExpectations(timeout: 5) { error in
            XCTAssertNil(error, "свайп от кромки не вернул назад — вместе с системной кнопкой потерян жест")
        }
    }

    /// Вертикальная тяга — это прокрутка, и ей шторка не отвечает.
    func testAVerticalDragIsNotASwipe() {
        let app = launchProbe()
        let canvas = app.descendants(matching: .any)["probe.canvas"]
        XCTAssertTrue(canvas.waitForExistence(timeout: 10))
        let from = canvas.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.1))
        let to = canvas.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.95))
        from.press(forDuration: 0.08, thenDragTo: to)
        XCTAssertFalse(drawerAppears(app, within: 2), "вертикальная тяга открыла шторку")
    }
}
