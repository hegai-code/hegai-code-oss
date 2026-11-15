import SwiftUI
import CCRemoteKit

/// Память on the Mac: the shared list and detail side by side. The views and
/// every bit of data logic live in `CCRemote/Features/Memory`; this file is
/// only the split-window arrangement.
struct MacMemoryPane: View {
    @State private var selectedEntry: MemoryEntry?
    @State private var reloadTick = 0

    var body: some View {
        HSplitView {
            MemoryListView(selectedId: selectedEntry?.id, reloadTick: reloadTick) {
                selectedEntry = $0
            }
            .frame(minWidth: 280, idealWidth: 340, maxWidth: 460)
            Group {
                if let entry = selectedEntry {
                    MemoryDetailView(entry: entry) {
                        selectedEntry = nil
                        reloadTick += 1
                    }
                } else {
                    VStack(spacing: Theme.s2) {
                        Image(systemName: "brain.head.profile").font(.system(size: 28)).foregroundStyle(Theme.text3)
                        Text("Выберите заметку").font(.ui(13, weight: .medium)).foregroundStyle(Theme.text2)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
            .frame(minWidth: 380, maxWidth: .infinity)
        }
        .background(Theme.bg)
    }
}
