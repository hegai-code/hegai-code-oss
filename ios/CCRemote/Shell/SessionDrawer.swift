import SwiftUI
import CCRemoteKit

/// Cached project-first session navigation, retained throughout drawer gestures.
struct SessionDrawer: View, Equatable {
    let width: CGFloat
    var visible: Bool = true
    // Parent drag closures change every tick. Only these presentation inputs
    // belong to the parent; Observation and local State still invalidate this
    // view when inventory, search, selection or favorites actually change.
    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.width == rhs.width && lhs.visible == rhs.visible
    }
    @Environment(CentralClient.self) private var client
    @Environment(Router.self) private var router
    @Environment(AppSettings.self) private var settings
    @Environment(DrawerModel.self) private var model
    @State private var search = ""
    @State private var searching = false
    @FocusState private var searchFocused: Bool
    @State private var selectedProjectId: String?
    /// «Раньше» / «Скрытые» are folded by default: the drawer answers «where
    /// is work happening», not «every folder I ever opened».
    @State private var olderOpen = false
    @State private var hiddenOpen = false
    @State private var refreshTask: Task<Void, Never>?

    private var selectedProject: DrawerModel.Project? {
        model.corpus.projects.first { $0.id == selectedProjectId }
    }

    var body: some View {
        #if DEBUG
        let _ = { DrawerPerformanceProbe.drawerBodies += 1 }()
        #endif
        let corpus = model.corpus
        let showingList = selectedProjectId != nil || !search.isEmpty
        let matches = model.sessions(projectId: selectedProjectId, query: search) {
            client.navigationTitles.label(machineId: $0.machineId, session: $0.session)
        }
        projectsLayer(corpus: corpus, showingList: showingList, matches: matches)
        // Как в чате (09.10.2026): строки уходят под часы, шапку меню и
        // подвал с «Чатом» и гаснут, а не режутся краем safe area. Маска же
        // держит ширину шторки — прежний `.clipped()` больше не нужен, а он
        // и давал глухие полосы сверху и снизу.
        .frame(width: width)
        .frame(maxHeight: .infinity)
        .chatEdgeFade(extraTop: 52, extraBottom: 60)
        .overlay(alignment: .top) { header }
        .overlay(alignment: .bottom) { footer }
        .foregroundStyle(Theme.drawerText)
        .background(Theme.drawerBackground.ignoresSafeArea())
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(visible ? "shell.drawer" : "shell.drawer.hidden")
        // The first fill is immediate; every later change is coalesced (see
        // `scheduleRefresh`). Not skipped while the drawer is closed: this model
        // also feeds the ☰ button's dot and the home screen's «в работе» list.
        .onAppear { refresh() }
        .onChange(of: client.machines) { _, _ in scheduleRefresh() }
        .onChange(of: client.activeRuns) { _, _ in scheduleRefresh() }
        .onChange(of: client.hiddenAutomatedSessionKeys) { _, _ in scheduleRefresh() }
        .onChange(of: client.completionReads.unread) { _, _ in scheduleRefresh() }
        .onChange(of: client.effectiveViewerId) { _, _ in scheduleRefresh() }
        .onChange(of: settings.favorites) { _, _ in scheduleRefresh() }
        .onChange(of: settings.hiddenProjects) { _, _ in scheduleRefresh() }
        .onChange(of: visible) { _, now in
            if now {
                // Opening must show the current inventory, not a pending one.
                refreshTask?.cancel(); refreshTask = nil
                refresh()
                // Opening the drawer shows the limits ring: bring it up to date.
                client.refreshQuota()
            } else { search = ""; searching = false; searchFocused = false }
        }
        .accessibilityAction(named: "Закрыть") { router.closeDrawer() }
    }

    /// Проекты и сессии.
    private func projectsLayer(corpus: DrawerModel.Corpus, showingList: Bool,
                               matches: [SessionItem]) -> some View {
        ZStack {
            // Retaining the project scroll view keeps its exact offset on Back.
            drawerScroll {
                LazyVStack(alignment: .leading, spacing: 8) {
                    projectCards(corpus)
                }
                .padding(.horizontal, 12)
            }
            .opacity(showingList ? 0 : 1)
            .allowsHitTesting(!showingList)
            .accessibilityHidden(showingList)
            if showingList {
                drawerScroll {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        if let project = selectedProject { projectHeading(project, opensProject: false) }
                        if matches.isEmpty { emptyState }
                        ForEach(matches) { item in session(item, corpus) }
                    }
                    .padding(.horizontal, 12)
                }
                .id(selectedProjectId ?? "search")
            }
        }
    }

    /// Карточки проектов и полки «Раньше» / «Скрытые».
    @ViewBuilder
    private func projectCards(_ corpus: DrawerModel.Corpus) -> some View {
        if corpus.projects.isEmpty { emptyState }
        ForEach(corpus.shelves.recent) { project in projectCard(project, corpus) }
        if !corpus.shelves.older.isEmpty {
            shelf("Раньше", systemImage: "clock", projects: corpus.shelves.older, open: $olderOpen)
        }
        if !corpus.shelves.hidden.isEmpty {
            shelf("Скрытые", systemImage: "eye.slash", projects: corpus.shelves.hidden, open: $hiddenOpen)
        }
    }

    private func drawerScroll<Content: View>(@ViewBuilder content: () -> Content) -> some View {
        ScrollView {
            content().padding(.top, 56).padding(.bottom, 68)
        }
        .scrollIndicators(.hidden)
        .scrollDismissesKeyboard(.interactively)
        .unifiedScrollEdges()
        .scrollClipDisabled()
        .contentShape(Rectangle())
        .accessibilityIdentifier("drawer.sessions")
    }

    private var emptyState: some View {
        Text(searching ? "Ничего не найдено" : client.status == .open || client.fleetIsCached ? "Пока нет сессий" : "Подключаюсь…")
            .font(.system(.subheadline)).foregroundStyle(Theme.drawerSecondary).padding(24)
    }

    private var header: some View {
        HStack(spacing: 8) {
            if selectedProjectId != nil {
                Button {
                    selectedProjectId = nil; search = ""; searching = false; searchFocused = false
                } label: {
                    Image(systemName: "chevron.left").font(.system(size: 17, weight: .medium))
                        .frame(width: 36, height: 36)
                        .background(Theme.drawerCard, in: Circle())
                        .frame(width: 44, height: 44).contentShape(Rectangle())
                }
                .buttonStyle(.plain).accessibilityLabel("Все проекты")
                .accessibilityIdentifier("drawer.back")
            }
            if searching {
                TextField(selectedProjectId == nil ? "Поиск сессий" : "Поиск в проекте", text: $search)
                    .font(.system(.subheadline)).focused($searchFocused)
                    .autocorrectionDisabled().textInputAutocapitalization(.never)
                    .submitLabel(.search)
                    .padding(8)
                    .background(Theme.drawerCard, in: RoundedRectangle(cornerRadius: 12))
                    .accessibilityIdentifier("drawer.searchField")
            } else {
                Button {
                    search = ""; searching = false; searchFocused = false; selectedProjectId = nil
                    router.home(); Haptics.light()
                } label: {
                    HegaiWordmark(size: 21)
                        .lineLimit(1).frame(minHeight: Theme.tapTarget).contentShape(Rectangle())
                }.buttonStyle(.plain)
                    .accessibilityLabel("Hegai Code, на главную")
                    .accessibilityIdentifier("drawer.brand")
                Spacer(minLength: 0)
                // Лимиты живут здесь с 11.10.2026 (раньше — справа на главной).
                // Внутри открытого проекта шапка и так занята кнопкой «назад».
                // Подпись «NN%» — только где она влезает: на 375pt шторка 307pt,
                // знак + два кольца + поиск вмещаются лишь без подписей.
                if selectedProjectId == nil {
                    // 20pt и на 2pt ниже центра строки: кольца встают на линию
                    // букв «hegai.code», а не на её середину (Владелец, 11.10.2026).
                    UsageLimitsView(compact: true, headerSummary: true, ringSize: 20,
                                    showsPercent: width >= 350)
                        .offset(y: 2)
                }
            }
            Button {
                searching.toggle(); search = ""; searchFocused = searching
            } label: {
                Image(systemName: searching ? "xmark" : "magnifyingglass")
                    .font(.system(size: 18, weight: .regular))
                    .frame(width: 36, height: 36)
                    .background(Theme.drawerCard, in: Circle())
                    .overlay(Circle().strokeBorder(Theme.drawerRim, lineWidth: 1))
                    .frame(width: Theme.tapTarget, height: Theme.tapTarget)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(searching ? "Отменить поиск" : "Поиск")
            .accessibilityIdentifier("drawer.search")
        }
        .padding(.leading, selectedProjectId == nil ? 24 : 12).padding(.trailing, 12)
        .padding(.vertical, 4)
    }

    private func projectCard(_ project: DrawerModel.Project, _ corpus: DrawerModel.Corpus) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            projectHeading(project)
            ForEach(project.preview) { item in session(item, corpus) }
        }
        .padding(.bottom, 8)
        .background(Theme.drawerCard, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
    }

    private func projectHeading(_ project: DrawerModel.Project, opensProject: Bool = true) -> some View {
        let duplicate = model.corpus.projects.contains {
            $0.id != project.id && $0.title == project.title && $0.machineName == project.machineName
        }
        return HStack(spacing: 0) {
            Button {
                guard opensProject else { return }
                search = ""; searching = false; searchFocused = false
                selectedProjectId = project.id
                Haptics.light()
            } label: {
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 4) {
                        Text(project.title).lineLimit(1).truncationMode(.tail)
                            .accessibilityIdentifier("drawer.projectTitle.\(project.id)")
                        Text("/").foregroundStyle(Theme.drawerSecondary)
                        Text(project.machineName).lineLimit(1).truncationMode(.tail)
                            .foregroundStyle(Theme.drawerSecondary)
                    }
                    .font(.system(size: 15, weight: .semibold))
                    if duplicate, let cwd = project.cwd {
                        Text(cwd).font(.system(size: 10)).lineLimit(1).truncationMode(.middle)
                            .foregroundStyle(Theme.drawerSecondary)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.leading, 12).padding(.vertical, 4)
                .frame(minHeight: 48).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("drawer.project.\(project.id)")
            .accessibilityLabel("\(project.title), \(project.machineName)")
            .contextMenu { hideButton(project) }
            Button {
                guard let target = project.target else { return }
                router.newChat(in: target); Haptics.light()
            } label: {
                Image(systemName: "plus").font(.system(size: 19, weight: .regular))
                    .frame(width: 44, height: 44).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(project.target == nil)
            .foregroundStyle(project.target == nil ? Theme.drawerSecondary : Theme.drawerText)
            .accessibilityLabel("Новый чат в \(project.title)")
            .accessibilityHint(project.unavailableReason ?? project.machineName)
            .accessibilityIdentifier("drawer.add.\(project.id)")
            .help(project.unavailableReason ?? "Новый чат")
        }
        .padding(.trailing, 4)
    }

    /// A folded shelf: a header row with a count, one line per project inside.
    private func shelf(_ title: String, systemImage: String, projects: [DrawerModel.Project],
                       open: Binding<Bool>) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                open.wrappedValue.toggle(); Haptics.light()
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: open.wrappedValue ? "chevron.down" : "chevron.right")
                        .font(.system(size: 12, weight: .semibold)).frame(width: 14)
                    Image(systemName: systemImage).font(.system(size: 13))
                    Text(title).font(.system(.subheadline, weight: .semibold))
                    if projects.contains(where: { !$0.unreadCompletions.isEmpty }) { unreadDot }
                    Spacer(minLength: 0)
                    Text("\(projects.count)").font(.system(.footnote).monospacedDigit())
                }
                .foregroundStyle(Theme.drawerSecondary)
                .padding(.horizontal, 12).frame(minHeight: Theme.tapTarget).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("\(title), \(projects.count)")
            .accessibilityValue((open.wrappedValue ? "Развёрнуто" : "Свёрнуто") +
                                (projects.contains(where: { !$0.unreadCompletions.isEmpty }) ? ", Непрочитанный ответ" : ""))
            .accessibilityIdentifier("drawer.shelf.\(title)")
            if open.wrappedValue {
                ForEach(projects) { project in shelfRow(project) }
            }
        }
    }

    /// Name / machine, last change on the right. Opens the project's list.
    private func shelfRow(_ project: DrawerModel.Project) -> some View {
        Button {
            search = ""; searching = false; searchFocused = false
            selectedProjectId = project.id; Haptics.light()
        } label: {
            HStack(spacing: 4) {
                Text(project.title).font(.system(.subheadline, weight: .medium)).lineLimit(1)
                Text("/ \(project.machineName)").font(.system(.subheadline))
                    .foregroundStyle(Theme.drawerSecondary).lineLimit(1)
                if !project.unreadCompletions.isEmpty { unreadDot }
                Spacer(minLength: 8)
                Text(Self.ago(project.lastModified)).font(.system(.footnote).monospacedDigit())
                    .foregroundStyle(Theme.drawerSecondary)
            }
            .truncationMode(.tail)
            .padding(.horizontal, 12).frame(minHeight: Theme.tapTarget).contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("drawer.shelfRow.\(project.id)")
        .accessibilityLabel("\(project.title), \(project.machineName), \(Self.ago(project.lastModified))")
        .accessibilityValue(project.unreadCompletions.isEmpty ? "" : "Непрочитанный ответ")
        .contextMenu { hideButton(project) }
    }

    private var unreadDot: some View {
        Circle().fill(Theme.drawerCompleted).frame(width: 6, height: 6).accessibilityHidden(true)
    }

    @ViewBuilder private func hideButton(_ project: DrawerModel.Project) -> some View {
        if settings.hiddenProjects.contains(project.id) {
            Button { settings.hiddenProjects.remove(project.id) } label: {
                Label("Вернуть в список", systemImage: "eye")
            }
        } else {
            Button { settings.hiddenProjects.insert(project.id) } label: {
                Label("Скрыть проект", systemImage: "eye.slash")
            }
        }
    }

    static func ago(_ stamp: Double, now: Date = Date()) -> String {
        let minutes = max(0, Int((now.timeIntervalSince1970 - stamp / 1000) / 60))
        if minutes < 1 { return "сейчас" }
        if minutes < 60 { return "\(minutes) мин" }
        if minutes < 1440 { return "\(minutes / 60) ч" }
        return "\(minutes / 1440) дн"
    }

    private func session(_ item: SessionItem, _ corpus: DrawerModel.Corpus) -> some View {
        let current = router.currentSession?.id == item.id
        let mark = RunMark(item.session.activityState(run: corpus.runs[item.id]))
        let attention = mark == .attention
        let unread = mark == .none && client.completionReads.unread[item.id] != nil
        let title = client.navigationTitles.label(machineId: item.machineId, session: item.session)
        let activity = mark == .live ? (item.session.isCodex ? "Codex работает" : "Claude работает") : ""
        return Button {
            router.openSession(machineId: item.machineId, sessionId: item.session.sessionId)
            Haptics.light()
        } label: {
            HStack(spacing: 8) {
                SessionActivityIcon.title(title, active: mark == .live, isCodex: item.session.isCodex, isOpenCode: item.session.isOpenCode)
                    .font(.system(.subheadline, weight: current ? .medium : .regular))
                    .accessibilityIdentifier("drawer.sessionTitle.\(item.id)")
                    .accessibilityLabel(title)
                    .accessibilityValue(activity)
                    .lineLimit(1).truncationMode(.tail)
                Spacer(minLength: 0)
                if settings.favorites.contains(item.id) {
                    Image(systemName: "star.fill").font(.system(size: 9)).foregroundStyle(Theme.drawerSecondary)
                }
                if attention || unread {
                    Circle().fill(attention ? Theme.drawerBlue : Theme.drawerCompleted)
                        .frame(width: 6, height: 6)
                        .accessibilityHidden(true)
                }
            }
            .padding(.horizontal, 8).frame(minHeight: 36)
            .background(current ? Theme.drawerControl : .clear, in: RoundedRectangle(cornerRadius: 12))
            .contentShape(Rectangle()).padding(.horizontal, 4)
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("drawer.session.\(item.id)")
        .accessibilityLabel(activity.isEmpty ? title : "\(activity), \(title)")
        .task(id: "\(client.storageScope):\(item.session.title):\(visible):\(Int(item.session.lastModified / 300_000))") {
            guard visible else { return }
            await client.navigationTitles.prepare(client: client, machineId: item.machineId, session: item.session)
        }
        .accessibilityValue([attention ? (corpus.runs[item.id]?.attentionLabel ?? "Ждёт решения") : nil,
                             unread ? "Готово · не прочитано" : nil,
                             settings.favorites.contains(item.id) ? "Избранное" : nil]
            .compactMap { $0 }.joined(separator: ", "))
        .contextMenu {
            Button {
                settings.toggleFavorite(machineId: item.machineId, sessionId: item.session.sessionId)
            } label: {
                Label(settings.favorites.contains(item.id) ? "Убрать из избранного" : "В избранное", systemImage: "star")
            }
        }
    }

    private var footer: some View {
        HStack {
            Button { router.newChat(); Haptics.light() } label: {
                Label("Чат", systemImage: "square.and.pencil")
                    .font(.system(.subheadline, weight: .medium))
                    .padding(.horizontal, 16).frame(height: 36)
                    .foregroundStyle(Theme.onDrawerCreateAction)
                    .background(Theme.drawerCreateAction, in: Capsule())
                    .frame(minHeight: Theme.tapTarget)
                    .contentShape(Rectangle())
            }.buttonStyle(.plain).accessibilityLabel("Создать чат")
                .accessibilityIdentifier("drawer.newChat")
            Spacer()
            Button { router.openSettings(.account); Haptics.light() } label: {
                Image(systemName: "gearshape").font(.system(size: 19))
                    .frame(width: 36, height: 36)
                    .background(Theme.drawerControl, in: Circle())
                    .overlay(Circle().strokeBorder(Theme.drawerRim, lineWidth: 1))
                    .frame(width: Theme.tapTarget, height: Theme.tapTarget)
                    .contentShape(Rectangle())
            }.buttonStyle(.plain).accessibilityLabel("Настройки")
                .accessibilityIdentifier("drawer.settings")
        }
        .padding(.horizontal, 24).padding(.vertical, 8)
    }

    /// Inventory and activity frames arrive in bursts (a running session moves
    /// `machines` and `activeRuns` every few seconds); each used to rebuild the
    /// whole project corpus with a deep comparison of the fleet. One trailing
    /// rebuild 300 ms after the last change is indistinguishable on screen.
    private func scheduleRefresh() {
        refreshTask?.cancel()
        refreshTask = Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(300))
            guard !Task.isCancelled else { return }
            refresh()
        }
    }

    private func refresh() {
        model.update(machines: client.machines, runs: client.activeRuns,
                     favorites: settings.favorites, viewerId: client.effectiveViewerId,
                     unreadCompletions: client.completionReads.unread,
                     hiddenProjects: settings.hiddenProjects,
                     excludedSessions: client.hiddenAutomatedSessionKeys)
        if let id = selectedProjectId, !model.corpus.projects.contains(where: { $0.id == id }) {
            selectedProjectId = nil
        }
    }
}
