import SwiftUI
import CCRemoteKit

/// Одна страница и одна шторка.
///
/// Здесь был `TabView` с четырьмя вкладками. Нижнего меню больше нет — не
/// потому, что оно некрасиво, а потому что веб эту модель уже прошёл и выбросил
/// по опыту: три из четырёх вкладок были списком сессий по разной оси, а
/// четвёртая («Ещё») существовала затем, чтобы вместить то, что не влезло в
/// первые три. DESIGN.md, «Навигация»: «На телефоне рельсы нет и нижнего
/// таб-бара тоже: одна страница и одна шторка».
///
/// Что получилось из этого геометрически: приложение — это КАРТОЧКА, и шторка
/// не наезжает на неё, а отодвигает. Так делает референс (iOS-шторка ChatGPT), и
/// именно поэтому это читается шторкой: видно то, что ты оставил, целиком и в
/// одном тапе, а не экран за туманом.
struct AppShell: View {
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(Router.self) private var router
    @Environment(CentralClient.self) private var client

    /// Регистр коробок, которые едут вбок сами (см. `ShellSwipe.swift`). Живёт
    /// здесь, а не в приложении: он про ЭТОТ жест и умирает вместе с шелом.
    @State private var swipeGuard = SwipeGuard()
    @State private var drawerModel = DrawerModel()

    /// Сырое смещение пальца в текущей тяге. Ноль — пальца на стекле нет.
    @State private var drag: CGFloat = 0
    /// Палец СЕЙЧАС на стекле. Отдельно от `drag != 0`, потому что тяга может
    /// вернуться ровно в ноль, не кончившись, — и в этот кадр анимацию включать
    /// нельзя: она догоняла бы палец вместо того, чтобы идти за ним.
    @State private var dragging = false

    var body: some View {
        GeometryReader { geo in
            // The supplied reference leaves about one quarter of the page visible.
            let width = min(geo.size.width * 0.82, 360)
            // Насколько шторка открыта ПРЯМО СЕЙЧАС, в точках. Одно число на
            // всю геометрию: положение карточки, плотность скрима и
            // положение самой шторки — всё считается отсюда, поэтому они не
            // могут разъехаться.
            let shown = min(max((router.isDrawerOpen ? width : 0) + drag, 0), width)
            // Оно же долей — 0 закрыто, 1 открыто.
            let t = width > 0 ? shown / width : 0

            ZStack(alignment: .leading) {
                // Background revealed as the page slides aside.
                (t > 0 ? Theme.drawerBackground : pageCanvas).ignoresSafeArea()

                // Трансформ — на самой карточке контента, и это не стилистика.
                // Если повесить его на общего предка, вместе с карточкой
                // уменьшится и уедет шторка — то есть эффект сломает ровно то,
                // что украшает. В вебе та же ловушка звучит иначе («transform на
                // предке заставил бы position: fixed шторки считаться от него»),
                // но это одна и та же ошибка.
                card(shown: shown, t: t, geometry: geo)

                if t > 0 {
                    // Transparent hit surface closes the drawer. Dimming belongs
                    // inside the page mask so the rounded corners remain visible.
                    Color.clear
                        .ignoresSafeArea()
                        .contentShape(Rectangle())
                        .onTapGesture { close() }
                }

                // Шторка СМОНТИРОВАНА ВСЕГДА и просто стоит за левым краем.
                //
                // Раньше она монтировалась в момент открытия, и её присутствие
                // было состоянием. Красиво, но платил за это палец: первый кадр
                // жеста уходил на постройку списка, и шторка появлялась уже
                // догоняющей. За кадр она построиться не успевает и не должна —
                // строить её надо было заранее.
                //
                // LazyVStack limits row creation to the scroll viewport. Its
                // horizontal offset does not guarantee zero offscreen work.
                SessionDrawer(width: width, visible: t > 0)
                    .equatable()
                    .offset(x: shown - width)
                    .shellDrag(onChange: { track($0) },
                               onEnd: { settle(dx: $0, velocity: $1) })
                    // Пока шторка за краем, она не только не нажимается, но и
                    // не существует для VoiceOver и для XCUITest: её наличие
                    // по-прежнему ОТВЕЧАЕТ на вопрос «открыта ли» (см.
                    // `ShellGestureUITests`), и ответ обязан остаться честным
                    // после того, как сам вид перестал появляться и исчезать.
                    .allowsHitTesting(t > 0)
                    .accessibilityHidden(t <= 0)
            }
            // Пока палец на стекле — БЕЗ анимации: анимировать то, что и так
            // едет за пальцем, значит вставить между ними задержку. Как только
            // отпустили — обычная кривая шелла, и она же обслуживает открытие
            // кнопкой ☰ и любым другим вызовом роутера.
            .animation(dragging || reduceMotion ? nil : Theme.ease, value: shown)
        }
        .environment(swipeGuard)
        .environment(drawerModel)
        .onChange(of: router.isDrawerOpen) { _, open in
            if open { dismissComposerKeyboard() }
        }
        .onChange(of: readingSessionKey, initial: true) { _, key in
            client.setVisibleSession(key)
        }
        .onChange(of: client.storageScope) { _, _ in
            client.setVisibleSession(readingSessionKey)
        }
        .onDisappear {
            client.setVisibleSession(nil)
        }
    }

