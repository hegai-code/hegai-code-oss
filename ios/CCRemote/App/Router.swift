import SwiftUI
import Observation
import CCRemoteKit

/// A session address used for navigation + deep links. `id` is the
/// `machineId::sessionId` key the web, the favourites and `AppSettings.columnRefs`
/// all agree on; `init?(serialized:)` reads it back byte-for-byte, so one encoder
/// keeps persisted refs, live-run lookups and SwiftUI identity aligned.
struct SessionRoute: Hashable, Identifiable {
    private static let separator = "::"

    let machineId: String
    let sessionId: String

    var id: String { "\(machineId)\(Self.separator)\(sessionId)" }

    init(machineId: String, sessionId: String) {
        self.machineId = machineId
        self.sessionId = sessionId
    }

    init?(serialized: String) {
        let parts = serialized.components(separatedBy: Self.separator)
        guard parts.count == 2, !parts[0].isEmpty, !parts[1].isEmpty else { return nil }
        machineId = parts[0]
        sessionId = parts[1]
    }
}

/// A project address (project label = cwd basename, spanning machines).
struct ProjectRoute: Hashable {
    let project: String
}

/// Экран, который кладётся на стек поверх корня.
///
/// Их два. Было семь — «Ещё» носила Команду, Железо, Роадмап, Карту, Память,
/// Профиль и Настройки, потому что нижняя полоса не вмещала рельсу. Полосы нет:
/// Команда осталась экраном со своими табами, а Железо, Память и Профиль стали
/// ТАБАМИ Настроек — ровно как в вебе, где `/w/hardware`, `/w/memory` и
/// `/w/profile` открывают таб и поправляют адрес.
///
/// `roadmap` и `map` не переехали никуда и больше не существуют: они
/// группировали сессии по продукту — вопрос месячный, а не дневной.
/// String-backed, чтобы `CC_SCREEN` мог назвать любой из оставшихся.
enum ScreenRoute: String, Hashable {
    case team, settings
    /// Лента уведомлений. Жила на Главной — экрана нет, и это её единственное
    /// оставшееся место: лист «ещё» внизу шторки. Туда же смотрит и ember-точка
    /// на ☰, так что «где непрочитанное» отвечается одной дорогой.
    case notifications
    #if DEBUG
    /// Стенд для правила «жест не крадётся у того, что едет вбок». Не роут
    /// продукта — аффорданс приёмки, и в собранном приложении его нет.
    case swipeProbe = "swipe-probe"
    #endif
}

/// Всё, что может лежать на стеке шелла.
///
/// Один тип на три адреса — потому что `NavigationStack` с типизированным
/// путём требует однородного массива, а однородный массив — это то, из чего
/// роутер может спросить, что лежит сверху (см. `Router.push`).
enum ShellRoute: Hashable {
    case session(SessionRoute)
    case newRun(NewRunRoute)
    case project(ProjectRoute)
    case screen(ScreenRoute)

    /// Чат сам рисует мягкий верхний край (`chatEdgeFade`); шелл не кладёт
    /// поверх него свою непрозрачную полосу под часами.
    var fadesOwnTopEdge: Bool {
        switch self {
        case .session, .newRun: return true
        default: return false
        }
    }
}

/// Прогон, начатый только что и ещё не назвавший своей сессии.
///
/// Отдельный случай стека, а не `session` с пустым id: адреса у него в этот
/// момент нет (`session_started` приходит позже), и всё, что про него известно,
/// — куда начали. См. `NewRunView`.
struct NewRunRoute: Hashable {
    let label: String
    let machineName: String
    let source: String?
    var projectName: String = "Без проекта"
}

