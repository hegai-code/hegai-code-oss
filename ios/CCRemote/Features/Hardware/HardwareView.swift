import SwiftUI
import CCRemoteKit

/// Таб «Железо» — всё про машины в одном месте: как подключить новую, какие
/// уже есть у этого аккаунта, и что с ними прямо сейчас (телеметрия 30-секундными
/// пробами плюс список процессов по запросу). Телефонная половина
/// `web/src/components/Hardware.tsx` — единственный тяжёлый экран веба, который
/// стоило принести: когда машина ложится, ты редко за столом.
///
/// «Подключить машину» и «Мои устройства» приехали сюда из таба «Аккаунт»
/// (`WorkspaceDevicesSection`). Там они были третьим разговором про железо на
/// экране про личность; здесь — первым разговором про железо на экране про
/// железо.
struct HardwareView: View {
    @Environment(CentralClient.self) private var client
    /// Телеметрию хаб шлёт только пока открыт экран, который её показывает
    /// (`statsOnDemand`): раз в 30 с на машину кадры шли на любом экране.
    @State private var wantsStats = false

    private var machines: [MachineSnapshot] {
        client.machines.sorted {
            $0.online != $1.online ? $0.online
                : $0.machine.name.localizedCaseInsensitiveCompare($1.machine.name) == .orderedAscending
        }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.s5) {
                // Порядок — по тому, зачем сюда заходят. Телеметрия наверху:
                // «что с машиной прямо сейчас» — это девять раз из десяти.
                // Коды подключения и список устройств — администрирование, и
                // оно внизу; наверху девять строк «Отозвать» отодвигали
                // единственный экран, ради которого таб существует, на второй
                // экран прокрутки.
                VStack(alignment: .leading, spacing: Theme.s2) {
                    SettingsSectionHeader(text: "Серверы", count: machines.isEmpty ? nil : machines.count)
                    if machines.isEmpty {
                        Text("Нет подключённых машин.")
                            .font(SettingsStyle.body).foregroundStyle(Theme.drawerSecondary)
                            .frame(maxWidth: .infinity).padding(.vertical, Theme.s8)
                    } else {
                        LazyVStack(spacing: Theme.s3) {
                            ForEach(machines) { snap in
                                MachineCard(snapshot: snap,
                                            stats: client.machineStats[snap.machine.machineId])
                            }
                        }
                    }
                }

                if client.status == .open, !machines.isEmpty {
                    VStack(alignment: .leading, spacing: Theme.s2) {
                        SettingsSectionHeader(text: "Подключение")
                        VStack(spacing: 0) {
                            countRow("В сети", "\(machines.filter(\.online).count) из \(machines.count)")
                            Divider().overlay(Theme.divider)
                            countRow("Активных задач", "\(client.activeRuns.count)")
                        }
                        .settingsCard()
                    }
                }

                if client.status == .open {
                    VStack(alignment: .leading, spacing: Theme.s2) {
                        SettingsSectionHeader(text: "Устройства пространства")
                        WorkspaceDevicesSection()
                            .settingsCard()
                    }
                }
            }
            .padding(Theme.s4)
            .frame(maxWidth: Theme.readingWidth)
            .frame(maxWidth: .infinity)
        }
        .background(Theme.settingsBackground)
        .onAppear {
            guard !wantsStats else { return }
            wantsStats = true
            client.setStatsInterest(true)
        }
        .onDisappear {
            guard wantsStats else { return }
            wantsStats = false
            client.setStatsInterest(false)
        }
    }

    private func countRow(_ label: String, _ value: String) -> some View {
        HStack {
            Text(label).font(SettingsStyle.body).foregroundStyle(Theme.text)
            Spacer()
            Text(value).font(SettingsStyle.body).foregroundStyle(Theme.textMuted)
                .monospacedDigit()
        }
        .padding(.horizontal, Theme.s3)
        .frame(minHeight: SettingsStyle.rowHeight)
    }
}