    private var readingSessionKey: String? {
        guard scenePhase == .active, !router.isDrawerOpen, !dragging else { return nil }
        if case .newRun = router.path.last, let active = client.active, !active.sessionId.isEmpty {
            return "\(active.machineId)::\(active.sessionId)"
        }
        return router.currentSession?.id
    }

    private var pageCanvas: Color {
        if case .screen(.settings) = router.path.last { return Theme.settingsBackground }
        return Theme.bg
    }

    // MARK: - Карточка приложения

    private func card(shown: CGFloat, t: CGFloat, geometry: GeometryProxy) -> some View {
        ShellNavigation()
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(pageCanvas)
        // Off-chat screens keep a solid canvas strip under the clock. A chat
        // fades its own top edge instead (ChatGPT-style, `chatEdgeFade`),
        // so the transcript dims under the clock rather than being cut off.
        .overlay(alignment: .top) {
            if router.path.last?.fadesOwnTopEdge != true {
                pageCanvas.frame(height: geometry.safeAreaInsets.top)
                    .offset(y: -geometry.safeAreaInsets.top)
                    .allowsHitTesting(false)
            }
        }
        .overlay { Theme.scrim.opacity(0.42 * t).ignoresSafeArea().allowsHitTesting(false) }
        // One explicit full-screen path for content, dimming, shadow and rim.
        // The safe-area content frame alone puts the rounded corner above the
        // visible screen; an unmasked global scrim then looks rectangular.
        .mask { pageShape(progress: t).fill(.white)
                .padding(.top, -geometry.safeAreaInsets.top).padding(.bottom, -geometry.safeAreaInsets.bottom) }
        .background {
            pageShape(progress: t).fill(pageCanvas)
                .padding(.top, -geometry.safeAreaInsets.top).padding(.bottom, -geometry.safeAreaInsets.bottom)
                .shadow(color: Theme.shadowXl.color.opacity(t), radius: Theme.shadowXl.radius, y: Theme.shadowXl.y)
        }
        .overlay {
            pageShape(progress: t).strokeBorder(Theme.rim.opacity(t), lineWidth: 1)
                .padding(.top, -geometry.safeAreaInsets.top).padding(.bottom, -geometry.safeAreaInsets.bottom)
                .allowsHitTesting(false)
        }
        // Slide the page at its original scale, matching the reference.
        .offset(x: shown)
        // Тяга вправо где угодно по карточке. Направление, не кромка: левую
        // кромку iOS забрал под системный «назад».
        .shellDrag(onChange: { track($0) },
                   onEnd: { settle(dx: $0, velocity: $1) })
    }

