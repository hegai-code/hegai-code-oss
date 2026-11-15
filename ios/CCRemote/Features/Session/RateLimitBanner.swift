import SwiftUI
import CCRemoteKit

/// A small floating notice outside the conversation; never a modal sheet.
struct RateLimitBanner: View {
    let machineId: String
    @Environment(CentralClient.self) private var client
    @Environment(\.scenePhase) private var scenePhase
    @State private var shown: RateLimitNotice?
    @State private var shownKey: String?

    private var presentationKey: String {
        client.storageScope + ":" + machineId + ":" +
            (client.rateLimitNotices.latest[machineId]?.key(machineId: machineId) ?? "")
    }

    var body: some View {
        // Keep a mounted container even before the first notice. An empty
        // conditional Group has no child to receive the appearance/change hooks.
        VStack(spacing: 0) {
            if let shown, shownKey == presentationKey {
                TimelineView(.periodic(from: .now, by: 60)) { context in
                    if shown.isCurrent(now: context.date) {
                        HStack(alignment: .center, spacing: 10) {
                            Image(systemName: shown.rejected ? "exclamationmark.circle" : "gauge.with.dots.needle.67percent")
                                .font(.body)
                                .foregroundStyle(Theme.orangeText)
                                .accessibilityHidden(true)
                            VStack(alignment: .leading, spacing: 3) {
                                Text(shown.message).font(.ui(Theme.sizeMeta, weight: .medium))
                                    .foregroundStyle(Theme.text)
                                if let reset = shown.resetText(now: context.date) {
                                    Text(reset).font(.ui(Theme.sizeMeta)).foregroundStyle(Theme.textMuted)
                                }
                            }
                            .fixedSize(horizontal: false, vertical: true)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .accessibilityElement(children: .combine)
                            Button { self.shown = nil } label: {
                                Image(systemName: "xmark").font(.caption.weight(.semibold))
                                    .foregroundStyle(Theme.textMuted)
                                    .frame(width: 44, height: 44).contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel("Скрыть предупреждение о лимите")
                        }
                        .padding(.leading, 14).padding(.trailing, 2).padding(.vertical, 8)
                        .background(shown.rejected ? Theme.attnSoft : Theme.surfaceRaised,
                                    in: RoundedRectangle(cornerRadius: Theme.radiusLg, style: .continuous))
                        .floating(Theme.shadowSm, radius: Theme.radiusLg)
                        .accessibilityIdentifier("rateLimit.banner")
                        .padding(.horizontal, 16).padding(.bottom, 6)
                    }
                }
            }
        }
        .onChange(of: presentationKey, initial: true) { _, _ in presentIfVisible() }
        .onChange(of: scenePhase) { _, phase in if phase == .active { presentIfVisible() } }
    }

    private func presentIfVisible() {
        guard scenePhase == .active, shownKey != presentationKey else { return }
        shownKey = presentationKey
        shown = client.rateLimitNotices.claim(machineId: machineId)
    }
}
