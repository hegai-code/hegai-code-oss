import SwiftUI
import CCRemoteKit
import UIKit

/// Native semantic tokens. See ios/DESIGN.md; web CSS is a separate system.
/// SF and Dynamic Type, a shared canvas/group/sheet surface ladder, transparent
/// gaps between islands. Provider marks and blue/green status dots keep their roles.
enum Theme {
    // Sidebar palette follows the owner-provided ChatGPT reference.
    static let drawerBackground = bg
    static let drawerCard = Color(light: 0xFFFFFF, dark: 0x191919)
    static let drawerText = Color(light: 0x161616, dark: 0xF5F5F5)
    static let drawerSecondary = Color(light: 0x666666, dark: 0x999999)
    static let drawerControl = Color(light: 0xF3F3F3, dark: 0x111111)
    static let drawerRim = Color(light: 0xE6E6E6, dark: 0x292929)
    static let composerBackground = Color(light: 0xFCFCFC, dark: 0x191919)
    /// Бургунди по просьбе владельца 08.10.2026 (было голубое #0088FF).
    /// Белый значок: 9.2:1 в светлой, 6.5:1 в тёмной; в тёмной тон поднят,
    /// чтобы круг держал 3:1 к почти чёрной канве (#7A2E3A там 2.1:1).
    static let composerAction = Color(light: 0x7A2E3A, dark: 0x9E3D4E)
    static let onComposerAction = Color(hex: 0xFFFFFF)
    static let settingsBackground = bg
    static let settingsGroup = drawerCard
    static let drawerCompleted = Color(light: 0x24843B, dark: 0x5BD477)
    static let drawerBlue = Color(light: 0x0079E8, dark: 0x0088FF)
    // Та же бургунди, что у отправки: белая надпись 9.2:1 / 6.5:1.
    static let drawerCreateAction = composerAction
    static let onDrawerCreateAction = Color(hex: 0xFFFFFF)
    static let claudeActivity = Color(light: 0xC75A28, dark: 0xF28B54)
    static let codexActivity = Color(light: 0x1D3A2E, dark: 0xE8F0EC)


    // MARK: - Поверхности
    //
    // Канва не бежевая: a.test's ivory — цвет СТРАНИЦЫ, он под статьёй, которую
    // читают две минуты. Здесь инструмент, открытый весь день, и на ivory каждая
    // белёсая штука внутри (колодец кода, строка диффа, чип файла) дерётся с
    // канвой за право выглядеть бумагой. В каждой ступени остался след зелени
    // (~1% насыщенности): назвать его нельзя, отсутствие — заметно.

    static let bg = Color(light: 0xF6F7F6, dark: 0x0B0C0D)             // канва, транскрипт
    static let surface = Color(light: 0xFFFFFF, dark: 0x0B0C0D)        // полосы, колонки, композер
    static let surfaceRaised = Color(light: 0xFFFFFF, dark: 0x191919)  // карточки, поповеры, модалки
    /// Колодец канона: поля ввода, код, машинные строки.
    static let surfaceSunken = Color(light: 0xF0F2F0, dark: 0x121415)
    static let chip = Color(light: 0xECEEEC, dark: 0x1C1F21)           // чипы, теги
    /// Ховер — это ТИНТ, а не фиксированная ступень: он обязан читаться и на
    /// канве, и на приподнятой карточке, и на чернильной плашке.
    static let surfaceHover = Color(ink: 0.05, ivory: 0.06)

    static let divider = Color(ink: 0.10, ivory: 0.10)                 // волосяная линия
    static let border = Color(ink: 0.16, ivory: 0.22)                  // край карточки, контур контрола

    // MARK: - Чернила
    //
    // Каждый тон держит ≥4.5:1 на своём фоне — ВКЛЮЧАЯ таймстемпы, счётчики и
    // лейблы секций. Канонный `--text-muted` в 0.42 предназначен плейсхолдерам;
    // здесь на нём живёт контент, поэтому оба тира подняты.

    static let text = Color(light: 0x101F18, dark: 0xFCFAF1)           // ink / ivory
    static let textMuted = Color(ink: 0.72, ivory: 0.78)               // вторичный — 6.6:1 / 11:1
    static let textFaint = Color(ink: 0.62, ivory: 0.50)               // время, счётчики — 4.8:1 / 4.9:1
    /// Ivory поверх сплошной ТЁМНОЙ заливки (чернила, красный) в обеих темах.
    static let textOnColor = Color(hex: 0xFCFAF1)

    // MARK: - Четыре роли цвета
    //
    // Раньше это был один токен. `action` тянул кнопки, плашку выделения,
    // unread-бейджи И фокус одновременно — и потому не мог следовать канону, не
    // позеленив unread (а зелёный здесь означает git/success/live). Разведение
    // ролей — единственное, что делает канон применимым.

