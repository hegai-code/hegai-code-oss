import SwiftUI

// The session screen's infographics (docs/WATCH.md §7): what is going on in a
// glance, before any text. Colours are the theme's: ember = needs you,
// green = working, red = failed, ivory/muted = quiet.

/// Ring around the plan's «3/7»; a spinner while work runs without a plan;
/// a mark for the quiet states.
struct StatusRing: View {
    let item: WatchInboxItem
    var size: CGFloat = 46

    private var tint: Color { WatchTheme.color(forState: item.state) }

    var body: some View {
        ZStack {
            Circle().stroke(WatchTheme.chip, lineWidth: 5)
            if let p = item.progress, p.total > 0 {
                Circle()
                    .trim(from: 0, to: max(0.02, p.fraction))
                    .stroke(tint, style: StrokeStyle(lineWidth: 5, lineCap: .round))
                    .rotationEffect(.degrees(-90))
                VStack(spacing: -2) {
                    Text("\(min(p.done, p.total))").font(.system(size: 15, weight: .bold, design: .rounded))
                    Text("из \(p.total)").font(.system(size: 9, weight: .medium)).foregroundStyle(WatchTheme.muted)
                }
                .monospacedDigit()
                .foregroundStyle(WatchTheme.ivory)
            } else {
                Circle().stroke(tint.opacity(item.isWorking ? 0 : 1), lineWidth: 5)
                if item.isWorking {
                    ProgressView().tint(tint)
                } else {
                    Image(systemName: glyph).font(.system(size: 17, weight: .bold)).foregroundStyle(tint)
                }
            }
        }
        .frame(width: size, height: size)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibility)
    }

    private var glyph: String {
        switch item.state {
        case "needs_attention": return "exclamationmark"
        case "error": return "xmark"
        default: return "checkmark"
        }
    }

    private var accessibility: String {
        if let p = item.progress, p.total > 0 { return "План: \(p.done) из \(p.total)" }
        return FleetSummary.stateLabel(item.state)
    }
}

/// Top of the session screen: ring, state with a live timer, the step in
/// progress, and chips for context and background work.
struct StatusCard: View {
    let item: WatchInboxItem

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .center, spacing: 8) {
                StatusRing(item: item)
                VStack(alignment: .leading, spacing: 1) {
                    Text(stateLine).font(.caption.weight(.semibold))
                        .foregroundStyle(WatchTheme.color(forState: item.state))
                    timeLine.font(.caption2).monospacedDigit().foregroundStyle(WatchTheme.muted)
                }
                Spacer(minLength: 0)
            }
            Text(item.title).font(.footnote.weight(.semibold)).foregroundStyle(WatchTheme.ivory)
                .lineLimit(3)
            if item.isWorking, let active = item.progress?.active, !active.isEmpty {
                HStack(alignment: .firstTextBaseline, spacing: 4) {
                    Image(systemName: "arrow.forward.circle.fill").font(.caption2)
                        .foregroundStyle(WatchTheme.working)
                    Text(active).font(.caption2).foregroundStyle(WatchTheme.ivory).lineLimit(3)
                }
            }
            chips
        }
        .padding(8)
        .background(WatchTheme.chip.opacity(0.6), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    private var stateLine: String {
        switch item.state {
        case "needs_attention": return "Ждёт тебя"
        case "working": return "Работает"
        case "error": return "Ошибка"
        default: return "Готово"
        }
    }

    /// Live states count up from when they began; quiet ones say how long ago.
    @ViewBuilder private var timeLine: some View {
        if item.isWorking || item.state == "needs_attention",
           let ms = item.startedMs ?? item.sinceMs {
            HStack(spacing: 3) {
                Image(systemName: "timer")
                Text(Date(timeIntervalSince1970: Double(ms) / 1000), style: .timer)
            }
        } else if let t = FleetSummary.relative(ms: item.activityMs) {
            Text(t)
        }
    }

    @ViewBuilder private var chips: some View {
        let hasContext = item.contextPct != nil
        let bg = item.background ?? 0
        if hasContext || bg > 0 {
            HStack(spacing: 6) {
                if let pct = item.contextPct { ContextMeter(percent: pct) }
                if bg > 0 {
                    Label("\(bg)", systemImage: "square.stack.3d.down.right")
                        .font(.caption2).foregroundStyle(WatchTheme.ivory)
                        .padding(.horizontal, 6).padding(.vertical, 2)
                        .background(WatchTheme.chip, in: Capsule())
                        .accessibilityLabel("В фоне: \(bg)")
                }
            }
        }
    }
}

/// «контекст 62%» over a short bar; ember once it is nearly full.
struct ContextMeter: View {
    let percent: Int

