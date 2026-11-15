import Foundation
import CCRemoteKit

// «Что сделано» и карточка работы — порт `web/src/render/turnRecaps.ts` и
// `turnWork` из `web/src/panels/Chat.tsx` (c80e7c7f, 20.10.2026).

/// Один вызов инструмента хода. Слова из него (`StepText`) считаются, только
/// когда блок раскрыли: `transcriptRows` пересобирается на каждый токен стрима,
/// а регулярки по тысяче вызовов истории на каждый токен — лишнее.
enum RecapCall: Equatable {
    case block(name: String, input: JSONValue)
    case line(String)

    var step: Step {
        switch self {
        case let .block(name, input): return StepText.human(name: name, input: input)
        case let .line(text): return StepText.toolLine(text)
        }
    }
}

/// Что сделал законченный ход: вызовы и сколько он шёл.
struct TurnRecapData: Equatable {
    var calls: [RecapCall]
    /// Нет, когда ход кончился механикой без отметки времени после неё.
    var ms: Double?

    var steps: [Step] { calls.map(\.step) }
}

/// Что про запись транскрипта нужно итогу хода.
enum RecapItem {
    /// Сообщение человека — начало хода.
    case human(ts: Double?)
    /// Любая другая речь — её отметка времени и есть конец хода.
    case speech(ts: Double?)
    /// Механика между речью.
    case run(calls: [RecapCall])
}

/// Где встают «Что сделано»: по одному после последней записи каждого
/// законченного хода с действиями, ключ — id этой записи. Ход — всё между двумя
/// сообщениями человека; последний законченный, только когда ран не занят.
/// История и живой хвост — один транскрипт: ход, начатый на диске и
/// продолженный стримом, считается один раз. Длительность опущена, когда ход
/// кончился механикой без отметки после неё; страница истории, начатая посреди
/// хода, итога не даёт (`started`).
func turnRecaps(_ items: [(id: String, item: RecapItem)], busy: Bool) -> [String: TurnRecapData] {
    var done: [String: TurnRecapData] = [:]
    var calls: [RecapCall] = []
    var startTs: Double?
    var endTs: Double?
    var openEnd = false
    var started = false
    var lastId: String?

    func flush() {
        if started, let id = lastId, !calls.isEmpty {
            var ms: Double?
            if !openEnd, let s = startTs, let e = endTs, e > s { ms = e - s }
            done[id] = TurnRecapData(calls: calls, ms: ms)
        }
        calls = []
        endTs = nil
        openEnd = false
    }

    for (id, item) in items {
        switch item {
        case let .human(ts):
            flush()
            started = true
            startTs = ts
        case let .speech(ts):
            if let ts {
                endTs = ts
                openEnd = false
            }
        case let .run(runCalls):
            calls += runCalls
            if !runCalls.isEmpty { openEnd = true }
        }
        lastId = id
    }
    if !busy { flush() }
    return done
}

/// «14 шагов · 5:28».
func recapMeta(steps: Int, ms: Double?) -> String {
    var parts = ["\(steps) \(plural(steps, "шаг", "шага", "шагов"))"]
    if let ms, ms > 0 { parts.append(clockText(ms: ms)) }
    return parts.joined(separator: " · ")
}

/// «5:28», «1:02:09».
func clockText(ms: Double) -> String {
    guard ms.isFinite else { return "0:00" }
    let seconds = Int(min(max(0, (ms / 1000).rounded(.down)), Double(Int32.max)))
    if seconds >= 3600 { return String(format: "%d:%02d:%02d", seconds / 3600, seconds / 60 % 60, seconds % 60) }
    return String(format: "%d:%02d", seconds / 60, seconds % 60)
}

// MARK: - Карточка работы

/// Ход глазами карточки сессии: шаги хода по живому хвосту после последней
/// строки человека. Только когда в хвосте работы нет совсем — экран открыт
/// посреди хода, а переигровка не пришла, — вместо него встаёт хвост истории
/// (иначе шаги считались бы дважды или считался бы прошлый ход).
///
/// Слова считаются только для последних `shown` шагов — столько показывает карточка
/// (`WorkingIndicator`); сколько их всего, лежит в `stepCount`. Раньше `StepText`
/// гонялся по каждому вызову хода на каждую дельту стрима (16fb20a3, 20.10.2026).
struct TurnWork: Equatable {
    /// Последние `shown` шагов хода (меньше, когда их меньше).
    var steps: [Step]
    /// Сколько шагов в ходе всего, без вызовов помощников.
    var stepCount: Int
    /// Последний шаг ещё идёт, а не «между шагами».
    var current: Bool
    /// Последний шаг хода — вызов помощника (`Agent`/`Task`): сессия ждёт его,
    /// а у него своя карточка в ленте. Тогда карточки работы нет — она
    /// повторяла бы помощника третий раз (24.10.2026, просьба владельца).
    var waitsOnHelper = false

