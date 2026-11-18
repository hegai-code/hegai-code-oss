import SwiftUI
import CCRemoteKit

// Управляющие табы «Команды» — зеркала веб-`TeamViews.tsx`, ездят на
// `client.team` (REST). Каждая мутация докладывает в местную полосу, а не в
// глобальный тост, и на успехе перечитывает список: источник правды — хаб.
//
// Формы здесь рисуются СВОИМИ контролами, а не стоковыми. Стоковый
// `Button("…")`, `.textFieldStyle(.roundedBorder)` и `Picker` брали ember-тинт
// приложения и системную серую рамку: «Выдать ссылку», «Опубликовать» и
// «Отозвать» выглядели тремя одинаковыми оранжевыми словами — без веса, без
// роли и без цели нажатия в 44. Роль теперь названа (`ActionButton`), а выбор
// из двух значений — это ряд чипов (`FolderChip`), то есть тот же элемент,
// которым выбирают везде в продукте.

// MARK: - Люди

struct TeamPeopleView: View {
    @Environment(CentralClient.self) private var client
    @Environment(AppSettings.self) private var settings
    @Environment(Router.self) private var router

    @State private var members: [MemberSummary] = []
    @State private var loading = false
    @State private var note: String?
    @State private var inviteEmail = ""
    @State private var inviteRole = "member"
    @State private var inviteLink: String?
    /// The link is the hub's account-setup link (`setupUrl`), not `/?invite=`.
    @State private var inviteIsSetup = false
    @State private var expandedUserId: String?

