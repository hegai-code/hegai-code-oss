import SwiftUI
import CCRemoteKit

/// Идентичность задачи «спросить каталог»: статус И поколение сокета, чтобы быстрый
/// reconnect, которого SwiftUI не успел увидеть как `.closed`, всё равно перезапускал её.
private struct ShelfSocketKey: Equatable {
    let status: CentralClient.ConnStatus
    let generation: Int
}

/// Когда перечитывать выданные воркспейсу папки: смена воркспейса или новый сокет.
private struct ShareTargetsKey: Equatable {
    let workspaceId: String?
    let generation: Int
}

/// Новый разговор: проект выбирается в листе, основной экран остаётся для задачи.
/// Черновики по проектам, настройки по машине/движку и share-handoff сохраняются.
struct StartScreen: View {
    @Environment(CentralClient.self) private var client
    @Environment(Router.self) private var router
    @Environment(AppSettings.self) private var settings

    /// Второй источник полки: то, что знают агенты (`projects.list`), а опись
    /// сессий не знает — пустые, только что созданные и разделённые проекты.
    @State private var owned = OwnedProjects()
    /// Третий источник: корни control-share текущего воркспейса (REST, как в вебе
    /// `App.tsx` и в маке `MacStartPane`). Участнику на чужой машине хаб отдаёт
    /// `canControl=false`, поэтому `projects.list` его агента не спрашивается, а
    /// своих сессий в выданной папке у новичка ещё нет — без этого списка полка
    /// пуста, и стартовать некуда (25.10.2026, «Аномалия» у участника на devbox).
    @State private var shareTargets: [ExtraTarget] = []
    @State private var shareWorkspace: String?
    @State private var projectModel = StartProjectModel()
    /// The selected machine's Codex model list, kept even while Claude is chosen
    /// so the OpenCode segment can appear. Shares `StartModelCache` with
    /// `StartRunPicker` (same key shape).
    @State private var codexModels: [ModelInfoLite]?
    /// The question got its answer or failed: nothing more to wait for.
    @State private var codexModelsSettled = false
    /// Выбор хранится ПАРОЙ `machine::cwd`, никогда индексом. Индекс в списке,
    /// отсортированном по свежести, переставлял выбор на другой проект каждый
    /// раз, когда кто-то во флоте трогал сессию, — молча.
    @State private var projectKey = UserDefaults.standard.string(forKey: Self.projectKeyDefault) ?? ""
    @State private var machineChoice: String?
    @State private var projectByMachine: [String: String] = [:]
    @State private var category: SessionCategory?
    /// Распознаватель живёт ЗДЕСЬ, а не в композере: чип «Рамблинг» и есть
    /// кнопка микрофона, значит включать диктовку умеют двое, а аудио-сессия
    /// одна.
    @State private var dictation = SpeechDictation()
    @State private var startRun = StartRunSettings()
    @State private var showFind = false
    @State private var showServers = false
    @State private var findQuery = ""
    @State private var showCustom = false
    @State private var pendingCustom = false
    @State private var customPath = ""
    @State private var customMachineId = ""
    /// «Новая папка» участника: одна папка в выданном корне (`fs.mkdir`).
    @State private var showNewFolder = false
    @State private var pendingNewFolder = false
    @State private var newFolderName = ""
    @State private var newFolderRoot = ""
    @State private var newFolderBusy = false
    @State private var newFolderError: String?
    @State private var keyboardTop: CGFloat = .greatestFiniteMagnitude
    /// Каталог, выбранный руками: цель, которой нет ни в описи, ни в ответе
    /// агента, поэтому она живёт отдельной строкой и подмешивается в полку.
    @State private var custom: ProjectTarget?

    private static let projectKeyDefault = "cc-project"

    // MARK: - Производные

    private var projects: [ProjectTarget] { projectModel.projects }

    private func refreshProjects() {
        var extra = owned.targets + shareTargets
        if let custom {
            extra.append(ExtraTarget(machineId: custom.machineId, cwd: custom.cwd,
                                     label: custom.label, origin: .adopted,
                                     lastModified: custom.lastModified))
        }
        projectModel.update(machines: client.machines, viewerId: client.effectiveViewerId,
                            runs: client.activeRuns, extra: extra)
    }

