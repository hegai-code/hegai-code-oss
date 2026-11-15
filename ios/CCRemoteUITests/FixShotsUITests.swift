import XCTest

/// Кадры ПРАВОК — тем же способом, что и обход: настоящими нажатиями.
///
/// Отдельно от `GuidedWalkUITests`, потому что назначение другое. Тот отвечает
/// «работает или нет» и ходит по всему продукту; этот доказывает КОНКРЕТНУЮ
/// правку и потому ходит коротко и встаёт ровно там, где её видно.
///
/// Общее у них одно и главное: до состояния ДОХОДЯТ, а не встают в него
/// launch-переменной. Кадр, снятый по `CC_SCREEN`, показывает, что экран умеет
/// так выглядеть, и ничего не говорит о том, что туда можно попасть.
///
/// Перед каждым кадром — ожидание УСПОКОЕНИЯ. Шторка и листы едут, и снимок,
/// сделанный по факту появления, ловит их на полпути: «открытая шторка» на
/// такой картинке обрезана краем экрана, а «поднятый лист» — это пустой экран
/// с полоской у нижней кромки. Оба раза виноват не продукт, а спешка снимка.
final class FixShotsUITests: XCTestCase {

    private var hub = ""
    private var token = ""

    override func setUpWithError() throws {
        continueAfterFailure = true
        let env = ProcessInfo.processInfo.environment
        hub = env["CC_LIVE_HUB"] ?? ""
        token = env["CC_LIVE_TOKEN"] ?? ""
        try XCTSkipIf(hub.isEmpty || token.isEmpty, "нужен живой хаб: правки видно только на настоящем инвентаре")
    }

    // MARK: - Кадры

    /// Пункт 2: строки шторки — только название.
    func testShotDrawerRows() {
        let app = launch()
        waitForFleet(app)
        shot(app, "02-drawer-before-open")
        XCTAssertTrue(openDrawer(app), "шторка не открылась")
        settleDrawer(app)
        shot(app, "02-drawer-title-only")
    }

    /// Пункты 3 и 4: нет кнопки «назад», панели стеклянные.
    func testShotSessionChrome() {
        let app = launch()
        waitForFleet(app)
        guard openFirstSession(app) else {
            XCTFail("не удалось открыть сессию нажатиями"); return
        }
        Thread.sleep(forTimeInterval: 1.5)
        shot(app, "0304-session-chrome")
        XCTAssertFalse(app.buttons["shell.back"].exists,
                       "кнопка «назад» всё ещё на экране сессии")
        // Выход из сессии — только шторкой: проверяем, что дорога осталась.
        XCTAssertTrue(openDrawer(app), "из сессии не открылась шторка — выйти нечем")
        settleDrawer(app)
        shot(app, "03-exit-via-drawer")
    }

    /// Пункт 5: стартовый экран — чипы, а не коробки.
    func testShotStartScreen() {
        let app = launch()
        waitForFleet(app)
        Thread.sleep(forTimeInterval: 1.0)
        shot(app, "05-start-screen")
    }

    /// Пункт 6: выбор модели виден ВНУТРИ сессии.
    func testShotRunPickerInSession() {
        let app = launch()
        waitForFleet(app)
        guard openFirstSession(app) else {
            XCTFail("не удалось открыть сессию нажатиями"); return
        }
        Thread.sleep(forTimeInterval: 1.5)
        shot(app, "06-session-run-picker")
    }

    /// Пункт 7: ОДИН И ТОТ ЖЕ кусок ленты в двух гарнитурах и двух темах.
    ///
    /// Лицо и тема приходят снаружи (`CC_FACE`, `CC_THEME`), потому что
    /// переключатель гарнитуры — константа сборки: без пусковой переменной
    /// пришлось бы пересобирать приложение между кадрами, и «тот же кусок
    /// ленты» перестал бы быть тем же. Имя кадра собирается из них же, чтобы
    /// четыре снимка нельзя было перепутать.
    func testShotReadingFace() {
        let env = ProcessInfo.processInfo.environment
        let face = env["CC_FACE"] ?? "system"
        let theme = env["CC_THEME"] ?? "light"

        let app = XCUIApplication()
        app.launchEnvironment = [
            "CC_HUB_URL": hub, "CC_TOKEN": token,
            "CC_THEME": theme, "CC_FACE": face, "CC_HW_KEYBOARD": "false",
        ]
        app.launch()
        waitForFleet(app)
        guard openFirstSession(app) else { XCTFail("не открылась сессия"); return }
        Thread.sleep(forTimeInterval: 2.0)
        shot(app, "07-face-\(face)-\(theme)")
    }

    /// Круг 0.7.4: модель в шапке, имена без голого URL, без оранжевого квадрата.
    func testShotRoundTwo() {
        let app = launch()
        waitForFleet(app)

        // Шторка: имена сессий и заголовок секции без оранжевой метки.
        XCTAssertTrue(openDrawer(app), "шторка не открылась")
        settleDrawer(app)
        shot(app, "10-drawer-names-no-ember")

        // Сессия: модель — главный элемент шапки, над композером пусто.
        guard openFirstSession(app) else { XCTFail("не открылась сессия"); return }
        Thread.sleep(forTimeInterval: 1.5)
        shot(app, "11-session-model-in-header")

        // Строка выбора над композером должна была УЙТИ вместе с переездом.
        XCTAssertFalse(app.staticTexts["GPT-6-Astra · High"].exists,
                       "старая строка модели осталась над композером")
    }

