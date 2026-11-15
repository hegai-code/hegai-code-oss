import Foundation
import CCRemoteKit

/// Pure selection from the already prepared, owned drawer corpus.
struct HomeSessions {
    let attention: [SessionItem]
    let working: [SessionItem]
    let completed: [SessionItem]

    init(corpus: DrawerModel.Corpus, completions: [String: SessionCompletionReads.Completion],
         unread: [String: Double], now: Date = .now) {
        attention = corpus.items.filter { $0.session.activityState(run: corpus.runs[$0.id]) == .needs_attention }
        working = corpus.working
        let idle = corpus.items.filter { item in
            let state = item.session.activityState(run: corpus.runs[item.id])
            return state == nil || state == .idle
        }
        let candidates = idle.filter { item in
            unread[item.id] != nil || completions[item.id].map { now.timeIntervalSince1970 * 1000 - $0.at < 86_400_000 } == true
        }.sorted {
            let a = completions[$0.id]?.at ?? unread[$0.id] ?? 0
            let b = completions[$1.id]?.at ?? unread[$1.id] ?? 0
            return a == b ? $0.id < $1.id : a > b
        }
        // A read receipt changes the dot, not the row's place. Keep all unread
        // results and a bounded tail of recently read ones in completion order.
        let retained = Set(candidates.filter { unread[$0.id] == nil }.prefix(8).map(\.id))
        completed = candidates.filter { unread[$0.id] != nil || retained.contains($0.id) }
    }
}