    private func loadShareTargets() async {
        // Только участнику. Владельцу/менеджеру ручка отдаёт ВСЕ выдачи воркспейса,
        // а стартовать на чужой машине им можно не в каждой: полка предложила бы
        // папку, в которой хаб откажет. Свои машины у них и так спрашиваются.
        guard client.viewer?.workspace.role == "member",
              let workspaceId = client.viewer?.workspace.workspaceId else {
            shareTargets = []
            shareWorkspace = nil
            return
        }
        // Чужой воркспейс не должен подсказывать свои папки, пока едет ответ.
        if shareWorkspace != workspaceId { shareTargets = []; shareWorkspace = workspaceId }
        // Ошибка сети — не «папок нет»: оставить показанное, а не стереть полку.
        guard let shares = try? await client.team.projects(workspaceId: workspaceId) else { return }
        // Ответ мог прийти уже про другой воркспейс.
        guard workspaceId == client.viewer?.workspace.workspaceId else { return }
        shareTargets = shares.filter(\.isControl).map {
            ExtraTarget(machineId: $0.machineId, cwd: $0.root, label: $0.name)
        }
    }

    private var target: ProjectTarget? {
        if let explicit = router.newChatTarget {
            // Keep the draft identity even if access or connectivity changes.
            // Sending checks live permissions separately in start().
            return explicit
        }
        let all = projects.filter { machineChoice == nil || $0.machineId == machineChoice }
        return all.first { $0.id == projectKey } ?? ProjectShelf.recent(all).first ?? all.first
    }

    private var selectedKey: String { target?.id ?? "" }
    private var selectedMachineId: String {
        target?.machineId ?? machineChoice ?? onlineMachines.first?.machine.machineId ?? ""
    }

    private var machine: MachineSnapshot? {
        client.machines.first { $0.machine.machineId == selectedMachineId }
    }

    /// Сессии сотрудника идут в Codex через общий шлюз, что бы ни просил провод,
    /// — и у песочницы своего логина Claude нет вовсе. Обе замены делает хаб
    /// независимо от пикера, поэтому пикер их не показывает контролом.
    private var isMember: Bool { client.viewer?.workspace.role == "member" }
    private var isSandbox: Bool { machine?.isSandbox == true }
    /// То, на чём сессия РЕАЛЬНО пойдёт, — не `preferredAgent`. И список
    /// моделей, и список режимов разные у движков, поэтому ключ именно этот.
    /// Claude switched off on the chosen machine by its owner (web 536df3f):
    /// the session runs Codex whatever was remembered — a send must not ask
    /// for a Claude the agent refuses.
    private var claudeOff: Bool { machine?.claudeOff == true }
    private var agentIsFixed: Bool { isMember || isSandbox || claudeOff }
    /// «OpenCode» is offered only when this machine's Codex list has Go rows.
    private var hasGoRows: Bool { AgentModels.hasGoRows(codexModels ?? []) }
    /// Until the machine answers, a remembered OpenCode stays selected and holds
    /// the send: falling back would start the session on Codex without saying so.
    private var openCodeWaiting: Bool {
        !agentIsFixed && settings.preferredAgent == AgentModels.opencode && codexModels == nil && !codexModelsSettled
    }
    /// The agent in force: "claude" | "codex" | "opencode". A remembered
    /// "opencode" falls back to Codex on a machine without Go rows — the
    /// remembered value itself is left alone, so it returns with the rows.
    private var agentChoice: String {
        if agentIsFixed { return "codex" }
        let remembered = settings.preferredAgent
        if remembered == AgentModels.opencode { return hasGoRows || openCodeWaiting ? remembered : "codex" }
        return remembered
    }
    /// The RUNTIME ("claude" | "codex"): the wire and `isCodex`. OpenCode is Codex.
    private var engine: String { agentChoice == "claude" ? "claude" : "codex" }
    /// Машина И выбор агента: пара, которой принадлежит запомненный выбор. Ни один из
    /// двух списков между ними не переносится; OpenCode помнит модель отдельно от Codex.
    private var startRunKey: String { "\(selectedMachineId)::\(agentChoice)" }
    private var source: String? {
        isSandbox ? "codex" : isMember ? nil : claudeOff ? "codex" : engine
    }
    /// An OpenCode start always names its model: unset, it would land on the
    /// machine's non-Go default.
    private var startModel: String? {
        guard agentChoice == AgentModels.opencode else { return startRun.model }
        return AgentModels.defaultGoModel(models: codexModels ?? [], remembered: startRun.model)
    }