    /// Общие primary-кнопки; отправка в композере использует composerAction.
    ///
    /// Чернильная плашка с ivory — ровно как в вебе (`--action: var(--ink)`,
    /// `web/src/styles.css`). Зелёного на заливках нет: «Новая сессия», квадрат
    /// отправки, плашка проекта и инициалы аккаунта читались одним насыщенным
    /// пятном. Контраст от замены вырос: ink/ivory 15.8:1 против green/ivory
    /// 10.3:1.
    ///
    /// **Ember сюда не идёт.** Он — цвет ВНИМАНИЯ (`attn`, `brand`):
    /// непрочитанное, «нужен ответ», точка eyebrow, кольцо фокуса. Кнопки и
    /// окантовки им не красятся. 22.09 это правило было ненадолго нарушено и
    /// в тот же день восстановлено.
    static let action = Color(light: 0x101F18, dark: 0xFCFAF1)
    static let onAction = Color(light: 0xFCFAF1, dark: 0x101F18)
    static let actionHover = Color(light: 0x1C3128, dark: 0xF1ECD8)
    static let actionPress = Color(light: 0x070F0C, dark: 0xE7E1CA)
    /// Заливка канонного icon-button'а — чип, а не плашка.
    static let actionSoft = Color(ink: 0.08, ivory: 0.10)
    static let actionSoft2 = Color(ink: 0.14, ivory: 0.16)
    /// Выключенная кнопка действия. Всё ещё роль action, только приглушённая:
    /// прежняя заливка `chip` отличалась от композера на ~1.5% светлоты, то есть
    /// была невидимой кнопкой отправки, пока поле пустое.
    static let actionMuted = action.opacity(0.35)

    /// Сплошная плашка НАСТОЯЩЕГО выбора: курсор палитры, мультивыбор файлов,
    /// выбранная строка в маленьком меню.
    ///
    /// Не следует за `action`, который в тёмной теме переворачивается в ivory:
    /// пятнадцать ivory-полос вниз по почти чёрной колонке — это стена бликов,
    /// а не выделение. Поэтому в тёмной — приподнятый графит (8.9:1 для ivory).
    static let select = Color(light: 0x101F18, dark: 0x2C3234)
    static let onSelect = Color(hex: 0xFCFAF1)

    /// «Ты здесь» — подложка НАВИГАЦИОННОГО состояния: выбранная сессия,
    /// активный проект, чип машины, текущая папка.
    ///
    /// Это не «выбрано», и это отдельный токен. Сплошная плашка тащит за собой
    /// дюжину переопределений цвета у детей строки — только чтобы они читались
    /// поверх неё, — и чёрная полоса в списке сессий становится самым заметным
    /// объектом экрана. Тинт говорит то же самое, дети остаются своего цвета,
    /// выделение держится полужирным начертанием.
    /// 9% от текста в светлой, 14% в тёмной: на почти чёрном 9% не читается.
    static let here = Color(ink: 0.09, ivory: 0.14)

    /// Unread, needs-attention, attention-точки. Ember — и НА НЁМ ТОЛЬКО INK,
    /// никогда ivory: ivory на ember меряется 2.7:1.
    static let attn = Color(light: 0xFF6A3D, dark: 0xFF7F57)
    static let onAttn = Color(hex: 0x101F18)                           // 5.94:1
    static let attnHover = Color(light: 0xF2552A, dark: 0xFF6A3D)
    static let attnSoft = Color(light: 0xFFE4DA, dark: 0x402318)

    /// Индикаторы, тонкие границы, точка eyebrow, фокус-гало.
    static let brand = Color(light: 0xFF6A3D, dark: 0xFF8A64)
    static let focusRing = Color(light: 0xFF6A3D, dark: 0xFF8A64).opacity(0.55)
    /// Ссылка несёт свою аффордансу подчёркиванием, а не оттенком — поэтому
    /// тёмная тема давно брала здесь ember вместо зелёного (1.8:1 на чернилах),
    /// а светлая теперь говорит то же самое чернилами.
    static let link = text
    /// Ссылка ВНУТРИ прозы (ответ агента, реплика человека) — синяя и с
    /// подчёркиванием, как `--link-prose` веба (10.10.2026, «надо, чтобы она
    /// синим подсвечивалась»): чернила с подчёркиванием читались как акцент, а
    /// не как то, что можно нажать. 5.67:1 на холсте светлой, 8.1:1 на графите.
    static let linkProse = Color(light: 0x1F5FBF, dark: 0x7FB2FF)

    // MARK: - «Идёт прогон» — пульс, а не цвет
    //
    // Было `#6fbf3a`, самый частый зелёный в продукте: по квадрату на строку, в
    // каждой строке. «Идёт» здесь говорит ПУЛЬС (`Theme.pulse`), а не оттенок,
    // поэтому метка может быть тоном текста и ничего не теряет. Ember сюда
    // брать нельзя: ember — это needs_attention, и оба состояния стоят в одной
    // колонке.
    //
    // В тёмной теме `live` ОБЯЗАН переопределяться: ink на почти чёрном — это
    // ничто, метка просто исчезла бы.
    static let live = Color(light: 0x101F18, dark: 0xFCFAF1)
    /// Парный к `live`, и не косметика: `live` работает и заливкой (пилюля
    /// статуса) и переворачивается между темами, так что фиксированный цвет
    /// текста на нём нечитаем в одной из двух.
    static let onLive = Color(light: 0xFCFAF1, dark: 0x101F18)

