import XCTest

/// Передача из «Поделиться» — НАСТОЯЩИМ шарингом, из Safari.
///
/// **Почему не открытием ссылки.** `ccremote://share` можно открыть чем угодно,
/// и приложение честно прочитает буфер. Но это доказывает только вторую
/// половину: само РАСШИРЕНИЕ при этом не запускается вовсе. А ломается обычно
/// оно — тип, который оно не умеет загрузить, буфер, который оно пишет одним
/// элементом вместо четырёх, схема, которую оно зовёт из фонового контекста.
/// Ссылка проходит мимо всего этого и выглядит зелёной.
///
/// **Что именно проверяется.** Не «текст оказался в поле», а то, ради чего фаза
/// 4 трогала эту дорогу: передача садится в композер СТАРТОВОГО ЭКРАНА (формы
/// новой сессии больше нет), один раз, и НЕ затирает уже набранного черновика.
///
/// ## Две ловушки среды, каждая из которых однажды съела этот тест
///
/// **1. У симулятора на этой машине нет DNS.** `example.com` в нём отвечает
/// «the server can't be found» — ровно то же, из-за чего в репозитории лежит
/// `scripts/hub-bridge.py`. Поэтому страница берётся с ЛОКАЛЬНОГО сервера на
/// петле хоста: симулятор делит сетевой стек с macOS, так что его `127.0.0.1`
/// и есть хостовый. Поднять перед прогоном:
///
///     mkdir -p /tmp/ph4-share-probe && cd /tmp/ph4-share-probe \
///       && python3 -m http.server 8765 --bind 127.0.0.1 &
///
/// Если сервера нет, тест падает СРАЗУ и говорит эту строку — он не
/// пропускается: пропущенная приёмка выглядит зелёной, ничего не доказав.
///
/// **2. В iOS 26 у Safari больше нет кнопки «Поделиться» в панели.** Она
/// уехала в меню «···», и Safari сам сообщает об этом всплывающей подсказкой
/// при первом запуске. Поиск кнопки по имени `Share` поэтому не находит
/// ничего — дорога идёт «···» → «Поделиться».
///
/// Каждое ожидание названо вслух, а промах печатает срез дерева доступности,
/// чтобы следующая версия iOS чинилась чтением отчёта, а не перебором.
final class ShareHandoffUITests: XCTestCase {

    /// Хост:порт локальной страницы — он же маркер, который обязан доехать.
    private let probeHost = "127.0.0.1:8765"
    private var probeURL: String { "http://\(probeHost)/" }
    private let typed = "мой черновик"

    override func setUp() {
        continueAfterFailure = false
    }

    // MARK: Приёмка

