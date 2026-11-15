import XCTest
@testable import CCRemote

/// Переводчик со старых пусковых имён на новые.
///
/// Эти тесты стоят здесь не ради покрытия. `CC_TAB` и `CC_PUSH` — единственный
/// способ, которым скриншот-скрипты ставят приложение в нужное состояние, и
/// ломаются они ТИХО: скрипт отработает, файл появится, размер совпадёт, а
/// внутри окажется другой экран. Компилятор про это ничего не скажет — имена
/// приходят строками из среды.
final class LaunchAffordancesTests: XCTestCase {

    // MARK: Новые имена

    func testEmptyEnvironmentLandsOnTheRootWithNothingToSay() {
        let a = LaunchAffordances.parse([:])
        XCTAssertEqual(a.screen, .start)
        XCTAssertFalse(a.drawerOpen)
        XCTAssertEqual(a.lens, .list)
        XCTAssertTrue(a.notes.isEmpty)
    }

    /// Системный алерт уведомлений закрывал кадры стенда на свежем симуляторе.
    func testStandsAndTheFlagDoNotAskForNotifications() {
        XCTAssertTrue(LaunchAffordances.parse([:]).notificationPrompt)
        XCTAssertFalse(LaunchAffordances.parse(["CC_TRANSCRIPT": "suggest"]).notificationPrompt)
        XCTAssertFalse(LaunchAffordances.parse(["CC_GALLERY": "1"]).notificationPrompt)
        XCTAssertFalse(LaunchAffordances.parse(["CC_SCREEN": "transcript"]).notificationPrompt)
        XCTAssertFalse(LaunchAffordances.parse(["CC_NOTIFICATIONS": "false"]).notificationPrompt)
        XCTAssertTrue(LaunchAffordances.parse(["CC_SCREEN": "team", "CC_NOTIFICATIONS": "true"]).notificationPrompt)
    }

    func testScreenNamesTheScreen() {
        XCTAssertEqual(LaunchAffordances.parse(["CC_SCREEN": "start"]).screen, .start)
        XCTAssertEqual(LaunchAffordances.parse(["CC_SCREEN": "team"]).screen, .team(.overview))
        XCTAssertEqual(LaunchAffordances.parse(["CC_SCREEN": "gallery"]).screen, .gallery)
        XCTAssertEqual(LaunchAffordances.parse(["CC_SCREEN": "transcript"]).screen, .transcript)
    }

    /// Стенд транскрипта — как и витрина, со своей переменной: скрипты зовут
    /// его именем секции (`turns` / `tools` / `composer`), а не единицей.
    func testTranscriptFixtureHasItsOwnFlag() {
        XCTAssertEqual(LaunchAffordances.parse(["CC_TRANSCRIPT": "1"]).screen, .transcript)
        XCTAssertEqual(LaunchAffordances.parse(["CC_TRANSCRIPT": "tools"]).screen, .transcript)
        // «0» — это выключено, как и у шторки.
        XCTAssertEqual(LaunchAffordances.parse(["CC_TRANSCRIPT": "0"]).screen, .start)
    }

    /// Команда — экран с табами, как и Настройки, и называется он так же.
    /// Два экрана с табами не должны требовать двух разных способов их назвать:
    /// первая версия харнеса умела `settings:memory`, но на Команде понимала
    /// только «team», и снять «Аудит» было нечем, кроме тапа по координате.
    func testTeamScreenTakesATabAndDefaultsToTheFirst() {
        XCTAssertEqual(LaunchAffordances.parse(["CC_SCREEN": "team"]).screen, .team(.overview))
        XCTAssertEqual(LaunchAffordances.parse(["CC_SCREEN": "team:people"]).screen, .team(.people))
        XCTAssertEqual(LaunchAffordances.parse(["CC_SCREEN": "team:projects"]).screen, .team(.projects))
        XCTAssertEqual(LaunchAffordances.parse(["CC_SCREEN": "team:audit"]).screen, .team(.audit))
        // Несуществующий таб — это не «первый», а НЕПОНЯТОЕ имя: иначе опечатка
        // молча снимала бы Обзор под именем «аудита».
        let bogus = LaunchAffordances.parse(["CC_SCREEN": "team:access"])
        XCTAssertEqual(bogus.screen, .start)
        XCTAssertFalse(bogus.notes.isEmpty)
    }