    init(steps: [Step], current: Bool, waitsOnHelper: Bool = false, stepCount: Int? = nil) {
        self.steps = steps
        self.stepCount = stepCount ?? steps.count
        self.current = current
        self.waitsOnHelper = waitsOnHelper
    }

    static let none = TurnWork(steps: [], current: false)

    /// Сколько последних шагов рисует карточка.
    static let shown = 3

    /// Вызовы помощников не шаги хода: у каждого своя карточка под абзацем.
    static let helperTools: Set<String> = ["Agent", "Task"]

    static func isHelper(line text: String) -> Bool {
        let name = text.prefix { $0 != " " && $0 != "{" }
        return helperTools.contains(String(name))
    }

    static func of(lines: [TranscriptLine], history: [HistoryMessage], activity: String) -> TurnWork {
        let start = lines.lastIndex { $0.kind == .user }
        let tail = lines[(start.map { $0 + 1 } ?? 0)...]
        // Один проход без разбора текста: сколько шагов и тексты последних.
        var anyCall = false
        var count = 0
        var lastTexts: [String] = []
        var liveIds: [String] = []
        for line in tail where line.kind == .tool_use {
            anyCall = true
            guard !isHelper(line: line.text) else { continue }
            count += 1
            lastTexts.append(line.text)
            if lastTexts.count > shown { lastTexts.removeFirst() }
            if let id = line.toolUseId { liveIds.append(id) }
        }
        var steps = lastTexts.map { StepLineCache.shared.step(for: $0) }
        let working = anyCall || tail.contains { $0.kind == .assistant }
        if start == nil && !working {
            let fromHistory = historyWork(history)
            steps = fromHistory.steps
            count = fromHistory.count
        } else if start == nil, !history.isEmpty, !liveIds.isEmpty {
            // The live tail begins mid-turn — the hub restarted, or its replay
            // window let the person's line go — and the file holds the turn's
            // earlier calls. Counting only the tail made the number drop and
            // climb again on open (24.10.2026); one call counts once. Joined
            // only when a call is in both: a history read before this turn
            // began would otherwise lend it the previous turn's steps.
            let earlier = historyCallIds(history)
            let shared = liveIds.reduce(0) { $0 + (earlier.contains($1) ? 1 : 0) }
            if shared > 0 { count += earlier.count - shared }
        }
        let last = tail.last { $0.kind != .status && $0.kind != .system }
        let onHelper = last?.kind == .tool_use && isHelper(line: last?.text ?? "")
        return TurnWork(steps: steps, current: !onHelper && last?.kind == .tool_use && activity != WorkActivity.thinking,
                        waitsOnHelper: onHelper && activity != WorkActivity.thinking, stepCount: count)
    }

    /// Вызовы истории после последнего сообщения человека: последние `shown` словами и общее число.
    static func historyWork(_ history: [HistoryMessage]) -> (steps: [Step], count: Int) {
        var recent: [(name: String, input: JSONValue)] = []   // с конца, не больше `shown`
        var count = 0
        for message in history.reversed() {
            if isHuman(message) { break }
            for block in message.blocks.reversed() {
                if case let .toolUse(_, name, input) = block, !helperTools.contains(name) {
                    count += 1
                    if recent.count < shown { recent.append((name, input)) }
                }
            }
        }
        return (recent.reversed().map { StepText.human(name: $0.name, input: $0.input) }, count)
    }

    /// Ids of the history's calls after the last human message, helpers excluded.
    static func historyCallIds(_ history: [HistoryMessage]) -> Set<String> {
        var ids: Set<String> = []
        for message in history.reversed() {
            if isHuman(message) { break }
            for block in message.blocks {
                if case let .toolUse(id, name, _) = block, !helperTools.contains(name) { ids.insert(id) }
            }
        }
        return ids
    }

    private static func isHuman(_ message: HistoryMessage) -> Bool {
        guard message.role == .user else { return false }
        var hasText = false
        for block in message.blocks {
            switch block {
            case .toolResult: return false
            case let .text(text):
                if !stripHarnessNoise(text).trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { hasText = true }
            case .image: hasText = true  // a picture alone is a prompt too
            default: break
            }
        }
        return hasText
    }
}

/// Слова `StepText.toolLine` по тексту строки `tool_use`. Функция чистая, поэтому ключ — сам
/// текст: тот же текст — тот же шаг, и карточка на дельте стрима не разбирает JSON заново.
/// Ограничен и сбрасывается целиком (строк хода на экране единицы); зовётся с главного потока,
/// замок — на случай теста или предпросмотра.
final class StepLineCache: @unchecked Sendable {
    static let shared = StepLineCache()
    private static let limit = 64

    private let lock = NSLock()
    private var items: [String: Step] = [:]

    func step(for line: String) -> Step {
        lock.lock()
        if let hit = items[line] {
            lock.unlock()
            return hit
        }
        lock.unlock()
        let made = StepText.toolLine(line)
        lock.lock()
        if items.count >= Self.limit { items.removeAll(keepingCapacity: true) }
        items[line] = made
        lock.unlock()
        return made
    }
}
