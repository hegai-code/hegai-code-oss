import Foundation

/// Экран, на который харнес просит встать при запуске.
///
/// Это не роут приложения, а *просьба снаружи*: `scripts/shoot.sh` должен уметь
/// поставить приложение в нужное состояние без скриптованных тапов, потому что
/// тап по координате ломается от любой правки вёрстки, а `CC_*` — нет.
enum LaunchScreen: Equatable {
    /// Корень — стартовый экран.
    case start
    case team(TeamTab)
    case settings(SettingsTab)
    /// Лента уведомлений — лист «ещё» в подвале шторки.
    case notifications
    /// Витрина дизайн-системы. Живёт ВНЕ шелла (см. `CCRemoteApp`): она ничего
    /// не знает про хаб и роняет свой маяк готовности сама.
    case gallery
    /// Стенд транскрипта — тот же приём, что и витрина, только для документа и
    /// композера. Существует потому, что живой прод не умеет показать по заказу
    /// упавший инструмент, а снимать его «когда повезёт» — значит не уметь
    /// повторить кадр через месяц.
    case transcript
    /// DEBUG-стенд для правила «жест не крадётся у того, что само едет вбок».
    /// Существует ровно затем, чтобы это правило можно было нажать руками на
    /// детерминированном экране, а не искать в проде сессию с широким кодом.
    case swipeProbe
}

/// Разобранная пусковая среда: экран, шторка, линза — и что при этом пришлось
/// перевести со старых имён.
///
/// **Почему это отдельный разбор, а не три `ProcessInfo` по месту.** Фаза 2
/// выбросила нижнее меню, а вместе с ним `CC_TAB` и `CC_PUSH`, которыми жили
/// скриншот-скрипты. Если бы старое имя просто перестало совпадать с новым
/// `switch`, скрипт продолжил бы запускаться, приложение встало бы на корень, и
/// файл `sessions-375.png` оказался бы снимком стартового экрана. Такую поломку
/// не видно: картинка есть, размер верный, имя верное. Поэтому перевод —
/// явный, с записью в `notes`, и `announce()` проговаривает его в лог.
struct LaunchAffordances: Equatable {
    var screen: LaunchScreen = .start
    /// Шторка открыта уже на первом кадре.
    var drawerOpen = false
    var lens: SessionLens = .list
    /// Открыть меню переноса у первой карточки Flow.
    ///
    /// Аффорданс приёмки, как `CC_GALLERY` и `CC_TRANSCRIPT`: меню переноса —
    /// ЕДИНСТВЕННЫЙ способ двигать карточку на телефоне, поэтому кадр с
    /// открытым меню обязан существовать. Снять его тапом нельзя — тап по
    /// координате ломается от любой правки вёрстки, — а системное меню и вовсе
    /// не открывается ниоткуда, кроме пальца. Ровно поэтому меню здесь своё
    /// (см. `FlowLens`), и веб рисует свой попап по той же причине.
    var flowMenu = false
    /// Спрашивать ли системное разрешение на уведомления при запуске.
    ///
    /// `false` на стендах без хаба (витрина, транскрипт, swipe-probe) и по
    /// `CC_NOTIFICATIONS=false|0`. Системный алерт ложится поверх первого кадра,
    /// а на свежем симуляторе (iPhone SE в `shoot.sh`) на него никто ни разу не
    /// ответил — и он закрывал полосу подсказок в каждом снимке 10.10.2026.
    /// `defaults write` из `shoot.sh` не помогал: на симуляторе он пишет в общие
    /// настройки, а приложение читает свой контейнер. Только этот запуск: в
    /// настройки ничего не пишется.
    var notificationPrompt = true
    /// Человекочитаемые строки о каждом переводе и каждом непонятом значении.
    var notes: [String] = []

    /// Пусковая среда ЭТОГО запуска. `static let`, а не вычисление по месту:
    /// среда за время жизни процесса не меняется, а разбор с побочным эффектом
    /// (`announce`) должен случиться один раз.
    static let current = parse(ProcessInfo.processInfo.environment)