    func testSettingsScreenTakesATabAndDefaultsToTheFirst() {
        XCTAssertEqual(LaunchAffordances.parse(["CC_SCREEN": "settings"]).screen, .settings(.account))
        XCTAssertEqual(LaunchAffordances.parse(["CC_SCREEN": "settings:hardware"]).screen, .settings(.hardware))
        XCTAssertEqual(LaunchAffordances.parse(["CC_SCREEN": "settings:memory"]).screen, .settings(.memory))
        XCTAssertEqual(LaunchAffordances.parse(["CC_SCREEN": "settings:profile"]).screen, .settings(.profile))
        XCTAssertEqual(LaunchAffordances.parse(["CC_SCREEN": "settings:reports"]).screen, .settings(.reports))
    }

    func testDrawerIsItsOwnAxisOverAnyScreen() {
        let a = LaunchAffordances.parse(["CC_SCREEN": "team", "CC_DRAWER": "1"])
        XCTAssertEqual(a.screen, .team(.overview))
        XCTAssertTrue(a.drawerOpen)
    }

    /// `CC_DRAWER=0` — это «нет». Иначе любая переменная, выставленная в ноль
    /// «чтобы выключить», читалась бы как «да».
    func testDrawerZeroMeansClosed() {
        XCTAssertFalse(LaunchAffordances.parse(["CC_DRAWER": "0"]).drawerOpen)
    }

    func testNotificationsIsItsOwnScreenNow() {
        XCTAssertEqual(LaunchAffordances.parse(["CC_SCREEN": "notifications"]).screen, .notifications)
        let a = LaunchAffordances.parse(["CC_PUSH": "notifications"])
        XCTAssertEqual(a.screen, .notifications)
        XCTAssertFalse(a.notes.isEmpty, "переезд ленты с Главной обязан объявиться в логе")
    }

    /// Меню переноса живёт только во Flow, поэтому флаг ставит и шторку, и
    /// линзу — просить меню и не просить линзу было бы опиской, которую видно
    /// только по снятому кадру.
    func testFlowMenuFlagTurnsOnEverythingItNeeds() {
        let a = LaunchAffordances.parse(["CC_FLOW_MENU": "1"])
        XCTAssertTrue(a.flowMenu)
        XCTAssertTrue(a.drawerOpen)
        XCTAssertEqual(a.lens, .flow)
        XCTAssertFalse(a.notes.isEmpty)
        XCTAssertFalse(LaunchAffordances.parse(["CC_FLOW_MENU": "0"]).flowMenu)
    }

    func testLensNamesOneOfTheTwo() {
        XCTAssertEqual(LaunchAffordances.parse(["CC_LENS": "list"]).lens, .list)
        XCTAssertEqual(LaunchAffordances.parse(["CC_LENS": "flow"]).lens, .flow)
    }

    // MARK: Переводы со старых имён — и они ГРОМКИЕ

    func testOldTabHomeBecomesTheRoot() {
        let a = LaunchAffordances.parse(["CC_TAB": "home"])
        XCTAssertEqual(a.screen, .start)
        XCTAssertFalse(a.notes.isEmpty, "перевод обязан объявиться в логе")
    }

    /// Самый важный перевод: «покажи сессии» — это теперь шторка, а не экран.
    func testOldTabSessionsBecomesTheRootWithTheDrawerOpen() {
        for tab in ["sessions", "board", "columns"] {
            let a = LaunchAffordances.parse(["CC_TAB": tab])
            XCTAssertEqual(a.screen, .start, tab)
            XCTAssertTrue(a.drawerOpen, "CC_TAB=\(tab) должен открыть шторку")
            XCTAssertFalse(a.notes.isEmpty, "CC_TAB=\(tab) обязан объявиться в логе")
        }
    }

