import SwiftUI
import CCRemoteKit

/// Полка проектов — ГДЕ будет работа.
///
/// Карточка на машину, а не плоский список. Две вещи чинятся этим сразу. Плоский
/// список по свежести кладёт в хвост проекты, которых не касались семь месяцев,
/// — это не пускатель, это архив. И плоский список отвечает на вопрос «где это
/// запустится» повторяющейся колонкой вместо заголовка.
///
/// Поэтому: только свежая работа (`ProjectShelf.recencyWindow`), сгруппированная
/// под коробкой, на которой она идёт, по нескольку на коробку. Всё, что старше
/// или глубже, — в одном нажатии за «Найти».
struct ProjectShelfView: View {
    let projects: [ProjectTarget]
    let machines: [MachineSnapshot]
    let selectedId: String
    let onPick: (ProjectTarget) -> Void
    let onFind: () -> Void
    let onCustom: () -> Void
    /// «Сессии проекта» — вторичное действие строки. Контекстное меню здесь
    /// допустимо ровно потому, что ПЕРВИЧНОЕ действие строки видимо и очевидно:
    /// скрытый жест плох как ЕДИНСТВЕННЫЙ путь, а не как второй.
    let onOpenProject: (ProjectTarget) -> Void

    /// Проектов на карточку. Пять — столько влезает под заголовок, не превращая
    /// карточку в список сам по себе; остальное в одном нажатии.
    private let perCard = 5

    /// Карточки, у которых список раскрыт целиком. Не сохраняется: это жест
    /// «покажи остальное вот в этой», а не настройка, — вернувшаяся через сутки
    /// раскрытой карточка была бы просто более высокой полкой.
    @State private var expanded: Set<String> = []

    private struct Card: Identifiable {
        let machineId: String
        let name: String
        let online: Bool
        let ownerName: String?
        let items: [ProjectTarget]
        let more: Int
        let open: Bool
        /// Уточнитель пути для одноимённых — считается от того, что НА ЭКРАНЕ.
        let qualifier: [String: String]
        let recent: Double
        var id: String { machineId }
    }

