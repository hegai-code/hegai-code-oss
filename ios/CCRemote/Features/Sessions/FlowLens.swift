import SwiftUI
import CCRemoteKit

/// Flow — доска задач (= сессий) по СТАДИЯМ, вторая линза списка.
///
/// Доска, но читаемая сверху вниз: пять колонок, втиснутые в 307pt шторки, были
/// бы одной колонкой, притворяющейся доской. Стадия — заголовок группы, её
/// можно свернуть; карточки под ним.
///
/// **Перетаскивания здесь нет и быть не может.** В вебе карточку таскают мышью
/// (HTML5 drag не шлёт touch-событий вовсе), и там же написано, зачем у каждой
/// карточки ещё и меню: это ЕДИНСТВЕННЫЙ способ передвинуть её на телефоне.
/// Поэтому кнопка стадии здесь — видимый контрол с шевроном, а не долгое
/// нажатие: жест без аффорданса — это фича, о которой знает только автор, а
/// доска, на которой нечем двигать карточки, — это список.
///
/// Сессия попадает на доску, когда у неё есть сохранённая стадия, либо когда она
/// живая: живой прогон без стадии ПЛАВАЕТ в «В работе», чтобы идущая работа
/// никогда не была невидимой.
struct FlowLens: View {
    @Environment(CentralClient.self) private var client
    @Environment(Router.self) private var router

    /// Свёрнутые стадии принадлежат шторке и переживают смену линзы.
    @Binding var collapsed: Set<String>

    /// Открыто ли меню переноса хоть у одной карточки — наружу, хозяину
    /// шторки. Ему это нужно ровно для одного: увести плавающую «+ Чат»,
    /// которая стоит поверх нижнего края списка и накрывает последний пункт
    /// меню («Убрать с доски»). Видно на кадрах `flow-menu-*` фазы 4.
    @Binding var menuShown: Bool

    @State private var confirmDone: FlowItem?
    /// У какой карточки открыто меню переноса. Одно на линзу: два меню внахлёст
    /// читаются сломанной вёрсткой, а не двумя меню.
    ///
    /// Собственное состояние, а не системный `Menu`, — по двум причинам.
    /// Веб здесь тоже рисует свой попап со скримом, так что это паритет; и
    /// системное меню нельзя открыть ниоткуда, кроме пальца, — а кадр
    /// «доска с открытым меню переноса» обязан сниматься без тапа по
    /// координате (`CC_FLOW_MENU`, см. `LaunchAffordances`).
    @State private var menuFor: String? = LaunchAffordances.current.flowMenu ? "" : nil

    struct FlowItem: Identifiable {
        let id: String
        let item: SessionItem
        let stage: SessionStage
        /// На доске только по живости — сохранённой стадии ещё нет.
        let floating: Bool
        let committed: Bool
        let since: Double
    }

    let items: [FlowItem]