    // MARK: - Семантика / git
    //
    // Зелёный — git/success/live, ember — акцент и внимание. Любая заливка под
    // текстом берёт `red`; `redBright` — ТОЛЬКО графика (точки, гуттеры диффов,
    // границы), ivory на нём 4.09:1.

    static let green = Color(hex: 0x06463D)                            // фирменный зелёный (не заливка под текстом)
    static let positive = Color(light: 0x0A5A4E, dark: 0x6FBF3A)       // зелёный текст — 7.76:1
    static let orange = Color(hex: 0xF2A900)                           // золото — графика / «изменено»
    static let orangeText = Color(light: 0x8F6400, dark: 0xF5C34D)     // доступное золото для мелкого текста
    static let red = Color(light: 0xBD3223, dark: 0xB4322A)            // заливка под текстом — 5.48:1
    static let redBright = Color(hex: 0xDF3F2E)                        // ТОЛЬКО графика
    static let dangerHover = Color(hex: 0xC53522)
    static let negative = Color(light: 0xBD3223, dark: 0xFF8577)       // доступный красный для текста
    static let purple = Color(hex: 0x8E3B57)
    static let purpleText = Color(light: 0x8E3B57, dark: 0xD493AB)
    static let yellow = Color(hex: 0xF2A900)                           // звезда избранного = золото
    static let teal = Color(hex: 0x5C8AA6)                             // тег Codex — info blue канона
    static let tealDark = Color(light: 0x44708A, dark: 0x9CC3D8)
    static let groupAlt = Color(light: 0x44708A, dark: 0x9CC3D8)
    static let diffAddBg = Color(light: 0xE3EFDD, dark: 0x1C2F22)
    static let diffDelBg = Color(light: 0xFBE3DC, dark: 0x3A221C)

    /// Синий забирает свою настоящую работу: слой AI / данных / инфраструктуры.
    static let ai = Color(light: 0xDCEAF1, dark: 0x233A45)
    static let onAi = Color(light: 0x06463D, dark: 0x9CC3D8)           // 6.63:1

    /// Терминал остаётся тёмным в ОБЕИХ темах (чернила канона, ANSI-safe).
    static let terminalBg = Color(hex: 0x0B1511)
    static let terminalText = Color(hex: 0xFCFAF1)

    // MARK: - Тона типов файлов
    //
    // Единственное место, где палитра расширена, и расширена намеренно: файловый
    // менеджер читают взглядом, а взгляд опирается на форму и цвет раньше, чем
    // на имя. Тона аватаров сюда НЕ переиспользуются: `av3.fg` — это ivory, цвет
    // текста НА тёмной плашке, и половина пары, взятая отдельно, не несёт
    // никакого контраста. Каждое значение измерено против канвы своей темы.
    static let ftypeCode = Color(light: 0x0A5A4E, dark: 0x6FD0B4)      // 7.77:1 / 10.51:1
    static let ftypeDoc = Color(light: 0x101F18, dark: 0xFCFAF1)       // 16.31:1 / 18.58:1
    static let ftypeMedia = Color(light: 0xA8431C, dark: 0xFF8A64)     // 5.76:1 / 8.39:1
    static let ftypeData = Color(light: 0x1F5673, dark: 0xB7D4E4)      // 7.62:1 / 12.54:1

    // MARK: - Идентичность: четыре плоских тона аватара
    //
    // Плоские, не градиенты: градиентов в системе нет, а две из семи старых пар
    // ставили белое на золото и белое на лайм (1.6:1 и 2.2:1). Объявление
    // парами bg+fg — это и есть то, что делает каждый тон измеримым.
    static let av0 = (bg: Color(inkTint: 0x06463D, lightAlpha: 0.12, darkTint: 0x6FBF3A, darkAlpha: 0.16),
                      fg: Color(light: 0x06463D, dark: 0x8ED468))
    static let av1 = (bg: Color(light: 0xDCEAF1, dark: 0x233A45), fg: Color(light: 0x06463D, dark: 0x9CC3D8))
    static let av2 = (bg: Color(light: 0xFFE4DA, dark: 0x402318), fg: Color(light: 0x8A3417, dark: 0xFF8A64))
    static let av3 = (bg: Color(inkTint: 0x101F18, lightAlpha: 1.0, darkTint: 0xFAF7EA, darkAlpha: 0.16),
                      fg: Color(light: 0xFCFAF1, dark: 0xFCFAF1))

    /// Четыре тона по порядку — `avatarIdx()` индексирует именно этот массив.
    static var avatarPalette: [(bg: Color, fg: Color)] { [av0, av1, av2, av3] }

    // Шести оттенков семейств инструментов (`toolRead` / `toolBash` /
    // `toolEdit` / `toolTask` / `toolWeb` / `toolTodo`) здесь больше нет.
    // Канон разрешает машинной строке ТРИ смысловых цвета — чтение, запись и
    // запуск, ошибка, — и они собраны на `ToolTone`
    // (`Features/Render/ToolViews.swift`) из уже существующих ролей: `green`,
    // `attn`, `red`. Отдельные токены нужны не были: это была палитра
    // идентичности инструментов, то есть шесть оттенков на то, что и так
    // написано буквами рядом.