    private func pageShape(progress: CGFloat) -> RoundedRectangle {
        RoundedRectangle(cornerRadius: Theme.radiusDevice * progress, style: .continuous)
    }

    // MARK: - Тяга

    private func dismissComposerKeyboard() {
        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder),
                                        to: nil, from: nil, for: nil)
    }

    private func track(_ dx: CGFloat) {
        if !dragging, !router.isDrawerOpen, dx > 0 { dismissComposerKeyboard() }
        // A drag sample is an immediate position, even if a descendant or an
        // interrupted settling animation supplied an animated transaction.
        var transaction = Transaction(animation: nil)
        transaction.disablesAnimations = true
        withTransaction(transaction) {
            dragging = true
            drag = dx
        }
    }

    /// Палец отпущен — встать в одно из двух положений.
    ///
    /// Само решение живёт в `ShellSwipe.settle` и проверяется тестом: здесь
    /// остаётся только применить его к состоянию и не забыть обнулить тягу.
    /// Обнуляется она ВСЕГДА, в том числе когда положение не изменилось, —
    /// иначе шторка, доведённая до середины и отпущенная, там бы и осталась.
    private func settle(dx: CGFloat, velocity: CGFloat) {
        let wasOpen = router.isDrawerOpen
        let target = ShellSwipe.settle(dx: dx, velocity: velocity, wasOpen: wasOpen)
        withAnimation(reduceMotion ? nil : Theme.ease) {
            dragging = false
            drag = 0
            if target != wasOpen {
                target ? router.openDrawer() : router.closeDrawer()
            }
        }
        if target != wasOpen { Haptics.light() }
    }

    private func close() {
        withAnimation(reduceMotion ? nil : Theme.ease) {
            drag = 0
            dragging = false
            router.closeDrawer()
        }
        Haptics.light()
    }
}

/// Drawer geometry must not recreate the navigation content on every drag tick.
private struct ShellNavigation: View {
    @Environment(Router.self) private var router

    var body: some View {
        NavigationStack(path: Binding(get: { router.path }, set: { router.path = $0 })) {
            StartScreen().shellRoutes()
        }
    }
}

/// Куда ведёт стек шелла. Один набор пунктов назначения на одно приложение —
/// раньше их было три копии, по одной на вкладку.
private struct ShellRoutes: ViewModifier {
    func body(content: Content) -> some View {
        content
            .navigationDestination(for: ShellRoute.self) { route in
                // Сессия и её предшественник «новый ран» — единственные экраны
                // БЕЗ «назад»: из разговора выходят шторкой. Остальные вытолкнутые
                // экраны (Проекты, Команда, Настройки, Уведомления) — это места,
                // куда зашли и откуда возвращаются, и кнопка там остаётся.
                let wantsBack: Bool = {
                    switch route {
                    case .session, .newRun: return false
                    default: return true
                    }
                }()
                Group {
                    switch route {
                    case let .project(p):
                        ProjectSessionsView(project: p.project)
                    case let .session(s):
                        SessionDetailView(machineId: s.machineId, sessionId: s.sessionId)
                    case let .newRun(r):
                        NewRunView(label: r.label, machineName: r.machineName, source: r.source, projectName: r.projectName)
                    case .screen(.team):
                        TeamView()
                    case .screen(.notifications):
                        NotificationCenterView()
                    case .screen(.settings):
                        SettingsTabsView()
                    #if DEBUG
                    case .screen(.swipeProbe):
                        SwipeProbeView()
                    #endif
                    }
                }
                .pushedScreen(back: wantsBack)
            }
    }
}

