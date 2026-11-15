import Foundation
import CCRemoteKit

/// A reading/export snapshot. Only speech and attachment markers belong here;
/// tool output and internal reasoning remain in the transcript's activity sheet.
struct ConversationDocument {
    struct Entry: Identifiable, Equatable {
        let id: String
        let human: Bool
        let text: String
    }

    let entries: [Entry]
    let limited: Bool

    init(history: [HistoryMessage], lines: [TranscriptLine], limited: Bool) {
        let saved = history.compactMap { message -> Entry? in
            guard message.role == .user || message.role == .assistant else { return nil }
            let text = cleanBlocks(message.blocks).compactMap { block -> String? in
                switch block {
                case .text(let text): return text
                case .image: return "[Фото]"
                default: return nil
                }
            }.joined(separator: "\n\n").trimmingCharacters(in: .newlines)
            guard !text.isEmpty else { return nil }
            return Entry(id: "history-\(message.uuid)", human: message.role == .user, text: text)
        }
        let live = TranscriptReconciler().reconcile(history: history, lines: lines).compactMap { line -> Entry? in
            guard line.kind == .user || line.kind == .assistant else { return nil }
            let text = ([stripHarnessNoise(line.text)] + line.images.map { _ in "[Фото]" })
                .filter { !$0.isEmpty }.joined(separator: "\n\n")
                .trimmingCharacters(in: .newlines)
            guard !text.isEmpty else { return nil }
            return Entry(id: "live-\(line.id)", human: line.kind == .user, text: text)
        }
        entries = saved + live
        self.limited = limited
    }

    func matching(_ query: String) -> [Entry] {
        let query = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else { return [] }
        return entries.filter { $0.text.localizedStandardContains(query) }
    }

    func markdown(title: String, agent: String) -> String {
        let note = limited ? "> Доступен только хвост истории (до 2000 сообщений).\n\n" : ""
        return "# \(title.replacingOccurrences(of: "\n", with: " "))\n\n" + note
            + entries.map { "## \($0.human ? "Пользователь" : agent)\n\n\($0.text)" }
                .joined(separator: "\n\n---\n\n") + "\n"
    }
}
