import XCTest

/// ПРОХОД РУКАМИ по собранному приложению против ЖИВОГО хаба.
///
/// Это не приёмка правила и не baseline-съёмка. Это обход продукта нажатиями:
/// каждое состояние достигается тем же способом, каким до него доходит
/// человек, — пальцем, а не launch-переменной. Разница не косметическая:
/// кадр, снятый по `CC_SCREEN=...`, доказывает, что экран УМЕЕТ так
/// выглядеть; он ничего не говорит о том, можно ли до него ДОЙТИ.
///
/// **Ничего не чинится.** Тест собирает наблюдения и печатает их строками
/// `[ХОД]`; красный тест здесь — находка, а не поломка харнеса. Поэтому
/// `continueAfterFailure = true` и почти нет `XCTAssert`: обход, вставший на
/// первом расхождении, — полотчёта.
///
/// Запуск (мост — симуляторы этой машины не резолвят code.acme.test):
///
///     python3 ios/scripts/hub-bridge.py &
///     CC_LIVE_HUB=ws://localhost:8444/mobile/ui \
///     CC_LIVE_TOKEN=$(cat ~/.hegai-ui-token) \
///     xcodebuild test-without-building -project ios/CCRemote.xcodeproj -scheme CCRemote \
///       -destination "id=<UDID-SE3-375>" -derivedDataPath ios/build \
///       -only-testing:CCRemoteUITests/GuidedWalkUITests
final class GuidedWalkUITests: XCTestCase {

    private enum Verdict: String {
        case works = "РАБОТАЕТ", broken = "НЕ РАБОТАЕТ", unknown = "НЕ СМОГ ПРОВЕРИТЬ"
    }

    private var notes: [String] = []

    private func note(_ step: String, _ v: Verdict, _ detail: String) {
        let line = "[ХОД] \(step) — \(v.rawValue): \(detail)"
        notes.append(line)
        print(line)
    }

    private var hub = ""
    private var token = ""

    /// Имена агента — ими отличается ход агента от хода человека.
    private let agentNames = ["Claude", "Codex"]

    override func setUpWithError() throws {
        continueAfterFailure = true
        let env = ProcessInfo.processInfo.environment
        hub = env["CC_LIVE_HUB"] ?? ""
        token = env["CC_LIVE_TOKEN"] ?? ""
        try XCTSkipIf(hub.isEmpty || token.isEmpty,
                      "нет живого хаба: задайте CC_LIVE_HUB и CC_LIVE_TOKEN")
    }

    override func tearDown() {
        print("\n===== ИТОГ ХОДА: \(name) =====")
        notes.forEach { print($0) }
        print("===== КОНЕЦ =====\n")
        super.tearDown()
    }

    // MARK: - Съёмка

    /// Кадр уезжает вложением в .xcresult (`xcresulttool export attachments`).
    /// Писать файлом нельзя: раннер в песочнице симулятора.
    private func shot(_ name: String) {
        let a = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        a.name = name
        a.lifetime = .keepAlways
        add(a)
    }

    // MARK: - Запуск

    private func launchApp(theme: String = "light") -> XCUIApplication {
        let app = XCUIApplication()
        app.launchEnvironment = [
            "CC_HUB_URL": hub,
            "CC_TOKEN": token,
            "CC_THEME": theme,
            // Софт-клавиатура: железная хостовая не отъедает экран, а композер
            // проверяется именно против отъеденного.
            "CC_HW_KEYBOARD": "false",
        ]
        app.launch()
        return app
    }

    /// Полка стартового экрана приезжает ВТОРЫМ сообщением после `connected`.
    @discardableResult
    private func waitForFleet(_ app: XCUIApplication, _ seconds: TimeInterval = 90) -> Bool {
        waitFor(seconds) { self.shelfRow(app).exists }
    }