/// Квадратная кнопка «назад» вместо системной.
///
/// С iOS 26 панель кладёт свою кнопку в стеклянную КАПСУЛУ, и в левом верхнем
/// углу каждого вытолкнутого экрана оказывался белый КРУГ — самый заметный
/// круг в системе, где кругов не бывает вовсе. `UIBarButtonItemAppearance`
/// (`NavigationChrome`) с ним не справился: капсулу рисует не фон элемента.
///
/// Жест возврата свайпом при этом ОБЯЗАН выжить — на телефоне им возвращаются
/// чаще, чем кнопкой. Его проверяет `ShellGestureUITests
/// .testSwipeBackStillPopsWithACustomBackButton` настоящим касанием: прятать
/// системную кнопку — исторически и есть тот способ, которым этот жест теряют.
struct BackButton: View {
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        Button {
            dismiss()
            Haptics.light()
        } label: {
            Image(systemName: "chevron.left")
                .font(.system(size: 17, weight: .semibold))  // бокс глифа
                .foregroundStyle(Theme.text)
                .frame(width: Theme.tapTarget, height: Theme.tapTarget)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("shell.back")
        .accessibilityLabel("Назад")
    }
}

/// Общая обвязка ВЫТОЛКНУТОГО экрана: своя кнопка «назад» вместо системной —
/// и возвращённый следом жест возврата, который вместе с ней теряется.
///
/// `back: false` — экран, из которого выходят НЕ назад. Такой ровно один род:
/// сессия. Владелец: «кнопку назад на хуй убрать у сессий» — выход через
/// шторку, как в ChatGPT, где из разговора тоже не возвращаются, а
/// переключаются.
///
/// Вместе с кнопкой у такого экрана снят и `PopGestureKeeper`, и это не
/// небрежность, а то, ради чего всё: жест возврата от кромки и жест открытия
/// шторки — оба тяга ВПРАВО, и левая кромка до сих пор была занята первым (см.
/// `ShellSwipe`: «левую кромку iOS забрал под системный назад»). Сняв возврат,
/// мы отдаём шторке весь экран целиком, включая кромку, — то есть в сессии
/// любая тяга вправо делает одно и то же. Два разных исхода у одного движения,
/// зависящих от того, на сколько точек от края лёг палец, — это и есть то, что
/// на телефоне читается как «приложение живёт своей жизнью».
private struct PushedScreen: ViewModifier {
    var back: Bool = true

    func body(content: Content) -> some View {
        content
            .navigationBarBackButtonHidden(true)
            .toolbar {
                if back { bareToolbarItem(placement: .leadingActions) { BackButton() } }
            }
            .background(back ? PopGestureKeeper().frame(width: 0, height: 0) : nil)
    }
}

/// Возвращает жест «назад от кромки», который `navigationBarBackButtonHidden`
/// забирает вместе с кнопкой.
///
/// Это не предположение: зонд фазы 5 снял обе стороны настоящим касанием — с
/// системной кнопкой свайп от кромки возвращает назад, без неё перестаёт.
/// `UINavigationController` вешает `interactivePopGestureRecognizer` на себя и
/// отключает его, когда кнопки нет; делегат, отвечающий «можно, если в стеке
/// больше одного экрана», включает его обратно, не разрешая тянуть с корня
/// (свайп на корне оставлял бы стек в подвешенном состоянии).
///
/// Дырка в SwiftUI, поэтому UIKit: у `NavigationStack` нет способа сказать это
/// декларативно, а ходить вверх по `parent` за навигационным контроллером —
/// единственный доступный путь. Вид нулевого размера, ничего не рисует.
private struct PopGestureKeeper: UIViewControllerRepresentable {
    func makeUIViewController(context: Context) -> Keeper { Keeper() }
    func updateUIViewController(_ controller: Keeper, context: Context) { controller.claim() }

    final class Keeper: UIViewController, UIGestureRecognizerDelegate {
        override func didMove(toParent parent: UIViewController?) {
            super.didMove(toParent: parent)
            claim()
        }

