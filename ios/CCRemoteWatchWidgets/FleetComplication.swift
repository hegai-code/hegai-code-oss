import SwiftUI
import WidgetKit

/// Counts shown on the face; `nil` when signed out or the hub could not be asked.
struct FleetEntry: TimelineEntry {
    let date: Date
    let waiting: Int?
    let working: Int?

    var line: String {
        guard let waiting, let working else { return "Hegai" }
        return FleetSummary.line(waiting: waiting, working: working)
    }
}

struct FleetProvider: TimelineProvider {
    func placeholder(in context: Context) -> FleetEntry { FleetEntry(date: .now, waiting: 1, working: 2) }

    func getSnapshot(in context: Context, completion: @escaping (FleetEntry) -> Void) {
        completion(placeholder(in: context))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<FleetEntry>) -> Void) {
        Task {
            var entry = FleetEntry(date: .now, waiting: nil, working: nil)
            if let creds = WatchKeychain.load(), let inbox = try? await WatchAPI.fetchInbox(creds) {
                entry = FleetEntry(date: .now, waiting: inbox.waiting, working: inbox.working)
            }
            // The app also reloads the timeline after every inbox fetch and when
            // a notification arrives; this is the floor.
            completion(Timeline(entries: [entry], policy: .after(Date().addingTimeInterval(15 * 60))))
        }
    }
}

struct FleetComplicationView: View {
    @Environment(\.widgetFamily) private var family
    let entry: FleetEntry

    var body: some View {
        switch family {
        case .accessoryCircular:
            VStack(spacing: 0) {
                Text("\(entry.waiting ?? 0)").font(.title3.weight(.bold))
                Image(systemName: (entry.waiting ?? 0) > 0 ? "bubble.left.fill" : "bolt.fill").font(.caption2)
            }
            .widgetAccentable()
        case .accessoryRectangular:
            VStack(alignment: .leading, spacing: 2) {
                Text("Hegai Code").font(.caption2).foregroundStyle(.secondary)
                Text(entry.waiting.map { FleetSummary.waiting($0) } ?? "—").font(.headline).widgetAccentable()
                Text(entry.working.map { FleetSummary.working($0) } ?? "").font(.caption)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        case .accessoryCorner:
            Text("\(entry.waiting ?? 0)").font(.title3.weight(.bold)).widgetAccentable()
                .widgetLabel { Text(entry.line) }
        default:
            Text(entry.line)
        }
    }
}

struct FleetComplication: Widget {
    let kind = "HegaiFleet"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: FleetProvider()) { entry in
            FleetComplicationView(entry: entry)
                .containerBackground(.fill.tertiary, for: .widget)
        }
        .configurationDisplayName("Hegai Code")
        .description("Сколько сессий ждут ответа и сколько работают.")
        .supportedFamilies([.accessoryCircular, .accessoryRectangular, .accessoryInline, .accessoryCorner])
    }
}

@main
struct HegaiWatchWidgets: WidgetBundle {
    var body: some Widget { FleetComplication() }
}
