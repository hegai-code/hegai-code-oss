import SwiftUI
import CCRemoteKit

/// The menu bar item — the reason a native client beats a browser tab.
///
/// The one job is surfacing the moment an agent needs a human, without a context
/// switch: the count of runs waiting on you is readable from any app, and one
/// click goes straight to the session. Everything else in the panel is there
/// because you are already looking at it.
struct MacMenuBarLabel: View {
    let waiting: Int
    let working: Int

    var body: some View {
        HStack(spacing: 4) {
            Image(systemName: waiting > 0 ? "asterisk.circle.fill" : "asterisk.circle")
            if waiting > 0 {
                Text("\(waiting)")
            } else if working > 0 {
                Text("\(working)")
                    .foregroundStyle(.secondary)
            }
        }
    }
}

/// The popover behind the menu bar item.
struct MacMenuBarPanel: View {
    @Environment(CentralClient.self) private var client
    @Environment(Router.self) private var router
    @Environment(\.openWindow) private var openWindow

    private var waiting: [ActiveRunInfo] {
        client.activeRuns.filter { $0.state == .needs_attention }
    }
    private var working: [ActiveRunInfo] {
        client.activeRuns.filter { $0.state == .working }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Divider()
            if waiting.isEmpty && working.isEmpty {
                Text(client.status == .open ? "Никто не ждёт ответа" : "Нет связи с хабом")
                    .font(.ui(13))
                    .foregroundStyle(Theme.text3)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(Theme.s3)
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        if !waiting.isEmpty {
                            SectionLabel(text: "Ждут ответа").padding(.horizontal, Theme.s3).padding(.top, Theme.s2)
                            ForEach(waiting, id: \.runId) { row($0) }
                        }
                        if !working.isEmpty {
                            SectionLabel(text: "В работе").padding(.horizontal, Theme.s3).padding(.top, Theme.s2)
                            ForEach(working, id: \.runId) { row($0) }
                        }
                    }
                    .padding(.bottom, Theme.s2)
                }
                .frame(maxHeight: 320)
            }
            Divider()
            footer
        }
        .frame(width: 320)
        .background(Theme.bg)
    }

    private var header: some View {
        HStack(spacing: Theme.s2) {
            HegaiMark(size: 16).foregroundStyle(Theme.primary)
            Text("Hegai Code").font(.ui(13, weight: .semibold)).foregroundStyle(Theme.text)
            Spacer()
            OnlineDot(online: client.status == .open, size: Theme.statusDot)
        }
        .padding(Theme.s3)
    }

    private func row(_ run: ActiveRunInfo) -> some View {
        Button {
            router.openSession(machineId: run.machineId, sessionId: run.sessionId)
            openWindow(id: "main")
            NSApplication.shared.activate(ignoringOtherApps: true)
        } label: {
            HStack(spacing: Theme.s2) {
                Rectangle()
                    .fill(run.state == .needs_attention ? Theme.primary : Theme.live)
                    .frame(width: Theme.statusDot, height: Theme.statusDot)
                    .clipShape(RoundedRectangle(cornerRadius: Theme.statusDotRadius))
                VStack(alignment: .leading, spacing: 1) {
                    Text(run.macDisplayTitle)
                        .font(.ui(13)).foregroundStyle(Theme.text).lineLimit(1)
                    if let machine = run.machineName {
                        Text(machine).font(.ui(11)).foregroundStyle(Theme.text3).lineLimit(1)
                    }
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, Theme.s3)
            .padding(.vertical, 6)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private var footer: some View {
        HStack {
            Button("Открыть окно") {
                openWindow(id: "main")
                NSApplication.shared.activate(ignoringOtherApps: true)
            }
            .buttonStyle(.plain)
            .font(.ui(12))
            .foregroundStyle(Theme.link)
            Button("Новая сессия") {
                router.startNewSession()
                openWindow(id: "main")
                NSApplication.shared.activate(ignoringOtherApps: true)
            }
            .buttonStyle(.plain)
            .font(.ui(12))
            .foregroundStyle(Theme.link)
            .padding(.leading, Theme.s2)
            Spacer()
            Button("Выйти") { NSApplication.shared.terminate(nil) }
                .buttonStyle(.plain)
                .font(.ui(12))
                .foregroundStyle(Theme.text3)
        }
        .padding(Theme.s3)
    }
}
