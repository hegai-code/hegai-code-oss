import SwiftUI
import CCRemoteKit

/// A finished answer is not a promise that the user's whole task is done.
enum TurnCompletion {
    static let continuation = "Продолжи текущую задачу и доведи её до конца. Если для продолжения нужен мой ответ, задай конкретный вопрос."

    static func isComplete(history: [HistoryMessage], lines: [TranscriptLine], busy: Bool,
                           connected: Bool, state: AttentionState?, completedAt: Double? = nil,
                           lastModified: Double? = nil, historyConfirmed: Bool = true,
                           linesConfirmed: Bool = true) -> Bool {
        guard connected, !busy, lines.isEmpty || linesConfirmed,
              EnrichTailFinder.tail(history: historyConfirmed ? history : [], lines: lines, busy: false) != nil else { return false }
        if let state { return state == .idle }
        // A removed run can retain a confirmed completion. Only use it with
        // dated, converged history: live timestamps are receipt times, and a
        // newer transcript may already contain another turn's commentary.
        guard lines.isEmpty, !history.isEmpty, let completedAt, completedAt.isFinite,
              let lastModified, lastModified <= completedAt else { return false }
        return history.allSatisfy { message in
            guard let ts = message.ts, ts.isFinite else { return false }
            return ts <= completedAt
        }
    }
}

struct TurnCompletionRow: View {
    var onContinue: (() -> Void)? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.s1) {
            Text("Ответ завершён")
                .font(.ui(Theme.sizeMeta))
                .foregroundStyle(Theme.textMuted)
                .accessibilityIdentifier("turn.completed")
            if let onContinue {
                Button("Продолжить задачу", action: onContinue)
                    .font(.ui(Theme.sizeMeta))
                    .frame(minHeight: 44)
                    .accessibilityIdentifier("turn.continue")
            }
        }
    }
}