    private var codexModelsKey: String {
        "\(client.storageScope)::\(selectedMachineId)::codex::\(client.connectionEpoch)::\(client.status == .open)::\(agentIsFixed)"
    }

    private func loadCodexModels() async {
        let key = "\(client.storageScope)::\(selectedMachineId)::codex"
        // The cache paints at once but does not end the question: a list cached
        // while Go was briefly down must not hide OpenCode until the next launch.
        let cached = StartModelCache.cached(key)
        codexModels = cached
        codexModelsSettled = false
        // Fixed Codex (member, sandbox, Claude off) never shows the segment.
        guard !agentIsFixed, !selectedMachineId.isEmpty, client.status == .open else { return }
        let answer = try? await client.listModels(machineId: selectedMachineId, source: "codex")
        guard !Task.isCancelled else { return }
        // A failed or empty answer ends the wait too: the picker then visibly
        // shows Codex, rather than holding every send with no explanation.
        codexModelsSettled = true
        guard let list = answer, !list.isEmpty else { return }
        let runtime = list.contains { $0.resolved != nil }
        if runtime { StartModelCache.remember(key, list) }
        if runtime || cached == nil { codexModels = list }
    }

    /// Типы работы, которые ВЫБРАННАЯ машина умеет запустить. Категория
    /// переписывает первый ход в `/<skill> …`, поэтому чип со скиллом, которого
    /// там нет, не запускает поток — он оставляет в транскрипте бесхозную
    /// слэш-команду и выглядит сработавшим.
    private var categories: [SessionCategory] {
        SessionCategory.pickable.filter { $0.runnable(on: machine?.machine.skills) }
    }

    /// Черновик — на проект. Пустая строка, пока опись не приехала: это
    /// «места ещё нет», и композер набранное в это окно НЕ выбрасывает, а
    /// переносит на тот проект, на который мы встанем (`ComposerView.moveDraft`).
    private var draftKey: String {
        if !selectedKey.isEmpty { return "new::\(selectedKey)" }
        // An explicitly selected empty server must not borrow another project's draft.
        return machineChoice.map { "new::server::\($0)" } ?? ""
    }

    // MARK: - Экран