    var body: some View {
        let all = items
        // `CC_FLOW_MENU=1` просит открыть меню у ПЕРВОЙ карточки, какой бы она
        // ни оказалась: имя сессии во флоте меняется между прогонами, а кадр
        // приёмки должен сниматься одинаково через месяц.
        let openKey = menuFor == "" ? all.first?.id : menuFor
        if all.isEmpty {
            Text("Ни у одной сессии нет стадии, и ничего не запущено.")
                .font(.ui(Theme.sizeMeta)).foregroundStyle(Theme.textFaint)
                .padding(.horizontal, Theme.s3).padding(.vertical, Theme.s4)
        } else {
            ForEach(SessionStage.allCases) { stage in
                let inStage = all.filter { $0.stage == stage }
                if !inStage.isEmpty {
                    stageHead(stage, count: inStage.count)
                    if !collapsed.contains(stage.rawValue) {
                        ForEach(inStage) { card($0, menuOpen: $0.id == openKey) }
                    }
                }
            }
        }
        // Диалог — на самой линзе, а не на карточке: карточка может уехать из
        // группы ровно тем действием, которое он подтверждает.
        Color.clear.frame(height: 0)
            .confirmationDialog(confirmDone.map { "Перенести «\(title(of: $0))» в Готово?" } ?? "",
                                isPresented: Binding(get: { confirmDone != nil },
                                                     set: { if !$0 { confirmDone = nil } }),
                                titleVisibility: .visible) {
                if let it = confirmDone {
                    Button("Готово и завершить", role: .destructive) {
                        client.setStage(machineId: it.item.machineId,
                                        sessionId: it.item.session.sessionId, stage: "done")
                        client.endSession(machineId: it.item.machineId,
                                          sessionId: it.item.session.sessionId)
                        Haptics.success()
                    }
                    Button("Отмена", role: .cancel) {}
                }
            } message: {
                Text("Сессия будет закрыта — для внешней VSCode-сессии это принудительное завершение.")
            }
            // Один факт наружу, и считается он ОТ `openKey`, а не от `menuFor`:
            // `CC_FLOW_MENU` открывает меню у первой карточки пустой строкой,
            // и хозяин шторки обязан увидеть это так же, как палец.
            .onChange(of: openKey != nil, initial: true) { _, open in menuShown = open }
            // Линза уходит (сменили лензу, начали искать, закрыли шторку) —
            // вместе с ней уходит и её меню.
            .onDisappear { menuShown = false }
    }

    private func title(of it: FlowItem) -> String {
        it.item.session.title.isEmpty ? String(it.item.session.sessionId.prefix(8))
                                      : it.item.session.title
    }

