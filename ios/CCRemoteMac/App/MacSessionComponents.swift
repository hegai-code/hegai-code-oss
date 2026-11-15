import SwiftUI
import CCRemoteKit

/// The Mac's name for the shared session ref. One encoder (`SessionRoute.id`,
/// `machineId::sessionId`) keeps persisted column refs, live-run lookups and
/// SwiftUI identity byte-for-byte aligned across both apps.
typealias MacSessionKey = SessionRoute

extension ActiveRunInfo {
    var macDisplayTitle: String {
        let cleaned = cleanTitle(title)
        return cleaned.isEmpty ? String(sessionId.prefix(8)) : cleaned
    }
}

struct MacStatusMark: View {
    let color: Color

    var body: some View {
        RoundedRectangle(cornerRadius: Theme.statusDotRadius, style: .continuous)
            .fill(color)
            .frame(width: Theme.statusDot, height: Theme.statusDot)
    }
}

/// The same active-run row appears on Start and Home with only the amount of
/// secondary information changing between the two surfaces.
struct MacActiveRunRow: View {
    enum Presentation {
        case compact
        case detailed
    }

    let run: ActiveRunInfo
    let presentation: Presentation

    @Environment(Router.self) private var router

    var body: some View {
        Button { router.openSession(machineId: run.machineId, sessionId: run.sessionId) } label: {
            HStack(spacing: Theme.s2) {
                MacStatusMark(color: run.state.pillColor)
                titleBlock
                Spacer()
                if case .detailed = presentation, let owner = run.ownerName {
                    Text(owner).font(.mono(10)).foregroundStyle(Theme.text2)
                }
                if let machine = run.machineName {
                    Text(machine).font(.mono(10)).foregroundStyle(Theme.text3)
                }
                if case .compact = presentation {
                    Text(run.state.label).font(.mono(10)).foregroundStyle(Theme.text3)
                }
                Text(RelTime.short(run.since)).font(.mono(10)).foregroundStyle(Theme.text3)
            }
            .padding(.horizontal, Theme.s3).padding(.vertical, Theme.s2)
            .background(Theme.surface, in: RoundedRectangle(cornerRadius: Theme.radiusMd, style: .continuous))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    @ViewBuilder
    private var titleBlock: some View {
        switch presentation {
        case .compact:
            Text(run.macDisplayTitle)
                .font(.ui(13, weight: .medium)).foregroundStyle(Theme.text).lineLimit(1)
        case .detailed:
            VStack(alignment: .leading, spacing: 1) {
                Text(run.macDisplayTitle)
                    .font(.ui(13, weight: .medium)).foregroundStyle(Theme.text).lineLimit(1)
                if let preview = run.preview, !preview.isEmpty {
                    Text(preview).font(.ui(11)).foregroundStyle(Theme.text3).lineLimit(1)
                }
            }
        }
    }
}
