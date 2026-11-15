import SwiftUI
import CCRemoteKit

/// Колонки — 2–4 sessions side by side (web `SessionColumns.tsx`). The set
/// lives in the shared `ColumnsModel`; each pane is a `SessionPaneView` on its
/// own scoped `CentralClient` (`role: .pane`) — exactly the web's "own socket
/// per column" pattern — so streams, approvals and takeover work in every pane
/// at once without touching the single-writer rules. The phone shows the same
/// set as swipeable pages (`ColumnsPagerView`).
struct MacColumnsPane: View {
    @Environment(CentralClient.self) private var client
    @Environment(AppSettings.self) private var settings
    @State private var showPicker = false

    private var model: ColumnsModel { ColumnsModel(settings: settings, client: client) }

    var body: some View {
        let model = self.model
        let refs = model.refs
        VStack(spacing: 0) {
            toolbar(model)
            Divider()
            if refs.isEmpty {
                ColumnsEmptyState(cap: ColumnsModel.maximumColumnCount,
                                  canFill: model.canFillWithActive,
                                  onFill: { model.fillWithActive() },
                                  onAdd: { showPicker = true })
            } else {
                HStack(spacing: 0) {
                    ForEach(refs) { ref in
                        Group {
                            if model.isStale(ref) {
                                ColumnStaleTile(ref: ref) { model.remove(ref) }
                            } else {
                                // The pane's header carries its status and close
                                // button — no bar of its own.
                                SessionPaneView(machineId: ref.machineId, sessionId: ref.sessionId) {
                                    model.remove(ref)
                                }
                            }
                        }
                        .frame(minWidth: 360, maxWidth: .infinity, maxHeight: .infinity)
                        .id(ref.id)
                        if ref != refs.last { Divider() }
                    }
                    if !model.isFull { addTile }
                }
            }
        }
        .background(Theme.bg)
    }

    // MARK: Chrome

    private func toolbar(_ model: ColumnsModel) -> some View {
        HStack(spacing: Theme.s2) {
            Button("Заполнить активными") { model.fillWithActive() }
                .disabled(!model.canFillWithActive)
            Button("Добавить сессию") { showPicker = true }
                .disabled(model.isFull)
                .popover(isPresented: $showPicker, arrowEdge: .bottom) {
                    ColumnPickerView(model: model,
                                     onPick: { ref in model.add(ref); showPicker = false },
                                     onFill: { model.fillWithActive(); showPicker = false })
                        .frame(width: 400, height: 420)
                }
            Spacer()
            Text("\(model.refs.count)/\(ColumnsModel.maximumColumnCount)")
                .font(.mono(10)).foregroundStyle(Theme.text3)
        }
        .padding(.horizontal, Theme.s4)
        .padding(.vertical, Theme.s2)
        .background(Theme.surface)
    }

    private var addTile: some View {
        Button { showPicker = true } label: {
            VStack(spacing: Theme.s2) {
                Image(systemName: "plus").font(.system(size: 20, weight: .medium))
                    .foregroundStyle(Theme.text3)
                Text("Добавить").font(.ui(12)).foregroundStyle(Theme.text3)
            }
            .frame(width: 120)
            .frame(maxHeight: .infinity)
            .background(Theme.surface2)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}