    private var workspaceId: String? { client.viewer?.workspace.workspaceId }
    private var canManage: Bool { client.viewer?.workspace.role == "owner" }
    private var managers: [MemberSummary] { members.filter(\.isManager) }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.s5) {
                if let note { noteBanner(note) { self.note = nil } }
                if canManage { inviteCard }
                membersCard
                if canManage, !managers.isEmpty { scopeCard }
            }
            .padding(Theme.s4)
            .frame(maxWidth: Theme.readingWidth, alignment: .leading)
            .frame(maxWidth: .infinity)
        }
        .background(Theme.bg)
        .task { await reload() }
    }

    private var inviteCard: some View {
        VStack(alignment: .leading, spacing: Theme.s3) {
            SectionLabel(text: "Пригласить")
            // Стопкой, не строкой: поле + выбор роли + кнопка — это около 510pt
            // фиксированной ширины, которой у телефона нет.
            TeamField(placeholder: "email@example.com", text: $inviteEmail, kind: .email)
            HStack(spacing: Theme.s2) {
                ForEach(["member", "manager"], id: \.self) { role in
                    FolderChip(title: role, active: inviteRole == role) { inviteRole = role }
                }
                Spacer()
            }
            ActionButton("Выдать ссылку", systemImage: "link",
                         enabled: !inviteEmail.trimmingCharacters(in: .whitespaces).isEmpty) {
                Task { await invite() }
            }
            if let inviteLink {
                HStack(spacing: Theme.s2) {
                    Text(inviteLink)
                        .font(.mono(Theme.sizeMicro)).foregroundStyle(Theme.textMuted)
                        .lineLimit(1).truncationMode(.middle)
                        .textSelection(.enabled)
                    Spacer(minLength: 0)
                    // The hub sends no email: the link travels in whatever
                    // messenger the team uses.
                    if let url = URL(string: inviteLink) {
                        ShareLink(item: url) {
                            Image(systemName: "square.and.arrow.up")
                                .font(.system(size: 14))  // бокс глифа
                                .foregroundStyle(Theme.textMuted)
                                .frame(width: Theme.tapTarget, height: Theme.tapTarget)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Поделиться ссылкой")
                    }
                    Button {
                        copyToPasteboard(inviteLink)
                        Haptics.success()
                    } label: {
                        Image(systemName: "doc.on.doc")
                            .font(.system(size: 14))  // бокс глифа
                            .foregroundStyle(Theme.textMuted)
                            .frame(width: Theme.tapTarget, height: Theme.tapTarget)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Скопировать ссылку")
                }
                .padding(.leading, Theme.s3)
                .background(Theme.surfaceSunken,
                            in: RoundedRectangle(cornerRadius: Theme.radiusMd, style: .continuous))
                Text(inviteIsSetup
                     ? "Ссылка одноразовая: по ней человек задаст пароль и код аутентификатора и сразу попадёт в команду. Письмо сервер не отправляет — перешлите ссылку сами."
                     : "Ссылка одноразовая: человек входит с той же почтой и попадает в команду. Письмо сервер не отправляет — перешлите ссылку сами.")
                    .font(.ui(Theme.sizeMicro)).foregroundStyle(Theme.textFaint)
            }
        }
        .padding(Theme.s4)
        .frame(maxWidth: .infinity, alignment: .leading)
        .card()
    }

    private var membersCard: some View {
        VStack(alignment: .leading, spacing: Theme.s3) {
            SectionLabel(text: "Участники", count: members.isEmpty ? nil : members.count)
            if loading && members.isEmpty {
                ProgressView().controlSize(.small)
            } else if members.isEmpty {
                Text("Хаб не вернул участников.")
                    .font(.ui(Theme.sizeMeta)).foregroundStyle(Theme.textFaint)
            }
            ForEach(members) { member in
                memberRow(member)
                if expandedUserId == member.userId {
                    MemberWorkList(userId: member.userId, name: member.displayName)
                        .padding(.leading, Theme.s5)
                }
            }
        }
        .padding(Theme.s4)
        .frame(maxWidth: .infinity, alignment: .leading)
        .card()
    }

    private func memberRow(_ member: MemberSummary) -> some View {
        let open = expandedUserId == member.userId
        return VStack(alignment: .leading, spacing: Theme.s2) {
            Button {
                withAnimation(Theme.easeFast) {
                    expandedUserId = open ? nil : member.userId
                }
                Haptics.light()
            } label: {
                HStack(spacing: Theme.s3) {
                    Avatar(seed: member.userId, label: member.displayName, size: Theme.avatarCard)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(member.displayName)
                            .font(.ui(Theme.sizeSmall, weight: .semibold)).foregroundStyle(Theme.text)
                            .lineLimit(1)
                        if let email = member.email {
                            Text(email)
                                .font(.mono(Theme.sizeMicro)).foregroundStyle(Theme.textFaint)
                                .lineLimit(1).truncationMode(.middle)
                        }
                    }
                    Spacer(minLength: Theme.s2)
                    Image(systemName: open ? "chevron.down" : "chevron.right")
                        .font(.system(size: 11, weight: .semibold))  // бокс глифа
                        .foregroundStyle(Theme.textFaint)
                }
                .frame(minHeight: Theme.tapTarget)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            // Роль — ряд чипов под строкой, а не выпадашка в её правом краю:
            // системный `Picker` там был четвёртым шрифтом в карточке и
            // единственным местом продукта, где выбирают не чипом. Владельца
            // не понижают, поэтому у его строки чипов нет — только тег.
            if canManage, !member.isOwner {
                HStack(spacing: Theme.s2) {
                    ForEach(["member", "manager"], id: \.self) { role in
                        FolderChip(title: role, active: member.role == role) {
                            Task { await setRole(member, to: role) }
                        }
                    }
                    Spacer()
                }
                .padding(.leading, Theme.avatarCard + Theme.s3)
            } else {
                Chip(text: member.role, mono: false)
                    .padding(.leading, Theme.avatarCard + Theme.s3)
            }
        }
    }

    private var scopeCard: some View {
        VStack(alignment: .leading, spacing: Theme.s3) {
            SectionLabel(text: "Скоуп менеджера")
            Text("Менеджер видит работу только назначенных ему людей и проектов.")
                .font(.ui(Theme.sizeMicro)).foregroundStyle(Theme.textFaint)
            ForEach(managers) { manager in
                HStack(spacing: Theme.s2) {
                    Text(manager.displayName)
                        .font(.ui(Theme.sizeSmall, weight: .medium)).foregroundStyle(Theme.text)
                        .lineLimit(1)
                    Spacer(minLength: Theme.s2)
                    Menu {
                        ForEach(members.filter { $0.userId != manager.userId }) { m in
                            Button(m.displayName) {
                                Task { await assign(manager: manager, memberId: m.userId) }
                            }
                        }
                    } label: {
                        HStack(spacing: Theme.s1 + 2) {
                            Text("Назначить")
                                .font(.ui(Theme.sizeMeta, weight: .semibold))
                            Image(systemName: "chevron.down")
                                .font(.system(size: 10, weight: .semibold))  // бокс глифа
                        }
                        .foregroundStyle(Theme.text)
                        .padding(.horizontal, Theme.s3)
                        .frame(minHeight: Theme.tapTarget)
                        .background(Theme.chip,
                                    in: RoundedRectangle(cornerRadius: Theme.radiusMd, style: .continuous))
                    }
                    .plainMenu()
                }
                .frame(minHeight: Theme.tapTarget)
            }
        }
        .padding(Theme.s4)
        .frame(maxWidth: .infinity, alignment: .leading)
        .card()
    }

    // MARK: Действия

    private func reload() async {
        guard let workspaceId else { return }
        loading = true
        do { members = try await client.team.members(workspaceId: workspaceId) }
        catch { note = "Не удалось получить участников: \(error.localizedDescription)" }
        loading = false
    }

    private func invite() async {
        guard let workspaceId else { return }
        do {
            let info = try await client.team.invite(workspaceId: workspaceId,
                                                    email: inviteEmail.trimmingCharacters(in: .whitespaces),
                                                    role: inviteRole)
            let origin = HegaiAuth.apiBase(hubURL: settings.hubURL)?.absoluteString ?? ""
            inviteLink = info.setupUrl ?? "\(origin)/?invite=\(info.token)"
            inviteIsSetup = info.setupUrl != nil
            inviteEmail = ""
        } catch {
            note = "Приглашение не создано: \(error.localizedDescription)"
        }
    }

    private func setRole(_ member: MemberSummary, to role: String) async {
        guard let workspaceId, role != member.role else { return }
        do {
            try await client.team.setRole(workspaceId: workspaceId, userId: member.userId, role: role)
            await reload()
        } catch {
            note = "Роль не изменена: \(error.localizedDescription)"
            await reload()
        }
    }

    private func assign(manager: MemberSummary, memberId: String) async {
        guard let workspaceId else { return }
        do {
            try await client.team.assign(workspaceId: workspaceId, managerUserId: manager.userId,
                                         targetKind: "member", targetId: memberId)
            note = "Назначено: \(manager.displayName) ведёт этого человека."
        } catch {
            note = "Не назначено: \(error.localizedDescription)"
        }
    }
}

/// Работа одного человека: его сессии по всему флоту плюс то, что идёт прямо
/// сейчас. Приписка приходит из полей владельца, которые проставляет хаб.
private struct MemberWorkList: View {
    let userId: String
    let name: String
    @Environment(CentralClient.self) private var client
    @Environment(Router.self) private var router

    private var runs: [ActiveRunInfo] {
        client.activeRuns.filter { $0.ownerUserId == userId }
    }
    private var items: [SessionItem] {
        ProjectGrouping.allItems(from: client.machines)
            .filter { $0.session.owner?.userId == userId }
            .sorted { $0.session.lastModified > $1.session.lastModified }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.s1) {
            if runs.isEmpty && items.isEmpty {
                Text("Пока не видно сессий \(name).")
                    .font(.ui(Theme.sizeMicro)).foregroundStyle(Theme.textFaint)
            } else {
                if !runs.isEmpty {
                    Text("сейчас в работе: \(runs.count)")
                        .font(.mono(Theme.sizeMicro)).foregroundStyle(Theme.textFaint)
                }
                ForEach(Array(items.prefix(8))) { item in
                    Button {
                        router.openSession(machineId: item.machineId,
                                           sessionId: item.session.sessionId)
                    } label: {
                        VStack(alignment: .leading, spacing: 1) {
                            HStack(spacing: Theme.s2) {
                                StatusSquare(color: client.runFor(machineId: item.machineId,
                                                                  sessionId: item.session.sessionId) != nil
                                                    ? Theme.live : Theme.textFaint.opacity(0.55))
                                Text(item.session.title.isEmpty
                                     ? String(item.session.sessionId.prefix(8))
                                     : item.session.title)
                                    .font(.ui(Theme.sizeMeta)).foregroundStyle(Theme.textMuted)
                                    .lineLimit(1)
                            }
                            Text("\(item.machineName) · \(RelTime.short(item.session.lastModified))")
                                .font(.mono(Theme.sizeMicro)).foregroundStyle(Theme.textFaint)
                                .padding(.leading, Theme.statusDot + Theme.s2)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .frame(minHeight: Theme.tapTarget)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
            }
        }
        .padding(.vertical, Theme.s1)
    }
}

// MARK: - Проекты

struct TeamProjectsView: View {
    @Environment(CentralClient.self) private var client
    @Environment(Router.self) private var router

    @State private var shares: [ProjectShare] = []
    @State private var loading = false
    @State private var note: String?
    @State private var showPublish = false

    private var workspaceId: String? { client.viewer?.workspace.workspaceId }
    private var canManage: Bool { client.viewer?.workspace.role == "owner" }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.s5) {
                if let note { noteBanner(note) { self.note = nil } }
                if canManage {
                    ActionButton("Опубликовать проект", systemImage: "plus") { showPublish = true }
                }
                sharesCard
            }
            .padding(Theme.s4)
            .frame(maxWidth: Theme.readingWidth, alignment: .leading)
            .frame(maxWidth: .infinity)
        }
        .background(Theme.bg)
        .task { await reload() }
        // Лист с детентами: встроенная карточка не пережила колонку в 375pt.
        .sheet(isPresented: $showPublish) {
            ProjectPublishSheet(workspaceId: workspaceId) { await reload() }
                .sheetSize()
        }
    }

    private var sharesCard: some View {
        VStack(alignment: .leading, spacing: Theme.s3) {
            SectionLabel(text: "Общие проекты", count: shares.isEmpty ? nil : shares.count)
            if loading && shares.isEmpty {
                ProgressView().controlSize(.small)
            } else if shares.isEmpty {
                Text("Пока ничего не опубликовано.")
                    .font(.ui(Theme.sizeMeta)).foregroundStyle(Theme.textFaint)
            }
            ForEach(shares) { share in
                HStack(spacing: Theme.s3) {
                    VStack(alignment: .leading, spacing: 1) {
                        HStack(spacing: Theme.s2) {
                            Text(share.name)
                                .font(.ui(Theme.sizeSmall, weight: .semibold)).foregroundStyle(Theme.text)
                                .lineLimit(1)
                            if share.isControl { Chip(text: "team control", mono: false) }
                        }
                        Text("\(machineName(share.machineId)) · \(share.root)")
                            .font(.mono(Theme.sizeMicro)).foregroundStyle(Theme.textFaint)
                            .lineLimit(1).truncationMode(.middle)
                    }
                    Spacer(minLength: Theme.s2)
                    if canManage {
                        Button {
                            Task { await remove(share) }
                        } label: {
                            Image(systemName: "trash")
                                .font(.system(size: 14))  // бокс глифа
                                .foregroundStyle(Theme.negative)
                                .frame(width: Theme.tapTarget, height: Theme.tapTarget)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Отозвать публикацию «\(share.name)»")
                    }
                }
                .frame(minHeight: Theme.tapTarget)
            }
        }
        .padding(Theme.s4)
        .frame(maxWidth: .infinity, alignment: .leading)
        .card()
    }

    // MARK: Действия

    private func machineName(_ id: String) -> String {
        client.machines.first { $0.machine.machineId == id }?.machine.name ?? String(id.prefix(8))
    }

    private func reload() async {
        guard let workspaceId else { return }
        loading = true
        do { shares = try await client.team.projects(workspaceId: workspaceId) }
        catch { note = "Не удалось получить проекты: \(error.localizedDescription)" }
        loading = false
    }

    private func remove(_ share: ProjectShare) async {
        guard let workspaceId else { return }
        do {
            try await client.team.removeProject(workspaceId: workspaceId, shareId: share.projectShareId)
            await reload()
        } catch {
            note = "Не удалось отозвать: \(error.localizedDescription)"
        }
    }
}

/// Форма публикации: машина → корень (с чипами известных проектов) → имя →
/// доступ. Держит свой черновик; на успехе перечитывает через вызывающего и
/// закрывается сама.
private struct ProjectPublishSheet: View {
    let workspaceId: String?
    var onPublished: () async -> Void
    @Environment(CentralClient.self) private var client
    @Environment(\.dismiss) private var dismiss

    @State private var machineId = ""
    @State private var root = ""
    @State private var displayName = ""
    @State private var access = "view"
    @State private var knownRoots: [String] = []
    @State private var note: String?

    private var shareableMachines: [MachineSnapshot] {
        client.machines.filter(\.hasControl)
    }
    private var incomplete: Bool {
        machineId.isEmpty
            || root.trimmingCharacters(in: .whitespaces).isEmpty
            || displayName.trimmingCharacters(in: .whitespaces).isEmpty
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.s4) {
                SectionLabel(text: "Опубликовать проект")
                Text("Участники увидят сессии в этой папке; «control» разрешает им запускать там свои.")
                    .font(.ui(Theme.sizeMicro)).foregroundStyle(Theme.textFaint)
                if let note { noteBanner(note) { self.note = nil } }

                field("Машина") {
                    WrapRow(spacing: Theme.s2) {
                        ForEach(shareableMachines) { m in
                            FolderChip(title: m.machine.name,
                                       active: machineId == m.machine.machineId) {
                                machineId = m.machine.machineId
                                Task { await loadRoots() }
                            }
                        }
                    }
                }

                field("Папка") {
                    TeamField(placeholder: "/path/to/project", text: $root, kind: .path)
                    if !knownRoots.isEmpty {
                        WrapRow(spacing: Theme.s2) {
                            ForEach(knownRoots.prefix(12), id: \.self) { r in
                                FolderChip(title: (r as NSString).lastPathComponent,
                                           active: root == r) {
                                    root = r
                                    if displayName.isEmpty {
                                        displayName = (r as NSString).lastPathComponent
                                    }
                                }
                            }
                        }
                    }
                }

                field("Имя") {
                    TeamField(placeholder: "Отображаемое имя", text: $displayName, kind: .plain)
                }

                field("Доступ") {
                    HStack(spacing: Theme.s2) {
                        ForEach(["view", "control"], id: \.self) { a in
                            FolderChip(title: a, active: access == a) { access = a }
                        }
                        Spacer()
                    }
                }

                HStack(spacing: Theme.s2) {
                    ActionButton("Отмена", kind: .quiet) { dismiss() }
                    ActionButton("Опубликовать", wide: true, enabled: !incomplete) {
                        Task { await publish() }
                    }
                }
                .padding(.top, Theme.s2)
            }
            .padding(Theme.s5)
            .frame(maxWidth: .infinity, alignment: .topLeading)
        }
        .background(Theme.bg)
        .task {
            if machineId.isEmpty { machineId = shareableMachines.first?.machine.machineId ?? "" }
            await loadRoots()
        }
    }

    /// Подпись поля — моно-капс БЕЗ ember-точки: точка помечает секцию, и
    /// пятая подряд превращала бы самый узнаваемый мотив системы в обои.
    private func field<Content: View>(_ label: String,
                                      @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: Theme.s2) {
            SectionLabel(text: label, eyebrow: false)
            content()
        }
    }

    private func loadRoots() async {
        guard !machineId.isEmpty else { knownRoots = []; return }
        knownRoots = (try? await client.listProjects(machineId: machineId).map(\.cwd)) ?? []
    }

    private func publish() async {
        guard let workspaceId else { return }
        do {
            _ = try await client.team.shareProject(workspaceId: workspaceId, machineId: machineId,
                                                   root: root.trimmingCharacters(in: .whitespaces),
                                                   name: displayName.trimmingCharacters(in: .whitespaces),
                                                   access: access)
            await onPublished()
            dismiss()
        } catch {
            note = "Не опубликовано: \(error.localizedDescription)"
        }
    }
}