    /// Акценты категорий сессии — точка чипа, никогда не заливка под мелким текстом.
    static let catRambling = Color(light: 0x8A5A2E, dark: 0xD9A76A)
    static let catSync = Color(light: 0x3F6B7D, dark: 0x86B3C6)
    static let catShip = Color(light: 0x06463D, dark: 0x5FBFA4)
    static let catVerify = Color(light: 0x1F6F4A, dark: 0x6CC48F)
    static let catBugs = Color(light: 0xBD3223, dark: 0xEF7264)
    static let catMobile = Color(light: 0x7D4A86, dark: 0xC294CB)
    static let catFeature = Color(light: 0xB07400, dark: 0xE0A23E)
    static let catCodex = Color(light: 0x2C6B76, dark: 0x6FB6C2)
    static let catBacklog = Color(light: 0x44708A, dark: 0x7BA8C4)
    static let catResearch = Color(light: 0x8E3B57, dark: 0xD78FAA)
    static let catWebpage = Color(light: 0x2F6F5E, dark: 0x6FB39C)
    static let catText = Color(light: 0x7A5A2E, dark: 0xC8A373)
    static let catTz = Color(light: 0x5B4B8A, dark: 0xA89AD4)

    /// Акценты колонок Flow.
    static let stageBacklog = Color(light: 0x8A8A86, dark: 0x9A9A96)
    static let stagePlanning = Color(light: 0x44708A, dark: 0x7BA8C4)
    static let stageInProgress = Color(light: 0xB07400, dark: 0xE0A23E)
    static let stageTesting = Color(light: 0x8E3B57, dark: 0xD78FAA)
    static let stageDone = Color(light: 0x1A7F37, dark: 0x3FB950)

    /// Цикл цветов проекта/группы (акценты дорожек, границы групп).
    static let groupCycle: [Color] = [attn, groupAlt, purpleText, orangeText, positive, negative]

    // MARK: - Лестница радиусов — 8 / 12 / 16 / 20 / 999 (ИНВАРИАНТ)

    static let radiusSm: CGFloat = 8       // внутренние чипы, квадрат инструмента, статусные метки
    static let radiusMd: CGFloat = 12      // кнопки, icon-button'ы, поля, строки
    static let radiusLg: CGFloat = 16      // карточки, плашки, композер
    static let radiusXl: CGFloat = 20      // модалки, палитра
    /// ЛИЦЕНЗИЯ НА ПИЛЮЛЮ: теги, бейджи и АКТИВНЫЕ фильтр-чипы. Больше ничего.
    static let pill: CGFloat = 999
    /// Не ступень лестницы, а угол САМОГО ТЕЛЕФОНА. Нужен там, где поверхность
    /// притворяется краем устройства — шторка фазы 2, лист поверх экрана.
    /// 48pt повторяет крупное скругление сдвинутого чата в референсе.
    static let radiusDevice: CGFloat = 48

    // MARK: - Размеры компонентов

    static let avatarList: CGFloat = 40
    static let avatarHeader: CGFloat = 36
    static let avatarCard: CGFloat = 34
    static let avatarTable: CGFloat = 28
    static let unreadBadge: CGFloat = 22
    static let fab: CGFloat = 56
    static let sendButton: CGFloat = 44
    static let composerActionSize: CGFloat = 32

    /// Края чата (08.10.2026, по образцу ChatGPT) — альфа маски прокрутки,
    /// см. `chatEdgeFade()`. Сверху от экрана: под часами строка почти
    /// погашена, к низу островов шапки проявляется полностью. Снизу от верха
    /// композера: полностью видна → 30% → `edgeFloor` у полоски «домой».
    static var topEdgeMask: LinearGradient { LinearGradient(stops: [
        .init(color: .black.opacity(edgeFloor), location: 0),
        .init(color: .black.opacity(0.2), location: 0.42),
        .init(color: .black, location: 1),
    ], startPoint: .top, endPoint: .bottom) }
    static var bottomEdgeMask: LinearGradient { LinearGradient(stops: [
        .init(color: .black, location: 0),
        .init(color: .black.opacity(0.3), location: 0.5),
        .init(color: .black.opacity(edgeFloor), location: 1),
    ], startPoint: .top, endPoint: .bottom) }
    static let edgeFloor = 0.06

