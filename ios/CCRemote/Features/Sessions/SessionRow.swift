import SwiftUI
import CCRemoteKit

/// Сессия как ЖУРНАЛЬНАЯ ЗАПИСЬ, а не строка чата (DESIGN.md).
///
/// Впереди — ровно один знак, и какой именно, решает `RunMark` (Kit): прогон в
/// ходу получает МОЛНИЮ, «ждёт меня» и «ошибка» держат квадрат своего цвета,
/// всё остальное — приглушённую метку, чтобы у списка осталась ровная левая
/// колонка. Раньше здесь стоял квадрат на все случаи: он говорил одно и то же
/// про «открыта» и про «работает», а это давно разные состояния.
///
/// Дальше заголовок и относительное время; под ними — строка состояния (тоже из
/// Kit, `stateLine`), чип категории, владелец и точка внимания.
struct SessionRow: View {
    let item: SessionItem
    var showServer: Bool = true
    var showProject: Bool = false
    /// «Ты здесь» — ЭТА сессия сейчас открыта.
    ///
    /// Раньше параметр звался `selected` и рисовал сплошную плашку выбора. Две
    /// поломки в одной строке: плашку никто никогда не передавал (шторка
    /// показывала сто двадцать пять одинаковых строк, и какая из них открыта,
    /// нельзя было узнать вовсе), а выбрана она и не была — открытая сессия
    /// это НАВИГАЦИОННОЕ состояние, «ты здесь», а не «эту строку я отметил».
    /// Разница не косметическая: сплошная плашка тащит за собой перекраску
    /// заголовка, времени, чипов и меток — дюжину цветов, — только чтобы они
    /// читались поверх неё, и чёрная полоса становится самым заметным объектом
    /// экрана. Тинт говорит то же самое, дети остаются своего цвета.
    var here: Bool = false
    /// Текст, который вызывающий уже держит, — им перебивают строку состояния.
    var preview: String? = nil
    var previewLines: Int = 1

    /// ТОЛЬКО НАЗВАНИЕ. Режим шторки.
    ///
    /// Владелец, посмотрев 0.7.2 на телефоне: «в боковом меню надо сделать
    /// сообщения как в веб версии, только название, без лишних иконок».
    /// Требование — буквально второе: одно название. (Веб при этом сегодня
    /// строку рисует БОГАЧЕ — там и ведущий знак, и время, и превью, и чипы, —
    /// так что «как в вебе» и «только название» друг другу противоречат;
    /// сделано по второму, потому что оно и есть сказанное.)
    ///
    /// Почему параметр, а не переписанная строка. Тот же вид живёт ещё в двух
    /// местах — карточка Flow и «Сессии проекта», — и там богатая строка на
    /// месте: это экраны про разбор, а не про «быстро перепрыгнуть в другой
    /// разговор». Жалоба была про шторку, и сужение остаётся в шторке.
    ///
    /// Побочно это самый дешёвый вид в списке: он не спрашивает `client`
    /// вообще, тогда как полный на каждую строку делает линейный поиск по
    /// активным прогонам (`runFor`) — на 645 сессиях это и есть цена открытия.
    var titleOnly: Bool = false
    /// «Ждёт меня» — единственный знак, который в режиме названия остаётся.
    ///
    /// Разрешён явно: без него список теряет навигацию — сессия, которая зовёт,
    /// ничем не отличается от шестисот сорока четырёх соседних. Приходит
    /// ГОТОВЫМ значением, а не вычисляется здесь: считать его на месте значило
    /// бы вернуть тот самый `runFor` на каждую строку.
    var unread: Bool = false

    @Environment(CentralClient.self) private var client
    @Environment(AppSettings.self) private var settings
    @Environment(Router.self) private var router

    private var s: SessionSummary { item.session }
    /// Имя — из ОБЩЕЙ функции (`sessionDisplayName`), а не своё.
    ///
    /// Здесь стояло `s.title.isEmpty ? короткий id : s.title`, и именно оно
    /// показывало в списке `https://acme.test/m/36804d5d8c1b4e2f…`: заголовок
    /// не пустой, значит показываем как есть. Мест показа имени четыре, и своё
    /// правило в каждом — четыре разных представления о том, как называется
    /// сессия.
    private var title: String {
        sessionDisplayName(title: s.title, project: s.project, cwd: s.cwd, sessionId: s.sessionId)
    }
    private var machineOnline: Bool {
        client.machines.first { $0.machine.machineId == item.machineId }?.online ?? false
    }
    /// Чужой владелец. Свой не показывается: подписывать каждую свою строку
    /// своим же именем — это шум, а не атрибуция.
    private var otherOwner: String? {
        guard let owner = s.owner, owner.userId != client.effectiveViewerId else { return nil }
        let name = owner.fullName ?? owner.email ?? ""
        return name.isEmpty ? nil : name.split(separator: " ").first.map(String.init)
    }