    private var clamped: Int { max(0, min(100, percent)) }
    private var tint: Color { clamped >= 80 ? WatchTheme.ember : WatchTheme.ivory.opacity(0.8) }

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text("контекст \(clamped)%").font(.system(size: 10)).monospacedDigit()
                .foregroundStyle(WatchTheme.muted)
            ZStack(alignment: .leading) {
                Capsule().fill(WatchTheme.chip)
                Capsule().fill(tint).frame(width: 64 * CGFloat(clamped) / 100)
            }
            .frame(width: 64, height: 3)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Контекст заполнен на \(clamped) процентов")
    }
}

/// The session's own plan as bullets: done ticked and dimmed, the current
/// step highlighted, the rest hollow.
struct PlanChecklist: View {
    let progress: WatchProgress

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack {
                Text("План").font(.caption.weight(.semibold)).foregroundStyle(WatchTheme.ivory)
                Spacer()
                Text("\(progress.done) из \(progress.total)").font(.caption2).monospacedDigit()
                    .foregroundStyle(WatchTheme.muted)
            }
            PlanBar(fraction: progress.fraction).frame(height: 4)
            ForEach(Array((progress.steps ?? []).enumerated()), id: \.offset) { _, step in
                HStack(alignment: .firstTextBaseline, spacing: 5) {
                    Image(systemName: icon(step.status)).font(.caption2)
                        .foregroundStyle(color(step.status))
                    Text(step.text).font(.caption2)
                        .foregroundStyle(step.status == "completed" ? WatchTheme.muted : WatchTheme.ivory)
                        .fontWeight(step.status == "in_progress" ? .semibold : .regular)
                        .lineLimit(3)
                }
            }
        }
    }

    private func icon(_ status: String) -> String {
        switch status {
        case "completed": return "checkmark.circle.fill"
        case "in_progress": return "circle.inset.filled"
        default: return "circle"
        }
    }

    private func color(_ status: String) -> Color {
        switch status {
        case "completed": return WatchTheme.working
        case "in_progress": return WatchTheme.ember
        default: return WatchTheme.muted
        }
    }
}

/// Thin track with a filled part, for the inbox row and the checklist.
struct PlanBar: View {
    let fraction: Double
    var tint: Color = WatchTheme.working

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Capsule().fill(WatchTheme.chip)
                Capsule().fill(tint).frame(width: max(3, geo.size.width * fraction))
            }
        }
    }
}

/// After a finished turn: what was done, and one-tap «what next».
struct NextStepsView: View {
    let item: WatchInboxItem
    let sending: Bool
    let sent: Bool
    let onSend: (String) -> Void

    @State private var custom = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let summary = item.summary, !summary.isEmpty {
                Text(summary).font(.footnote).foregroundStyle(WatchTheme.ivory)
            } else if let last = item.lastText, !last.isEmpty {
                Text(last).font(.footnote).foregroundStyle(WatchTheme.ivory).lineLimit(8)
            }
            if sent {
                Label("Отправлено", systemImage: "checkmark").font(.footnote)
                    .foregroundStyle(WatchTheme.working)
            }
            let replies = item.replies ?? []
            if !replies.isEmpty {
                Text("Что дальше").font(.caption.weight(.semibold)).foregroundStyle(WatchTheme.muted)
                    .padding(.top, 2)
                // By position: the model may suggest the same reply twice.
                ForEach(Array(replies.enumerated()), id: \.offset) { _, reply in
                    Button {
                        onSend(reply.send)
                    } label: {
                        HStack(alignment: .firstTextBaseline, spacing: 6) {
                            Image(systemName: "arrow.up.circle.fill").foregroundStyle(WatchTheme.ember)
                            VStack(alignment: .leading, spacing: 1) {
                                Text(reply.label)
                                // The label and the text are both the model's: show
                                // what will actually be sent when it says more.
                                if reply.send != reply.label {
                                    Text(reply.send).font(.caption2).fontWeight(.regular)
                                        .foregroundStyle(WatchTheme.muted).lineLimit(3)
                                }
                            }
                        }
                    }
                    .buttonStyle(WatchButtonStyle())
                }
            }
            TextField(replies.isEmpty ? "Ответить" : "Свой ответ", text: $custom)
                .submitLabel(.send)
                .onSubmit {
                    let t = custom.trimmingCharacters(in: .whitespacesAndNewlines)
                    guard !t.isEmpty else { return }
                    onSend(t)
                    custom = ""
                }
        }
        // Once a reply went out the old suggestions are spent: a second tap
        // would start another turn.
        .disabled(sending || sent)
    }
}