private struct MachineCard: View {
    let snapshot: MachineSnapshot
    let stats: MachineStats?
    @Environment(CentralClient.self) private var client
    @State private var showProcs = false
    @State private var expanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.s3) {
            Button { withAnimation(Theme.easeFast) { expanded.toggle() } } label: {
                HStack(spacing: Theme.s3) {
                    Image(systemName: "desktopcomputer").font(.system(.body))
                    VStack(alignment: .leading, spacing: Theme.s1) {
                        Text(snapshot.machine.name).font(SettingsStyle.heading).foregroundStyle(Theme.text)
                        Text(snapshot.online ? "В сети" : "Не в сети").font(SettingsStyle.caption)
                            .foregroundStyle(snapshot.online ? Theme.positive : Theme.textMuted)
                    }.frame(maxWidth: .infinity, alignment: .leading)
                    Image(systemName: expanded ? "chevron.down" : "chevron.right")
                        .font(.system(.caption, weight: .semibold)).foregroundStyle(Theme.textFaint)
                }.frame(minHeight: SettingsStyle.rowHeight).contentShape(Rectangle())
            }.buttonStyle(.plain).accessibilityIdentifier("hardware.machine.\(snapshot.machine.machineId)")
            MachinePrivacyRow(machineId: snapshot.machine.machineId, machineName: snapshot.machine.name)
            if expanded {
                if let stats {
                    Text("\(stats.platform) · аптайм \(uptime(stats.uptimeSec))")
                        .font(SettingsStyle.caption).foregroundStyle(Theme.drawerSecondary)
                        .lineLimit(1)

                    meter("CPU", percent: stats.cpuPercent,
                          value: "\(Int(stats.cpuPercent))% · la \(String(format: "%.2f", stats.load1))")
                    meter("Память", percent: pct(stats.memUsed, stats.memTotal),
                          value: "\(bytes(stats.memUsed)) / \(bytes(stats.memTotal))")
                    if stats.swapTotal > 0 {
                        meter("Swap", percent: pct(stats.swapUsed, stats.swapTotal),
                              value: "\(bytes(stats.swapUsed)) / \(bytes(stats.swapTotal))")
                    }
                    if stats.diskTotal > 0 {
                        meter("Диск /", percent: pct(stats.diskUsed, stats.diskTotal),
                              value: "\(bytes(stats.diskUsed)) / \(bytes(stats.diskTotal))")
                    }
                    // Строка агента и кнопка процессов переносятся: на 375 с крупным
                    // системным шрифтом они не стояли в одну строку и выдавливали
                    // кнопку за край карточки.
                    ViewThatFits(in: .horizontal) {
                        HStack(spacing: Theme.s2) { agentLine; Spacer(); procButton }
                        VStack(alignment: .leading, spacing: Theme.s2) {
                            agentLine
                            procButton
                        }
                    }
                    if showProcs {
                        Divider().overlay(Theme.divider)
                        ProcessList(machineId: snapshot.machine.machineId)
                    }
                } else {
                    Text(snapshot.online ? "Диагностика пока недоступна."
                                         : "Сервер не в сети.")
                        .font(SettingsStyle.caption).foregroundStyle(Theme.drawerSecondary)
                }
            }
        }
        .padding(Theme.s4)
        .frame(maxWidth: .infinity, alignment: .leading)
        .settingsCard()
    }

    @ViewBuilder private var agentLine: some View {
        if let stats {
            Text("агент \(bytes(stats.agentRss)) · \(String(format: "%.1f", stats.agentCpuPercent))% CPU")
                .font(SettingsStyle.caption).foregroundStyle(Theme.drawerSecondary)
        }
    }

    @ViewBuilder private var procButton: some View {
        if snapshot.online {
            Button { withAnimation(Theme.easeFast) { showProcs.toggle() } } label: {
                Text(showProcs ? "Скрыть процессы" : "Процессы")
                    .font(SettingsStyle.heading).foregroundStyle(Theme.link)
                    .frame(minHeight: SettingsStyle.rowHeight)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        }
    }

    /// Прибор: подпись, значение моно-строкой и полоса с КВАДРАТНЫМИ концами.
    /// Была капсула — то есть пилюля на том, что пилюлей быть не имеет права
    /// (лицензия только у тегов, бейджей и активных фильтр-чипов), и у неё
    /// закруглялся сам ноль: пустая шкала выглядела как немного занятая.
    private func meter(_ label: String, percent: Double, value: String) -> some View {
        let p = min(max(percent, 0), 100)
        return VStack(spacing: 3) {
            HStack {
                Text(label).font(SettingsStyle.caption).foregroundStyle(Theme.textMuted)
                Spacer()
                Text(value).font(SettingsStyle.caption).foregroundStyle(Theme.textMuted)
            }
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Rectangle().fill(Theme.chip)
                    Rectangle()
                        .fill(p >= 90 ? Theme.red : p >= 75 ? Theme.orange : Theme.positive)
                        .frame(width: geo.size.width * p / 100)
                }
            }
            .frame(height: 6)
            .clipShape(RoundedRectangle(cornerRadius: Theme.statusDotRadius, style: .continuous))
        }
    }

    private func pct(_ used: Double, _ total: Double) -> Double {
        total > 0 ? used / total * 100 : 0
    }
    private func bytes(_ n: Double) -> String {
        let gb = 1024.0 * 1024 * 1024, mb = 1024.0 * 1024
        if n >= 10 * gb { return "\(Int(n / gb))G" }
        if n >= gb { return String(format: "%.1fG", n / gb) }
        return "\(max(0, Int(n / mb)))M"
    }
    private func uptime(_ sec: Double) -> String {
        let d = Int(sec / 86_400), h = Int(sec.truncatingRemainder(dividingBy: 86_400) / 3600)
        if d > 0 { return "\(d)д \(h)ч" }
        let m = Int(sec.truncatingRemainder(dividingBy: 3600) / 60)
        return h > 0 ? "\(h)ч \(m)м" : "\(m)м"
    }
}