    func testOldTabMoreBecomesSettings() {
        for tab in ["more", "settings"] {
            let a = LaunchAffordances.parse(["CC_TAB": tab])
            XCTAssertEqual(a.screen, .settings(.account), tab)
            XCTAssertFalse(a.notes.isEmpty, tab)
        }
    }

    /// Три строки выброшенной вкладки «Ещё» стали табами Настроек — и `CC_PUSH`
    /// обязан попадать именно на свой таб, а не на первый попавшийся.
    func testOldPushLandsOnTheTabThatScreenBecame() {
        XCTAssertEqual(LaunchAffordances.parse(["CC_PUSH": "team"]).screen, .team(.overview))
        XCTAssertEqual(LaunchAffordances.parse(["CC_PUSH": "hardware"]).screen, .settings(.hardware))
        XCTAssertEqual(LaunchAffordances.parse(["CC_PUSH": "memory"]).screen, .settings(.memory))
        XCTAssertEqual(LaunchAffordances.parse(["CC_PUSH": "profile"]).screen, .settings(.profile))
        for push in ["team", "hardware", "memory", "profile"] {
            XCTAssertFalse(LaunchAffordances.parse(["CC_PUSH": push]).notes.isEmpty, push)
        }
    }

    /// У Роадмапа и Карты места в шелле нет. Это законный ответ — но он ДОЛЖЕН
    /// прозвучать, иначе скрипт снимет корень и назовёт файл «roadmap».
    func testOldPushWithNowhereToGoSaysSoOutLoud() {
        // Роадмап и Карта УДАЛЕНЫ в фазе 4, но имя обязано продолжать звучать:
        // скрипт, зовущий их, иначе снял бы корень и назвал файл «roadmap».
        for push in ["roadmap", "map"] {
            let a = LaunchAffordances.parse(["CC_PUSH": push])
            XCTAssertEqual(a.screen, .start, push)
            XCTAssertFalse(a.notes.isEmpty, "CC_PUSH=\(push) обязан объявиться в логе")
        }
    }

    func testNewNameWinsOverTheOldOne() {
        let a = LaunchAffordances.parse(["CC_SCREEN": "team", "CC_TAB": "home", "CC_PUSH": "memory"])
        XCTAssertEqual(a.screen, .team(.overview))
    }

    // MARK: Непонятое — тоже вслух

    func testUnknownValuesFallBackAndComplain() {
        for env in [["CC_SCREEN": "колонки"], ["CC_TAB": "inbox"], ["CC_PUSH": "files"]] {
            let a = LaunchAffordances.parse(env)
            XCTAssertEqual(a.screen, .start, "\(env)")
            XCTAssertFalse(a.notes.isEmpty, "\(env) обязано объявиться в логе")
        }
    }

    /// Линз было четыре. Скрипт, зовущий выброшенную, получает Список — и
    /// узнаёт об этом.
    func testRetiredLensesFallBackToTheList() {
        for lens in ["projects", "table"] {
            let a = LaunchAffordances.parse(["CC_LENS": lens])
            XCTAssertEqual(a.lens, .list, lens)
            XCTAssertFalse(a.notes.isEmpty, lens)
        }
    }

    /// Пустая строка — это «не задано», а не «задано пустым». simctl легко
    /// пробрасывает пустое значение, и оно не должно ничего переводить.
    func testEmptyValuesAreTreatedAsAbsent() {
        let a = LaunchAffordances.parse(["CC_SCREEN": "", "CC_TAB": "", "CC_PUSH": "",
                                         "CC_LENS": "", "CC_DRAWER": "", "CC_FLOW_MENU": ""])
        XCTAssertEqual(a.screen, .start)
        XCTAssertFalse(a.drawerOpen)
        XCTAssertTrue(a.notes.isEmpty)
    }
}
