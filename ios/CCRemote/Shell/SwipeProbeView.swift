import SwiftUI

#if DEBUG
/// Стенд для одного правила: **жест шторки не крадётся у того, что само едет
/// вбок**.
///
/// Правило нельзя доказать юнит-тестом до конца. Тест проверяет арифметику
/// (`ShellSwipe.isSwipe`) и попадание точки в прямоугольник
/// (`SwipeGuard.blocks`) — но не то, что прямоугольник вообще зарегистрировался,
/// что координаты в одной системе и что `simultaneousGesture` не отобрал тягу у
/// прокрутки. Это проверяется только настоящим пальцем по настоящему экрану.
///
/// А для настоящего пальца нужен ДЕТЕРМИНИРОВАННЫЙ экран. Искать в проде сессию
/// с достаточно широким код-блоком — значит поставить приёмку фазы в зависимость
/// от чужого транскрипта, который завтра другой. Поэтому стенд: `CC_SCREEN=
/// swipe-probe`, две мишени в известных местах, и подпись, что должно
/// произойти на каждой.
///
/// DEBUG-only, как `GalleryView` и `HarnessSignals`: в собранном приложении этого
/// экрана нет.
struct SwipeProbeView: View {
    @Environment(Router.self) private var router

    /// Достаточно широкая строка, чтобы блок ехал вбок на любой из четырёх
    /// ширин, включая 430pt.
    private let wide = "const drawerWidth = min(geo.size.width * 0.82, 320); // 82vw, capped at 320 — the same number the web spells as --drawer-w, and the card is narrower than the drawer so a real sliver stays"

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.s5) {
            VStack(alignment: .leading, spacing: Theme.s2) {
                SectionLabel(text: "Мишень 1 — код-блок")
                Text("Свайп вправо ПО ЭТОМУ блоку должен ехать по коду и НЕ открывать шторку.")
                    .font(.ui(Theme.sizeSmall)).foregroundStyle(Theme.textMuted)
                CodeBlock(text: wide)
                    .accessibilityIdentifier("probe.code")
            }

            // Второй код-блок — ДРУГОЙ. Тот, что выше, — `CodeBlock` служебных
            // строк; этот приезжает из markdown внутри прозы агента, а это на
            // телефоне самый частый код, который вообще видят. До фазы 3 он не
            // ехал вбок вовсе (MarkdownUI обрезал длинную строку молча), и
            // чинится это в другом месте — значит, и проверяться должно
            // отдельно, иначе зелёная мишень 1 продолжит отвечать за мишень,
            // которой её не проверяли.
            VStack(alignment: .leading, spacing: Theme.s2) {
                SectionLabel(text: "Мишень 2 — код внутри прозы")
                Text("То же самое, но блок пришёл из markdown ответа агента.")
                    .font(.ui(Theme.sizeSmall)).foregroundStyle(Theme.textMuted)
                MarkdownText(text: "```swift\n\(wide)\n```")
                    .accessibilityIdentifier("probe.mdcode")
            }

            VStack(alignment: .leading, spacing: Theme.s2) {
                SectionLabel(text: "Мишень 3 — обычное полотно")
                Text("Свайп вправо ЗДЕСЬ, рядом с блоком, должен открыть шторку.")
                    .font(.ui(Theme.sizeSmall)).foregroundStyle(Theme.textMuted)
                RoundedRectangle(cornerRadius: Theme.radiusLg, style: .continuous)
                    .fill(Theme.surfaceSunken)
                    .frame(height: 96)
                    .overlay(
                        Text("полотно")
                            .font(.mono(Theme.sizeMicro)).foregroundStyle(Theme.textFaint)
                    )
                    .accessibilityIdentifier("probe.canvas")
            }

            // Состояние — и словами на экране, и как accessibility-значение,
            // потому что читают его двое: человек на скриншоте и UI-тест,
            // который водит по этому стенду настоящим касанием.
            Text("Шторка \(router.isDrawerOpen ? "ОТКРЫТА" : "закрыта")")
                .font(.mono(Theme.sizeMeta, weight: .medium))
                .foregroundStyle(router.isDrawerOpen ? Theme.text : Theme.textMuted)
                .accessibilityIdentifier("probe.state")
                .accessibilityValue(router.isDrawerOpen ? "open" : "closed")

            Spacer()
        }
        .padding(Theme.s4)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(Theme.bg)
        .navigationTitle("Свайп: стенд")
        .inlineTitle()
        .toolbar {
            bareToolbarItem { DrawerButton() }
        }
    }
}
#endif
