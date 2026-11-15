import SwiftUI
import CCRemoteKit

// Помощники в чате (10.10.2026) — порт `web/src/render/Subagents.tsx`.
//
// Один помощник — одна карточка под абзацем, который запустил вызов
// `Agent`/`Task`: кто, что делает, сейчас, сколько, чем кончилось. Работающие —
// ещё и строками панели «В фоне» над полем ввода, со «Стоп». Его собственный
// транскрипт — по кнопке «Что он делал», листом только для чтения. Его реплики
// в ленту родителя не попадают никогда: там они читались как речь самой сессии.
//
// Живые факты — уровень `subagents` от агента (`CentralClient.subagents`).
// Перечитанная история его не несёт, и карточка берёт исход из самой истории:
// результат вызова и `<task-notification>` (`SubagentNotices`).

/// Что открыть в листе транскрипта помощника.
struct SubagentTarget: Identifiable, Equatable {
    var toolUseId: String?
    var agentId: String?
    var title: String
    var id: String { "\(toolUseId ?? ""):\(agentId ?? "")" }
}

/// Всё, что нужно карточкам и панели. Без него (`nil` в окружении) карточек нет.
struct SubagentsContext {
    /// Живые помощники по id вызова родителя.
    var live: [String: Subagent] = [:]
    var notices: [String: AgentNotice] = [:]
    /// Ран ещё здесь, чтобы закончить начатое в истории фоновым вызовом.
    var runAlive = false
    /// Нет — когда открыть нечем (новый чат ещё без адреса сессии).
    var open: ((SubagentTarget) -> Void)?
    /// Нет — у того, кто не может управлять раном.
    var stop: ((String) -> Void)?
}

private struct SubagentsKey: EnvironmentKey {
    static let defaultValue: SubagentsContext? = nil
}

extension EnvironmentValues {
    var subagents: SubagentsContext? {
        get { self[SubagentsKey.self] }
        set { self[SubagentsKey.self] = newValue }
    }
}

extension TranscriptRow {
    /// Вызовы `Agent`/`Task` в механике, которую несёт эта строка — и в истории,
    /// и в живом хвосте. Карточки встают под абзацем там же, где его шестерёнка.
    var agentCalls: [SubagentCall] {
        // A call the history holds and the live replay repeats is ONE card
        // (20.10.2026: the same helper was drawn twice).
        var seen = Set<String>()
        return (SubagentCall.from(blocks: blocks) + SubagentCall.from(lines: lines)).filter { call in
            guard let id = call.toolUseId, !id.isEmpty else { return true }
            return seen.insert(id).inserted
        }
    }
}

/// Разбор истории на исходы вызовов и множество вызовов — один проход на
/// массив, а не на каждый токен стрима (тело чата пересчитывается на каждый).
final class SubagentHistoryMemo {
    private var input: [HistoryMessage] = []
    private var valid = false
    private(set) var notices: [String: AgentNotice] = [:]
    private(set) var calls: Set<String> = []

    func update(_ history: [HistoryMessage]) {
        if valid && history == input { return }
        input = history
        notices = SubagentNotices.from(history: history)
        calls = Set(history.flatMap { SubagentCall.from(blocks: $0.blocks) }.compactMap(\.toolUseId))
        valid = true
    }
}

// MARK: - Метка статуса

/// Квадрат 8×8 с радиусом 2, как метки статуса в вебе. Работающий пульсирует
/// бренд-цветом; готовый — зелёный текстовый тон, ошибка — красный,
/// остановленный — бледный, неизвестный — пустой контур.
struct SubagentStatusMark: View {
    let status: SubagentStatus?

    /// Пульс 1 → 0.35 → 1 по 0.9 с в каждую сторону — как был у `phaseAnimator`. Крутится
    /// только пока метка на виду, сцена активна, нет Low Power Mode и «Уменьшения движения»
    /// (`livePulse`); иначе стоит.
    var body: some View {
        mark
            .livePulse(status == .running, animation: .easeInOut(duration: 0.9).repeatForever(autoreverses: true))
            .accessibilityHidden(true)
    }

    private var mark: some View {
        RoundedRectangle(cornerRadius: 2, style: .continuous)
            .fill(fill)
            .overlay {
                if status == nil {
                    RoundedRectangle(cornerRadius: 2, style: .continuous).strokeBorder(Theme.textFaint, lineWidth: 1)
                }
            }
            .frame(width: 8, height: 8)
    }

    private var fill: Color {
        switch status {
        case .running: return Theme.brand
        case .completed: return Theme.positive
        case .failed: return Theme.negative
        case .stopped: return Theme.textFaint
        case nil: return .clear
        }
    }
}