    var body: some View {
        GeometryReader { geometry in
            startContent
                // Navigation pops can miss SwiftUI keyboard avoidance. Add only
                // the overlap left after any system safe-area adjustment.
                .padding(.bottom, max(0, geometry.frame(in: .global).maxY - keyboardTop))
        }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillChangeFrameNotification)) { notification in
            guard let frame = notification.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? CGRect else { return }
            let duration = notification.userInfo?[UIResponder.keyboardAnimationDurationUserInfoKey] as? Double ?? 0.25
            withAnimation(.easeOut(duration: duration)) { keyboardTop = frame.minY }
        }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillHideNotification)) { _ in
            keyboardTop = .greatestFiniteMagnitude
        }
    }

    private var startContent: some View {
        // Quick navigation uses only the space left above the composer.
        VStack(spacing: 0) {
            StartActiveSessions().dismissKeyboardOnTap().frame(maxHeight: .infinity).clipped()
            foot
        }
        .background(Theme.bg)
        .inlineTitle()
        .toolbarBackground(.hidden, for: .navigationBar)
        .toolbar {
            bareToolbarItem { DrawerButton() }
            // «Подключаюсь…» в строке навбара, пока идёт.
            bareToolbarItem(placement: .principal) { HubTitleStatus() }
            bareToolbarItem(placement: .topBarTrailing) { WorkspaceSwitcher() }
        }
        .onChange(of: router.newChatTarget, initial: true) { _, target in
            if let target { machineChoice = target.machineId; setProjectKey(target.id) }
        }
        .onChange(of: client.machines, initial: true) { _, _ in refreshProjects() }
        .onChange(of: client.activeRuns) { _, _ in refreshProjects() }
        .onChange(of: client.effectiveViewerId) { _, _ in refreshProjects() }
        .onChange(of: owned.targets) { _, _ in refreshProjects() }
        .onChange(of: shareTargets) { _, _ in refreshProjects() }
        // Выданные папки — свойство воркспейса: перечитать при его смене и на новом
        // сокете (папку могли выдать, пока нас не было).
        .task(id: ShareTargetsKey(workspaceId: client.viewer?.workspace.workspaceId,
                                  generation: client.socketGeneration)) { await loadShareTargets() }
        .onChange(of: custom) { _, _ in refreshProjects() }
        .task(id: OwnedProjects.key(for: client.machines)) { await owned.refresh(client: client) }
        // Тот же ключ, что и у полки: пока сокет не открыт, спрашивать некого,
        // а открывшись — уже можно. Новый сокет спрашивает заново (проект мог появиться,
        // пока нас не было), смена статуса того же сокета — нет (см. `ShelfAskPolicy`).
        .task(id: ShelfSocketKey(status: client.status, generation: client.socketGeneration)) {
            await owned.refresh(client: client)
        }
        // Экран появился: проект, созданный с веба или другого телефона, иначе не
        // показался бы, пока жив сокет. Не чаще раза в 5 минут.
        .task { await owned.refresh(client: client, appeared: true) }
        // Смена проекта может увести композер на машину, которая выбранный тип
        // работы не умеет. Снять выбор — единственный честный вариант: оставить
        // его значило бы отправить `/rambling` туда, где его никто не ловит, и
        // без единого чипа на экране, который это объяснит.
        .onChange(of: selectedKey) { _, _ in
            if let cat = category, !categories.contains(cat) { category = nil }
        }
        // Выбор принадлежит паре «машина+движок», поэтому переход на любого из
        // двух ПЕРЕЧИТЫВАЕТ, а не переносит: id модели Codex ничего не значит
        // для Claude, а `bypassPermissions`, предложенный на одной коробке,
        // удержан на следующей.
        .onChange(of: startRunKey, initial: true) { _, _ in
            startRun = StartRunStore.load(machineId: selectedMachineId, engine: agentChoice)
        }
        .onChange(of: startRun) { _, next in
            StartRunStore.save(next, machineId: selectedMachineId, engine: agentChoice)
        }
        .task(id: codexModelsKey) { await loadCodexModels() }
        .sheet(isPresented: $showFind, onDismiss: {
            if pendingCustom { pendingCustom = false; presentCustom() }
            if pendingNewFolder { pendingNewFolder = false; presentNewFolder() }
        }) { findSheet }
        .sheet(isPresented: $showCustom) { customSheet }
        .sheet(isPresented: $showNewFolder) { newFolderSheet }
        .sheet(isPresented: $showServers) { serverSheet }
    }

    // MARK: - Подвал: где, какого рода, и сам композер

    private var foot: some View {
        VStack(spacing: Theme.s1) {
            HStack(spacing: Theme.s2) {
                Button { showServers = true; Haptics.light() } label: {
                    targetIsland(machine?.machine.name ?? target?.machineName ?? "Сервер", icon: "server.rack")
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("start.server")
                .accessibilityLabel("Сервер")
                .accessibilityValue(machine?.machine.name ?? target?.machineName ?? "Не выбран")
                Button { findQuery = ""; showFind = true; Haptics.light() } label: {
                    targetIsland(target?.label ?? "Выбрать проект", icon: "folder")
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("start.project")
                .accessibilityValue(target.map { "\($0.machineName), \($0.cwd)" } ?? "Не выбран")
                Spacer(minLength: 0)
            }
            .padding(.horizontal, Theme.s3)
            if category != nil { categoryChips.frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, Theme.s3) }

            ComposerView(isActive: true,
                         draftKey: draftKey,
                         onSend: start,
                         autoFocus: router.focusesNewChat && router.path.isEmpty && !router.isDrawerOpen,
                         seed: router.pendingShare,
                         onSeedTaken: { router.pendingShare = nil },
                         hostDictation: dictation,
                         alwaysExpanded: true, placeholderText: "Опиши задачу…",
                         showsRunControls: false, overlaysTranscript: false,
                         migratesDraftFrom: target.map { "new::server::\($0.machineId)" },
                         polishContext: { [label = target?.label] raw in PolishRequest(text: raw, project: label) },
                         privateMachine: privateTarget) {
                if !selectedMachineId.isEmpty {
                    StartRunPicker(machineId: selectedMachineId, isCodex: engine == "codex",
                                   agent: agentChoice, showsOpenCode: hasGoRows || openCodeWaiting,
                                   agentSelection: agentChoice,
                                   value: $startRun, showsAgentPicker: true,
                                   agentIsFixed: agentIsFixed,
                                   fixedAgentLabel: isMember || isSandbox ? "Codex · шлюз" : "Codex",
                                   categories: categories, category: $category)
                }
            }
        }
        .padding(.top, Theme.s1)
    }

    private func targetIsland(_ title: String, icon: String) -> some View {
        HStack(spacing: Theme.s2) {
            Image(systemName: icon)
            Text(title).lineLimit(1).truncationMode(.middle)
            Image(systemName: "chevron.down").font(.system(size: 10, weight: .semibold))
        }
        .font(.system(.subheadline)).foregroundStyle(Theme.text)
        .padding(.horizontal, Theme.s3).padding(.vertical, Theme.s2)
        .frame(minHeight: 36)
        .background(Theme.composerBackground, in: Capsule())
        .overlay { Capsule().strokeBorder(Theme.rim, lineWidth: 1) }
        .shadow(color: Theme.shadowSm.color, radius: Theme.shadowSm.radius, y: Theme.shadowSm.y)
        .frame(minHeight: Theme.tapTarget).contentShape(Rectangle())
    }

    private var serverSheet: some View {
        NavigationStack {
            List {
                ForEach(client.machines.filter(\.canStartHere).sorted {
                    $0.machine.name.localizedCaseInsensitiveCompare($1.machine.name) == .orderedAscending
                }) { m in
                    Button { pickServer(m.machine.machineId); showServers = false; Haptics.light() } label: {
                        HStack(spacing: Theme.s3) {
                            Image(systemName: "server.rack").foregroundStyle(Theme.textMuted)
                            VStack(alignment: .leading, spacing: Theme.s1) {
                                Text(m.machine.name).font(.system(.subheadline))
                                if !m.online { Text("Не в сети").font(.system(.caption)).foregroundStyle(Theme.textMuted) }
                            }
                            Spacer()
                            if m.machine.machineId == selectedMachineId { Image(systemName: "checkmark") }
                        }.foregroundStyle(Theme.text).frame(minHeight: Theme.tapTarget)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain).disabled(!m.online)
                    .listRowBackground(Theme.settingsGroup)
                    .accessibilityIdentifier("start.server.\(m.machine.machineId)")
                    .accessibilityValue(m.machine.machineId == selectedMachineId ? "Выбран" : "")
                }
                if client.machines.allSatisfy({ !$0.canStartHere }) {
                    Text("Подключи сервер в настройках.").font(SettingsStyle.body).foregroundStyle(Theme.textMuted)
                        .listRowBackground(Theme.settingsGroup)
                }
            }
            .scrollContentBackground(.hidden).background(Theme.settingsBackground)
            .navigationTitle("Серверы").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .topBarTrailing) { SheetCloseButton { showServers = false } } }
        }.tint(Theme.text)
    }

    /// Чип категории. Их предлагается одна — та, где надиктовываешь сумбур и
    /// получаешь внятную постановку, — и её чип И ЕСТЬ кнопка микрофона:
    /// нажал — сразу пошла диктовка. Второе нажатие (снятие выбора) диктовку
    /// останавливает, тем же переключателем, что и сам микрофон. «Рамблинг» —
    /// не ярлык сессии, а способ её начать: его нажимают ВМЕСТО того, чтобы
    /// печатать, и ожидание второго тапа по микрофону — ровно то трение, ради
    /// снятия которого эта категория существует.
    private var categoryChips: some View {
        HStack(spacing: Theme.s2) {
            ForEach(categories) { cat in
                let on = category == cat
                Button {
                    let next: SessionCategory? = on ? nil : cat
                    category = next
                    showFind = false
                    Haptics.light()
                    guard cat == .rambling else { return }
                    // A private machine's words never go to the hub's recogniser.
                    if next != nil, !privateTarget, !dictation.active { dictation.toggle() }
                    if next == nil, dictation.recording { dictation.toggle() }
                } label: {
                    HStack(spacing: 5) {
                        if cat == .rambling {
                            Image(systemName: dictation.recording ? "stop.fill" : "mic.fill")
                                .font(.system(size: 10, weight: .semibold))  // бокс глифа
                        } else {
                            RoundedRectangle(cornerRadius: Theme.statusDotRadius, style: .continuous)
                                .fill(on ? Theme.onSelect : cat.color)
                                .frame(width: 6, height: 6)
                        }
                        Text(cat.label).font(.ui(Theme.sizeMeta, weight: .medium)).fixedSize()
                    }
                    .foregroundStyle(on ? Theme.onSelect : Theme.textMuted)
                    .padding(.horizontal, Theme.s3)
                    .frame(height: 30)
                    .background(on ? Theme.select : Theme.chip, in: Capsule())  // пилюля: фильтр-чип
                }
                .buttonStyle(.plain)
                .accessibilityLabel(cat == .rambling
                                    ? "Наговорить задачу — микрофон включится сразу"
                                    : "Сессия откроется скиллом /\(cat.skill)")
            }
        }
    }

    // MARK: - Поиск и своя папка

    private var findSheet: some View {
        NavigationStack {
            let q = findQuery.trimmingCharacters(in: .whitespaces).lowercased()
            let all = projects.filter { $0.machineId == selectedMachineId }
                .sorted { ($0.mine ? 0 : 1, -$0.lastModified) < ($1.mine ? 0 : 1, -$1.lastModified) }
            let rows = q.isEmpty ? all : all.filter { "\($0.label) \($0.machineName) \($0.cwd)".lowercased().contains(q) }
            List {
                if client.viewer?.switcherChoices.isEmpty == false {
                    Section {
                        HStack {
                            WorkspaceSwitcher()
                            // Лист закрывает корневой тост — сообщение о запрете здесь же.
                            if let err = client.lastError {
                                Text(err.message).font(.ui(Theme.sizeMicro)).foregroundStyle(Theme.textMuted)
                            }
                            Spacer(minLength: 0)
                        }
                            .listRowBackground(Color.clear)
                            .listRowInsets(EdgeInsets())
                    }
                }
                Section {
                    ForEach(rows) { p in
                        Button {
                            pick(p)
                            showFind = false
                        } label: {
                            HStack(spacing: Theme.s2) {
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(p.label).font(.ui(Theme.sizeSmall)).foregroundStyle(Theme.text)
                                    Text(p.cwd)
                                        .font(.ui(Theme.sizeMicro)).foregroundStyle(Theme.textMuted)
                                        .lineLimit(1).truncationMode(.middle)
                                }
                                Spacer()
                                if p.id == selectedKey { Image(systemName: "checkmark").foregroundStyle(Theme.text) }
                            }.frame(minHeight: Theme.tapTarget).contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .listRowBackground(Theme.settingsGroup)
                        .accessibilityIdentifier("start.project.\(p.id)")
                    }
                }
                if !memberRoots.isEmpty {
                    Button { showFind = false; pendingNewFolder = true } label: {
                        Label("Новая папка", systemImage: "folder.badge.plus")
                    }.listRowBackground(Theme.settingsGroup)
                        .accessibilityIdentifier("start.newFolder")
                }
                Button { showFind = false; pendingCustom = true } label: {
                    Label("Другая папка", systemImage: "folder")
                }.listRowBackground(Theme.settingsGroup)
                    .accessibilityIdentifier("start.customFolder")
                if rows.isEmpty {
                    Text(all.isEmpty ? "На этом сервере пока нет проектов. Можно выбрать другую папку." : "Ничего не нашлось").font(.ui(Theme.sizeMeta)).foregroundStyle(Theme.textFaint)
                        .listRowBackground(Theme.settingsGroup)
                }
            }
            .scrollContentBackground(.hidden)
            .background(Theme.settingsBackground)
            .searchable(text: $findQuery, prompt: "Найти проект")
            .navigationTitle("Проекты")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) { SheetCloseButton { showFind = false } }
            }
        }.tint(Theme.text)
    }

    private var onlineMachines: [MachineSnapshot] {
        client.machines.filter { $0.online && $0.canStartHere }
            .sorted { $0.machine.name.localizedCaseInsensitiveCompare($1.machine.name) == .orderedAscending }
    }

    private var customSheet: some View {
        NavigationStack {
            Form {
                Section("Сервер") {
                    Picker("Сервер", selection: $customMachineId) {
                        ForEach(onlineMachines) { m in Text(m.machine.name).tag(m.machine.machineId) }
                    }
                }.listRowBackground(Theme.settingsGroup)
                Section("Папка") {
                    TextField("/absolute/path", text: $customPath)
                        .font(.mono(Theme.sizeMicro)).textInputAutocapitalization(.never).autocorrectionDisabled()
                }.listRowBackground(Theme.settingsGroup)
            }
            .scrollContentBackground(.hidden)
            .background(Theme.settingsBackground)
            .navigationTitle("Другая папка")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { Button("Отмена") { showCustom = false } }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Выбрать") { useCustom() }.fontWeight(.semibold)
                        .disabled(customMachineId.isEmpty
                                  || customPath.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
        }
        .presentationDetents([.medium])
    }

    // MARK: - Новая папка участника

    /// Выданные корни на выбранной машине — только в них хаб даёт участнику
    /// создать папку. Пусто у владельца и менеджера: у них свои машины.
    private var memberRoots: [String] {
        guard isMember, machine?.online == true else { return [] }
        var seen = Set<String>()
        return shareTargets.filter { $0.machineId == selectedMachineId }
            .map(\.cwd).filter { seen.insert($0).inserted }
    }

    private func shareLabel(_ root: String) -> String {
        shareTargets.first { $0.machineId == selectedMachineId && $0.cwd == root }?.label
            ?? (root as NSString).lastPathComponent
    }

    private var newFolderSheet: some View {
        let nameError = MemberFolder.nameError(newFolderName)
        let roots = memberRoots
        let name = newFolderName
        return NavigationStack {
            Form {
                if roots.count > 1 {
                    Section("Где") {
                        Picker("Общая папка", selection: $newFolderRoot) {
                            ForEach(roots, id: \.self) { r in Text(shareLabel(r)).tag(r) }
                        }
                    }.listRowBackground(Theme.settingsGroup)
                }
                Section {
                    TextField("Название", text: $newFolderName)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                        .submitLabel(.done)
                        .onSubmit { Task { await createFolder() } }
                        .accessibilityIdentifier("start.newFolder.name")
                } header: {
                    Text("Папка")
                } footer: {
                    if let msg = newFolderError ?? nameError {
                        Text(msg).foregroundStyle(Theme.red)
                    } else if !newFolderRoot.isEmpty {
                        Text(MemberFolder.join(root: newFolderRoot, name: name.isEmpty ? "…" : name))
                            .font(.mono(Theme.sizeMicro))
                    }
                }.listRowBackground(Theme.settingsGroup)
            }
            .scrollContentBackground(.hidden)
            .background(Theme.settingsBackground)
            .navigationTitle("Новая папка")
            .navigationBarTitleDisplayMode(.inline)
            .onChange(of: newFolderName) { _, _ in newFolderError = nil }
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { Button("Отмена") { showNewFolder = false } }
                ToolbarItem(placement: .topBarTrailing) {
                    if newFolderBusy {
                        ProgressView()
                    } else {
                        Button("Создать") { Task { await createFolder() } }.fontWeight(.semibold)
                            .disabled(name.trimmingCharacters(in: .whitespaces).isEmpty
                                      || nameError != nil || newFolderRoot.isEmpty)
                            .accessibilityIdentifier("start.newFolder.create")
                    }
                }
            }
        }
        .presentationDetents([.medium])
        .interactiveDismissDisabled(newFolderBusy)
    }

    private func presentNewFolder() {
        let roots = memberRoots
        guard !roots.isEmpty else { return }
        newFolderRoot = target.flatMap { MemberFolder.root(containing: $0.cwd, roots: roots) } ?? roots[0]
        newFolderName = ""
        newFolderError = nil
        newFolderBusy = false
        showNewFolder = true
    }

    private func createFolder() async {
        let name = newFolderName
        let root = newFolderRoot
        let machineId = selectedMachineId
        guard !newFolderBusy, !root.isEmpty, !name.trimmingCharacters(in: .whitespaces).isEmpty,
              MemberFolder.nameError(name) == nil else { return }
        newFolderBusy = true
        defer { newFolderBusy = false }
        do {
            let r = try await client.makeFolder(machineId: machineId, cwd: root, name: name)
            // Уже существующая папка — не свежая: не делать вид, что создали.
            if r.created == false {
                newFolderError = "Папка с таким именем уже есть."
                Haptics.warning()
                return
            }
            let dir = MemberFolder.join(root: root, name: name)
            let machineName = client.machines.first { $0.machine.machineId == machineId }?.machine.name ?? machineId
            let t = ProjectTarget(machineId: machineId, machineName: machineName, cwd: dir,
                                  label: name, lastModified: Date().timeIntervalSince1970 * 1000,
                                  mine: true, origin: .adopted, hasSessions: false)
            custom = t
            refreshProjects()
            pick(t)
            showNewFolder = false
            Haptics.success()
        } catch {
            newFolderError = MemberFolder.describe(error.localizedDescription)
            Haptics.warning()
        }
    }

    private func presentCustom() {
        customMachineId = selectedMachineId
        customPath = ""
        showCustom = true
    }

    private func useCustom() {
        let dir = customPath.trimmingCharacters(in: .whitespaces)
        guard !customMachineId.isEmpty, !dir.isEmpty else { return }
        let name = onlineMachines.first { $0.machine.machineId == customMachineId }?.machine.name
            ?? customMachineId
        let t = ProjectTarget(machineId: customMachineId, machineName: name, cwd: dir,
                              label: (dir as NSString).lastPathComponent,
                              lastModified: 0, mine: true, origin: .adopted,
                              hasSessions: false)
        custom = t
        refreshProjects()
        pick(t)
        showCustom = false
        Haptics.light()
    }

    // MARK: - Действия

    private func pick(_ p: ProjectTarget) {
        if let current = target { projectByMachine[current.machineId] = current.id }
        router.newChatTarget = nil
        machineChoice = p.machineId
        projectByMachine[p.machineId] = p.id
        setProjectKey(p.id)
    }

    private func pickServer(_ id: String) {
        guard id != selectedMachineId else { return }
        if let current = target { projectByMachine[current.machineId] = current.id }
        router.newChatTarget = nil
        machineChoice = id
        let available = projects.filter { $0.machineId == id }
        let next = available.first { $0.id == projectByMachine[id] } ?? ProjectShelf.recent(available).first
        setProjectKey(next?.id ?? "")
    }

    private func setProjectKey(_ key: String) {
        projectKey = key
        // `<machine>::<folder>` of a private machine is not parked in UserDefaults.
        let machine = projects.first { $0.id == key }?.machineId ?? key.components(separatedBy: "::").first ?? ""
        if !machine.isEmpty, client.isPrivateMachine(machine) {
            UserDefaults.standard.removeObject(forKey: Self.projectKeyDefault)
        } else {
            UserDefaults.standard.set(key, forKey: Self.projectKeyDefault)
        }
    }

    /// Начать сессию и уйти в её живой чат.
    ///
    /// Возвращает, УЕХАЛО ли сообщение: композер чистит себя только тогда, иначе
    /// человеку нечего повторить.
    /// The machine this screen would start on is private (or its key is held here).
    private var privateTarget: Bool { !selectedMachineId.isEmpty && client.isPrivateMachine(selectedMachineId) }

    private func start(_ text: String, _ images: [ImageAttachment]) -> Bool {
        guard let t = target, machine?.online == true, machine?.canStartHere == true else { return false }
        if openCodeWaiting { return false }
        // Три настройки едут СОВЕТОМ: хаб отбрасывает то, чего эта машина не
        // умеет, а не отказывает в старте, — поэтому устаревший выбор стоит
        // настройки, но никогда сессии.
        guard client.newSession(machineId: t.machineId, cwd: t.cwd,
                                message: text.isEmpty ? nil : text, images: images,
                                // A skill prefix is built by the hub from text it cannot read
                                // on a private machine (docs/E2EE.md): none there.
                                category: privateTarget ? nil : category,
                                source: source,
                                model: startModel, effort: startRun.effort,
                                permissionMode: startRun.permissionMode)
        else { return false }
        router.openNewRun(label: compactSessionName(title: text, project: t.label),
                          machineName: t.machineName, source: source, projectName: t.label)
        Haptics.success()
        return true
    }
}
