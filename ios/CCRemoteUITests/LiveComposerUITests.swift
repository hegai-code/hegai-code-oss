import XCTest

/// Приёмка фазы 6: композер против ЖИВОГО хаба.
///
/// **Почему отдельно от остальных UI-тестов.** `ShellGestureUITests` и
/// `ShareHandoffUITests` обходятся хабом, которого нет (`ws://127.0.0.1:1`), —
/// им нужен только шелл. Здесь проверяется ровно обратное: что набранное
/// доезжает до настоящей машины и оттуда приходит ответ. Для этого нужен
/// живой хаб и НАСТОЯЩИЙ пользовательский токен, которого нет ни в репозитории,
/// ни в CI, ни у следующего, кто клонирует дерево.
///
/// Поэтому тест пропускается без `CC_LIVE_HUB` + `CC_LIVE_TOKEN` — и это
/// единственное место в дереве, где пропуск разрешён. Пропущенная приёмка
/// зелёная и ничего не доказывает, так что читайте так: в обычном прогоне
/// этого теста НЕТ. Запускать руками:
///
///     python3 ios/scripts/hub-bridge.py &
///     CC_LIVE_HUB=ws://localhost:8444/mobile/ui \
///     CC_LIVE_TOKEN=$(cat ~/.hegai-ui-token) \
///     xcodebuild test -project ios/CCRemote.xcodeproj -scheme CCRemote \
///       -destination "id=<UDID>" -derivedDataPath ios/build \
///       -only-testing:CCRemoteUITests/LiveComposerUITests
///
/// (мост — потому что симуляторы этой машины не резолвят `code.acme.test`;
/// см. `scripts/hub-bridge.py`.)
///
/// **Чего он НЕ проверяет, сколько бы ни был зелёным.** Диктовка здесь доходит
/// до состояния записи — и на этом всё: у симулятора нет микрофона устройства,
/// он слышит вход хоста, поэтому «распознало ли», «как ведёт себя на улице» и
/// «не сожрала ли батарею» отсюда не видно. Жест на стекле, шаринг из Safari на
/// телефоне и тап по пушу — тем более: см. «что осталось непроверенным» в
/// `REBUILD.md`.
final class LiveComposerUITests: XCTestCase {

    private var hub = ""
    private var token = ""

    override func setUpWithError() throws {
        continueAfterFailure = false
        let env = ProcessInfo.processInfo.environment
        hub = env["CC_LIVE_HUB"] ?? ""
        token = env["CC_LIVE_TOKEN"] ?? ""
        try XCTSkipIf(hub.isEmpty || token.isEmpty, """
            нет живого хаба: задайте CC_LIVE_HUB и CC_LIVE_TOKEN (см. комментарий \
            к файлу). Без них проверять нечего — этот класс и есть единственный \
            в дереве, которому нужен настоящий прод.
            """)
    }

    // MARK: - Отправка в живую сессию

    /// Главная дорога продукта: набрать на стартовом экране, нажать отправить,
    /// увидеть СВОЮ реплику в транскрипте и дождаться ответа модели.
    ///
    /// Проверяется именно ответ, а не «экран сменился»: сессия, которая
    /// открылась и молчит, — ровно та поломка, ради которой всё это писалось.
    func testSendingFromTheStartScreenReachesALiveSessionAndGetsAnAnswer() throws {
        let app = launch(screen: "start")
        let field = composer(of: app)
        // Сначала ФЛОТ, потом текст. Композер рисуется раньше, чем приезжают
        // машины, а `start()` без выбранного проекта молча возвращает `false`:
        // черновик остаётся, экран не меняется, и это выглядит как «кнопка не
        // работает» — ровно так этот тест и упал в первый прогон.
        XCTAssertTrue(waitFor(60) { app.buttons.matching(
            NSPredicate(format: "label CONTAINS ' на '")).firstMatch.exists
        }, "флот не приехал: на полке нет ни одного проекта.\n\(dump(app))")

        // Маркер в тексте — чтобы найти СВОЮ реплику в чужом транскрипте.
        let mark = "фаза6-\(Int(Date().timeIntervalSince1970) % 100000)"
        field.tap()
        field.typeText("Ответь ровно одним словом: \(mark)")
        XCTAssertTrue((field.value as? String)?.contains(mark) == true,
                      "не удалось набрать текст — дальше проверять нечего")

        let send = app.buttons["Отправить"]
        XCTAssertTrue(send.waitForExistence(timeout: 10), "кнопки отправки нет.\n\(dump(app))")
        XCTAssertTrue(send.isEnabled, "кнопка отправки неактивна при набранном тексте")
        send.tap()

        // Черновик очищается ТОЛЬКО на успешной отправке — это и есть признак
        // того, что ход ушёл в хаб, а не осел в поле.
        XCTAssertTrue(waitFor(20) { ((field.value as? String) ?? "").contains(mark) == false },
                      "отправка не состоялась: текст остался в композере.\n\(dump(app))")

        // Своя реплика в документе.
        XCTAssertTrue(waitFor(30) { app.staticTexts.matching(
            NSPredicate(format: "label CONTAINS %@", mark)).firstMatch.exists
        }, "отправленное не появилось в транскрипте.\n\(dump(app))")

        // Ответ. Две минуты — это неспешный холодный старт на далёкой коробке.
        XCTAssertTrue(waitFor(120) { app.staticTexts.matching(
            NSPredicate(format: "label CONTAINS[c] 'ассистент' OR label CONTAINS[c] 'claude' "
                        + "OR label CONTAINS[c] 'codex'")).firstMatch.exists
        }, "сессия открылась, но ответа не пришло.\n\(dump(app))")
    }

    // MARK: - Диктовка