    /// Минимальная цель нажатия. Это НЕ размер рисунка: иконочная кнопка
    /// композера нарисована на `iconButton`, а нажимается на `tapTarget` —
    /// 32 рисованных пикселя читаются как аккуратный ряд, 32 нажимаемых
    /// читаются как «не попадает».
    static let tapTarget: CGFloat = 44
    /// Нарисованный квадрат иконочной кнопки внутри композера.
    static let iconButton: CGFloat = 32
    /// Каждая статусная метка — квадрат 8×8. Круглая точка читается как HUD
    /// игры, квадратная — как прибор, а это прибор.
    static let statusDot: CGFloat = 8
    static let statusDotRadius: CGFloat = 2
    /// Угол аватара как доля его размера (28%). Не круг: кругов в системе нет.
    static let avatarCornerRatio: CGFloat = 0.28
    /// Мера чтения транскрипта и композера — одно число на четыре правила.
    /// Плотность держится мерой, а не мелким кеглем.
    static let readingWidth: CGFloat = 760
    /// Колонка говорящего в транскрипте: метка идентичности плюс имя, под ними
    /// время хода моно-строкой. Оба — ВНЕ меры чтения.
    static let speakerGutter: CGFloat = 76

    // MARK: - Сетка 4 / 8 (ИНВАРИАНТ)

    static let s1: CGFloat = 4
    static let s2: CGFloat = 8
    static let s3: CGFloat = 12
    static let s4: CGFloat = 16
    static let s5: CGFloat = 20
    static let s6: CGFloat = 24
    static let s8: CGFloat = 32

    // MARK: - Лестница типов
    //
    // Шкала ПЛОТНОГО ИНСТРУМЕНТА, не маркетинговая. 72px display и 52px h1
    // существуют ради геройского экрана; у этого продукта героя нет, и импорт
    // той шкалы — ровно тот способ, которым «применение a.test» превращается в
    // лендинг.
    //
    // Лестница висит на `sizeBody`, и тело — 16, потому что транскрипт это
    // ПОВЕРХНОСТЬ ЧТЕНИЯ: здесь читают структурированный документ, а не ленту
    // реплик. 14 был кеглем обвязки вокруг читаемого, а не кеглем читаемого.
    //
    // Ни один размер мимо этих десяти. Исключение — это БОКС или ПОРОГ, а не
    // кегль, и помечается комментарием на своей же строке.

    static let sizeScreen: CGFloat = 28    // одно большое ЧИСЛО на экране
    static let sizePage: CGFloat = 24      // заголовок экрана — ступенью ниже того числа
    static let sizeTitle: CGFloat = 20     // заголовки секций и панелей
    static let sizeLead: CGFloat = 18      // h2 прозы, заголовки модалок
    static let sizeCard: CGFloat = 17      // заголовки карточек
    static let sizeNavigationTitle: CGFloat = 16 // однострочный остров названия сессии
    /// Controls and text entry keep the standard system body size.
    static let sizeBody: CGFloat = 17
    /// Conversation prose has its own compact size, including streamed answers.
    static let sizeChatBody: CGFloat = 16
    static let sizeSmall: CGFloat = 14.5   // строки списка, кнопки, чипы
    static let sizeMeta: CGFloat = 13      // моно-мета, счётчики, время
    static let sizeMicro: CGFloat = 12     // моно-капс eyebrow
    /// ТОЛЬКО глиф внутри фиксированного квадратного бокса (инициал аватара,
    /// цифра в бейдже). Не ступень для текста.
    static let sizeNano: CGFloat = 10

    // Межстрочные и трекинг. Трекинг — в ЕМ: SwiftUI `.tracking()` принимает
    // пункты, поэтому его всегда умножают на кегль (`Theme.track(_:_:)`).
    static let lhTitle: CGFloat = 1.2
    static let lhBody: CGFloat = 1.5
    /// Плотные строки внутри абзаца; границы абзацев задаёт MarkdownText.
    static let lhRead: CGFloat = 1.38
    static let lhHuman: CGFloat = 1.4
    static let lsTitle: CGFloat = -0.01
    static let lsHuman: CGFloat = 0.01     // серифный курсив — положительный намеренно
    static let lsTech: CGFloat = 0.03      // моно
    static let lsCaps: CGFloat = 0.14      // моно ALL-CAPS eyebrow

    /// Трекинг в пунктах из значения в em и кегля.
    static func track(_ em: CGFloat, _ size: CGFloat) -> CGFloat { em * size }

    /// ГОЛОС ЧИТАЕМОГО ТЕКСТА — один переключатель на весь продукт.
    ///
    /// Владелец: «проверь ещё там размеры шрифтов, сами шрифты и
    /// форматирование, чтобы оно было похоже на чатгпт». Референс набран
    /// системным шрифтом, и это не мелочь оформления: SF — то, чем на айфоне
    /// набрано всё остальное, и текст в нём читается как текст системы, а не
    /// как чужая гарнитура в чужом приложении.
    ///
    /// Это МЕНЯЕТ ЛИЦО ПРОДУКТА, поэтому откат обязан быть одной строкой, а не
    /// раскопками: `.onest` возвращает прежний фирменный голос целиком, включая
    /// серифный курсив. Ничто в дереве не зовёт гарнитуры по имени мимо этого
    /// переключателя.
    ///
    /// Моноширинный НЕ переключается: код, пути и время остаются IBM Plex Mono
    /// в обоих вариантах — в референсе код тоже моноширинный, и это тот слой,
    /// где гарнитура несёт смысл (выравнивание, отличимость `l1I` и `0O`).
    enum ReadingFace { case system, onest }