/// Навигация телефона: ОДНА страница и ОДИН drawer.
///
/// Здесь было четыре вкладки и стек на каждую — и три из четырёх вкладок были
/// списком сессий по разной оси. Веб прошёл эту модель и выбросил её, причём по
/// опыту, а не по вкусу: «three lenses on one dataset, not three places»
/// (`navModel.ts`), а на телефоне он дошёл до конца мысли — рельсы нет, нижней
/// полосы нет, `/w/sessions` это композер, а список сессий живёт ТОЛЬКО в
/// шторке (DESIGN.md, «Навигация»).
///
/// Что из этого следует для состояния:
///   * стек один (`path`), потому что мест, между которыми можно прыгать, не
///     осталось — есть корень и то, что легло на него сверху;
///   * `isDrawerOpen` — полноправная часть навигации, а не украшение: это
///     единственная дорога к другой сессии;
///   * линз две, и держит их роутер, чтобы `CC_LENS` работал без тапов.
@MainActor
@Observable
final class Router {
    /// Единственный стек. Раньше их было три (по вкладке), и каждый метод
    /// открытия начинался со `switch tab` — выбора, в какой из трёх положить.
    /// Выбора нет: класть некуда, кроме этого.
    ///
    /// ТИПИЗИРОВАННЫЙ массив, а не `NavigationPath`. Разница не стилистическая:
    /// `NavigationPath` непрозрачен — из него нельзя спросить, что лежит
    /// сверху. А спросить надо, иначе сессия, выбранная в шторке ПОВЕРХ другой
    /// сессии, ляжет на неё сверху, и каждая похороненная копия продолжит
    /// держать свою задачу фокуса и истории. Ровно от этого когда-то завели
    /// `switchSession`; со шторкой это перестало быть краевым случаем и стало
    /// основным путём, поэтому правило переехало в сам стек (см. `push`).
    var path: [ShellRoute] = []

    /// Положить экран на стек, соблюдая одно правило: **сессия никогда не
    /// ложится на сессию**. Перейти из разговора в разговор — это замена, а не
    /// спуск на уровень глубже; «назад» из второго обязан вести в список, а не
    /// в первый.
    private func push(_ route: ShellRoute) {
        if case .session = route, case .session = path.last { path.removeLast() }
        // Тот же закон для только что начатого прогона: он РАЗГОВОР, и
        // «назад» из него обязано вести в список, а не в предыдущий разговор.
        if case .session = route, case .newRun = path.last { path.removeLast() }
        if case .newRun = route, case .session = path.last { path.removeLast() }
        if case .newRun = route, case .newRun = path.last { path.removeLast() }
        path.append(route)
    }

    /// Какая сессия сейчас ОТКРЫТА, если открыта.
    ///
    /// Спрашивается у стека, а не хранится рядом с ним: второе — это копия
    /// состояния, которая расходится ровно тогда, когда на неё перестают
    /// смотреть (возврат по жесту стек меняет, а копию нет). Смотреть можно
    /// только в вершину — сессия никогда не лежит под сессией, это держит
    /// `push`.
    ///
    /// Нужно это шторке: она показывает весь корпус и до 22.09 не говорила,
    /// какая из ста двадцати пяти строк — та, из которой ты её открыл.
    var currentSession: SessionRoute? {
        if case let .session(route) = path.last { return route }
        return nil
    }

    /// Шторка: список сессий поверх того, что открыто. Открывается ☰ в шапке и
    /// свайпом вправо.
    var isDrawerOpen: Bool = LaunchAffordances.current.drawerOpen
    func openDrawer() {
        #if DEBUG
        DrawerPerformanceProbe.shared.begin()
        #endif
        isDrawerOpen = true
    }
    func closeDrawer() { isDrawerOpen = false }
    func toggleDrawer() { isDrawerOpen.toggle() }

    /// Какой линзой шторка показывает сессии. На роутере, а не во вью, чтобы
    /// `CC_LENS=list|flow` доводил скриншот-прогон до нужного кадра.
    var sessionLens: SessionLens = LaunchAffordances.current.lens

    /// Переданное из «Поделиться»: садится в композер СТАРТОВОГО ЭКРАНА, а не
    /// в отдельную форму новой сессии — формы больше нет, и корень приложения
    /// и есть то место, куда это просились положить. Гасится композером, как
    /// только он передачу принял (`ComposerView.onSeedTaken`), иначе она
    /// приедет ещё раз на следующем кадре и удвоит текст.
    var pendingShare: ComposerSeed?
    /// «Оригинал» из ленты: открыть сессию и доскроллить до сообщения. Живёт
    /// отдельно от `openSession` (его подпись не меняется, см. ниже): звавший
    /// сначала ставит просьбу, потом открывает сессию как обычно, а `ChatView`
    /// сам находит строку, как только история приехала, и гасит просьбу, когда
    /// доехал или сдался.
    var pendingMessageAnchor: (sessionId: String, uuid: String)?

    /// An explicit project never falls back to a different server or directory.
    var newChatTarget: ProjectTarget?
    var focusesNewChat = true

    func home() {
        focusesNewChat = false
        pendingMessageAnchor = nil
        path.removeAll()
        closeDrawer()
    }