    /// Микрофон либо пишет, либо ВСЛУХ объясняет, почему нет. Третьего быть не
    /// должно.
    ///
    /// Почему проверка именно такой формы. Раньше здесь было
    /// «дойти до записи» — и на симуляторе этой машины оно не доходит никогда:
    /// у симулятора нет DNS (та же дыра, из-за которой в дереве лежит
    /// `scripts/hub-bridge.py`), а `SFSpeechRecognizer.isAvailable` без сети
    /// false. Приложение при этом ведёт себя ПРАВИЛЬНО: говорит
    /// «Распознавание речи сейчас недоступно — проверьте сеть». Требовать от
    /// такой среды записи — значит держать вечно красный тест и ничего им не
    /// доказывать.
    ///
    /// А вот что доказывать стоит и здесь: тишины не бывает. Диктовка однажды
    /// уже «не работала» ровно так — кнопка нажималась, и не происходило
    /// НИЧЕГО (гонка hold-to-talk с колбэком разрешения, см. `MicButton`).
    /// Мёртвую кнопку этот тест ловит на любой машине; настоящую диктовку
    /// (микрофон устройства, распознавание речи) — только телефон.
    func testDictationEitherRecordsOrSaysWhyNot() throws {
        let app = launch(screen: "start")
        _ = composer(of: app)

        let mic = app.buttons["Начать запись"]
        XCTAssertTrue(mic.waitForExistence(timeout: 20), "кнопки микрофона нет.\n\(dump(app))")
        mic.tap()

        // Микрофон и распознавание спрашивают разрешение — настоящая дорога
        // проходит через оба запроса, и тест тоже.
        allowSystemPrompts(times: 2)

        let recording = app.buttons["Остановить запись"]
        let alert = app.alerts.firstMatch
        XCTAssertTrue(waitFor(30) { recording.exists || alert.exists },
                      "микрофон нажат, и не произошло НИЧЕГО — ни записи, ни отказа.\n\(dump(app))")

        if recording.exists {
            recording.tap()
            return
        }
        // Отказ обязан быть объяснённым: «Диктовка» с пустым телом — это та же
        // тишина, только в рамке.
        let said = alertText(app)
        XCTAssertTrue(said.count > "Диктовка".count, "отказ без причины: «\(said)»")
        // Не промах, а запись в журнал прогона: на машине без сети это
        // ЕДИНСТВЕННЫЙ достижимый исход, и он честный.
        print("[приёмка] диктовка отказалась и назвала причину: \(said)")
        app.alerts.firstMatch.buttons.firstMatch.tap()
    }

    // MARK: - Вложение

    /// Картинка из медиатеки становится вложением композера.
    ///
    /// Снимок в медиатеку кладут снаружи (`xcrun simctl addmedia`): у чистого
    /// симулятора её нет, и пикер открывается на «Нет фото или видео» — это
    /// пустой тест, который выглядит зелёным.
    func testPhotoFromTheLibraryBecomesAnAttachment() throws {
        let app = launch(screen: "start")
        _ = composer(of: app)

        let clip = app.buttons["Вложение"]
        XCTAssertTrue(clip.waitForExistence(timeout: 20), "кнопки вложения нет.\n\(dump(app))")
        clip.tap()

        let library = app.buttons["Медиатека"]
        XCTAssertTrue(library.waitForExistence(timeout: 10), "в меню нет «Медиатека».\n\(dump(app))")
        library.tap()

        // Пикер живёт в СВОЁМ процессе, поэтому ищем по всему экрану.
        let photo = app.images.firstMatch
        XCTAssertTrue(photo.waitForExistence(timeout: 30), """
            медиатека пуста или не открылась. Положите снимок:
              xcrun simctl addmedia <UDID> /path/to.png
            \(dump(app))
            """)
        photo.tap()
        for name in ["Add", "Добавить", "Done", "Готово"] where app.buttons[name].exists {
            app.buttons[name].tap()
            break
        }

        XCTAssertTrue(app.otherElements["composer.attachment"].waitForExistence(timeout: 30)
                      || app.images["composer.attachment"].waitForExistence(timeout: 5),
                      "вложение не прикрепилось.\n\(dump(app))")
    }

    // MARK: - Шаги

    private func launch(screen: String) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchEnvironment = [
            "CC_HUB_URL": hub,
            "CC_TOKEN": token,
            "CC_THEME": "light",
            "CC_SCREEN": screen,
        ]
        app.launch()
        return app
    }

    /// Поле композера — и заодно ожидание того, что флот приехал: пустой
    /// стартовый экран рисуется и без хаба, а тут нужен именно живой.
    private func composer(of app: XCUIApplication) -> XCUIElement {
        let field = app.textViews.firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 60), "композер не появился.\n\(dump(app))")
        return field
    }

    /// Текст алерта приложения целиком — заголовок, сообщение и кнопки.
    private func alertText(_ app: XCUIApplication) -> String {
        let alert = app.alerts.firstMatch
        return alert.staticTexts.allElementsBoundByIndex.map(\.label).joined(separator: " / ")
    }

    private func allowSystemPrompts(times: Int) {
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        for _ in 0..<times {
            var tapped = false
            for label in ["OK", "Allow", "Разрешить", "Разрешить доступ"] {
                let button = springboard.buttons[label]
                if button.waitForExistence(timeout: 8) { button.tap(); tapped = true; break }
            }
            if !tapped { return }
        }
    }

    private func waitFor(_ seconds: TimeInterval, _ cond: () -> Bool) -> Bool {
        let deadline = Date().addingTimeInterval(seconds)
        repeat { if cond() { return true } } while Date() < deadline
        return false
    }

    private func dump(_ app: XCUIApplication) -> String {
        String(app.debugDescription.prefix(4000))
    }
}