// MARK: - Аудит

struct TeamAuditView: View {
    @Environment(CentralClient.self) private var client
    @State private var events: [AuditEvent] = []
    @State private var loading = false
    @State private var note: String?

    private var workspaceId: String? { client.viewer?.workspace.workspaceId }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.s3) {
                if let note { noteBanner(note) { self.note = nil } }
                SectionLabel(text: "События", count: events.isEmpty ? nil : events.count)
                if loading && events.isEmpty {
                    ProgressView().controlSize(.small)
                } else if events.isEmpty {
                    Text("Журнал пуст.")
                        .font(.ui(Theme.sizeMeta)).foregroundStyle(Theme.textFaint)
                }
                // Событие — запись журнала в две строки, а не четыре колонки в
                // одной: на 375 из них выживала полторы, и конец каждой строки
                // съедало многоточие.
                // Карточка только когда есть что в неё класть: пустая рисовала
                // невидимую плашку нулевой высоты под словами «Журнал пуст».
                if !events.isEmpty {
                  VStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(events.enumerated()), id: \.element.id) { index, event in
                        if index > 0 { Divider().overlay(Theme.divider) }
                        VStack(alignment: .leading, spacing: 2) {
                            HStack(spacing: Theme.s2) {
                                Text(event.actorName ?? String(event.actorUserId.prefix(8)))
                                    .font(.ui(Theme.sizeMeta, weight: .semibold))
                                    .foregroundStyle(Theme.text)
                                    .lineLimit(1)
                                Spacer(minLength: Theme.s2)
                                Text(RelTime.short(event.createdAt))
                                    .font(.mono(Theme.sizeMicro)).foregroundStyle(Theme.textFaint)
                            }
                            Text("\(event.action) · \(event.targetKind) \(String(event.targetId.prefix(12)))")
                                .font(.mono(Theme.sizeMicro)).foregroundStyle(Theme.textMuted)
                                .lineLimit(1).truncationMode(.middle)
                        }
                        .padding(.vertical, Theme.s2)
                    }
                  }
                  .padding(.horizontal, Theme.s4)
                  .frame(maxWidth: .infinity, alignment: .leading)
                  .card()
                }
            }
            .padding(Theme.s4)
            .frame(maxWidth: Theme.readingWidth, alignment: .leading)
            .frame(maxWidth: .infinity)
        }
        .background(Theme.bg)
        .task { await reload() }
    }

    private func reload() async {
        guard let workspaceId else { return }
        loading = true
        do { events = try await client.team.audit(workspaceId: workspaceId) }
        catch { note = "Не удалось получить журнал: \(error.localizedDescription)" }
        loading = false
    }
}