    var body: some View {
        if titleOnly { titleOnlyRow } else { fullRow }
    }

    /// Название, и всё. Точка непрочитанного — единственное исключение.
    private var titleOnlyRow: some View {
        Button {
            router.openSession(machineId: item.machineId, sessionId: s.sessionId); Haptics.light()
        } label: {
            HStack(spacing: Theme.s2) {
                Text(title)
                    // Начертание — то же, чем «ты здесь» отличалось и раньше:
                    // тинт в одиночку на светлой канве почти не виден.
                    .font(.ui(Theme.sizeSmall, weight: here ? .bold : .regular))
                    .foregroundStyle(Theme.text)
                    .lineLimit(1)
                    .truncationMode(.tail)
                Spacer(minLength: Theme.s2)
                if unread {
                    Circle()
                        .fill(Theme.attn)
                        .frame(width: 7, height: 7)
                        .accessibilityLabel("ждёт ответа")
                }
            }
            .padding(.horizontal, Theme.s3)
            // Высота цели нажатия держится здесь: без второй строки и меток
            // строка стала низкой, а 44pt — это не украшение, а палец.
            .frame(minHeight: 44)
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
            .hereTint(here)
        }
        .buttonStyle(.plain)
        .contextMenu { favoriteButton }
    }

    private var fullRow: some View {
        let run = client.runFor(machineId: item.machineId, sessionId: s.sessionId)
        let mark = RunMark(s.activityState(run: run))
        let fav = settings.isFavorite(machineId: item.machineId, sessionId: s.sessionId)
        return Button {
            router.openSession(machineId: item.machineId, sessionId: s.sessionId); Haptics.light()
        } label: {
            HStack(alignment: .top, spacing: Theme.s3) {
                lead(mark)
                    .frame(width: 14, alignment: .center)
                    .padding(.top, 3)

                VStack(alignment: .leading, spacing: 3) {
                    HStack(alignment: .firstTextBaseline, spacing: Theme.s1) {
                        if fav {
                            Image(systemName: "star.fill").font(.system(size: 9))  // бокс глифа
                                .foregroundStyle(Theme.yellow)
                        }
                        Text(title)
                            // Открытая сессия — полужирным. Тинт намеренно
                            // тихий, и в одиночку он на светлой канве почти
                            // не виден; начертание и есть вторая половина
                            // того, чем «ты здесь» отличается от соседей.
                            .font(.ui(Theme.sizeSmall, weight: here ? .bold : .semibold))
                            .foregroundStyle(Theme.text)
                            .lineLimit(1)
                        Spacer(minLength: Theme.s2)
                        // Время — в моноширинном: это слой данных, и в списке
                        // оно должно стоять колонкой, а не плясать по ширине
                        // цифр.
                        Text(RelTime.short(s.lastModified))
                            .font(.mono(Theme.sizeMicro))
                            .foregroundStyle(Theme.textFaint)
                    }

                    Text(stateLine)
                        .font(.ui(Theme.sizeMicro))
                        .foregroundStyle(stateTone)
                        .lineLimit(previewLines)
                        .multilineTextAlignment(.leading)
                        .fixedSize(horizontal: false, vertical: true)

                    // Метки: категория, владелец, точка внимания. Отдельной
                    // строкой, а не в хвосте состояния, — иначе на 375pt они
                    // отъедают у него ровно те слова, ради которых он есть.
                    if s.categoryInfo != nil || otherOwner != nil || mark == .attention || s.isCodex {
                        HStack(spacing: Theme.s2) {
                            if let cat = s.categoryInfo { categoryChip(cat) }
                            if let owner = otherOwner { ownerChip(owner) }
                            if s.isCodex { CodexBadge(active: s.active ?? false) }
                            Spacer(minLength: 0)
                            if mark == .attention { UnreadBadge(count: 1) }
                        }
                    }
                }
            }
            .padding(.horizontal, Theme.s3)
            .padding(.vertical, Theme.s2)
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
            .hereTint(here)
        }
        .buttonStyle(.plain)
        .contextMenu { favoriteButton }
    }

