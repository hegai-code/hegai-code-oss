import SwiftUI
import CCRemoteKit

/// Команда — четыре таба веба: Обзор (кто делит это пространство, чьи машины
/// чьи, что идёт сейчас), Люди (роли, приглашения, скоуп менеджера), Проекты
/// (публикации) и Аудит. Управление ездит на `client.team` (REST).
///
/// Пятого таба — «Доступ» (`/w/team/access`, видимый только админу платформы) —
/// здесь НЕТ намеренно: CCRemoteKit не умеет его эндпоинты, а Kit в этой работе
/// не трогается. См. строку об этом в `ios/REBUILD.md`.
struct TeamView: View {
    @Environment(Router.self) private var router

    var body: some View {
        VStack(spacing: 0) {
            // Та же полоса табов, что у Настроек, и по той же причине: это
            // четыре экрана, а не четыре фильтра (см. `TabStrip`).
            TabStrip(tabs: TeamTab.allCases, label: \.label,
                     active: Binding(get: { router.teamTab },
                                     set: { router.teamTab = $0 }))
                .background(Theme.surface)
            switch router.teamTab {
            case .overview: TeamOverviewView()
            case .people: TeamPeopleView()
            case .projects: TeamProjectsView()
            case .audit: TeamAuditView()
            }
        }
        .background(Theme.bg)
        .navigationTitle("Команда")
        .inlineTitle()
    }
}

/// Обзор — целиком из снимка, который сокет и так принёс (`viewer`,
/// `machines[].owner`, `activeRuns`). Ни одного запроса своего.
struct TeamOverviewView: View {
    @Environment(CentralClient.self) private var client
    @Environment(AppSettings.self) private var settings
    @Environment(Router.self) private var router

    /// Человек вместе с его машинами и работой, которая на них идёт.
    private struct Person: Identifiable {
        let userId: String
        let name: String
        let email: String?
        var machines: [MachineSnapshot]
        var id: String { userId }
    }

    private var people: [Person] {
        var byUser: [String: Person] = [:]
        for snap in client.machines {
            guard let owner = snap.owner else { continue }
            let name = owner.fullName ?? owner.email ?? String(owner.userId.prefix(8))
            byUser[owner.userId, default: Person(userId: owner.userId, name: name,
                                                 email: owner.email, machines: [])]
                .machines.append(snap)
        }
        return byUser.values.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    }

    /// Машины, которые пространство никому не приписало.
    private var unowned: [MachineSnapshot] {
        client.machines.filter { $0.owner == nil }
    }