// MARK: - Общее

/// Поле ввода «Команды» — колодец канона вместо системной серой рамки.
/// `.roundedBorder` рисовал единственный в продукте контрол с чужой геометрией
/// и своим радиусом.
struct TeamField: View {
    enum Kind { case email, path, plain }

    let placeholder: String
    @Binding var text: String
    var kind: Kind = .plain

    var body: some View {
        Group {
            switch kind {
            case .email: TextField(placeholder, text: $text).emailField()
            case .path: TextField(placeholder, text: $text).plainTextEntry().font(.mono(Theme.sizeMeta))
            case .plain: TextField(placeholder, text: $text)
            }
        }
        .textFieldStyle(.plain)
        .font(kind == .path ? .mono(Theme.sizeMeta) : .ui(Theme.sizeSmall))
        .padding(.horizontal, Theme.s3)
        .frame(minHeight: Theme.tapTarget)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.surfaceSunken,
                    in: RoundedRectangle(cornerRadius: Theme.radiusMd, style: .continuous))
    }
}

/// Местная полоса ошибки/сообщения — мутации докладывают сюда, а не в
/// глобальный тост.
@ViewBuilder func noteBanner(_ text: String, dismiss: @escaping () -> Void) -> some View {
    HStack(alignment: .top, spacing: Theme.s2) {
        Text(text).font(.ui(Theme.sizeMeta)).foregroundStyle(Theme.text)
        Spacer(minLength: Theme.s2)
        Button { dismiss() } label: {
            Image(systemName: "xmark")
                .font(.system(size: 12, weight: .semibold))  // бокс глифа
                .foregroundStyle(Theme.textMuted)
                .frame(width: Theme.tapTarget, height: Theme.tapTarget)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Скрыть сообщение")
    }
    .padding(.leading, Theme.s3)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(Theme.surfaceSunken,
                in: RoundedRectangle(cornerRadius: Theme.radiusMd, style: .continuous))
}
