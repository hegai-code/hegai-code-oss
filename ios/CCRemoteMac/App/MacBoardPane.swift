import SwiftUI

/// Board destination: the lenses that need no zoom canvas — Таблица (everything
/// as rows), Flow (the kanban by stage) and Роадмап (products on a momentum
/// pipeline).
///
/// «Живое» is gone with `BoardView`. Once Главная grew «В работе» on both
/// platforms it read the same two sources — `activeRuns` plus editor-held
/// `livePid` — with the same dedup, differing only in pivoting by which client
/// opened the run instead of by what the run wants from you, and in having no
/// last message under each row. A strictly weaker copy is a duplicate, not a
/// lens, so it was deleted rather than moved.
struct MacBoardPane: View {
    @State private var lens: Lens = .table

    enum Lens: String, CaseIterable, Identifiable {
        case table, flow, roadmap
        var id: String { rawValue }
        var label: String {
            switch self {
            case .table: return "Таблица"
            case .flow: return "Flow"
            case .roadmap: return "Роадмап"
            }
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: Theme.s2) {
                ForEach(Lens.allCases) { lensOption in
                    FolderChip(title: lensOption.label, active: lens == lensOption) {
                        lens = lensOption
                    }
                }
                Spacer()
            }
            .padding(.horizontal, Theme.s4)
            .padding(.vertical, Theme.s2)
            .background(Theme.surface)
            Divider()
            switch lens {
            case .table: SessionsTableView()
            case .flow: FlowView()
            case .roadmap: RoadmapView()
            }
        }
        .background(Theme.bg)
    }
}
