import Foundation

/// Что стоит в ВЕДУЩЕМ слоте строки сессии — и какими словами строка говорит о
/// своём состоянии.
///
/// Порт `runMark` / `attentionLabel` из `web/src/lib.ts`. Одно определение,
/// потому что ведущий слот во всём продукте говорит на одном языке: прогон в
/// ходу получает молнию, «ждёт меня» и «ошибка» держат квадрат своего цвета, а
/// всё остальное не получает метки вовсе. В вебе это правило было выписано
/// ровно в одном месте (`ProjectList`) — и пикер колонок, до которого оно не
/// доехало, свёл все три состояния к одному булеву и покрасил «работает» и
/// «ждёт меня» одинаково.
///
/// `live` — это АГЕНТ В ХОДУ, а не «сессия открыта»: возобновлённая сессия
/// держит процесс всё время, пока она у тебя открыта, поэтому ключ на нём
/// помечал работающим весь список, и метка перестала что-либо различать.
public enum RunMark: String, Sendable {
    case live, attention, error, none

    public init(_ state: AttentionState?) {
        switch state {
        case .working: self = .live
        case .needs_attention: self = .attention
        case .error: self = .error
        default: self = .none
        }
    }
}

public extension ActiveRunInfo {
    var mark: RunMark { RunMark(state) }
    // `attentionLabel` — чего прогон в `needs_attention` на самом деле ждёт —
    // уже живёт на `ActiveRunInfo` (Models.swift). Он тут не повторяется: хаб
    // поднимает одно состояние на любой запрос инструмента, и слово, которым
    // интерфейс его называет, — единственное, что отличает вопрос от запроса
    // разрешения. Два таких слова разошлись бы.
}

public extension SessionSummary {
    /// Owned runs report through activity; external editors report in inventory.
    func activityState(run: ActiveRunInfo?) -> AttentionState? {
        if let run { return run.state }
        guard livePid != nil else { return nil }
        switch liveStatus {
        case "busy": return .working
        case "waiting": return .needs_attention
        case "idle": return .idle
        default: return nil
        }
    }

    /// Строка состояния под заголовком — что сессия делает прямо сейчас, а если
    /// ничего, то где она живёт.
    ///
    /// Состояние важнее адреса: строка, которая на работающей сессии печатает
    /// имя машины, тратит единственную свою строку на то, что не менялось
    /// неделю. Порядок тот же, что в `ProjectList`.
    func stateLine(run: ActiveRunInfo?, machineName: String,
                   machineOnline: Bool, showMachine: Bool = true,
                   showProject: Bool = false) -> String {
        switch RunMark(activityState(run: run)) {
        case .live:
            // Живой pid — это ЧУЖОЕ окно (редактор, терминал), а не наш ход.
            return isLive ? "открыта в \(entrypoint ?? "редакторе")" : "работает…"
        case .attention:
            guard let run else { return "ждёт решения" }
            if let tool = run.pendingTool, run.pendingKind == "permission" {
                return "\(run.attentionLabel): \(tool)"
            }
            return run.attentionLabel
        case .error:
            return "ошибка — нужен взгляд"
        case .none:
            var parts = [isCodex ? "Codex" : "Claude"]
            if showProject, let project { parts.append(project) }
            if showMachine { parts.append(machineName) }
            if !machineOnline { parts.append("офлайн") }
            return parts.joined(separator: " · ")
        }
    }
}