    private var cards: [Card] {
        let fresh = projects.filter { ProjectShelf.isFresh($0) || $0.id == selectedId }
        var byMachine: [String: [ProjectTarget]] = [:]
        var order: [String] = []
        for p in fresh {
            if byMachine[p.machineId] == nil { order.append(p.machineId) }
            byMachine[p.machineId, default: []].append(p)
        }
        return order.map { machineId -> Card in
            let all = byMachine[machineId] ?? []
            let snap = machines.first { $0.machine.machineId == machineId }
            let open = expanded.contains(machineId)
            var items = open ? all : Array(all.prefix(perCard))
            // Выбранный проект обязан быть ВИДЕН: композер, нацеленный на то,
            // чего не видно, — та самая поломка, от которой эта страховка.
            if !open, let sel = all.first(where: { $0.id == selectedId }),
               !items.contains(where: { $0.id == selectedId }) {
                items = [sel] + items.prefix(perCard - 1)
            }
            // Одинаковые ярлыки на ЭТОЙ машине требуют пути — `claudehegai`
            // лежит на buildbox-pc дважды. Считается от `items`, то есть от
            // того, что реально на экране: раскрытие карточки приводит хвост, и
            // два одноимённых обязаны начать показывать разницу ровно в тот
            // момент, когда появился второй.
            var byLabel: [String: [ProjectTarget]] = [:]
            for p in items { byLabel[p.label, default: []].append(p) }
            var qualifier: [String: String] = [:]
            for group in byLabel.values {
                for (k, v) in ProjectShelf.disambiguate(group) { qualifier[k] = v }
            }
            return Card(machineId: machineId,
                        name: snap?.machine.name ?? all.first?.machineName ?? machineId,
                        online: snap?.online ?? false,
                        ownerName: snap?.owner?.fullName ?? snap?.owner?.email,
                        items: items,
                        more: all.count - items.count,
                        open: open,
                        qualifier: qualifier,
                        recent: all.first?.lastModified ?? 0)
        }
        // Коробка, на которой идёт работа, важнее коробки, которая просто онлайн.
        .sorted { $0.recent > $1.recent }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.s2) {
            head
            let list = cards
            if list.isEmpty {
                Text(projects.isEmpty
                     ? "Пока негде начать: нет машины, на которой хаб разрешает старт."
                     : "Ничего свежего — всё за «Найти».")
                    .font(.ui(Theme.sizeMeta)).foregroundStyle(Theme.textFaint)
                    .padding(.horizontal, Theme.s3).padding(.vertical, Theme.s4)
            } else {
                ForEach(list) { card($0) }
            }
        }
    }

    /// Заголовок полки и два её действия.
    ///
    /// `ViewThatFits` + `fixedSize()`, а не просто `HStack`: на крупном
    /// accessibility-размере «Папка» и «Найти» не помещались в строку и
    /// переносились ПО БУКВАМ — вертикальной лесенкой из «П-а-п-к-а». Кнопка,
    /// набранная столбиком, перестаёт читаться кнопкой; лучше отдать ей
    /// собственную строку целиком.
    private var head: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: Theme.s2) {
                SectionLabel(text: "Проект", count: nil)
                Spacer()
                headActions
            }
            VStack(alignment: .leading, spacing: Theme.s2) {
                SectionLabel(text: "Проект", count: nil)
                HStack(spacing: Theme.s4) { headActions; Spacer(minLength: 0) }
            }
        }
        .padding(.horizontal, Theme.s2)
    }

    @ViewBuilder private var headActions: some View {
        Button(action: onCustom) {
            Label("Папка", systemImage: "folder.badge.plus")
                .font(.ui(Theme.sizeMicro, weight: .medium)).foregroundStyle(Theme.textMuted)
                .fixedSize()
                .frame(minHeight: Theme.tapTarget)
        }
        .buttonStyle(.plain)
        Button(action: onFind) {
            Label("Найти", systemImage: "magnifyingglass")
                .font(.ui(Theme.sizeMicro, weight: .medium)).foregroundStyle(Theme.textMuted)
                .fixedSize()
                .frame(minHeight: Theme.tapTarget)
        }
        .buttonStyle(.plain)
    }

    private func card(_ g: Card) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: Theme.s2) {
                Image(systemName: "desktopcomputer")
                    .font(.system(size: 14)).foregroundStyle(Theme.textFaint)  // бокс глифа
                VStack(alignment: .leading, spacing: 1) {
                    Text(g.name).font(.ui(Theme.sizeMeta, weight: .semibold)).foregroundStyle(Theme.text)
                    HStack(spacing: 5) {
                        OnlineDot(online: g.online)
                        Text(g.online ? "онлайн" : "нет соединения")
                            .font(.mono(Theme.sizeNano)).foregroundStyle(Theme.textFaint)
                        if let owner = g.ownerName {
                            Text("· \(owner)").font(.mono(Theme.sizeNano)).foregroundStyle(Theme.textFaint).lineLimit(1)
                        }
                    }
                }
                Spacer()
            }
            .padding(.horizontal, Theme.s3)
            .padding(.top, Theme.s3)
            .padding(.bottom, Theme.s2)

            ForEach(g.items) { p in projectRow(p, qualifier: g.qualifier[p.id]) }

            if g.more > 0 || g.open {
                Button {
                    if g.open { expanded.remove(g.machineId) } else { expanded.insert(g.machineId) }
                    Haptics.light()
                } label: {
                    // Удлиняет ЭТОТ список, на месте. Спрашивать «а что ещё на
                    // этой коробке» и получать в ответ другую поверхность —
                    // поиск на пол-экрана — значит отвечать не на тот вопрос.
                    // Ссылка несёт свою опору ПОДЧЁРКИВАНИЕМ, а не цветом —
                    // `--link: var(--ink)` в вебе, и там же записано почему.
                    // Ember отсюда убран: это не «посмотри на меня», это
                    // обычная ссылка.
                    Text(g.open ? "свернуть" : "ещё \(g.more)")
                        .font(.ui(Theme.sizeMicro, weight: .medium))
                        .underline()
                        .foregroundStyle(Theme.link)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, Theme.s3)
                        .frame(height: Theme.tapTarget)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            } else {
                Spacer().frame(height: Theme.s2)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .card(radius: Theme.radiusLg)
        .opacity(g.online ? 1 : 0.7)
    }

    private func projectRow(_ p: ProjectTarget, qualifier: String?) -> some View {
        let selected = p.id == selectedId
        return Button {
            onPick(p)
            Haptics.light()
        } label: {
            HStack(spacing: Theme.s2) {
                Image(systemName: selected ? "folder.fill" : "folder")
                    .font(.system(size: 13))  // бокс глифа
                    .foregroundStyle(selected ? Theme.onSelect : Theme.textFaint)
                    .frame(width: 18)
                Text(p.label)
                    .font(.ui(Theme.sizeMeta, weight: selected ? .semibold : .regular))
                    .selectedInk(selected, normal: Theme.text)
                    .lineLimit(1)
                if let qualifier {
                    Text(qualifier)
                        .font(.mono(Theme.sizeNano))
                        .selectedInk(selected, normal: Theme.textFaint)
                        .lineLimit(1).truncationMode(.head)
                }
                Spacer(minLength: Theme.s2)
                // Пустой проект называется пустым. Иначе «ещё не начинали» и
                // «всё закрыто» на полке неразличимы, а это разные ответы.
                if !p.hasSessions {
                    Text("пусто")
                        .font(.mono(Theme.sizeMicro))
                        .selectedInk(selected, normal: Theme.textFaint)
                }
                if p.live > 0 {
                    // Тон текста плюс пульс, не ember — см. `PulsingBolt`.
                    // На выбранной плашке пульса нет: там молния уже несёт
                    // `onSelect`, и мигать ей по чернилам нечем.
                    if selected {
                        Image(systemName: "bolt.fill")
                            .font(.system(size: 10))  // бокс глифа
                            .foregroundStyle(Theme.onSelect)
                    } else {
                        PulsingBolt(size: 10)
                    }
                }
                if p.attention > 0 {
                    Rectangle()
                        .fill(selected ? Theme.onSelect : Theme.attn)
                        .frame(width: 6, height: 6)
                }
            }
            .padding(.horizontal, Theme.s3)
            .frame(height: Theme.tapTarget)
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
            .selectionPlate(selected)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(p.label) на \(p.machineName)")
        .contextMenu {
            Button { onOpenProject(p) } label: {
                Label("Сессии проекта", systemImage: "list.bullet")
            }
        }
    }
}