    /// Системный. Прежний фирменный — `.onest`.
    ///
    /// `CC_FACE=onest|system` перебивает выбор на ОДИН запуск — тем же приёмом,
    /// что и `CC_THEME`. Заведено не для гибкости, а чтобы два варианта можно
    /// было снять одной сборкой и положить рядом: смена гарнитуры меняет лицо
    /// продукта целиком, и решать это надо по двум кадрам, а не по описанию.
    static let readingFace: ReadingFace = {
        switch ProcessInfo.processInfo.environment["CC_FACE"] {
        case "onest":  return .onest
        case "system": return .system
        default:       return .system
        }
    }()

    /// Интерлиньяж для SwiftUI из коэффициента лестницы.
    ///
    /// `.lineSpacing()` — это ДОБАВКА к собственной высоте строки гарнитуры, а
    /// не сам интерлиньяж, как `line-height` в CSS. Наивное `size * (lh - 1)`
    /// растягивало абзац почти в полтора раза против канона, и на телефоне
    /// ответ агента читался как стихи.
    ///
    /// Собственная высота строки зависит от ГАРНИТУРЫ, поэтому считается по
    /// той, которая сейчас выбрана: у Onest на 17 это ~21.8, у системной —
    /// ~20.3, и общая константа промахнулась бы на полтора пункта в каждой
    /// строке абзаца.
    static func leading(_ lh: CGFloat, _ size: CGFloat) -> CGFloat {
        let natural: CGFloat
        switch readingFace {
        case .system: natural = UIFont.systemFont(ofSize: size).lineHeight
        case .onest:  natural = UIFont(name: "Onest-Regular", size: size)?.lineHeight ?? size * 1.28
        }
        return max(0, size * lh - natural)
    }

    // MARK: - Объём
    //
    // Тени — зелёно-чернильные, никогда серые; цветного свечения не бывает.
    // В тёмной теме тень на почти чёрном не читается, поэтому каждая плавающая
    // поверхность несёт тень ВМЕСТЕ с `rim` — внутренней светлой кромкой. В
    // светлой теме `rim` прозрачен и ничего не стоит.

    struct Elevation {
        let color: Color
        let radius: CGFloat
        let y: CGFloat
    }

    static let shadowSm = Elevation(color: Color(ink: 0.05, black: 0.30), radius: 4, y: 2)
    static let shadow = Elevation(color: Color(ink: 0.07, black: 0.35), radius: 10, y: 6)
    /// Подписная «плавающая» тень: ею отделена карточка, у которой НЕТ границы.
    static let shadowLg = Elevation(color: Color(ink: 0.08, black: 0.40), radius: 24, y: 12)
    static let shadowXl = Elevation(color: Color(ink: 0.12, black: 0.50), radius: 36, y: 20)

    /// Внутренняя кромка тёмной темы. В светлой — полностью прозрачна.
    static let rim = Color(ink: 0.0, ivory: 0.10)
    /// Верхний блик той же кромки (в CSS это `inset 0 1px 0`).
    static let rimTop = Color(ink: 0.0, ivory: 0.20)

    static let scrim = Color(inkTint: 0x101F18, lightAlpha: 0.42, darkTint: 0x000000, darkAlpha: 0.62)

    // MARK: - Движение — 140 / 200 / 320 мс

    static let durFast: Double = 0.14
    static let dur: Double = 0.20
    static let durSlow: Double = 0.32
    static let easeFast = Animation.timingCurve(0.16, 1, 0.3, 1, duration: durFast)
    static let ease = Animation.timingCurve(0.16, 1, 0.3, 1, duration: dur)
    static let easeSlow = Animation.timingCurve(0.16, 1, 0.3, 1, duration: durSlow)
    /// Для всплывающего — мягче, чтобы оно садилось, а не щёлкало.
    static let easeSoft = Animation.timingCurve(0.22, 0.61, 0.36, 1, duration: dur)

    /// Пульс живого прогона. Это и есть «идёт» — не оттенок метки, а вот это.
    static let pulse = Animation.easeInOut(duration: 1).repeatForever(autoreverses: true)

}

// MARK: - Цвета состояния прогона

extension AttentionState {
    /// Семантика журнала: working — тон текста С ПУЛЬСОМ (не зелёный квадрат),
    /// needs_attention — ember, idle — нейтраль, error — красный. Это ЗАЛИВКИ;
    /// поверх них кладётся `pillInk`.
    var pillColor: Color {
        switch self {
        case .working: return Theme.live
        case .needs_attention: return Theme.attn
        case .idle: return Theme.chip
        case .error: return Theme.red
        case .unknown: return Theme.chip
        }
    }

    /// Чернила, берущие 4.5:1 на `pillColor`.
    var pillInk: Color {
        switch self {
        case .working: return Theme.onLive
        case .needs_attention: return Theme.onAttn
        case .idle, .unknown: return Theme.textMuted
        case .error: return Theme.textOnColor
        }
    }

    /// Пульсирует ли метка. «Идёт прогон» говорит движение, а не оттенок.
    var pulses: Bool { self == .working }