    /// Тот же круг в тёмной теме — читаемость шапки на стекле.
    func testShotRoundTwoDark() {
        let app = launch(theme: "dark")
        waitForFleet(app)
        guard openFirstSession(app) else { XCTFail("не открылась сессия"); return }
        Thread.sleep(forTimeInterval: 1.5)
        shot(app, "12-session-header-dark")
    }

    // MARK: - Дороги

    private func launch(theme: String = "light") -> XCUIApplication {
        let app = XCUIApplication()
        app.launchEnvironment = [
            "CC_HUB_URL": hub, "CC_TOKEN": token, "CC_THEME": theme, "CC_HW_KEYBOARD": "false",
        ]
        app.launch()
        return app
    }

    private func waitForFleet(_ app: XCUIApplication) {
        XCTAssertTrue(waitFor(90) {
            app.buttons.matching(NSPredicate(format: "label CONTAINS ' на '")).firstMatch.exists
        }, "флот не приехал")
    }

    private func drawerVisible(_ app: XCUIApplication) -> Bool {
        app.descendants(matching: .any).matching(identifier: "shell.drawer").firstMatch.exists
    }

    /// Жестом — он и есть проверяемая дорога; ☰ только как запасной ход.
    private func openDrawer(_ app: XCUIApplication) -> Bool {
        let from = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
        let to = app.coordinate(withNormalizedOffset: CGVector(dx: 0.92, dy: 0.5))
        from.press(forDuration: 0.06, thenDragTo: to)
        if waitFor(4, { self.drawerVisible(app) }) { return true }
        let burger = app.buttons["Сессии"]
        guard burger.exists else { return false }
        burger.tap()
        return waitFor(4) { self.drawerVisible(app) }
    }

    /// Панель шторки — самая большая область с её идентификатором.
    private func drawerPanel(_ app: XCUIApplication) -> CGRect {
        let matched = app.descendants(matching: .any).matching(identifier: "shell.drawer")
        var best = CGRect.null
        for i in 0..<8 {
            let e = matched.element(boundBy: i)
            guard e.exists else { break }
            let f = e.frame
            if best.isNull || f.width * f.height > best.width * best.height { best = f }
        }
        return best
    }

    /// Ждём, пока шторка ДОЕДЕТ: `shell.drawer` появляется на первом же сдвиге.
    private func settleDrawer(_ app: XCUIApplication) {
        var last = CGRect.null, stable = 0
        let deadline = Date().addingTimeInterval(4)
        while Date() < deadline {
            let best = drawerPanel(app)
            if best.isNull { break }
            if best.equalTo(last) { stable += 1; if stable >= 3 { return } } else { stable = 0; last = best }
        }
    }

    private func openFirstSession(_ app: XCUIApplication) -> Bool {
        guard openDrawer(app) else { return false }
        settleDrawer(app)
        // Отбор ПО МЕСТУ, а не по списку имён. Чипы линз подписаны вместе со
        // счётчиком («Список 648», «Flow 25»), поэтому точное совпадение с
        // «Список» их не ловит, и обход жал по линзе, считая её сессией.
        // Строки сессий — это всё, что лежит НИЖЕ поля поиска и ряда линз.
        // САМЫЙ БОЛЬШОЙ совпавший, а не `.firstMatch`: идентификатор достаётся и
        // потомкам, и первым оказывается крошечный внутренний вид (12×13pt).
        // По его рамке отбор «ниже поиска и выше подвала» отсекал вообще всё.
        let panel = drawerPanel(app)
        guard !panel.isNull else { return false }
        let listTop = panel.minY + 150
        for i in 0..<24 {
            let b = app.buttons.element(boundBy: i)
            guard b.exists else { break }
            let f = b.frame
            let l = b.label.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !l.isEmpty, l.count > 3, !l.contains(" на "),
                  f.minY > listTop, f.maxY < panel.maxY - 80,
                  app.frame.contains(f) else { continue }
            b.tap()
            if waitFor(20, { self.inSession(app) }) { return true }
        }
        return false
    }

    /// «Мы ВНУТРИ сессии».
    ///
    /// Раньше на это отвечала кнопка `shell.back`, но её у сессии больше нет
    /// (в том и правка). Композер для ответа не годится: он есть и на стартовом
    /// экране, поэтому проверка по нему была зелёной, ни разу не выйдя из
    /// корня, — и кадр «хром сессии» показывал стартовый экран со шторкой.
    ///
    /// Признак — по тому, чего в сессии НЕТ: полки проектов. Она живёт только
    /// на корне, и её строки узнаются по « на » в подписи.
    private func inSession(_ app: XCUIApplication) -> Bool {
        !drawerVisible(app)
            && app.textViews.firstMatch.exists
            && !app.buttons.matching(NSPredicate(format: "label CONTAINS ' на '")).firstMatch.exists
    }

    private func shot(_ app: XCUIApplication, _ name: String) {
        let a = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        a.name = name
        a.lifetime = .keepAlways
        add(a)
    }

    private func waitFor(_ seconds: TimeInterval, _ cond: () -> Bool) -> Bool {
        let deadline = Date().addingTimeInterval(seconds)
        repeat { if cond() { return true } } while Date() < deadline
        return cond()
    }
}
