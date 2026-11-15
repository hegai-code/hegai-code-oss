import SwiftUI

/// One session name, shared with the drawer, inside the available toolbar slot.
struct SessionTitle: View {
    let title: String
    let active: Bool
    let isCodex: Bool
    var isOpenCode: Bool = false
    let availableWidth: CGFloat
    @Environment(ConnectionIndicator.self) private var hub: ConnectionIndicator?

    var body: some View {
        if hub?.showConnecting == true {
            // Как в Telegram: пока нет связи, шапка говорит об этом вместо
            // названия — и больше нигде ничего не всплывает.
            ConnectingTitleLabel().headerIsland()
        } else {
            titleIsland
        }
    }

    private var titleIsland: some View {
        TitleWidthLayout(maxWidth: max(80, availableWidth - 136)) {
            HStack(spacing: 5) {
                SessionActivityIcon.title(title, active: active, isCodex: isCodex, isOpenCode: isOpenCode, enlarged: true)
                    .lineLimit(1).truncationMode(.tail)
                    .frame(maxWidth: .infinity)
                .font(.ui(Theme.sizeNavigationTitle, weight: .medium))
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(title)
                .accessibilityIdentifier("session.title")
                .accessibilityValue(active ? (isOpenCode ? "OpenCode работает" : isCodex ? "Codex работает" : "Claude работает") : "")
                Image(systemName: "chevron.down")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(Theme.textFaint)
            }
            .foregroundStyle(Theme.text)
            .padding(.horizontal, Theme.s2)
            .frame(height: Theme.tapTarget)
        }
        .headerIsland()
    }
}

/// Ask for the label's natural width, then offer only the space between the
/// two side islands. Short names shrink; long names use their truncation layout.
private struct TitleWidthLayout: Layout {
    let maxWidth: CGFloat

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        guard let title = subviews.first else { return .zero }
        let ideal = title.sizeThatFits(.unspecified)
        // The principal slot includes an extra 12pt gutter on each side.
        // Reclaim those gutters while retaining UIKit's device-specific outer
        // margins; ignoring the proposal entirely crowds controls on Plus phones.
        let slotWidth = proposal.width.map { $0 + 24 } ?? .infinity
        let width = min(ceil(ideal.width), maxWidth, slotWidth)
        return CGSize(width: width, height: ideal.height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        subviews.first?.place(at: bounds.origin, anchor: .topLeading,
                              proposal: ProposedViewSize(bounds.size))
    }
}