    private func stageHead(_ stage: SessionStage, count: Int) -> some View {
        Button {
            if collapsed.contains(stage.rawValue) { collapsed.remove(stage.rawValue) }
            else { collapsed.insert(stage.rawValue) }
            Haptics.light()
        } label: {
            HStack(spacing: Theme.s2) {
                Image(systemName: collapsed.contains(stage.rawValue) ? "chevron.right" : "chevron.down")
                    .font(.system(size: 9, weight: .semibold))  // бокс глифа
                    .foregroundStyle(Theme.textFaint).frame(width: 12)
                RoundedRectangle(cornerRadius: Theme.statusDotRadius, style: .continuous)
                    .fill(stage.color).frame(width: Theme.statusDot, height: Theme.statusDot)
                Text(stage.label.uppercased())
                    .font(.mono(Theme.sizeMicro, weight: .medium))
                    .tracking(Theme.track(Theme.lsCaps, Theme.sizeMicro))
                    .foregroundStyle(Theme.textFaint)
                Text("\(count)").font(.mono(Theme.sizeMicro)).foregroundStyle(Theme.textFaint)
                Spacer()
            }
            .padding(.horizontal, Theme.s2)
            .frame(height: 32)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func card(_ it: FlowItem, menuOpen: Bool) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            SessionRow(item: it.item, showServer: true, showProject: true)

            HStack(spacing: Theme.s2) {
                stageButton(it, open: menuOpen)
                if it.floating {
                    Text("живой ран без стадии").font(.mono(Theme.sizeMicro)).foregroundStyle(Theme.textFaint)
                        .lineLimit(1)
                }
                Spacer(minLength: 0)
                if it.committed && it.stage != .done {
                    Button { confirmDone = it } label: {
                        Text("коммит прошёл — закрыть")
                            .font(.mono(Theme.sizeMicro)).foregroundStyle(Theme.onAction)
                            .padding(.horizontal, Theme.s2)
                            .frame(height: 22)
                            // Кнопка — прямоугольник радиусом 12: пилюля
                            // лицензирована тегам, бейджам и активным
                            // фильтр-чипам, а это действие.
                            .background(Theme.action,
                                        in: RoundedRectangle(cornerRadius: Theme.radiusMd,
                                                             style: .continuous))
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, Theme.s3)
            .padding(.bottom, Theme.s2)

            if menuOpen { stageMenu(it) }
        }
        .card(radius: Theme.radiusMd)
        .overlay(alignment: .leading) {
            Rectangle().fill(it.stage.color).frame(width: 3)
                .clipShape(RoundedRectangle(cornerRadius: Theme.statusDotRadius))
                .padding(.vertical, Theme.s2)
        }
    }

    /// Кнопка стадии — единственный способ передвинуть карточку. Видимый
    /// контрол с шевроном, а не долгое нажатие.
    private func stageButton(_ it: FlowItem, open: Bool) -> some View {
        Button {
            menuFor = open ? nil : it.id
            Haptics.light()
        } label: {
            HStack(spacing: 4) {
                Text(it.stage.label).font(.mono(Theme.sizeMicro)).foregroundStyle(Theme.textMuted)
                Image(systemName: open ? "chevron.up" : "chevron.down")
                    .font(.system(size: 7, weight: .semibold)).foregroundStyle(Theme.textFaint)  // бокс глифа
            }
            .padding(.horizontal, Theme.s2)
            .frame(height: 22)
            .background(open ? Theme.surfaceHover : Theme.chip, in: Capsule())  // пилюля: фильтр-чип
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("flow.stage.\(it.id)")
        .accessibilityLabel("Перенести в другую стадию, сейчас: \(it.stage.label)")
    }

    /// Само меню переноса — строки стадий ВНУТРИ карточки, а не системный
    /// попап. Внутри, потому что шторка узкая и трансформированная: системное
    /// меню здесь всплывает поверх уехавшей карточки приложения, а не рядом с
    /// кнопкой, которую нажали.
    private func stageMenu(_ it: FlowItem) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(SessionStage.allCases) { target in
                let current = target == it.stage && !it.floating
                Button {
                    menuFor = nil
                    move(it, to: target)
                } label: {
                    HStack(spacing: Theme.s2) {
                        RoundedRectangle(cornerRadius: Theme.statusDotRadius, style: .continuous)
                            .fill(target.color)
                            .frame(width: Theme.statusDot, height: Theme.statusDot)
                        Text(target.label)
                            .font(.ui(Theme.sizeMeta, weight: current ? .semibold : .regular))
                            .foregroundStyle(Theme.text)
                        Spacer(minLength: 0)
                        if current {
                            Image(systemName: "checkmark")
                                .font(.system(size: 10, weight: .semibold))  // бокс глифа
                                .foregroundStyle(Theme.textFaint)
                        }
                    }
                    .padding(.horizontal, Theme.s3)
                    .frame(height: 36)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
            Divider().overlay(Theme.divider)
            Button {
                menuFor = nil
                client.setStage(machineId: it.item.machineId,
                                sessionId: it.item.session.sessionId, stage: nil)
                Haptics.light()
            } label: {
                HStack(spacing: Theme.s2) {
                    Image(systemName: "minus.circle").font(.system(size: 11))  // бокс глифа
                        .foregroundStyle(Theme.negative)
                    Text("Убрать с доски").font(.ui(Theme.sizeMeta)).foregroundStyle(Theme.negative)
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, Theme.s3)
                .frame(height: 36)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        }
        .padding(.vertical, Theme.s1)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.surfaceRaised)
        .overlay(alignment: .top) { Divider().overlay(Theme.divider) }
        .accessibilityIdentifier("flow.menu")
    }

    private func move(_ it: FlowItem, to stage: SessionStage) {
        guard stage != it.stage || it.floating else { return }
        // «Готово» закрывает сессию, а закрытие внешней VSCode-сессии —
        // принудительное завершение. Такое не делают одним тапом по меню.
        if stage == .done { confirmDone = it; return }
        client.setStage(machineId: it.item.machineId,
                        sessionId: it.item.session.sessionId, stage: stage.rawValue)
        Haptics.light()
    }
}