// MARK: - Карточки

/// «· тихо 1:05» — работающий помощник молчит дольше 30 с; золотой текстовый
/// тон, как `--orange-text` у веба. Пусто, пока он двигается.
func quietText(_ agent: Subagent?, nowMs: Double) -> Text {
    guard let quiet = SubagentFormat.quiet(agent, nowMs: nowMs) else { return Text("") }
    return Text(" · тихо \(SubagentFormat.clock(ms: quiet))").foregroundStyle(Theme.orangeText)
}

/// Карточки вызовов `Agent` одной пачки механики — под абзацем, который её объявил.
struct SubagentCards: View {
    let calls: [SubagentCall]
    @Environment(\.subagents) private var api

    var body: some View {
        if let api, !calls.isEmpty {
            VStack(alignment: .leading, spacing: Theme.s2) {
                ForEach(Array(calls.enumerated()), id: \.offset) { _, call in
                    SubagentCard(call: call, api: api)
                }
            }
            .padding(.top, Theme.s2)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

struct SubagentCard: View {
    let call: SubagentCall
    let api: SubagentsContext
    @State private var expanded = false

    private var live: Subagent? { call.toolUseId.flatMap { api.live[$0] } }
    private var notice: AgentNotice? { call.toolUseId.flatMap { api.notices[$0] } }
    /// Фоновый вызов, которого ран больше не несёт и который ничто не закрыло,
    /// кончился вместе с раном — утверждать нечего ни в одну сторону.
    private var status: SubagentStatus? {
        live?.status ?? notice?.status ?? (notice?.async == true && api.runAlive ? .running : nil)
    }
    private var kind: String { live?.kind ?? call.kind }
    private var task: String {
        let d = live?.description ?? ""
        return d.isEmpty ? call.description : d
    }
    /// «Sonnet 5.5»; пусто, пока агент не сказал модель.
    private var modelName: String? {
        ModelLabel.explicit(live?.model).map { ModelLabel.name(models: [], model: $0) }
    }

    /// Два прошлых шага и текущий — словами (`StepText.action`).
    private func runningSteps(_ agent: Subagent) -> [Step] {
        var raw: [String] = Array((agent.recent ?? []).suffix(2))
        if let action = agent.lastAction, !action.isEmpty { raw.append(action) }
        return raw.map { StepText.action($0) }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline, spacing: Theme.s2) {
                SubagentStatusMark(status: status).alignmentGuide(.firstTextBaseline) { $0.height }
                Text(task)
                    .font(.ui(Theme.sizeSmall, weight: .semibold))
                    .foregroundStyle(Theme.text)
                    .lineLimit(2)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            // «Explore · Sonnet 5.5» — кто и на какой модели, одной тихой строкой.
            WhoLine(kind: kind, model: modelName)
            if let live {
                if status == .running {
                    SecondClock { now in
                        metaText(live, now: now)
                    }
                } else {
                    metaText(live, now: Date())
                }
            }
            if status == .running, let live {
                // Последние шаги словами на тонкой линии: текущий — с пульсом,
                // без «сейчас:». Видно, что он движется (или что нет).
                StepTrail(steps: runningSteps(live), live: !(live.lastAction ?? "").isEmpty)
                // Its own checklist, when it keeps one: «3/5 · active» and a bar.
                if let plan = live.plan, plan.total > 0 { PlanLine(plan: plan) }
            }
            if status != .running, let summary = live?.summary ?? notice?.summary, !summary.isEmpty {
                Button { expanded.toggle() } label: {
                    Text(stripHarnessNoise(summary))
                        .font(.ui(Theme.sizeMeta))
                        .foregroundStyle(Theme.textMuted)
                        .lineLimit(expanded ? nil : 2)
                        .multilineTextAlignment(.leading)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityHint(expanded ? "Свернуть отчёт" : "Развернуть отчёт")
                .accessibilityIdentifier("subagent.summary")
            }
            actions
        }
        .padding(.horizontal, 14)
        .padding(.top, 10)
        .padding(.bottom, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .card(radius: Theme.radiusMd)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Помощник \(kind): \(task)\(status.map { ", \($0.word)" } ?? "")")
    }

    private func metaText(_ agent: Subagent, now: Date) -> some View {
        let ms = now.timeIntervalSince1970 * 1000
        return (Text(SubagentFormat.meta(agent, nowMs: ms)).foregroundStyle(Theme.textFaint)
                + quietText(agent, nowMs: ms))
            .font(.ui(Theme.sizeMicro))
            .monospacedDigit()
            .lineLimit(1)
            .padding(.leading, 16)
    }

    @ViewBuilder private var actions: some View {
        let canOpen = call.toolUseId != nil && api.open != nil
        let canStop = status == .running && live != nil && api.stop != nil
        let word = status.flatMap { $0 == .running ? nil : $0.word }
        if canOpen || canStop || word != nil {
            HStack(spacing: Theme.s4) {
                if canOpen, let open = api.open {
                    SubagentLink(title: "Что он делал") {
                        open(SubagentTarget(toolUseId: call.toolUseId, agentId: live?.id, title: "\(kind) · \(task)"))
                    }
                    .accessibilityIdentifier("subagent.open")
                }
                if canStop, let stop = api.stop, let live {
                    SubagentLink(title: "Остановить", danger: true) { stop(live.id) }
                        .accessibilityIdentifier("subagent.stop")
                }
                Spacer(minLength: 0)
                if let word {
                    Text(word).font(.ui(Theme.sizeMeta)).foregroundStyle(Theme.textFaint)
                }
            }
        }
    }
}

/// Текстовая кнопка карточки и панели: цель нажатия 44pt при строке 13pt.
struct SubagentLink: View {
    let title: String
    var danger = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(.ui(Theme.sizeMeta, weight: .medium))
                .foregroundStyle(danger ? Theme.negative : Theme.text)
                .frame(minHeight: Theme.tapTarget)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .padding(.vertical, -Theme.s3)   // 44pt нажатия без 44pt высоты строки
    }
}

// MARK: - Панель «В фоне»

/// Над полем ввода: что ещё работает — помощники и другие фоновые задачи,
/// у каждой свои часы и «Стоп». Заменяет строку «в фоне: …» (веб `SubagentPanel`).
struct SubagentPanel: View {
    let rows: [SubagentPanelRow]
    @Environment(\.subagents) private var api

    var body: some View {
        SecondClock { tick in
            let now = tick.timeIntervalSince1970 * 1000
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: Theme.s2) {
                    SubagentStatusMark(status: .running)
                    Text("В фоне · \(rows.reduce(0) { $0 + $1.ids.count })")
                        .font(.ui(Theme.sizeMeta, weight: .semibold))
                        .foregroundStyle(Theme.text)
                    Spacer(minLength: 0)
                    if let stop = api?.stop, rows.count > 1 {
                        SubagentLink(title: "Остановить все", danger: true) { rows.flatMap(\.ids).forEach(stop) }
                            .accessibilityIdentifier("subagents.stopAll")
                    }
                }
                .frame(minHeight: 28)
                ForEach(rows) { row in
                    rowView(row, now: now)
                }
            }
        }
        .padding(.horizontal, Theme.s3)
        .padding(.vertical, Theme.s2)
        .card(radius: Theme.radiusMd)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("chat.background")
    }

    private func rowView(_ row: SubagentPanelRow, now: Double) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: Theme.s2) {
            // Задача — первой строкой: на 393pt тип помощника и счётчики
            // выдавливали её из ряда целиком. Тип и «что сейчас» — второй.
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: Theme.s1) {
                    Text(row.label).font(.ui(Theme.sizeMeta)).foregroundStyle(Theme.text).lineLimit(1)
                    if row.ids.count > 1 {
                        Text("× \(row.ids.count)").font(.ui(Theme.sizeMeta)).foregroundStyle(Theme.textMuted).fixedSize()
                    }
                }
                let step: String? = row.lastAction.flatMap { $0.isEmpty ? nil : StepText.action($0).text }
                let planCount: String? = row.agent?.plan.flatMap { $0.total > 0 ? $0.count : nil }
                let detail: [String] = [planCount, row.kind, row.owner, step].compactMap { $0 }.filter { !$0.isEmpty }
                if !detail.isEmpty {
                    Text(detail.joined(separator: " · "))
                        .font(.ui(Theme.sizeMicro)).foregroundStyle(Theme.textFaint)
                        .lineLimit(1).truncationMode(.tail)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            (Text(((row.agent?.tokens).flatMap { $0 > 0 ? "\(SubagentFormat.tokens($0)) · " : nil } ?? "")
                  + SubagentFormat.clock(ms: now - row.since))
             + quietText(row.agent, nowMs: now))
                .fixedSize()
            if let open = api?.open, row.toolUseId != nil || row.agent != nil {
                SubagentLink(title: "Открыть") {
                    open(SubagentTarget(toolUseId: row.toolUseId, agentId: row.agent?.id,
                                        title: "\(row.kind ?? "агент") · \(row.label)"))
                }
            }
            if let stop = api?.stop {
                SubagentLink(title: "Стоп", danger: true) { row.ids.forEach(stop) }
                    .accessibilityLabel("Остановить: \(row.label)")
            }
        }
        .font(.ui(Theme.sizeMicro))
        .monospacedDigit()
        .foregroundStyle(Theme.textFaint)
        .padding(.vertical, 6)
    }
}

