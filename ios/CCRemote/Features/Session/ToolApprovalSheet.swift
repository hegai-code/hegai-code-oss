import SwiftUI
import CCRemoteKit

/// The tool-approval modal — shows the tool + its input for review, then
/// Deny / Allow. Edit/Write inputs get the same Diff/code rendering as chat.
struct ToolApprovalSheet: View {
    let request: ToolRequest
    let onDecide: (Bool) -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Theme.s3) {
                    HStack(spacing: Theme.s2) {
                        ToolSquare(name: request.tool)
                        Text(request.tool).font(.ui(Theme.sizeSmall, weight: .semibold)).foregroundStyle(Theme.text)
                        if let title = request.title, !title.isEmpty {
                            Text(title).font(.ui(Theme.sizeSmall)).foregroundStyle(Theme.textMuted).lineLimit(2)
                        }
                    }
                    inputPreview
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(Theme.s4)
            }
            .background(Theme.bg)
            .navigationTitle("Подтверждение")
            .inlineTitle()
            .safeAreaInset(edge: .bottom) { buttons }
        }
        .sheetSize()
    }

    @ViewBuilder private var inputPreview: some View {
        let input = request.input
        if request.tool == "Edit", let oldS = input["old_string"]?.stringValue {
            if let path = input["file_path"]?.stringValue {
                Text(path).font(.mono(Theme.sizeMicro)).foregroundStyle(Theme.textMuted)
            }
            DiffView(oldStr: oldS, newStr: input["new_string"]?.stringValue ?? "")
        } else if (request.tool == "Write" || request.tool == "NotebookEdit"),
                  let content = input["content"]?.stringValue {
            if let path = input["file_path"]?.stringValue {
                Text(path).font(.mono(Theme.sizeMicro)).foregroundStyle(Theme.textMuted)
            }
            CodeBlock(text: content)
        } else if request.tool == "Bash", let cmd = input["command"]?.stringValue {
            CodeBlock(text: cmd)
        } else {
            CodeBlock(text: input.prettyString)
        }
    }

    private var buttons: some View {
        HStack(spacing: Theme.s3) {
            Button {
                Haptics.rigid(); onDecide(false); dismiss()
            } label: {
                Text("Deny").frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)
            .tint(Theme.red)

            Button {
                Haptics.success(); onDecide(true); dismiss()
            } label: {
                Text("Allow").frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
        }
        .padding(Theme.s3)
        .background(.ultraThinMaterial)
    }
}