    var label: String {
        switch self {
        case .working: return "working"
        case .needs_attention: return "needs attention"
        case .idle: return "idle"
        case .error: return "error"
        case .unknown: return "unknown"
        }
    }
}

// MARK: - Цвета стадий и категорий
//
// Живут здесь, а не на энумах в CCRemoteKit, по той же причине, что и цвета
// `AttentionState`: слой протокола не должен импортировать SwiftUI, иначе он
// утащит дизайн-систему в пакет и перестанет собираться без UI-фреймворка.
// Зависимость всегда указывает UI → модель.

extension SessionStage {
    var color: Color {
        switch self {
        case .backlog: return Theme.stageBacklog
        case .planning: return Theme.stagePlanning
        case .in_progress: return Theme.stageInProgress
        case .testing: return Theme.stageTesting
        case .done: return Theme.stageDone
        }
    }
}

extension SessionCategory {
    var color: Color {
        switch self {
        case .rambling: return Theme.catRambling
        case .sync: return Theme.catSync
        case .ship: return Theme.catShip
        case .verify: return Theme.catVerify
        case .bugs: return Theme.catBugs
        case .mobile: return Theme.catMobile
        case .feature: return Theme.catFeature
        case .codex: return Theme.catCodex
        case .backlog: return Theme.catBacklog
        case .research: return Theme.catResearch
        case .webpage: return Theme.catWebpage
        case .text: return Theme.catText
        case .tz: return Theme.catTz
        }
    }
}

// MARK: - Динамические цвета
//
// Таблица токенов выше платформенно-свободна; только две строки, которые
// действительно строят системный цвет, — нет. UIKit разрешает динамический цвет
// против trait collection, поэтому ветка живёт здесь один раз, а не у каждого
// из сотни токенов.

extension Color {
    init(hex: UInt32) {
        self.init(.sRGB,
                  red: Double((hex >> 16) & 0xFF) / 255.0,
                  green: Double((hex >> 8) & 0xFF) / 255.0,
                  blue: Double(hex & 0xFF) / 255.0,
                  opacity: 1)
    }

    /// Цвет, который сам разрешается в `light` или `dark` по окружающему
    /// оформлению. Именно это делает весь `Theme` тема-зависимым, не трогая ни
    /// одного места вызова.
    init(light: UInt32, dark: UInt32) {
        self = dynamicColor { isDark in platformColor(hex: isDark ? dark : light) }
    }

    /// Полупрозрачные линии и затемнения: тёплые чернила на светлой, ivory на
    /// тёмной — пара `rgba(16,31,24,α)` / `rgba(250,247,234,α)` из веба.
    /// Никогда не чистый чёрный.
    init(ink lightAlpha: Double, ivory darkAlpha: Double) {
        self.init(inkTint: 0x101F18, lightAlpha: lightAlpha, darkTint: 0xFAF7EA, darkAlpha: darkAlpha)
    }

    /// Тень: тёплые чернила на светлой, чистый чёрный на тёмной — так тень
    /// ЕСТЬ на почти чёрном фоне, где чернильная была бы невидима.
    init(ink lightAlpha: Double, black darkAlpha: Double) {
        self.init(inkTint: 0x101F18, lightAlpha: lightAlpha, darkTint: 0x000000, darkAlpha: darkAlpha)
    }

    /// Общая форма: свой оттенок и своя прозрачность в каждой теме.
    init(inkTint: UInt32, lightAlpha: Double, darkTint: UInt32, darkAlpha: Double) {
        self = dynamicColor { isDark in
            isDark ? platformColor(hex: darkTint).withAlphaComponent(darkAlpha)
                   : platformColor(hex: inkTint).withAlphaComponent(lightAlpha)
        }
    }
}

typealias PlatformColor = UIColor

func platformColor(hex: UInt32) -> PlatformColor {
    UIColor(red: CGFloat((hex >> 16) & 0xFF) / 255.0,
            green: CGFloat((hex >> 8) & 0xFF) / 255.0,
            blue: CGFloat(hex & 0xFF) / 255.0,
            alpha: 1)
}

func dynamicColor(_ resolve: @escaping (_ isDark: Bool) -> PlatformColor) -> Color {
    Color(UIColor { trait in resolve(trait.userInterfaceStyle == .dark) })
}