// MARK: - Транскрипт помощника

/// Собственный транскрипт помощника, только для чтения, тем же рендером, что
/// история сессии. Пока он работает, файл растёт — лист перечитывает его и
/// перестаёт, когда помощник закончил. Пауза между чтениями растёт, пока ответ не
/// меняется (4 → 8 → 16 → 30 с) и сбрасывается на изменении; в неактивной сцене
/// чтения нет вовсе. Раньше — раз в 4 с, то есть до 15 полных транскриптов в минуту
/// по радио, даже когда помощник молчал. (`session.subagent` не принимает `limit`,
/// так что ограничить хвост запросом нельзя — отсюда реже, а не меньше.)
struct SubagentTranscriptSheet: View {
    let target: SubagentTarget
    let running: Bool
    let load: () async throws -> [HistoryMessage]
    let onClose: () -> Void

    @State private var messages: [HistoryMessage]?
    @State private var error: String?
    @State private var memo = TranscriptMemo()
    @Environment(\.scenePhase) private var scenePhase

    private struct PollKey: Equatable {
        let running: Bool
        let active: Bool
    }
    private static let firstPause = 4.0
    private static let longestPause = 30.0

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    if let error {
                        Text(error).font(.ui(Theme.sizeMeta)).foregroundStyle(Theme.negative)
                    } else if let messages {
                        if messages.isEmpty {
                            Text("Расшифровки помощника нет — CLI её не сохранил или сессия почищена.")
                                .font(.ui(Theme.sizeMeta)).foregroundStyle(Theme.textFaint)
                        } else {
                            let agent = target.title.components(separatedBy: " · ").first ?? "агент"
                            ForEach(transcriptRows(history: memo.items(for: messages))) { row in
                                TranscriptRowView(row: row, agent: agent, human: "задача")
                            }
                        }
                    } else {
                        HStack(spacing: Theme.s2) {
                            ProgressView().controlSize(.small)
                            Text("Загружаю…").font(.ui(Theme.sizeMeta)).foregroundStyle(Theme.textFaint)
                        }
                    }
                }
                .padding(.horizontal, Theme.s3)
                .padding(.vertical, Theme.s3)
                .frame(maxWidth: Theme.readingWidth)
                .frame(maxWidth: .infinity)
            }
            .background(Theme.bg)
            // Вложенные вызовы помощника — не карточки родителя: чужие исходы
            // и чужое «Стоп» здесь были бы ложью.
            .environment(\.subagents, nil)
            .navigationTitle(target.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                // «работает» — подписью под заголовком, а не кнопкой панели:
                // там iOS 26 сажает её в стеклянную капсулу и режет до «раб…».
                ToolbarItem(placement: .principal) {
                    VStack(spacing: 0) {
                        Text(target.title).font(.ui(Theme.sizeSmall, weight: .semibold))
                            .foregroundStyle(Theme.text).lineLimit(1)
                        if running {
                            Text("работает").font(.ui(Theme.sizeMicro)).foregroundStyle(Theme.textFaint)
                        }
                    }
                    .accessibilityElement(children: .combine)
                }
                ToolbarItem(placement: .topBarTrailing) {
                    SheetCloseButton(action: onClose).accessibilityIdentifier("subagent.close")
                }
            }
        }
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
        // Смена сцены или состояния помощника перезапускает опрос: вернулись в приложение —
        // первое чтение сразу, свежее.
        .task(id: PollKey(running: running, active: scenePhase == .active)) {
            guard scenePhase == .active else { return }
            var pause = Self.firstPause
            while !Task.isCancelled {
                do {
                    let read = try await load()
                    guard !Task.isCancelled else { return }
                    if read == messages {
                        // Ничего нового: не перерисовываем и ждём дольше.
                        pause = min(pause * 2, Self.longestPause)
                    } else {
                        messages = read
                        pause = Self.firstPause
                    }
                    if error != nil { error = nil }
                } catch is CancellationError {
                    return
                } catch {
                    guard !Task.isCancelled else { return }
                    self.error = error.localizedDescription
                }
                guard running else { return }
                try? await Task.sleep(for: .seconds(pause))
            }
        }
    }
}