    private func shelfRow(_ app: XCUIApplication) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "label CONTAINS ' на '")).firstMatch
    }

    private func waitFor(_ seconds: TimeInterval, _ cond: () -> Bool) -> Bool {
        let deadline = Date().addingTimeInterval(seconds)
        repeat { if cond() { return true } } while Date() < deadline
        return cond()
    }

    private func drawerOpen(_ app: XCUIApplication) -> Bool {
        app.descendants(matching: .any)["shell.drawer"].exists
    }

    // MARK: - Жесты

    /// Тяга вправо с ОСТАНОВКОЙ на полпути.
    ///
    /// `thenHoldForDuration` — единственный способ поймать жест В ПРОЦЕССЕ:
    /// палец доезжает и ЗАМИРАЕТ, а кадр снимает фоновая очередь внутри этого
    /// окна. Без удержания снимается только «до» и «после», а вопрос ровно
    /// про «во время».
    @discardableResult
    private func swipeRightHolding(_ app: XCUIApplication,
                                   fromX: CGFloat, toX: CGFloat,
                                   y: CGFloat = 0.5,
                                   shotName: String?) -> Bool {
        let from = app.coordinate(withNormalizedOffset: CGVector(dx: fromX, dy: y))
        let to = app.coordinate(withNormalizedOffset: CGVector(dx: toX, dy: y))

        var mountedMidGesture = false
        let mid = expectation(description: "кадр середины жеста")
        DispatchQueue.global(qos: .userInitiated).asyncAfter(deadline: .now() + 0.9) {
            mountedMidGesture = self.drawerOpen(app)
            if let shotName { self.shot(shotName) }
            mid.fulfill()
        }
        from.press(forDuration: 0.06, thenDragTo: to, withVelocity: .slow, thenHoldForDuration: 1.6)
        wait(for: [mid], timeout: 25)
        return mountedMidGesture
    }

    /// Дождаться, пока шторка ДОЕДЕТ, и вернуть её кадр.
    ///
    /// «Открыта» и «доехала» — разные вопросы: `shell.drawer` появляется на
    /// ПЕРВОМ различимом сдвиге (`visible: t > 0`), поэтому ожидание по одному
    /// наличию идентификатора возвращается посреди анимации. Кадры первого
    /// обхода из-за этого снимали шторку на полпути — её левая треть уходила
    /// за край экрана, и «открытая шторка» на картинке выглядела обрезанной.
    /// Здесь ждём, пока кадр перестанет меняться.
    @discardableResult
    private func settleDrawer(_ app: XCUIApplication, _ seconds: TimeInterval = 4) -> CGRect {
        // Идентификатор шторки разрешается больше чем в один элемент: SwiftUI
        // раздаёт его и потомкам. Поэтому, во-первых, нельзя спрашивать `frame`
        // у самого запроса (XCUITest отвечает «Multiple matching elements
        // found» и роняет тест), а во-вторых — нельзя брать `.firstMatch`: им
        // оказывается крошечный внутренний вид (замер дал 12.5×13pt), и по
        // нему «доехала ли шторка» не отвечает ничто. Берём САМЫЙ БОЛЬШОЙ
        // совпавший — это и есть контейнер.
        let matched = app.descendants(matching: .any).matching(identifier: "shell.drawer")
        func panel() -> CGRect {
            var best = CGRect.null
            for i in 0..<8 {
                let e = matched.element(boundBy: i)
                guard e.exists else { break }
                let f = e.frame
                if best.isNull || f.width * f.height > best.width * best.height { best = f }
            }
            return best
        }
        var last = CGRect.null, stable = 0
        let deadline = Date().addingTimeInterval(seconds)
        while Date() < deadline {
            let f = panel()
            if f.isNull { break }
            if f.equalTo(last) {
                stable += 1
                if stable >= 3 { return f }
            } else {
                stable = 0; last = f
            }
        }
        return last
    }

    private func closeDrawer(_ app: XCUIApplication) {
        if app.buttons["Закрыть"].exists { app.buttons["Закрыть"].tap() }
        else { app.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.5)).tap() }
        _ = waitFor(4) { !self.drawerOpen(app) }
    }

    /// Открыть шторку. Сначала ЖЕСТОМ (его и проверяем), кнопка — только
    /// запасной ход, чтобы обход не встал, и он отмечается в журнале.
    private func openDrawer(_ app: XCUIApplication, shot name: String? = nil) -> Bool {
        swipeRightHolding(app, fromX: 0.5, toX: 0.85, shotName: name)
        if waitFor(4, { self.drawerOpen(app) }) { return true }
        let burger = app.buttons["Сессии"]
        if burger.exists {
            burger.tap()
            return waitFor(4) { self.drawerOpen(app) }
        }
        return false
    }

    // MARK: - 1. Шторка

    func test01_Drawer() {
        let app = launchApp()
        XCTAssertTrue(waitForFleet(app), "флот не приехал за 90с")
        shot("01a-start")
        XCTAssertFalse(drawerOpen(app), "обход должен начинаться с закрытой шторки")

        // --- за пальцем или после отпускания ---------------------------------
        let tracked = swipeRightHolding(app, fromX: 0.5, toX: 0.8,
                                        shotName: "01b-drawer-mid-gesture")
        note("1. Шторка / идёт за пальцем", tracked ? .works : .broken,
             tracked
             ? "на полпути тяги (палец ещё на стекле, до отпускания) шторка уже смонтирована "
               + "и видима — значит едет за пальцем. Кадр 01b снят ВНУТРИ жеста."
             : "на полпути тяги шторки на экране нет — она прилетает только после отпускания. Кадр 01b.")

        let opened = waitFor(4) { self.drawerOpen(app) }
        let settled = settleDrawer(app)
        shot("01c-drawer-open")
        note("1. Шторка / открывается свайпом вправо", opened ? .works : .broken,
             opened ? "свайп вправо от середины экрана открыл шторку" : "свайп вправо шторку не открыл")
        guard opened else { return }

        // Доехала ли до конца, а не застряла на полпути: у доехавшей шторки
        // левый край совпадает с краем экрана.
        let flush = settled.minX >= -1
        note("1. Шторка / доезжает до конца", flush ? .works : .broken,
             "кадр доехавшей шторки \(settled) при экране \(app.frame); "
             + (flush ? "левый край вровень с экраном"
                      : "левый край УШЁЛ за экран — шторка встала, не доехав"))

        // --- закрыть тапом по затемнению --------------------------------------
        // На 375 карточка шторки занимает левую долю; тап у правого края — скрим.
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.5)).tap()
        let closedByScrim = waitFor(4) { !self.drawerOpen(app) }
        shot("01d-after-scrim-tap")
        note("1. Шторка / закрытие тапом по затемнению", closedByScrim ? .works : .broken,
             closedByScrim ? "тап по затемнению справа закрыл шторку" : "тап по затемнению шторку не закрыл")

        // --- открыть снова и закрыть свайпом влево -----------------------------
        guard openDrawer(app, shot: "01e-reopen-mid") else {
            note("1. Шторка / повторное открытие", .broken, "второй свайп вправо шторку не открыл")
            return
        }
        let from = app.coordinate(withNormalizedOffset: CGVector(dx: 0.55, dy: 0.5))
        let to = app.coordinate(withNormalizedOffset: CGVector(dx: 0.05, dy: 0.5))
        from.press(forDuration: 0.06, thenDragTo: to)
        let closedBySwipe = waitFor(4) { !self.drawerOpen(app) }
        shot("01f-after-swipe-left")
        note("1. Шторка / закрытие свайпом влево", closedBySwipe ? .works : .broken,
             closedBySwipe ? "свайп влево закрыл шторку" : "свайп влево шторку не закрыл")
    }

    // MARK: - 2. Ложное срабатывание на код-блоке

    func test02_CodeBlockDoesNotStealTheSwipe() {
        let app = launchApp()
        XCTAssertTrue(waitForFleet(app))

        guard openSession(app, preferring: .withCode) else {
            note("2. Ложное срабатывание", .unknown, "не удалось открыть ни одной живой сессии")
            return
        }
        shot("02a-session-opened")

        guard let code = findWideCodeBlock(app) else {
            note("2. Ложное срабатывание", .unknown,
                 "в доступных живых сессиях не нашлось горизонтально едущей коробки кода. "
                 + "Правило проверено синтетикой в ShellGestureUITests (probe.code/probe.mdcode), "
                 + "но НЕ на живом транскрипте.")
            return
        }
        shot("02b-code-block")
        XCTAssertFalse(drawerOpen(app))

        let from = code.coordinate(withNormalizedOffset: CGVector(dx: 0.12, dy: 0.5))
        let to = code.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.5))

        var stirredMidGesture = false
        let mid = expectation(description: "середина протаскивания кода")
        DispatchQueue.global(qos: .userInitiated).asyncAfter(deadline: .now() + 0.9) {
            stirredMidGesture = self.drawerOpen(app)
            self.shot("02c-code-drag-mid")
            mid.fulfill()
        }
        from.press(forDuration: 0.06, thenDragTo: to, withVelocity: .slow, thenHoldForDuration: 1.6)
        wait(for: [mid], timeout: 25)

        let stirredAfter = waitFor(2) { self.drawerOpen(app) }
        shot("02d-code-drag-after")
        let clean = !stirredMidGesture && !stirredAfter
        note("2. Ложное срабатывание", clean ? .works : .broken,
             clean
             ? "протаскивание широкого код-блока вбок шторку не шевельнуло — ни в середине жеста, ни после отпускания"
             : "протаскивание код-блока ШЕВЕЛЬНУЛО шторку (в середине: \(stirredMidGesture), после: \(stirredAfter))")
    }

    // MARK: - 3. Листы

    func test03_Sheets() {
        let app = launchApp()
        XCTAssertTrue(waitForFleet(app))
        guard openSession(app) else {
            note("3. Листы", .unknown, "не удалось открыть живую сессию")
            return
        }

        // --- «О сессии»: по заголовку, закрыть тапом снаружи -------------------
        guard let title = sessionTitleButton(app) else {
            note("3. Лист «О сессии» / открытие", .unknown, "не нашёл кнопку-заголовок в шапке сессии")
            return
        }
        title.tap()
        let infoUp = waitFor(8) { self.infoSheetUp(app) }
        // Лист ещё ВЫЕЗЖАЕТ, когда его уже видно: без этой паузы кадр ловит
        // панель на полпути, и «открытый лист» на картинке — пустой экран с
        // краем панели у нижней кромки. Ждём, пока «Готово» станет нажимаемым.
        _ = waitFor(4) { app.buttons["Готово"].exists && app.buttons["Готово"].isHittable }
        shot("03a-session-info-sheet")
        note("3. Лист «О сессии» / открытие по заголовку", infoUp ? .works : .broken,
             infoUp ? "тап по заголовку сессии поднял лист «О сессии»" : "тап по заголовку лист не поднял")

        if infoUp {
            // Снаружи = выше панели: лист во всю высоту прозрачный, верх — скрим.
            app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.05)).tap()
            let closed = waitFor(5) { !self.infoSheetUp(app) }
            shot("03b-after-outside-tap")
            note("3. Лист «О сессии» / закрытие тапом снаружи", closed ? .works : .broken,
                 closed ? "тап по затемнению над панелью закрыл лист"
                        : "тап снаружи лист НЕ закрыл — а он продуктовый и должен закрываться")
            if !closed, app.buttons["Готово"].exists { app.buttons["Готово"].tap() }
        }

        // --- лист подтверждения инструмента -------------------------------------
        // Вызвать по требованию нельзя: он приходит, когда живой прогон просит
        // разрешения. Ловим тот, что есть; не поймали — так и пишем.
        let approve = app.buttons.matching(
            NSPredicate(format: "label IN {'Allow', 'Deny', 'Разрешить', 'Запретить'}")).firstMatch
        let banner = app.buttons["Открыть"]
        var caught = approve.waitForExistence(timeout: 4)
        if !caught, banner.exists, app.staticTexts["Ждёт подтверждения инструмента"].exists {
            banner.tap()
            caught = approve.waitForExistence(timeout: 6)
        }

        if caught {
            shot("03c-tool-approval-sheet")
            app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.05)).tap()
            let stillThere = waitFor(3) { approve.exists }
            shot("03d-tool-sheet-after-outside-tap")
            note("3. Лист подтверждения инструмента / НЕ закрывается снаружи",
                 stillThere ? .works : .broken,
                 stillThere
                 ? "тап снаружи лист решения не закрыл — верно: случайный тап не должен означать «нет»"
                 : "ОПАСНО: лист решения закрылся тапом снаружи — это «нет», которого человек не говорил, "
                   + "отправленное в работающий прогон")
        } else {
            note("3. Лист подтверждения инструмента", .unknown,
                 "за время обхода ни один живой прогон не запросил подтверждения инструмента — "
                 + "поймать этот лист по требованию нельзя. По коду он поднимается обычным .sheet "
                 + "(SessionDetailView.presentations), то есть модально, в отличие от productSheet "
                 + "у «О сессии»; нажатием это НЕ подтверждено.")
        }
    }

    private func infoSheetUp(_ app: XCUIApplication) -> Bool {
        app.navigationBars["О сессии"].exists
            || app.staticTexts["О сессии"].exists
            || (app.buttons["Готово"].exists && app.staticTexts["Машина"].exists)
    }

    // MARK: - 4. Лента

    func test04_Feed() {
        let app = launchApp()
        XCTAssertTrue(waitForFleet(app))
        guard openSession(app, preferring: .withToolRuns) else {
            note("4. Лента", .unknown, "не удалось открыть живую сессию с содержимым")
            return
        }
        shot("04a-feed")

        // --- свёрнутые прогоны: значок со счётчиком -----------------------------
        // ВАЖНО: «Показать всё» (длинная реплика) и «Показать более ранние»
        // (голова ленты) тоже начинаются со слова «Показать» и сюда попасть НЕ
        // должны — иначе тест раскрывает не то и рапортует об успехе.
        var chipOrNil = visibleToolChip(app)
        for _ in 0..<8 where chipOrNil == nil {
            app.swipeDown()
            chipOrNil = visibleToolChip(app)
        }

        if let chip = chipOrNil {
            let label = chip.label
            shot("04b-collapsed-tool-run")
            let hasCounter = label.rangeOfCharacter(from: .decimalDigits) != nil
            note("4. Лента / свёрнутый прогон — значок со счётчиком",
                 hasCounter ? .works : .unknown,
                 hasCounter
                 ? "свёрнутый прогон найден и подписан числом: «\(label)» — значок со счётчиком на месте"
                 : "найден свёрнутый прогон без числа: «\(label)» (прогон без вызовов — допустимый случай)")

            chip.tap()
            // Раскрытый прогон — это `openCard` вместо значка: сам значок
            // перестаёт существовать, а в шапке карточки появляется сводка
            // вида «14 действий · Read×6 · Bash×4». Считать совпадения (`.count`)
            // здесь нельзя — это снова полный обход дерева.
            let expanded = waitFor(6) {
                !chip.exists
                    || app.staticTexts.matching(
                        NSPredicate(format: "label CONTAINS '×'")).firstMatch.exists
            }
            shot("04c-tool-run-expanded")
            note("4. Лента / прогон разворачивается по тапу", expanded ? .works : .broken,
                 expanded ? "тап по значку раскрыл прогон (значок ушёл, появилась карточка вызовов)"
                          : "тап по значку прогон не раскрыл")
        } else {
            note("4. Лента / свёрнутые прогоны", .unknown,
                 "в открытой сессии не встретилось свёрнутых прогонов инструментов")
        }

        // --- геометрия ходов: плашка человека справа, агент — во всю меру -------
        measureTurnGeometry(app)
    }

    private var toolChipPredicate: NSPredicate {
        NSPredicate(format: "label BEGINSWITH 'Показать ' AND NOT (label IN {'Показать всё', 'Показать более ранние'})")
    }
    private func toolChip(_ app: XCUIApplication) -> XCUIElement {
        app.buttons.matching(toolChipPredicate).firstMatch
    }

    /// Свёрнутый прогон, который РЕАЛЬНО НА ЭКРАНЕ.
    ///
    /// `firstMatch` отдаёт первый в дереве, а не первый видимый: в длинной
    /// сессии это ход, уехавший вверх (кадр y = -511), и нажатие по нему
    /// роняет тест («Failed to not hittable»). Лента длинная всегда, так что
    /// это не краевой случай, а обычный.
    private func visibleToolChip(_ app: XCUIApplication) -> XCUIElement? {
        let matched = app.buttons.matching(toolChipPredicate)
        for i in 0..<8 {
            let e = matched.element(boundBy: i)
            guard e.exists else { break }
            let f = e.frame
            if f.height > 1, app.frame.contains(f) { return e }
        }
        return nil
    }

    /// «Реплика человека — плашкой справа? У агента имени и времени нет?»
    ///
    /// Спросить это у дерева доступности НЕЛЬЗЯ: контейнер хода подписан
    /// «Имя, ЧЧ:ММ» и у человека, и у агента — подпись там служебная, для
    /// VoiceOver. Разница чисто зрительная, поэтому меряется ГЕОМЕТРИЕЙ:
    /// плашка человека уже меры и прижата вправо, ход агента идёт во всю меру
    /// от левого поля.
    private func measureTurnGeometry(_ app: XCUIApplication) {
        let stamped = NSPredicate(format: "label MATCHES '.+, [0-9]{2}:[0-9]{2}'")
        // Только внутри ленты: шторка смонтирована всегда и её строки не ходы.
        // Ищем по всему приложению, но С ПОТОЛКОМ и только среди того, что
        // реально на экране: сужение до `feedView` промахивалось (контейнеры
        // ходов лежат не в том поддереве, которое возвращала эвристика), а
        // закрытая шторка и так стоит за краем и в выборку не попадает.
        var turns: [XCUIElement] = []
        let matched = app.descendants(matching: .any).matching(stamped)
        for i in 0..<14 {
            let e = matched.element(boundBy: i)
            guard e.exists else { break }
            let f = e.frame
            if f.width > 40, app.frame.intersects(f), f.maxX > 0 { turns.append(e) }
        }
        guard !turns.isEmpty else {
            note("4. Лента / плашка человека и ход агента", .unknown,
                 "в видимой части ленты не нашлось подписанных ходов, чтобы померить геометрию")
            return
        }

        let screen = app.frame
        var human: [CGRect] = [], agent: [CGRect] = []
        for t in turns {
            let name = t.label.components(separatedBy: ",").first ?? ""
            if agentNames.contains(where: { name.caseInsensitiveCompare($0) == .orderedSame }) {
                agent.append(t.frame)
            } else {
                human.append(t.frame)
            }
        }
        shot("04d-turn-geometry")

        if let h = human.first, let a = agent.first {
            // Плашка справа: её левый край заметно правее левого края хода агента.
            let pushedRight = h.minX > a.minX + 24
            let narrower = h.width < a.width - 24
            note("4. Лента / реплика человека — плашкой справа",
                 (pushedRight || narrower) ? .works : .broken,
                 "ход человека: x=\(Int(h.minX)) ш=\(Int(h.width)); ход агента: x=\(Int(a.minX)) ш=\(Int(a.width)); "
                 + "экран \(Int(screen.width))pt. Прижат вправо: \(pushedRight), уже меры: \(narrower)")
        } else {
            note("4. Лента / реплика человека — плашкой справа", .unknown,
                 "в видимой части нашлись ходы только одной стороны "
                 + "(человек: \(human.count), агент: \(agent.count)) — сравнивать не с чем")
        }

        // Имя и время агента не должны быть НАПИСАНЫ на экране.
        var visibleAgentName: String?
        for n in agentNames where app.staticTexts[n].exists { visibleAgentName = n }
        note("4. Лента / у агента нет имени и времени",
             visibleAgentName == nil ? .works : .broken,
             visibleAgentName == nil
             ? "имя агента на экране не написано — оно живёт только в подписи для VoiceOver, как и задумано"
             : "имя агента «\(visibleAgentName!)» видно текстом в ленте")
    }

    // MARK: - 5. Композер

    func test05_Composer() {
        let app = launchApp()
        XCTAssertTrue(waitForFleet(app))

        let field = app.textViews.firstMatch
        guard field.waitForExistence(timeout: 60) else {
            note("5. Композер", .unknown, "поле композера не появилось")
            return
        }
        shot("05a-composer-empty")

        // --- микрофон ПЕРВЫМ: он размонтируется, как только в поле есть текст ---
        let mic = app.buttons["Начать запись"]
        if mic.waitForExistence(timeout: 10) {
            mic.tap()
            allowSystemPrompts(times: 2)
            let recording = app.buttons["Остановить запись"]
            let alert = app.alerts.firstMatch
            _ = waitFor(25) { recording.exists || alert.exists }
            shot("05b-mic-after-tap")
            if recording.exists {
                note("5. Композер / микрофон", .works, "кнопка довела до состояния записи")
                recording.tap()
            } else if alert.exists {
                let said = alert.staticTexts.allElementsBoundByIndex.map(\.label).joined(separator: " / ")
                note("5. Композер / микрофон", .unknown,
                     "до записи не дошло, но кнопка НЕ мёртвая — приложение вслух назвало причину: «\(said)». "
                     + "На симуляторе это единственный достижимый исход: нет DNS → SFSpeechRecognizer.isAvailable == false.")
                alert.buttons.firstMatch.tap()
            } else {
                note("5. Композер / микрофон", .broken,
                     "микрофон нажат — и не произошло НИЧЕГО: ни записи, ни объяснённого отказа")
            }
        } else {
            note("5. Композер / микрофон", .unknown, "кнопки микрофона нет на экране")
        }

        // --- рост поля и судьба кнопки отправки на 375 --------------------------
        let emptyHeight = field.frame.height
        field.tap()
        field.typeText("строка один\nстрока два\nстрока три\nстрока четыре")
        shot("05c-composer-multiline")
        let grownHeight = field.frame.height
        let grew = grownHeight > emptyHeight + 8

        let send = app.buttons["Отправить"]
        let sendExists = send.exists
        let screen = app.frame
        let sendInside = sendExists && screen.contains(send.frame)
        // `isHittable` роняет тест на элементе с невалидной точкой активации,
        // поэтому спрашиваем только когда у кнопки есть живой кадр.
        let sendHittable = sendExists && send.frame.width > 1 && send.frame.height > 1 && send.isHittable
        note("5. Композер / поле растёт", grew ? .works : .broken,
             "высота поля \(Int(emptyHeight))pt → \(Int(grownHeight))pt на четырёх строках")
        note("5. Композер / кнопка отправки не съедена на 375",
             (sendHittable && sendInside) ? .works : .broken,
             "кнопка «Отправить»: существует \(sendExists), нажимаема \(sendHittable), в границах экрана \(sendInside); "
             + "кадр кнопки \(sendExists ? "\(send.frame)" : "—"), экран \(screen)")

        clearField(field)

        // --- вложение -------------------------------------------------------------
        let clip = app.buttons["Вложение"]
        if clip.waitForExistence(timeout: 10) {
            clip.tap()
            let library = app.buttons["Медиатека"]
            if library.waitForExistence(timeout: 8) {
                shot("05d-attachment-menu")
                library.tap()
                // ИМЕННО снимок в пикере, а не первая попавшаяся картинка:
                // `app.images.firstMatch` цепляет служебный глиф композера,
                // уехавший за левый край (кадр x=-286), и XCUITest роняет тест
                // на попытке прокрутить к нему («Failed to scroll to visible»).
                // Берём ПЛИТКУ СЕТКИ, а не «первую картинку на экране»: у
                // системного пикера сверху стоят баннер «Private Access to
                // Photos» и панель управления, и тап по ним открывает меню
                // сортировки — снимок при этом не выбирается, а обход
                // докладывает «вложение не работает». Сетка живёт в нижней
                // половине и состоит из крупных плиток.
                var photo: XCUIElement?
                // Сетка начинается ВЫШЕ середины экрана (на 375 — примерно с
                // трети), поэтому порог по середине отсекал первый ряд целиком
                // и обход докладывал «медиатека пуста» на полной медиатеке.
                // Треть высоты — ниже баннера и панели, но выше первого ряда.
                let grid = app.frame.height * 0.3
                _ = waitFor(25) {
                    let cell = app.cells.element(boundBy: 0)
                    if cell.exists, cell.frame.width > 60, app.frame.contains(cell.frame) {
                        photo = cell; return true
                    }
                    for i in 0..<12 {
                        let img = app.images.element(boundBy: i)
                        guard img.exists else { break }
                        let f = img.frame
                        if f.width > 60, f.height > 60, f.minY > grid, app.frame.contains(f) {
                            photo = img; return true
                        }
                    }
                    return false
                }
                if let photo {
                    photo.tap()
                    for name in ["Add", "Добавить", "Done", "Готово"] where app.buttons[name].exists {
                        app.buttons[name].tap(); break
                    }
                    let attached = app.otherElements["composer.attachment"].waitForExistence(timeout: 20)
                        || app.images["composer.attachment"].waitForExistence(timeout: 3)
                    shot("05e-attachment-attached")
                    note("5. Композер / вложение", attached ? .works : .broken,
                         attached ? "снимок из медиатеки прикрепился к композеру"
                                  : "снимок выбран, но вложение в композере не появилось")
                } else {
                    shot("05d2-empty-library")
                    note("5. Композер / вложение", .unknown,
                         "пикер открылся, но медиатека симулятора пуста — выбирать нечего "
                         + "(лечится `xcrun simctl addmedia <UDID> файл.png`)")
                }
            } else {
                note("5. Композер / вложение", .broken, "меню вложения не предложило «Медиатека»")
            }
        } else {
            note("5. Композер / вложение", .unknown, "кнопки вложения нет на экране")
        }
    }

    // MARK: - 6. Живая отправка

    func test06_LiveSend() {
        let app = launchApp()
        XCTAssertTrue(waitForFleet(app), "флот не приехал — отправлять некуда")

        // Шлём в УЖЕ ИДУЩУЮ длинную сессию, а не в свежую со стартового
        // экрана. Разница принципиальна для последней проверки шага: «лента не
        // дёргает вниз, пока читаешь выше» требует, чтобы выше ВООБЩЕ БЫЛО что
        // читать. В новой сессии транскрипт короче экрана, прокрутки нет, и
        // замер смещения меряет не рывок ленты, а то, что ответ дописался снизу
        // и сдвинул вверх прижатое к низу — то есть ничего.
        let opened = openSession(app, preferring: .withToolRuns)
        if !opened {
            // Запасной ход: начать новую с полки, но тогда честно сказать, что
            // анти-рывок этим прогоном не проверен.
            let project = shelfRow(app)
            if project.exists { project.tap() }
        }
        shot("06a-session-opened")

        let field = app.textViews.firstMatch
        guard field.waitForExistence(timeout: 60) else {
            note("6. Живая отправка", .unknown, "композер не появился")
            return
        }

        let mark = "обход-\(Int(Date().timeIntervalSince1970) % 100000)"
        field.tap()
        field.typeText("Ответь ровно одним словом: \(mark)")
        shot("06b-typed")

        let send = app.buttons["Отправить"]
        guard send.waitForExistence(timeout: 10), send.isEnabled else {
            note("6. Живая отправка", .broken, "кнопка отправки отсутствует или неактивна при набранном тексте")
            return
        }
        send.tap()

        let leftComposer = waitFor(25) { ((field.value as? String) ?? "").contains(mark) == false }
        shot("06c-after-send")
        note("6. Живая отправка / ход ушёл", leftComposer ? .works : .broken,
             leftComposer ? "черновик очистился — отправка состоялась (черновик чистится только на успехе)"
                          : "текст остался в композере: отправка не состоялась")
        guard leftComposer else { return }

        let mine = waitFor(30) {
            app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", mark)).firstMatch.exists
        }
        shot("06d-my-message-in-feed")
        note("6. Живая отправка / своя реплика в ленте", mine ? .works : .broken,
             mine ? "отправленное появилось в транскрипте" : "отправленное в транскрипте не появилось")

        // --- не дёргает вниз, пока читаешь выше ----------------------------------
        // Уезжаем вверх и держим позицию, пока внизу капает ответ.
        // Уезжаем вверх и ПРОВЕРЯЕМ, что уехали: если прокрутки не было, вся
        // проверка ниже бессмысленна, и надо сказать это, а не выдать
        // сдвиг прижатого к низу за рывок ленты.
        let topBefore = app.staticTexts.element(boundBy: 0).exists
            ? app.staticTexts.element(boundBy: 0).frame.origin.y : CGFloat.nan
        app.swipeDown(); app.swipeDown()
        let topAfter = app.staticTexts.element(boundBy: 0).exists
            ? app.staticTexts.element(boundBy: 0).frame.origin.y : CGFloat.nan
        let didScroll = !topBefore.isNaN && !topAfter.isNaN && abs(topAfter - topBefore) > 20
        // Якорь берётся ИЗ ЛЕНТЫ, а не по всему приложению: шторка смонтирована
        // всегда, и `app.staticTexts` первым отдаёт её «Поиск сессий» — якорь,
        // который не шевелится никогда и делает проверку зелёной впустую.
        // Якорь — любой текст, РЕАЛЬНО ВИДНЫЙ в средней полосе экрана.
        // Закрытая шторка стоит за левым краем, поэтому «кадр внутри экрана»
        // сам по себе отсекает её содержимое, и угадывать ленту не нужно.
        // Верх (шапка) и низ (композер) исключены: они не едут вместе с лентой
        // и дали бы ноль смещения на любой прокрутке.
        var anchorText: XCUIElement?
        let band = app.frame.insetBy(dx: 0, dy: 120)
        for i in 0..<14 {
            let e = app.staticTexts.element(boundBy: i)
            guard e.exists else { break }
            let f = e.frame
            if f.height > 8, !e.label.isEmpty, band.contains(f) { anchorText = e; break }
        }
        let anchorLabel = anchorText?.label ?? ""
        let beforeY = anchorText?.frame.origin.y ?? .nan
        shot("06e-scrolled-up-reading")

        // Ответ ищется по КОНТЕЙНЕРУ хода агента, а не по написанному имени:
        // имени агента на экране нет по замыслу (см. шаг 4), оно живёт только
        // в подписи для VoiceOver. Предыдущая версия искала текст «claude» и
        // поэтому докладывала «ответа не пришло» на пришедшем ответе.
        let agentTurn = NSPredicate(format: "label MATCHES %@", "(Claude|Codex), [0-9]{2}:[0-9]{2}")
        let answered = waitFor(120) {
            app.descendants(matching: .any).matching(agentTurn).firstMatch.exists
                || app.buttons.matching(self.toolChipPredicate).firstMatch.exists
        }
        let after = anchorLabel.isEmpty ? nil : app.staticTexts[anchorLabel].firstMatch
        let afterY = (after?.exists ?? false) ? after!.frame.origin.y : .nan
        shot("06f-after-answer-while-reading")

        note("6. Живая отправка / пришёл ответ", answered ? .works : .broken,
             answered ? "модель ответила в открытую сессию" : "сессия открылась, но ответа за 120с не пришло")

        if !didScroll {
            note("6. Живая отправка / лента не дёргает вниз", .unknown,
                 "прокрутки вверх не получилось: транскрипт короче экрана, читать выше нечего. "
                 + "Измеренное смещение в такой сессии — это дописанный снизу ответ, сдвигающий "
                 + "прижатое к низу, а не рывок ленты у читающего. Проверка требует длинной сессии "
                 + "с настоящей отмоткой.")
        } else if beforeY.isNaN || afterY.isNaN {
            note("6. Живая отправка / лента не дёргает вниз", .unknown,
                 "не удалось закрепиться за элемент ленты, чтобы померить смещение "
                 + "(якорь «\(anchorLabel.prefix(40))» исчез из видимой части)")
        } else {
            let drift = abs(afterY - beforeY)
            let stable = drift < 40
            note("6. Живая отправка / лента не дёргает вниз", stable ? .works : .broken,
                 "якорь «\(anchorLabel.prefix(40))» сместился на \(Int(drift))pt за время прихода ответа "
                 + "(до \(Int(beforeY))pt, после \(Int(afterY))pt; порог 40pt)")
        }
    }

    // MARK: - 7. Экраны, табы, линзы

    func test07_ScreensTabsLenses() {
        let app = launchApp()
        XCTAssertTrue(waitForFleet(app))
        shot("07a-start-screen")
        note("7. Стартовый экран", .works,
             "корень поднялся с живым флотом, полка проектов заполнена")

        // --- линзы шторки: Список / Flow ------------------------------------------
        guard openDrawer(app, shot: "07b-drawer-mid") else {
            note("7. Линзы шторки", .unknown, "шторка не открылась — до линз не дошёл")
            return
        }
        settleDrawer(app)
        shot("07c-drawer-lens-list")
        // Заголовки разделов рисуются ЗАГЛАВНЫМИ (`SectionLabel`), поэтому
        // сравнение без учёта регистра, а не по точной строке.
        let sections = app.staticTexts.matching(
            NSPredicate(format: "label CONTAINS[c] 'сессии' OR label CONTAINS[c] 'в работе'")).firstMatch
        note("7. Линза «Список»", sections.exists ? .works : .unknown,
             sections.exists ? "линза Список показывает разделы сессий («\(sections.label)»)"
                             : "разделов сессий не видно — возможно, список пуст")

        // Чип линзы подписан ВМЕСТЕ СО СЧЁТЧИКОМ («Flow 12»), поэтому точное
        // совпадение по «Flow» не находит ничего. Первая версия обхода на этом
        // доложила «в шторке нет чипа линзы Flow» — findings, которого нет.
        let flowChip = app.buttons.matching(
            NSPredicate(format: "label BEGINSWITH 'Flow'")).firstMatch
        if flowChip.waitForExistence(timeout: 6) {
            flowChip.tap()
            let flowUp = waitFor(8) {
                app.descendants(matching: .any).matching(
                    NSPredicate(format: "identifier BEGINSWITH 'flow.stage.'")).firstMatch.exists
                    || app.staticTexts.matching(NSPredicate(
                        format: "label IN {'БЭКЛОГ','ПЛАНИРОВАНИЕ','В РАБОТЕ','ТЕСТИРОВАНИЕ','ГОТОВО'}")).firstMatch.exists
            }
            shot("07d-drawer-lens-flow")
            note("7. Линза «Flow»", flowUp ? .works : .unknown,
                 flowUp ? "линза Flow переключилась нажатием и показала стадии"
                        : "по тапу на Flow стадии не появились — возможно, ни у одной сессии нет стадии")

            let listChip = app.buttons.matching(
                NSPredicate(format: "label BEGINSWITH 'Список'")).firstMatch
            if listChip.exists {
                listChip.tap()
                shot("07e-drawer-lens-back-to-list")
                note("7. Линзы / возврат на Список", .works, "линза вернулась на Список нажатием")
            }
        } else {
            note("7. Линзы шторки", .broken, "в шторке нет чипа линзы «Flow»")
        }

        // --- Настройки и Команда: через подвал шторки «Ещё» -----------------------
        walkTabs(app, screen: "Настройки",
                 tabs: ["Аккаунт", "Железо", "Память", "Профиль"], prefix: "07f-settings")
        walkTabs(app, screen: "Команда",
                 tabs: ["Обзор", "Люди", "Проекты", "Аудит"], prefix: "07g-team")
    }

    /// Открыть экран из меню шторки и пройтись НАЖАТИЯМИ по всем его табам.
    private func walkTabs(_ app: XCUIApplication, screen: String, tabs: [String], prefix: String) {
        guard openFromDrawerMenu(app, titled: screen) else {
            note("7. \(screen)", .unknown, "не нашёл дороги на экран «\(screen)» нажатиями")
            return
        }
        shot("\(prefix)-opened")
        note("7. \(screen) / открытие", .works, "экран открыт нажатием через подвал шторки «Ещё»")

        for tab in tabs {
            let chip = app.buttons[tab]
            if chip.waitForExistence(timeout: 6) {
                chip.tap()
                _ = waitFor(1.5) { false }
                shot("\(prefix)-\(tab)")
                note("7. \(screen) / таб «\(tab)»", .works, "таб открылся нажатием")
            } else {
                note("7. \(screen) / таб «\(tab)»", .broken, "таба «\(tab)» нет на экране")
            }
        }
        let back = app.buttons["shell.back"]
        if back.exists { back.tap() }
        _ = waitFor(4) { !app.buttons["shell.back"].exists }
    }

    /// Дорога на Настройки / Команду: шторка → подвал «Ещё» → строка меню.
    private func openFromDrawerMenu(_ app: XCUIApplication, titled name: String) -> Bool {
        // Меню подвала — ЛИСТ. Оставшийся от прошлого экрана, он перекрывает
        // шторку, и «Ещё» под ним не нажимается: второй проход (Команда после
        // Настроек) поэтому не находил дороги, хотя первый её нашёл.
        if app.sheets.firstMatch.exists {
            app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.04)).tap()
            _ = waitFor(3) { !app.sheets.firstMatch.exists }
        }
        if !drawerOpen(app), !openDrawer(app) { return false }
        settleDrawer(app)

        let more = app.buttons["Ещё"]
        guard more.waitForExistence(timeout: 8) else { return false }
        more.tap()
        let row = app.buttons[name]
        guard row.waitForExistence(timeout: 8) else { return false }
        row.tap()
        // Экран считается открытым, когда появилась и своя кнопка «назад», и
        // шапка с нужным именем: без второго условия таб-полоса ещё не
        // построена, и первый же запрос таба уходит в пустоту.
        return waitFor(10) {
            app.buttons["shell.back"].exists
                && (app.navigationBars[name].exists || app.staticTexts[name].exists)
        }
    }

    // MARK: - Дороги нажатиями

    private enum SessionPreference { case any, withToolRuns, withCode }

    /// Открыть живую сессию НАЖАТИЯМИ: свайп → шторка → тап по строке сессии.
    ///
    /// Для ленты и кода нужна не любая сессия, а содержательная, поэтому при
    /// промахе обход возвращается и пробует следующую.
    private func openSession(_ app: XCUIApplication,
                             preferring: SessionPreference = .any) -> Bool {
        guard openDrawer(app, shot: nil) else { return false }

        let rows = sessionRows(app)
        guard !rows.isEmpty else { return false }

        let attempts = preferring == .any ? 1 : min(3, rows.count)
        for i in 0..<attempts {
            // Список мог перестроиться — перечитываем по месту.
            let fresh = sessionRows(app)
            guard i < fresh.count else { break }
            fresh[i].tap()
            guard waitFor(20, { app.buttons["shell.back"].exists || app.textViews.firstMatch.exists })
            else { continue }

            switch preferring {
            case .any:
                return true
            case .withToolRuns:
                if waitFor(8, { self.toolChip(app).exists }) { return true }
            case .withCode:
                if findWideCodeBlock(app) != nil { return true }
            }
            // Не подошла — назад и следующая.
            if app.buttons["shell.back"].exists { app.buttons["shell.back"].tap() }
            _ = waitFor(5) { !app.buttons["shell.back"].exists }
            guard openDrawer(app, shot: nil) else { return false }
        }
        // Ничего идеального не нашлось — оставляем открытой хоть какую-то.
        return app.buttons["shell.back"].exists || app.textViews.firstMatch.exists
    }

    /// Лента транскрипта — самая высокая прокрутка на экране.
    ///
    /// Нужна отдельным понятием, потому что «по всему приложению» здесь
    /// систематически врёт: шторка смонтирована ВСЕГДА (`AppShell`), и её
    /// содержимое попадает в любой глобальный запрос — вместе с ним в
    /// измерение приезжает элемент, который заведомо не двигается.
    /// ЛЕНИВО. `allElementsBoundByIndex` здесь недопустим: он заставляет
    /// XCUITest разрешить ВСЁ поддерево, а живой транскрипт — это сотни ходов
    /// с вложенными блоками, и запрос не укладывается во внутренний бюджет
    /// («Timed out while evaluating UI query» — так упал шаг 2 на Release).
    /// Разрешаем по одному элементу и с потолком на число проб.
    private func feedView(_ app: XCUIApplication) -> XCUIElement? {
        for i in 0..<3 {
            let s = app.scrollViews.element(boundBy: i)
            guard s.exists else { break }
            if s.frame.height > 200 { return s }
        }
        let first = app.scrollViews.firstMatch
        return first.exists ? first : nil
    }

    /// Строки сессий — кнопки ВНУТРИ шторки, не считая её хрома.
    ///
    /// Ищется строго в поддереве `shell.drawer`, а не по всему приложению, и
    /// без `isHittable`. Оба ограничения поставлены находками: по всему
    /// приложению в выборку попадает «Папка» со стартового экрана ПОД
    /// шторкой, а спросить у неё о нажимаемости нельзя — у элемента за
    /// уехавшей карточкой невалидная точка активации, и XCUITest не возвращает
    /// false, а РОНЯЕТ тест («Failed to determine hittability»). Обход при
    /// этом падал в трёх сценариях подряд и выглядел как поломка продукта.
    private func sessionRows(_ app: XCUIApplication) -> [XCUIElement] {
        let chrome: Set<String> = ["Список", "Flow", "Чат", "Закрыть", "Ещё", "Сессии",
                                   "Поиск сессий", "Настройки", "Команда", "Уведомления",
                                   "Назад", "Папка", "Найти", "Продолжить"]
        let drawer = app.descendants(matching: .any)["shell.drawer"]
        guard drawer.exists else { return [] }
        return drawer.buttons.allElementsBoundByIndex.filter { b in
            guard b.exists else { return false }
            let f = b.frame
            guard f.width > 40, f.height > 18 else { return false }
            let l = b.label.trimmingCharacters(in: .whitespacesAndNewlines)
            return !l.isEmpty && !chrome.contains(l) && l.count > 3 && !l.contains(" на ")
        }
    }

    /// Кнопка-заголовок в шапке сессии (`.principal`) — дорога в «О сессии».
    private func sessionTitleButton(_ app: XCUIApplication) -> XCUIElement? {
        let bar = app.navigationBars.firstMatch
        guard bar.exists else { return nil }
        let inBar = bar.buttons.allElementsBoundByIndex.filter {
            $0.exists && $0.identifier != "shell.back" && $0.label != "Назад"
                && $0.label != "Сессии" && !$0.label.isEmpty
        }
        if let widest = inBar.max(by: { $0.frame.width < $1.frame.width }), widest.frame.width > 60 {
            return widest
        }
        return nil
    }

    /// Коробка кода едет вбок — то есть это горизонтальный scrollView внутри
    /// ленты, заметно ниже самой ленты.
    private func findWideCodeBlock(_ app: XCUIApplication) -> XCUIElement? {
        guard let feed = feedView(app) else { return nil }
        // Коробка кода — прокрутка ВНУТРИ ленты: невысокая и широкая.
        // Пробуем по одному вложенному элементу, без обхода всего поддерева.
        // НАЗАД по истории (`swipeDown`), а не вперёд. Сессия открывается на
        // последнем ходе, то есть уже в самом низу: `swipeUp` оттуда не
        // прокручивает никуда, и обход «искал» код, стоя на месте. Код живёт
        // выше, в уже прошедших прогонах.
        for _ in 0..<10 {
            for i in 0..<4 {
                let inner = feed.scrollViews.element(boundBy: i)
                guard inner.exists else { break }
                let f = inner.frame
                if f.width > 180, f.height > 16, f.height < 280, app.frame.contains(f) {
                    return inner
                }
            }
            app.swipeDown()
        }
        return nil
    }

    private func clearField(_ field: XCUIElement) {
        let current = (field.value as? String) ?? ""
        guard !current.isEmpty else { return }
        field.tap()
        field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: current.count + 5))
    }

    private func allowSystemPrompts(times: Int) {
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        for _ in 0..<times {
            var tapped = false
            for label in ["OK", "Allow", "Разрешить", "Разрешить доступ",
                          "Allow While Using App", "При использовании приложения"] {
                let button = springboard.buttons[label]
                if button.waitForExistence(timeout: 6) { button.tap(); tapped = true; break }
            }
            if !tapped { return }
        }
    }
}