    private func runs(on machineId: String) -> [ActiveRunInfo] {
        client.activeRuns.filter { $0.machineId == machineId }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.s5) {
                viewerCard
                if !people.isEmpty {
                    VStack(alignment: .leading, spacing: Theme.s2) {
                        SectionLabel(text: "Люди", count: people.count)
                        ForEach(people) { personCard($0) }
                    }
                }
                if !unowned.isEmpty {
                    VStack(alignment: .leading, spacing: Theme.s2) {
                        SectionLabel(text: "Машины без владельца", count: unowned.count)
                        VStack(alignment: .leading, spacing: Theme.s3) {
                            ForEach(unowned) { machineRow($0) }
                        }
                        .padding(Theme.s4)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .card()
                    }
                }
            }
            .padding(Theme.s4)
            .frame(maxWidth: Theme.readingWidth, alignment: .leading)
            .frame(maxWidth: .infinity)
        }
        .background(Theme.bg)
    }

    // MARK: Куски

    private var viewerCard: some View {
        VStack(alignment: .leading, spacing: Theme.s3) {
            SectionLabel(text: "Вы")
            if let viewer = client.viewer {
                HStack(alignment: .top, spacing: Theme.s3) {
                    Avatar(seed: viewer.userId, label: viewer.displayName, size: Theme.avatarList)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(viewer.displayName)
                            .font(.ui(Theme.sizeCard, weight: .semibold)).foregroundStyle(Theme.text)
                        if let email = viewer.email {
                            Text(email)
                                .font(.mono(Theme.sizeMicro)).foregroundStyle(Theme.textFaint)
                                .lineLimit(1).truncationMode(.middle)
                        }
                    }
                    Spacer(minLength: Theme.s2)
                }
                // Роли переносятся, а не уезжают за край: у админа платформы их
                // две, и вторая на 375 не помещалась.
                WrapRow(spacing: Theme.s2) {
                    Chip(text: viewer.workspace.role, mono: false)
                    if viewer.platformAdmin { Chip(text: "platform admin", mono: false) }
                }
                if !viewer.teams.isEmpty {
                    Divider().overlay(Theme.divider)
                    SectionLabel(text: "Мои команды", eyebrow: false)
                    ForEach(viewer.teams) { ws in
                        let current = ws.workspaceId == viewer.workspace.workspaceId
                        Button {
                            settings.workspaceId = ws.workspaceId
                            client.switchWorkspace(ws.workspaceId)
                            Haptics.light()
                        } label: {
                            HStack(spacing: Theme.s2) {
                                Text(ws.displayName)
                                    .font(.ui(Theme.sizeSmall, weight: current ? .semibold : .regular))
                                    .foregroundStyle(Theme.text)
                                Text(ws.role)
                                    .font(.mono(Theme.sizeMicro)).foregroundStyle(Theme.textFaint)
                                Spacer()
                                if current {
                                    Image(systemName: "checkmark")
                                        .font(.system(size: 13, weight: .semibold))  // бокс глифа
                                        .foregroundStyle(Theme.textMuted)
                                }
                            }
                            .padding(.horizontal, Theme.s2)
                            .frame(minHeight: Theme.tapTarget)
                            .hereTint(current, radius: Theme.radiusSm)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                    }
                }
            } else {
                Text("Хаб ещё не прислал профиль.")
                    .font(.ui(Theme.sizeMeta)).foregroundStyle(Theme.textFaint)
            }
        }
        .padding(Theme.s4)
        .frame(maxWidth: .infinity, alignment: .leading)
        .card()
    }

    private func personCard(_ person: Person) -> some View {
        VStack(alignment: .leading, spacing: Theme.s3) {
            HStack(spacing: Theme.s3) {
                Avatar(seed: person.userId, label: person.name, size: Theme.avatarCard)
                VStack(alignment: .leading, spacing: 1) {
                    Text(person.name)
                        .font(.ui(Theme.sizeSmall, weight: .semibold)).foregroundStyle(Theme.text)
                    if let email = person.email {
                        Text(email).font(.mono(Theme.sizeMicro)).foregroundStyle(Theme.textFaint)
                            .lineLimit(1).truncationMode(.middle)
                    }
                }
                Spacer(minLength: Theme.s2)
                Text("\(person.machines.count)")
                    .font(.mono(Theme.sizeMeta)).foregroundStyle(Theme.textFaint)
                    .monospacedDigit()
                    .accessibilityLabel(counted(person.machines.count, "машина", "машины", "машин"))
            }
            ForEach(person.machines) { machineRow($0) }
        }
        .padding(Theme.s4)
        .frame(maxWidth: .infinity, alignment: .leading)
        .card()
    }

    private func machineRow(_ snap: MachineSnapshot) -> some View {
        VStack(alignment: .leading, spacing: Theme.s2) {
            // Имя, доступ и счёт сессий не встают в одну строку на 375 — и это
            // не «иногда»: имена машин длинные, а «полный доступ» длиннее их.
            VStack(alignment: .leading, spacing: Theme.s1) {
                HStack(spacing: Theme.s2) {
                    StatusSquare(color: snap.online ? Theme.live : Theme.textFaint.opacity(0.55))
                    Text(snap.machine.name)
                        .font(.ui(Theme.sizeSmall, weight: .medium)).foregroundStyle(Theme.text)
                        .lineLimit(1).truncationMode(.middle)
                    Spacer(minLength: Theme.s2)
                    Text(counted(snap.sessions.count, "сессия", "сессии", "сессий"))
                        .font(.mono(Theme.sizeMicro)).foregroundStyle(Theme.textFaint)
                }
                // Твой доступ так, как его посчитал хаб, — те же флаги, что
                // решают, предложит ли это приложение композер вообще.
                Chip(text: snap.hasControl ? "полный доступ"
                        : (snap.canStart == true ? "может запускать" : "только чтение"),
                     mono: false)
                    .padding(.leading, Theme.statusDot + Theme.s2)
            }
            ForEach(runs(on: snap.machine.machineId), id: \.runId) { run in
                Button {
                    router.openSession(machineId: run.machineId, sessionId: run.sessionId)
                } label: {
                    HStack(spacing: Theme.s2) {
                        StatusSquare(color: run.state == .needs_attention ? Theme.attn : Theme.live)
                        Text(cleanTitle(run.title).isEmpty ? String(run.sessionId.prefix(8))
                                                           : cleanTitle(run.title))
                            .font(.ui(Theme.sizeMeta)).foregroundStyle(Theme.textMuted).lineLimit(1)
                        Spacer(minLength: Theme.s2)
                        Text(run.state.label)
                            .font(.mono(Theme.sizeMicro)).foregroundStyle(Theme.textFaint)
                    }
                    .padding(.leading, Theme.s4)
                    .frame(minHeight: Theme.tapTarget)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
    }
}