// ============================================================================
// MARK: - Три голоса
//
//   Структура        Onest 400–600      интерфейс, заголовки, проза
//   Технический слой IBM Plex Mono      eyebrow, время, счётчики, пути, код
//   Человеческий     Source Serif 4 it  ровно два места: блок размышления
//                                       агента и цитата внутри его прозы
//
// Onest на данном весе читается ПЛОТНЕЕ Inter, поэтому каждый вес идёт на шаг
// вниз: 700→600, 600→500, кнопки на 500. Мэппинг ниже делает это сам, так что
// место вызова просит вес, который просится глазу, и получает верный.
//
// Два способа промахнуться, оба молчаливые:
//
//   1. Имя начертания. `Font.custom` принимает PostScript-имя, оно регулярно не
//      совпадает с именем файла, и на неизвестном имени функция не кидает и не
//      логирует — она отдаёт системный SF. Живой пример прямо здесь: файлы
//      IBMPlexMono-Medium.ttf / -SemiBold.ttf, а имена внутри них
//      `IBMPlexMono-Medm` и `IBMPlexMono-SmBld`. Проверяет `BundledFonts.audit()`
//      на каждом DEBUG-запуске.
//   2. Вес Onest. CoreText сложил все четыре начертания под ОДНО семейство
//      `Onest`, поэтому вес берётся именем начертания; `.weight()` поверх
//      семейства здесь не работает.
//
// Каждый размер идёт через `relativeTo:` — без него приложение глухо к Dynamic
// Type, и это долг, который дешевле закрыть один раз тут, чем в пяти фазах
// поверх.
// ============================================================================

extension Font {
    static var chatBody: Font {
        switch Theme.readingFace {
        case .system: return .system(.callout)
        case .onest: return .custom(OnestFace.name(for: .regular), size: Theme.sizeChatBody, relativeTo: .callout)
        }
    }

    /// Структура: интерфейс, заголовки, проза.
    ///
    /// Системный вариант идёт через СТУПЕНЬ Dynamic Type, а не через
    /// `.system(size:)`: последний фиксирован и глух к системному размеру
    /// текста, то есть заменил бы одну правку на регресс доступности по всему
    /// приложению. Ступени при этом почти совпадают с лестницей (`.body` — 17,
    /// `.callout` — 16, `.footnote` — 13, `.caption` — 12), так что кегли не
    /// уезжают.
    static func ui(_ size: CGFloat, weight: Font.Weight = .regular) -> Font {
        switch Theme.readingFace {
        case .system:
            return .system(textStyle(for: size), design: .default).weight(weight)
        case .onest:
            return .custom(OnestFace.name(for: weight), size: size, relativeTo: textStyle(for: size))
        }
    }

    /// Технический слой: eyebrow, время, счётчики, пути, код, терминал.
    static func mono(_ size: CGFloat, weight: Font.Weight = .regular) -> Font {
        .custom(PlexMonoFace.name(for: weight), size: size, relativeTo: textStyle(for: size))
    }

    /// Человеческий голос.
    ///
    /// При системном лице СЕРИФА НЕТ — он возвращает обычный текстовый шрифт.
    /// Это сознательная потеря «трёх голосов» из DESIGN.md: в референсе
    /// реплика человека отличается не гарнитурой, а ПЛАШКОЙ и стороной, а
    /// серифный курсив посреди системного текста читается цитатой из другой
    /// книги. Фирменный голос возвращается вместе с `readingFace = .onest`.
    static func serif(_ size: CGFloat) -> Font {
        switch Theme.readingFace {
        case .system: return ui(size)
        case .onest:  return .custom("SourceSerif4-It", size: size, relativeTo: textStyle(for: size))
        }
    }

    static func serifUpright(_ size: CGFloat) -> Font {
        switch Theme.readingFace {
        case .system: return ui(size)
        case .onest:  return .custom("SourceSerif4-Regular", size: size, relativeTo: textStyle(for: size))
        }
    }

    /// Ступень Dynamic Type, относительно которой масштабируется кегль.
    /// Без `relativeTo:` custom-шрифт вообще не реагирует на системный размер
    /// текста, и весь интерфейс остаётся фиксированным.
    static func textStyle(for size: CGFloat) -> Font.TextStyle {
        switch size {
        case 26...: return .largeTitle     // 28 — экранное число
        case 22..<26: return .title        // 24 — заголовок экрана
        case 19..<22: return .title2       // 20 — заголовок секции
        case 17.5..<19: return .title3     // 18 — h2 прозы
        case 15.5..<17.5: return .body     // 17 / 16 — карточка и тело
        case 14..<15.5: return .subheadline // 14.5 — строки, кнопки, чипы
        case 12.5..<14: return .footnote   // 13 — мета
        case 11..<12.5: return .caption    // 12 — eyebrow
        default: return .caption2          // 10 — глиф в боксе
        }
    }
}

/// Начертания Onest. Здесь же живёт правило «каждый вес на шаг вниз»: место
/// вызова просит тот вес, который просится глазу, и получает на ступень легче.
private enum OnestFace {
    static func name(for weight: Font.Weight) -> String {
        switch weight {
        case .black, .heavy, .bold: return "Onest-SemiBold"   // 700 → 600
        case .semibold, .medium: return "Onest-Medium"        // 600 → 500
        default: return "Onest-Regular"
        }
    }
}

/// Начертания IBM Plex Mono. Имена — те, что зарегистрировал CoreText, а не те,
/// что написаны на файлах: `-Medm` и `-SmBld` не опечатка.
private enum PlexMonoFace {
    static func name(for weight: Font.Weight) -> String {
        switch weight {
        case .black, .heavy, .bold, .semibold: return "IBMPlexMono-SmBld"
        case .medium: return "IBMPlexMono-Medm"
        default: return "IBMPlexMono"
        }
    }
}