        /// Делегат слабый, а экранов на стеке бывает несколько — поэтому не
        /// «поставили один раз», а «забираем себе каждый раз, когда этот экран
        /// снова оказался наверху».
        func claim() {
            navigationController?.interactivePopGestureRecognizer?.delegate = self
        }

        func gestureRecognizerShouldBegin(_ recognizer: UIGestureRecognizer) -> Bool {
            (navigationController?.viewControllers.count ?? 0) > 1
        }

        /// Жест кромки и прокрутка содержимого не воюют: вертикальная тяга
        /// остаётся прокруткой, горизонтальная от кромки — возвратом.
        func gestureRecognizer(_ recognizer: UIGestureRecognizer,
                               shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool {
            false
        }
    }
}

extension View {
    func shellRoutes() -> some View { modifier(ShellRoutes()) }

    /// Ставится на каждый экран, который лёг на стек, — включая те, что толкают
    /// свои собственные `navigationDestination` (деталь заметки в «Памяти»).
    func pushedScreen(back: Bool = true) -> some View { modifier(PushedScreen(back: back)) }
}

/// Новый разговор без промежуточного открытия шторки.
struct NewChatButton: View {
    /// The open session's project: «Новый чат» from inside a session starts in
    /// the SAME project (web 269c2fe/d6d2646), not in whichever one the start
    /// screen would pick as most recent. Nil when that folder cannot take a
    /// new run (unknown, «Без проекта», no access, machine offline).
    var target: ProjectTarget? = nil
    @Environment(Router.self) private var router

    var body: some View {
        Button {
            if let target { router.newChat(in: target) } else { router.newChat() }
            Haptics.light()
        } label: {
            Image(systemName: "square.and.pencil")
                .font(.system(size: 17, weight: .medium)) // Match the drawer glyph.
                .foregroundStyle(Theme.textMuted)
                .frame(width: Theme.tapTarget, height: Theme.tapTarget)
                .headerIsland()
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Новый чат")
        .accessibilityIdentifier("header.newChat")
    }
}

/// Кнопка ☰ — вход в шторку. Одна на приложение, чтобы «где список сессий»
/// отвечалось одинаково с корня и из открытой сессии.
struct DrawerButton: View {
    @Environment(Router.self) private var router
    @Environment(CentralClient.self) private var client
    @Environment(DrawerModel.self) private var model

    private var indicator: DrawerModel.Indicator? {
        model.corpus.indicator(unreadDecisions: client.completionReads.unreadDecisions,
                               unreadCompletions: client.completionReads.unread)
    }
    private var indicatorLabel: String {
        switch indicator {
        case .attention: return "Есть непросмотренный запрос решения"
        case .completed: return "Есть завершённые сессии с непрочитанным ответом"
        case nil: return ""
        }
    }

    var body: some View {
        Button {
            router.openDrawer()
            Haptics.light()
        } label: {
            Image(systemName: "line.3.horizontal")
                .font(.system(size: 17, weight: .medium))  // бокс глифа
                .foregroundStyle(Theme.textMuted)
                .frame(width: Theme.tapTarget, height: Theme.tapTarget)
                .headerIsland()
                .overlay(alignment: .topTrailing) {
                    if let indicator {
                        Circle().fill(indicator == .attention ? Theme.drawerBlue : Theme.drawerCompleted)
                            .frame(width: 6, height: 6)
                            .padding(5)
                            .allowsHitTesting(false)
                            .accessibilityHidden(true)
                    }
                }
                // Extend the 56pt hit target toward the screen edge. Reserve
                // 44pt in the toolbar so the extra area does not crowd the title.
                .frame(width: 56, height: Theme.tapTarget, alignment: .trailing)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Сессии")
        .accessibilityValue(indicatorLabel)
        .frame(width: Theme.tapTarget, alignment: .trailing)
        .offset(x: -6)
    }
}