    // MARK: - Открытие
    //
    // ПОДПИСИ ЭТИХ ЧЕТЫРЁХ МЕТОДОВ НЕ МЕНЯЮТСЯ. На них висит открытие по
    // уведомлению (`LocalNotifications.onTap`), дип-линк `CC_OPEN`, передача из
    // «Поделиться» и каждая строка каждого списка. Ломаются они невидимо: не
    // компиляцией, а тем, что на настоящем пуше и настоящем шаринге приложение
    // открывает не то. Внутренности переписаны под один стек; снаружи — то же.

    /// Открыть сессию.
    func openSession(machineId: String, sessionId: String) {
        push(.session(SessionRoute(machineId: machineId, sessionId: sessionId)))
        closeDrawer()
    }

    /// Сменить сессию на экране НА МЕСТЕ (шторка, переключатель под шапкой).
    ///
    /// Делает ровно то же, что `openSession`, и это не небрежность: правило
    /// «сессия не ложится на сессию» переехало в `push`, потому что со шторкой
    /// оно перестало быть краевым случаем одного переключателя и стало общим.
    /// Оба метода остались, потому что места вызова называют ими СВОЁ
    /// намерение — «провалиться» и «переключиться» читаются по-разному, даже
    /// когда стек делает одно и то же.
    func switchSession(machineId: String, sessionId: String) {
        openSession(machineId: machineId, sessionId: sessionId)
    }

    /// Открыть список сессий проекта.
    func openProject(_ project: String) {
        push(.project(ProjectRoute(project: project)))
        closeDrawer()
    }

    /// Открыть только что начатый прогон — до того, как он назовёт свою сессию.
    func openNewRun(label: String, machineName: String, source: String? = nil, projectName: String = "Без проекта") {
        push(.newRun(NewRunRoute(label: label, machineName: machineName, source: source, projectName: projectName)))
        closeDrawer()
    }

    /// «Новый чат» — это ВЕРНУТЬСЯ НА КОРЕНЬ.
    ///
    /// Раньше он поднимал форму новой сессии поверх всего. Формы нет: корень и
    /// есть композер, и отдельный экран для той же задачи был вторым
    /// изображением того же самого — с собственным выбором проекта, собственным
    /// черновиком и собственным представлением о том, что такое «начать».
    func newChat() {
        focusesNewChat = true
        newChatTarget = nil
        pendingMessageAnchor = nil
        path.removeAll()
        closeDrawer()
    }

    func newChat(in target: ProjectTarget) {
        focusesNewChat = true
        newChatTarget = target
        path.removeAll()
        closeDrawer()
    }

    /// Положить переданное из «Поделиться» в композер стартового экрана. Сам
    /// экран для этого должен быть виден, поэтому стек схлопывается: передача
    /// адресована композеру, а не тому разговору, который сейчас открыт.
    func presentShare(_ share: ComposerSeed) {
        focusesNewChat = true
        path.removeAll()
        closeDrawer()
        pendingShare = share
    }

    // MARK: - Экраны

    /// Положить на стек Команду или Настройки. Заменяет `morePath.append`.
    func openScreen(_ screen: ScreenRoute) {
        push(.screen(screen))
        closeDrawer()
    }

    /// То же, но не трогая шторку: `CC_SCREEN` и `CC_DRAWER` — независимые оси,
    /// и запрошенный экран не должен закрывать запрошенную поверх него шторку.
    func pushAtLaunch(_ screen: ScreenRoute) { push(.screen(screen)) }

    /// Открыть Настройки на конкретном табе — так же, как веб открывает
    /// `/w/hardware` и поправляет адрес на таб.
    func openSettings(_ tab: SettingsTab = .account) {
        settingsTab = tab
        openScreen(.settings)
    }

    /// Открыть Команду на конкретном табе.
    func openTeam(_ tab: TeamTab = .overview) {
        teamTab = tab
        openScreen(.team)
    }

    /// Таб, на котором откроются Настройки. На роутере, а не во вью: экран
    /// Настроек пересоздаётся при каждом пуше, и `@State` внутри него не может
    /// знать, что попросили Железо.
    var settingsTab: SettingsTab = {
        if case let .settings(tab) = LaunchAffordances.current.screen { return tab }
        return .account
    }()

    /// То же самое для Команды: `CC_SCREEN=team:audit` открывает свой таб.
    var teamTab: TeamTab = {
        if case let .team(tab) = LaunchAffordances.current.screen { return tab }
        return .overview
    }()

}