/// Процессы, которые стоит заметить на нагруженной машине.
private let hotCommand = try? NSRegularExpression(
    pattern: "claude|\\.vscode-server|code-server|vscode|codex", options: .caseInsensitive)

private struct ProcessList: View {
    let machineId: String
    @Environment(CentralClient.self) private var client

    @State private var procs: [ProcessSample]?
    @State private var filter = ""
    @State private var error: String?
    @State private var busyPid: Int?
    @State private var confirmKill: ProcessSample?

    private var shown: [ProcessSample] {
        let q = filter.trimmingCharacters(in: .whitespaces).lowercased()
        guard !q.isEmpty else { return procs ?? [] }
        return (procs ?? []).filter { $0.command.lowercased().contains(q) || "\($0.pid)".contains(q) }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.s2) {
            HStack(spacing: Theme.s2) {
                // Поле ввода — колодец канона (`surfaceSunken`) и прямоугольник
                // радиусом 12, а не капсула.
                TextField("Фильтр (vscode, claude, node)", text: $filter)
                    .textFieldStyle(.plain).font(SettingsStyle.body)
                    .autocorrectionDisabled().plainTextEntry()
                    .padding(.horizontal, Theme.s3)
                    .frame(minHeight: 36)
                    .background(Theme.surfaceSunken,
                                in: RoundedRectangle(cornerRadius: Theme.radiusMd, style: .continuous))
                Button { Task { await refresh() } } label: {
                    Image(systemName: "arrow.clockwise")
                        .font(.system(size: 15, weight: .medium))  // бокс глифа
                        .foregroundStyle(Theme.textMuted)
                        .frame(width: Theme.tapTarget, height: Theme.tapTarget)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Перечитать процессы")
            }
            if let error {
                Text(error).font(SettingsStyle.caption).foregroundStyle(Theme.negative)
            }
            if procs == nil {
                Text("Загружаю…").font(SettingsStyle.caption).foregroundStyle(Theme.drawerSecondary)
            } else if shown.isEmpty {
                Text("Ничего не найдено.").font(SettingsStyle.caption).foregroundStyle(Theme.drawerSecondary)
            } else {
                ForEach(shown.prefix(60)) { p in
                    row(p)
                }
            }
        }
        .task { await refresh() }
        .confirmationDialog(confirmKill.map { "Завершить процесс \($0.pid)?" } ?? "",
                            isPresented: Binding(get: { confirmKill != nil },
                                                 set: { if !$0 { confirmKill = nil } }),
                            titleVisibility: .visible) {
            if let p = confirmKill {
                Button("TERM", role: .destructive) { Task { await kill(p, signal: "TERM") } }
                Button("KILL (принудительно)", role: .destructive) { Task { await kill(p, signal: "KILL") } }
                Button("Отмена", role: .cancel) {}
            }
        } message: {
            if let p = confirmKill { Text(String(p.command.prefix(120))) }
        }
    }

    private func row(_ p: ProcessSample) -> some View {
        let hot = hotCommand?.firstMatch(in: p.command,
                                         range: NSRange(p.command.startIndex..., in: p.command)) != nil
        return HStack(spacing: Theme.s2) {
            Text("\(p.pid)").font(SettingsStyle.caption).foregroundStyle(Theme.drawerSecondary)
                .monospacedDigit()
                .frame(minWidth: 52, alignment: .leading)
            Text(String(format: "%.0f%%", p.cpu)).font(SettingsStyle.caption)
                .foregroundStyle(Theme.textMuted).monospacedDigit()
                .frame(minWidth: 42, alignment: .trailing)
            Text(p.command)
                .font(SettingsStyle.caption).foregroundStyle(hot ? Theme.text : Theme.textMuted)
                .lineLimit(1).truncationMode(.middle)
                .frame(maxWidth: .infinity, alignment: .leading)
            Button { confirmKill = p } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 12, weight: .semibold))  // бокс глифа
                    .foregroundStyle(Theme.negative)
                    .frame(width: Theme.tapTarget, height: Theme.tapTarget)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(busyPid == p.pid)
            .accessibilityLabel("Завершить процесс \(p.pid)")
        }
        .background(hot ? Theme.surfaceSunken : Color.clear)
    }

    private func refresh() async {
        error = nil
        do { procs = try await client.listProcesses(machineId: machineId) }
        catch { self.error = error.localizedDescription }
    }

    private func kill(_ p: ProcessSample, signal: String) async {
        busyPid = p.pid
        defer { busyPid = nil }
        do {
            let result = try await client.killProcess(machineId: machineId, pid: p.pid, signal: signal)
            if !result.ok { error = result.error ?? "не удалось завершить процесс" }
            // TERM нужен момент, чтобы дойти, прежде чем список его не покажет.
            try? await Task.sleep(for: .milliseconds(700))
            await refresh()
            Haptics.success()
        } catch {
            self.error = error.localizedDescription
        }
    }
}
