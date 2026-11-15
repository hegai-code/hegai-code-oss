import ActivityKit
import SwiftUI
import WidgetKit

// The one fleet-wide Live Activity (WATCH.md §5). The hub starts, updates and
// ends it by push; nothing here starts anything.

private enum Palette {
    static let ember = Color(red: 1.0, green: 0x7F / 255, blue: 0x57 / 255)
    static let working = Color(red: 0x5B / 255, green: 0xD4 / 255, blue: 0x77 / 255)
    static func color(_ state: String) -> Color {
        switch state {
        case "needs_attention": return ember
        case "working": return working
        case "error": return .red
        default: return .secondary
        }
    }
}

/// `sinceMs` is the absolute moment (epoch ms) the item entered its state
/// (docs/WATCH.md §5), so a relative timer keeps counting between pushes.
private func startDate(_ item: HegaiFleetAttributes.ContentState.Item,
                       _ state: HegaiFleetAttributes.ContentState) -> Date {
    Date(timeIntervalSince1970: Double(item.sinceMs) / 1000)
}

private struct ItemRow: View {
    let item: HegaiFleetAttributes.ContentState.Item
    let state: HegaiFleetAttributes.ContentState
    let stale: Bool

    var body: some View {
        HStack(spacing: 6) {
            Circle().fill(stale ? Color.secondary : Palette.color(item.state)).frame(width: 8, height: 8)
            Text(item.title).lineLimit(1).font(.subheadline)
                .foregroundStyle(stale ? Color.secondary : Color.primary)
            Spacer(minLength: 4)
            if !stale, let done = item.planDone, let total = item.planTotal, total > 0 {
                PlanMeter(done: min(done, total), total: total)
            }
            if stale {
                // A running timer here would claim the work is still going.
                EmptyView()
            } else if item.state == "needs_attention" || item.state == "working" {
                Text(startDate(item, state), style: .timer)
                    .monospacedDigit().font(.caption).foregroundStyle(.secondary)
                    .frame(maxWidth: 52, alignment: .trailing)
            } else {
                Text(FleetSummary.stateLabel(item.state)).font(.caption).foregroundStyle(.secondary)
            }
        }
    }
}

/// «3/7» and a short track: how far along the session's own plan is. Ember on
/// a faint track, like the app's plan strip (ios/DESIGN.md «Полоса плана»).
private struct PlanMeter: View {
    let done: Int
    let total: Int

    var body: some View {
        HStack(spacing: 4) {
            Text("\(done)/\(total)").monospacedDigit().font(.caption).foregroundStyle(.secondary)
            ZStack(alignment: .leading) {
                Capsule().fill(Color.secondary.opacity(0.3))
                Capsule().fill(Palette.ember)
                    .frame(width: 28 * CGFloat(done) / CGFloat(total))
            }
            .frame(width: 28, height: 3)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("План: \(done) из \(total)")
    }
}

/// Rows the lock screen lists; the hub sends at most this many
/// (`live_activity::ITEMS_MAX`). The Dynamic Island keeps three — it is shorter.
private let lockScreenRows = 5
private let islandRows = 3

struct FleetLockScreenView: View {
    let state: HegaiFleetAttributes.ContentState
    let stale: Bool

    var body: some View {
        FamilyAwareView(state: state, stale: stale)
    }
}

private struct FamilyAwareView: View {
    @Environment(\.activityFamily) private var family
    let state: HegaiFleetAttributes.ContentState
    let stale: Bool

    var body: some View {
        switch family {
        case .small: SmallView(state: state, stale: stale)
        default: FullView(state: state, stale: stale)
        }
    }
}

/// The header line and its color: past the stale date the counts are history.
private func summaryLine(_ state: HegaiFleetAttributes.ContentState, stale: Bool) -> String {
    stale ? FleetSummary.staleLine : FleetSummary.line(waiting: state.waiting, working: state.working)
}

private func summaryColor(_ state: HegaiFleetAttributes.ContentState, stale: Bool) -> Color {
    if stale { return .secondary }
    return state.waiting > 0 ? Palette.ember : Palette.working
}

private struct FullView: View {
    let state: HegaiFleetAttributes.ContentState
    let stale: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text("Hegai Code").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                Spacer()
                Text(summaryLine(state, stale: stale))
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(summaryColor(state, stale: stale))
            }
            ForEach(Array(state.items.prefix(lockScreenRows).enumerated()), id: \.offset) { _, item in
                ItemRow(item: item, state: state, stale: stale)
            }
        }
        .padding(14)
    }
}

/// Smart Stack on the watch: counts and the first title, nothing else.
private struct SmallView: View {
    let state: HegaiFleetAttributes.ContentState
    let stale: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(summaryLine(state, stale: stale))
                .font(.headline)
                .foregroundStyle(summaryColor(state, stale: stale))
            if let first = state.items.first {
                Text(first.title).font(.caption).lineLimit(2)
                    .foregroundStyle(stale ? Color.secondary : Color.primary)
            }
        }
    }
}

private func island(_ state: HegaiFleetAttributes.ContentState, stale: Bool) -> DynamicIsland {
    let attention = !stale && state.waiting > 0
    // Past the stale date a number would read as work in progress.
    let count = stale ? "–" : "\(state.waiting > 0 ? state.waiting : state.working)"
    return DynamicIsland {
        DynamicIslandExpandedRegion(.leading) {
            Label(stale ? "–" : "\(state.waiting)", systemImage: "bubble.left.fill")
                .foregroundStyle(attention ? Palette.ember : .secondary)
        }
        DynamicIslandExpandedRegion(.trailing) {
            Label(stale ? "–" : "\(state.working)", systemImage: "bolt.fill")
                .foregroundStyle(stale ? Color.secondary : Palette.working)
        }
        DynamicIslandExpandedRegion(.bottom) {
            VStack(alignment: .leading, spacing: 4) {
                if stale {
                    Text(FleetSummary.staleLine).font(.caption).foregroundStyle(.secondary)
                }
                ForEach(Array(state.items.prefix(islandRows).enumerated()), id: \.offset) { _, item in
                    ItemRow(item: item, state: state, stale: stale)
                }
            }
        }
    } compactLeading: {
        Image(systemName: "bubble.left.fill").foregroundStyle(attention ? Palette.ember : .secondary)
    } compactTrailing: {
        Text(count).monospacedDigit()
    } minimal: {
        Text(count).monospacedDigit()
            .foregroundStyle(summaryColor(state, stale: stale))
    }
}

/// The extension targets iOS 18 (project.yml): `supplementalActivityFamilies`
/// cannot be applied conditionally (it changes the opaque configuration type, and
/// WidgetBundleBuilder has no either-branch), and on iOS 17 the activity simply
/// does not appear. The app itself still runs on 17.
struct FleetLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: HegaiFleetAttributes.self) { context in
            FleetLockScreenView(state: context.state, stale: context.isStale)
        } dynamicIsland: { context in
            island(context.state, stale: context.isStale)
        }
        // Also offered to the watch Smart Stack.
        .supplementalActivityFamilies([.small])
    }
}

@main
struct HegaiWidgets: WidgetBundle {
    var body: some Widget { FleetLiveActivity() }
}
