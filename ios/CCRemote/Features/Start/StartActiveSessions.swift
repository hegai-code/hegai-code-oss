import SwiftUI
import CCRemoteKit

/// Home uses activity metadata only; opening it never fetches transcripts.
struct StartActiveSessions: View {
    @Environment(CentralClient.self) private var client
    @Environment(Router.self) private var router
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// The shell's prepared corpus — the always-mounted drawer keeps it current.
    /// This screen used to build a second `DrawerModel` of its own: the same
    /// fleet-wide grouping, again, on every inventory and activity frame.
    @Environment(DrawerModel.self) private var model
    @State private var activeExpanded = false
    @State private var recentExpanded: Bool?
    @ScaledMetric(relativeTo: .subheadline) private var estimatedRowHeight: CGFloat = 56

    var body: some View {
        let sessions = HomeSessions(corpus: model.corpus, completions: client.completionReads.completed,
                                    unread: client.completionReads.unread)
        let active = sessions.attention + sessions.working
        GeometryReader { geometry in
            let total = active.count + sessions.completed.count
            let headers = (active.isEmpty ? 0 : 1) + (sessions.completed.isEmpty ? 0 : 1)
            let headerHeight = max(Theme.tapTarget, estimatedRowHeight * 0.65)
            let chrome = CGFloat(headers) * headerHeight + Theme.s6 + (headers > 1 ? Theme.s4 : 0)
            let compact = total > 4 || CGFloat(total) * estimatedRowHeight + chrome > geometry.size.height
            let preview = compact ? min(3, max(0, Int((geometry.size.height - chrome - Theme.tapTarget) / estimatedRowHeight))) : active.count
            let activeOverflow = active.count > preview
            let recentOpen = recentExpanded ?? !compact
            ScrollView {
                VStack(alignment: .leading, spacing: Theme.s4) {
                    if !active.isEmpty {
                        VStack(alignment: .leading, spacing: Theme.s1) {
                            if activeOverflow {
                                Button { toggle { activeExpanded.toggle() } } label: {
                                    heading("Сейчас в работе", count: active.count, open: activeExpanded,
                                            dot: sessions.attention.isEmpty ? nil : Theme.drawerBlue)
                                }
                                .buttonStyle(.plain).accessibilityIdentifier("start.active.toggle")
                                .accessibilityValue("\(activeExpanded ? "Развёрнуто" : "Показано \(preview) из \(active.count)")\(sessions.attention.isEmpty ? "" : ", есть запросы решения")")
                            } else {
                                heading("Сейчас в работе", count: nil, open: nil, dot: nil)
                            }
                            LazyVStack(spacing: Theme.s1) {
                                ForEach(activeExpanded ? active : Array(active.prefix(preview))) { row($0) }
                            }
                            if activeOverflow, !activeExpanded, preview > 0 {
                                Button { toggle { activeExpanded = true } } label: {
                                    Text("Показать ещё \(active.count - preview)")
                                        .font(.system(.subheadline)).foregroundStyle(Theme.textMuted)
                                        .frame(maxWidth: .infinity, minHeight: Theme.tapTarget, alignment: .leading)
                                        .contentShape(Rectangle())
                                }.buttonStyle(.plain).accessibilityIdentifier("start.active.more")
                            }
                        }
                    }
                    if !sessions.completed.isEmpty {
                        VStack(alignment: .leading, spacing: Theme.s1) {
                            Button { toggle { recentExpanded = !recentOpen } } label: {
                                heading("Недавно завершены", count: sessions.completed.count, open: recentOpen,
                                        dot: sessions.completed.contains { client.completionReads.unread[$0.id] != nil }
                                        ? Theme.drawerCompleted : nil)
                            }
                            .buttonStyle(.plain).accessibilityIdentifier("start.recent.toggle")
                            .accessibilityValue("\(recentOpen ? "Развёрнуто" : "Свёрнуто")\(sessions.completed.contains { client.completionReads.unread[$0.id] != nil } ? ", есть непрочитанные ответы" : "")")
                            if recentOpen {
                                LazyVStack(spacing: Theme.s1) { ForEach(sessions.completed) { row($0) } }
                            }
                        }
                    }
                    if sessions.attention.isEmpty && sessions.working.isEmpty && sessions.completed.isEmpty {
                        Text(client.status == .open || client.fleetIsCached ? "Здесь появятся ваши задачи и результаты" : "Подключаемся к вашим задачам…")
                            .font(SettingsStyle.body).foregroundStyle(Theme.textMuted)
                            .frame(maxWidth: .infinity).padding(.vertical, Theme.s6)
                    }
                }
                .padding(.horizontal, Theme.s6).padding(.vertical, Theme.s3)
                .frame(maxWidth: 560).frame(maxWidth: .infinity)
            }
            .scrollIndicators(.hidden).scrollDismissesKeyboard(.interactively).unifiedScrollEdges()
            .accessibilityIdentifier("start.activeList")
        }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillShowNotification)) { _ in
            activeExpanded = false; recentExpanded = nil
        }
    }

    private func heading(_ title: String, count: Int?, open: Bool?, dot: Color?) -> some View {
        HStack(spacing: Theme.s2) {
            Text(title).font(.system(.subheadline, weight: .semibold)).accessibilityAddTraits(.isHeader)
            Spacer(minLength: Theme.s2)
            if let dot { Circle().fill(dot).frame(width: 6, height: 6).accessibilityHidden(true) }
            if let count { Text("\(count)").font(.system(.caption)).monospacedDigit() }
            if let open {
                Image(systemName: open ? "chevron.up" : "chevron.down")
                    .font(.system(size: 11, weight: .medium)).accessibilityHidden(true)
            }
        }
        .foregroundStyle(Theme.textMuted).frame(minHeight: Theme.tapTarget).contentShape(Rectangle())
    }

    private func toggle(_ change: () -> Void) {
        withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.2), change)
        Haptics.light()
    }

    private func row(_ item: SessionItem) -> some View {
        let title = client.navigationTitles.label(machineId: item.machineId, session: item.session)
        let context = "\(DrawerModel.projectName(item.session)) / \(item.machineName)"
        let run = model.corpus.runs[item.id]
        let state = item.session.activityState(run: run) ?? .idle
        let completion = client.completionReads.completed[item.id]
        let unread = client.completionReads.unread[item.id] != nil
        return Button {
            router.openSession(machineId: item.machineId, sessionId: item.session.sessionId)
            Haptics.light()
        } label: {
            HStack(spacing: Theme.s3) {
                Group {
                    if state == .working { SessionActivityIcon(isCodex: item.session.isCodex, isOpenCode: item.session.isOpenCode, size: 18) }
                    else if state == .needs_attention || unread {
                        Circle().fill(state == .needs_attention ? Theme.drawerBlue : Theme.drawerCompleted)
                            .frame(width: 8, height: 8)
                    } else {
                        Image(systemName: "checkmark").font(.system(.caption)).foregroundStyle(Theme.textMuted)
                    }
                }.frame(width: 18).accessibilityHidden(true)
                VStack(alignment: .leading, spacing: Theme.s1) {
                    Text(title).font(.system(.subheadline, weight: .medium))
                        .foregroundStyle(Theme.text).lineLimit(1)
                    Text(context).font(.system(.caption)).foregroundStyle(Theme.textMuted)
                        .lineLimit(1).truncationMode(.middle)
                }.frame(maxWidth: .infinity, alignment: .leading)
                if state == .idle, let stamp = completion?.at ?? client.completionReads.unread[item.id] {
                    TimelineView(.periodic(from: .now, by: 60)) { timeline in
                        Text(completedAgo(stamp, now: timeline.date))
                    }
                    .font(.system(.caption)).foregroundStyle(Theme.textMuted).fixedSize()
                }
                Image(systemName: "chevron.right").font(.system(size: 11, weight: .medium))
                    .foregroundStyle(Theme.textFaint).accessibilityHidden(true)
            }
            .padding(.vertical, Theme.s2)
            .frame(minHeight: Theme.tapTarget).contentShape(Rectangle())
        }
        .buttonStyle(.plain).accessibilityIdentifier("start.active.\(item.id)")
        .accessibilityLabel("\(title), \(context)")
        .accessibilityValue(state == .working ? "\(item.session.isCodex ? "Codex" : "Claude") работает"
                            : state == .needs_attention
                            ? (run?.pendingTool == "ExitPlanMode" ? "План готов к проверке" : run?.attentionLabel ?? "Ждёт решения")
                            : "\(unread ? "Непрочитанный ответ. " : "Завершена. ")\(completion?.preview ?? "")")
    }

    private func completedAgo(_ stamp: Double, now: Date) -> String {
        let minutes = max(0, Int((now.timeIntervalSince1970 - stamp / 1000) / 60))
        if minutes < 1 { return "сейчас" }
        if minutes < 60 { return "\(minutes) мин" }
        if minutes < 1440 { return "\(minutes / 60) ч" }
        return "\(minutes / 1440) д"
    }
}