    /// Избранное осталось ДОСТУПНЫМ, хотя звезду со строки сняли: долгое
    /// нажатие — не «лишняя иконка», оно ничего не занимает на экране.
    @ViewBuilder private var favoriteButton: some View {
        let fav = settings.isFavorite(machineId: item.machineId, sessionId: s.sessionId)
        Button {
            settings.toggleFavorite(machineId: item.machineId, sessionId: s.sessionId)
        } label: {
            Label(fav ? "Убрать из избранного" : "В избранное",
                  systemImage: fav ? "star.slash" : "star")
        }
    }

    /// Work uses the provider mark; attention/errors retain their status square.
    @ViewBuilder private func lead(_ mark: RunMark) -> some View {
        switch mark {
        case .live:
            SessionActivityIcon(isCodex: s.isCodex, isOpenCode: s.isOpenCode)
        case .attention:
            square(Theme.attn)
        case .error:
            square(Theme.negative)
        case .none:
            // Открытая в редакторе сессия — не «идёт работа», но и не пусто:
            // её держит чужой писатель, и это единственная причина, по которой
            // её нельзя возобновить.
            square(s.isLive ? Theme.live : Theme.textFaint)
        }
    }

    private func square(_ color: Color) -> some View {
        RoundedRectangle(cornerRadius: Theme.statusDotRadius, style: .continuous)
            .fill(color)
            .frame(width: Theme.statusDot, height: Theme.statusDot)
    }

    private var stateLine: String {
        if let preview, !preview.isEmpty { return preview }
        return s.stateLine(run: client.runFor(machineId: item.machineId, sessionId: s.sessionId),
                           machineName: item.machineName,
                           machineOnline: machineOnline,
                           showMachine: showServer,
                           showProject: showProject)
    }

    /// Состояние, которое зовёт, поднимается до полного тона текста; ошибка
    /// берёт красный. Ember сюда НЕ идёт, хотя он и есть цвет внимания:
    /// `#FF6A3D` мелким текстом на слоновой кости не держит 4.5:1, а правило
    /// «каждый текстовый тон держит контраст в обеих темах» не знает
    /// исключений. Цвет внимания несут метка слева и ember-бейдж справа —
    /// места, где он заливка, а не текст.
    private var stateTone: Color {
        switch RunMark(s.activityState(run: client.runFor(machineId: item.machineId, sessionId: s.sessionId))) {
        case .attention: return Theme.text
        case .error: return Theme.negative
        default: return Theme.textMuted
        }
    }

    private func categoryChip(_ cat: SessionCategory) -> some View {
        HStack(spacing: 4) {
            // Метка категории — статусная метка: квадрат 6×6 радиусом метки,
            // никогда не круг (DESIGN.md).
            RoundedRectangle(cornerRadius: Theme.statusDotRadius, style: .continuous)
                .fill(cat.color)
                .frame(width: 6, height: 6)
            Text(cat.label).font(.mono(Theme.sizeMicro))
                .foregroundStyle(Theme.textFaint)
        }
        .padding(.horizontal, 6)
        .frame(height: 18)
        .background(Theme.chip, in: Capsule())  // пилюля: тег
    }

    private func ownerChip(_ name: String) -> some View {
        HStack(spacing: 4) {
            Avatar(seed: name, label: name, size: 14, labelSize: 8)
            Text(name).font(.mono(Theme.sizeMicro))
                .foregroundStyle(Theme.textFaint)
                .lineLimit(1)
        }
        .padding(.horizontal, 6)
        .frame(height: 18)
        .background(Theme.chip, in: Capsule())  // пилюля: тег
    }
}

/// Молния «идёт работа»: тон текста плюс пульс.
///
/// Своим типом, а не модификатором на месте, потому что пульсу нужно
/// собственное `@State`, а `lead(_:)` — это `@ViewBuilder`-функция, и
/// состояние в ней жило бы у всей строки.
struct PulsingBolt: View {
    var size: CGFloat = 12

    var body: some View {
        Image(systemName: "bolt.fill")
            .font(.system(size: size, weight: .semibold))  // бокс глифа
            .foregroundStyle(Theme.live)
            .livePulse()
            .accessibilityHidden(true)
    }
}
