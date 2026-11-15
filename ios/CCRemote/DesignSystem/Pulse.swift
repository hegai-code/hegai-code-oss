import SwiftUI

// Пульс «идёт работа» и секундные часы — только пока на них есть кому смотреть.
//
// `Animation.repeatForever` и `TimelineView(.periodic)` сами не знают ни про сцену, ни про
// Low Power Mode: пока метка смонтирована, они крутятся. А смонтированы они в чате долго
// (транскрипт — один VStack, не ленивый список), поэтому пульс и часы жили всю сессию
// экрана. Здесь они включаются, только когда: метка на экране (появилась и, на iOS 18+, в
// видимой части прокрутки), сцена активна, нет Low Power Mode и «Уменьшения движения».
// Иначе метка стоит неподвижно, часы показывают последнее значение и не тикают.

/// Low Power Mode как наблюдаемое значение: view, прочитавший `lowPower` в body,
/// перестроится, когда пользователь включит или выключит режим.
@MainActor @Observable
final class PowerState {
    static let shared = PowerState()
    private(set) var lowPower = ProcessInfo.processInfo.isLowPowerModeEnabled

    private init() {
        NotificationCenter.default.addObserver(forName: .NSProcessInfoPowerStateDidChange, object: nil,
                                               queue: .main) { _ in
            MainActor.assumeIsolated { PowerState.shared.lowPower = ProcessInfo.processInfo.isLowPowerModeEnabled }
        }
    }
}

extension View {
    /// Пульс непрозрачности для метки «идёт»: `active` — смысл («работает»), остальные
    /// условия — когда пульс вообще стоит крутить (см. шапку файла). Выключенный пульс
    /// оставляет метку в полной непрозрачности, как неактивную.
    func livePulse(_ active: Bool = true, low: Double = 0.35, animation: Animation = Theme.pulse) -> some View {
        modifier(LivePulse(active: active, low: low, animation: animation))
    }
}

private struct LivePulse: ViewModifier {
    let active: Bool
    let low: Double
    let animation: Animation
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// Метка смонтирована и не ушла за край прокрутки.
    @State private var onScreen = true
    @State private var dim = false

    private var running: Bool {
        active && onScreen && scenePhase == .active && !reduceMotion && !PowerState.shared.lowPower
    }

    func body(content: Content) -> some View {
        tracked(content
            .opacity(running && dim ? low : 1)
            .animation(running ? animation : nil, value: dim))
            .onAppear { onScreen = true }
            .onDisappear { onScreen = false }
            .onChange(of: running, initial: true) { _, on in dim = on }
    }

    /// iOS 18+: настоящая видимость в прокрутке. Раньше onAppear/onDisappear знали только
    /// «смонтирована ли», а транскрипт держит смонтированными все строки окна.
    @ViewBuilder private func tracked(_ view: some View) -> some View {
        if #available(iOS 18.0, *) {
            view.onScrollVisibilityChange(threshold: 0.01) { onScreen = $0 }
        } else {
            view
        }
    }
}

/// Секундные часы: `TimelineView(.periodic(from: .now, by: 1))`, пока экран виден и сцена
/// активна; иначе одно статичное значение. Содержимое получает `Date`.
struct SecondClock<Content: View>: View {
    private let content: (Date) -> Content
    @Environment(\.scenePhase) private var scenePhase
    @State private var visible = true

    init(@ViewBuilder content: @escaping (Date) -> Content) {
        self.content = content
    }

    var body: some View {
        Group {
            if visible && scenePhase == .active {
                TimelineView(.periodic(from: .now, by: 1)) { tick in content(tick.date) }
            } else {
                content(Date())
            }
        }
        .onAppear { visible = true }
        .onDisappear { visible = false }
    }
}