    /// Чистая функция от среды — чтобы переводчик проверялся тестом, а не
    /// доверием. Порядок разбора: `CC_SCREEN` главнее старых имён, `CC_DRAWER`
    /// и `CC_LENS` — независимые оси поверх любого из них.
    static func parse(_ env: [String: String]) -> LaunchAffordances {
        var out = LaunchAffordances()

        // Витрина — самый старый флаг этой семьи, он остаётся рабочим сам по
        // себе: его уже знают скрипты фазы 1.
        if let gallery = env["CC_GALLERY"], !gallery.isEmpty {
            out.screen = .gallery
        }
        // Тот же приём, своя переменная: стенд снимают отдельными прогонами
        // и вместе с `CC_THEME`, а не как секцию витрины.
        if let fixture = env["CC_TRANSCRIPT"], !fixture.isEmpty, fixture != "0" {
            out.screen = .transcript
        }

        if let raw = env["CC_SCREEN"], !raw.isEmpty {
            switch screen(named: raw) {
            case let .some(screen):
                out.screen = screen
                // `CC_SCREEN=sessions` — не опечатка, а старая картина мира:
                // список сессий БЫЛ экраном. Теперь он только в шторке, и
                // просьба «покажи сессии» честно переводится в неё.
                if raw == "sessions" {
                    out.drawerOpen = true
                    out.notes.append("CC_SCREEN=sessions → корень со ОТКРЫТОЙ шторкой: списка сессий как экрана больше нет")
                }
            case .none:
                out.notes.append("CC_SCREEN=\(raw) не опознан — встаю на корень. Допустимо: start, team[:overview|people|projects|audit], notifications, settings[:account|hardware|memory|profile|reports], gallery, transcript, swipe-probe")
            }
        } else if let push = env["CC_PUSH"], !push.isEmpty {
            // CC_PUSH водил по вкладке «Ещё». Её нет: Команда осталась экраном,
            // а Железо/Память/Профиль стали табами Настроек.
            switch push {
            case "team":
                out.screen = .team(.overview)
                out.notes.append("CC_PUSH=team → CC_SCREEN=team")
            case "hardware":
                out.screen = .settings(.hardware)
                out.notes.append("CC_PUSH=hardware → CC_SCREEN=settings:hardware (Железо стало табом Настроек)")
            case "memory":
                out.screen = .settings(.memory)
                out.notes.append("CC_PUSH=memory → CC_SCREEN=settings:memory (Память стала табом Настроек)")
            case "profile":
                out.screen = .settings(.profile)
                out.notes.append("CC_PUSH=profile → CC_SCREEN=settings:profile (Профиль стал табом Настроек)")
            case "notifications":
                out.screen = .notifications
                out.notes.append("CC_PUSH=notifications → CC_SCREEN=notifications (лента переехала с Главной в лист шторки)")
            case "roadmap", "map":
                // Роадмап и Карта были строками в «Ещё». Их больше нет:
                // обе группировали сессии по продукту — вопрос месячный.
                out.notes.append("CC_PUSH=\(push) → корень: \(push) удалён в фазе 4 (группировка по продукту — вопрос месячный, а не дневной)")
            default:
                out.notes.append("CC_PUSH=\(push) не опознан — встаю на корень. Это имя из выброшенной вкладки «Ещё»; переходи на CC_SCREEN")
            }
        } else if let tab = env["CC_TAB"], !tab.isEmpty {
            // CC_TAB выбирал нижнюю вкладку. Нижнего меню нет — есть одна
            // страница и одна шторка, поэтому три из четырёх имён сходятся в
            // одну и ту же пару «корень + шторка».
            switch tab {
            case "home":
                out.notes.append("CC_TAB=home → CC_SCREEN=start")
            case "sessions", "board":
                out.drawerOpen = true
                out.notes.append("CC_TAB=\(tab) → корень со ОТКРЫТОЙ шторкой: список сессий живёт только в ней")
            case "columns":
                out.drawerOpen = true
                out.notes.append("CC_TAB=columns → корень со ОТКРЫТОЙ шторкой: сплит — настольный, на телефоне его нет")
            case "more", "settings":
                out.screen = .settings(.account)
                out.notes.append("CC_TAB=\(tab) → CC_SCREEN=settings:account (вкладка «Ещё» разошлась по табам Настроек)")
            default:
                out.notes.append("CC_TAB=\(tab) не опознан — встаю на корень. Нижних вкладок больше нет; переходи на CC_SCREEN")
            }
        }

        // Ось, а не экран: шторку можно попросить поверх любого `CC_SCREEN`.
        // «0» — это выключено, чтобы `CC_DRAWER=0` не читалось как «да».
        if let drawer = env["CC_DRAWER"], !drawer.isEmpty, drawer != "0" {
            out.drawerOpen = true
        }

        // Просить меню и не просить линзу — почти наверняка описка: меню живёт
        // только во Flow. Поэтому флаг ВКЛЮЧАЕТ линзу и говорит об этом.
        if let menu = env["CC_FLOW_MENU"], !menu.isEmpty, menu != "0" {
            out.flowMenu = true
            out.drawerOpen = true
            out.lens = .flow
            out.notes.append("CC_FLOW_MENU=1 → шторка, линза flow, меню переноса у первой карточки")
        }

        if let raw = env["CC_LENS"], !raw.isEmpty {
            if let lens = SessionLens(rawValue: raw) {
                out.lens = lens
            } else {
                // Линз было четыре. Проекты стали своим назначением, а Таблица
                // была Списком, пересказанным столбцами.
                out.notes.append("CC_LENS=\(raw) не опознан — беру Список. Осталось две линзы: list, flow")
            }
        }

        switch out.screen {
        case .gallery, .transcript, .swipeProbe: out.notificationPrompt = false
        default: break
        }
        if let raw = env["CC_NOTIFICATIONS"]?.lowercased(), ["0", "false", "no"].contains(raw) {
            out.notificationPrompt = false
        }

        return out
    }

    private static func screen(named raw: String) -> LaunchScreen? {
        if raw.hasPrefix("team") {
            // `team` без хвоста — первый таб; `team:<таб>` — named. Ровно та же
            // форма, что у настроек: два экрана с табами не должны требовать
            // двух разных способов их назвать.
            let suffix = raw.dropFirst("team".count)
            if suffix.isEmpty { return .team(.overview) }
            guard suffix.hasPrefix(":"),
                  let tab = TeamTab(rawValue: String(suffix.dropFirst())) else { return nil }
            return .team(tab)
        }
        if raw.hasPrefix("settings") {
            // `settings` без хвоста — первый таб; `settings:<таб>` — named.
            let suffix = raw.dropFirst("settings".count)
            if suffix.isEmpty { return .settings(.account) }
            guard suffix.hasPrefix(":"), let tab = SettingsTab(rawValue: String(suffix.dropFirst())) else { return nil }
            return .settings(tab)
        }
        switch raw {
        case "start", "sessions": return .start
        case "notifications": return .notifications
        case "gallery": return .gallery
        case "transcript": return .transcript
        case "swipe-probe": return .swipeProbe
        default: return nil
        }
    }

    /// Проговорить переводы в лог. Единственный канал, который есть у скрипта:
    /// молчаливый перевод — это та же тихая поломка, только на нашей стороне.
    func announce() {
        for note in notes { print("[launch] \(note)") }
    }
}
