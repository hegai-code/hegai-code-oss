import SwiftUI
import CCRemoteKit

/// Claude ↔ Codex (↔ OpenCode) at session start (web `StartScreen` picker).
///
/// For a workspace member the hub pins Codex whatever the wire asks — Claude on
/// their machine would spend the device owner's login — so they see the fact as
/// a chip, not a control. Shared by the iPhone start screen and the Mac start
/// pane; `height` is the control's outer height.
struct AgentPicker: View {
    let isMember: Bool
    var height: CGFloat = 30
    /// What the fixed chip says. «Codex · шлюз» for a member or a sandbox;
    /// plain «Codex» on a machine whose owner switched Claude off.
    var fixedLabel = "Codex · шлюз"
    /// «OpenCode» is offered only when the machine's Codex list has `pool-go/`
    /// rows. It is a client-local choice: the wire still says "codex".
    var showsOpenCode = false
    /// The choice actually in force. Differs from the remembered one when
    /// "opencode" is remembered but this machine has no Go rows.
    var selection: String?
    /// Ручной тап — в том числе по уже выбранному сегменту: экран по нему
    /// снимает автоподмену рантайма, которой значение в настройках не меняется.
    var onPick: ((String) -> Void)?
    @Environment(AppSettings.self) private var settings

    var body: some View {
        if isMember {
            Chip(text: fixedLabel, mono: false)
        } else {
            HStack(spacing: 2) {
                segment("Claude", value: "claude")
                segment("Codex", value: "codex")
                if showsOpenCode { segment("OpenCode", value: AgentModels.opencode) }
            }
            .padding(2)
            .background(Theme.chip,
                        in: RoundedRectangle(cornerRadius: Theme.radiusSm, style: .continuous))
        }
    }

    private func segment(_ label: String, value: String) -> some View {
        let active = (selection ?? settings.preferredAgent) == value
        return Button { settings.preferredAgent = value; onPick?(value); Haptics.light() } label: {
            Text(label)
                .font(.ui(Theme.sizeMicro, weight: .medium))
                .foregroundStyle(active ? Theme.onSelect : Theme.textMuted)
                .padding(.horizontal, Theme.s2)
                .frame(height: height - 4)
                .background(active ? Theme.select : Color.clear,
                            in: RoundedRectangle(cornerRadius: Theme.radiusSm - 2, style: .continuous))
        }
        .buttonStyle(.plain)
    }
}