    func testSharingFromSafariLandsInTheStartComposerWithoutEatingTheDraft() throws {
        let app = launchApp()
        let field = app.textViews.firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 30), "композер стартового экрана не появился")

        // Черновик, который передача обязана не тронуть.
        field.tap()
        field.typeText(typed)
        XCTAssertTrue((field.value as? String)?.contains(typed) == true,
                      "не удалось набрать черновик — дальше проверять нечего")

        // --- настоящий шаринг ------------------------------------------------
        let safari = XCUIApplication(bundleIdentifier: "com.apple.mobilesafari")
        safari.launch()
        XCTAssertTrue(safari.wait(for: .runningForeground, timeout: 30), "Safari не открылся")

        openProbePage(in: safari)
        tapShare(in: safari)
        tapOurApp(in: safari)
        // Safari may ask before opening our custom URL scheme, including on
        // simulators that have already shared once. The dialog belongs to the
        // system and survives app relaunches, so leaving it up poisons later UI
        // tests as well as this handoff.
        let system = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        for host in [system, safari] {
            for label in ["Open", "Открыть"] {
                let button = host.buttons[label]
                if button.waitForExistence(timeout: 2), button.isHittable { button.tap() }
            }
        }

        // --- приёмка -----------------------------------------------------------
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 30),
                      "расширение не вернуло управление приложению")

        // iOS спрашивает разрешение на чтение буфера: расширение передаёт
        // содержимое через `UIPasteboard`, а чтение без жеста — системный
        // запрос. Настоящая дорога проходит через него, и тест тоже.
        allowPasteIfAsked()

        let box = app.textViews.firstMatch
        XCTAssertTrue(box.waitForExistence(timeout: 20))
        // Текст приезжает асинхронно (буфер + даунскейл картинок), поэтому ждём
        // появления маркера, а не читаем поле первым же кадром.
        XCTAssertTrue(waitFor({ (box.value as? String)?.contains(self.probeHost) == true }, 20),
                      "переданное не оказалось в композере: «\((box.value as? String) ?? "")»")

        let text = (box.value as? String) ?? ""
        XCTAssertTrue(text.contains(typed), "передача затёрла набранный черновик: «\(text)»")
        // Один раз, а не дважды: у передачи есть id, и композер гасит её у
        // хозяина, как только принял.
        XCTAssertEqual(text.components(separatedBy: probeHost).count - 1, 1,
                       "переданное приехало дважды: «\(text)»")
    }

    // MARK: Шаги

    private func launchApp() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchEnvironment = [
            // Хаб настоящий не нужен: композер стартового экрана рисуется и без
            // машин. Но шелл показывается только «настроенному» приложению.
            "CC_HUB_URL": "ws://127.0.0.1:1/ui",
            "CC_TOKEN": "ui-test",
            "CC_THEME": "light",
            "CC_SCREEN": "start",
        ]
        app.launch()
        return app
    }

    /// Открыть локальную страницу и УБЕДИТЬСЯ, что она загрузилась.
    ///
    /// Проверка обязательна: на странице ошибки Safari адрес в строке остаётся,
    /// и шаринг внешне проходит — но делится он не тем, и разбираться в этом
    /// приходится уже по расшифровке.
    private func openProbePage(in safari: XCUIApplication) {
        let urlField = safari.textFields["Address"].exists
            ? safari.textFields["Address"] : safari.textFields.firstMatch
        XCTAssertTrue(urlField.waitForExistence(timeout: 20), "адресная строка Safari не найдена")
        urlField.tap()
        safari.typeText("\(probeURL)\n")

        let loaded = safari.staticTexts["phase4 share probe"].waitForExistence(timeout: 20)
        XCTAssertTrue(loaded, """
            локальная страница не загрузилась. У симулятора нет DNS, страницу \
            отдаёт сервер на петле хоста — подними его перед прогоном:
              mkdir -p /tmp/ph4-share-probe && cd /tmp/ph4-share-probe \
            && python3 -m http.server 8765 --bind 127.0.0.1 &
            """)
    }

    /// «···» → «Поделиться». В iOS 26 первого шага раньше не было.
    private func tapShare(in safari: XCUIApplication) {
        // Подсказка «теперь это в меню ···» перекрывает панель на первом запуске.
        dismissSafariTipIfShown(safari)

        let more = find(in: safari, ["More", "Ещё", "Page Settings", "Настройки страницы",
                                    "pageActionsButton", "MoreButton", "TabOverflowButton"])
        XCTAssertNotNil(more, "кнопка «···» в Safari не найдена.\n\(dump(safari))")
        more?.tap()

        let share = find(in: safari, ["Share", "Поделиться", "Share…", "Поделиться…", "ShareButton"])
        XCTAssertNotNil(share, "пункт «Поделиться» в меню «···» не найден.\n\(dump(safari))")
        share?.tap()
    }

    /// Наше приложение в листе. Оно может лежать за прокруткой ряда приложений.
    private func tapOurApp(in safari: XCUIApplication) {
        var target = find(in: safari, ["Hegai Code", "cc·remote", "CCRemote"])
        if target == nil {
            safari.collectionViews.firstMatch.swipeLeft()
            target = find(in: safari, ["Hegai Code", "cc·remote", "CCRemote"])
        }
        XCTAssertNotNil(target, "расширение не предложено в листе «Поделиться».\n\(dump(safari))")
        target?.tap()
    }

    // MARK: Утилиты

    /// Ищем и по метке, и по идентификатору: Apple переименовывает одно, не
    /// трогая другое, и наоборот.
    private func find(in app: XCUIApplication, _ names: [String]) -> XCUIElement? {
        let deadline = Date().addingTimeInterval(10)
        repeat {
            for name in names {
                for q in [app.buttons, app.cells, app.otherElements, app.staticTexts,
                          app.collectionViews.buttons] {
                    for e in [q[name], q.matching(identifier: name).firstMatch] where e.exists {
                        if e.isHittable { return e }
                    }
                }
            }
        } while Date() < deadline
        return nil
    }

    private func dismissSafariTipIfShown(_ safari: XCUIApplication) {
        for label in ["Close", "Закрыть", "OK", "Continue", "Продолжить", "Got It"] {
            let b = safari.buttons[label]
            if b.exists, b.isHittable { b.tap(); return }
        }
    }

    private func allowPasteIfAsked() {
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        for label in ["Allow Paste", "Разрешить вставку", "Paste", "Вставить"] {
            let button = springboard.buttons[label]
            if button.waitForExistence(timeout: 5) { button.tap(); return }
        }
    }

    private func waitFor(_ cond: () -> Bool, _ seconds: TimeInterval) -> Bool {
        let deadline = Date().addingTimeInterval(seconds)
        repeat { if cond() { return true } } while Date() < deadline
        return false
    }

    /// Срез дерева доступности для отчёта: полный `debugDescription` — это
    /// километры, а промах обычно виден в первых строках панели.
    private func dump(_ app: XCUIApplication) -> String {
        String(app.debugDescription.prefix(4000))
    }
}
