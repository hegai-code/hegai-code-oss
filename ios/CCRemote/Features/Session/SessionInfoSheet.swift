import SwiftUI
import UniformTypeIdentifiers
import CCRemoteKit

/// All conversation actions share the title's sheet. Runtime settings stay in
/// the composer; technical identifiers are secondary disclosure content.
struct SessionInfoSheet: View {
    let session: SessionSummary
    let machineId: String
    let machineName: String
    let canControl: Bool
    var canDrive: Bool = true
    /// A member who can start sessions may retitle any session the hub shows
    /// them; deleting stays behind `canControl`.
    var canRename: Bool = false
    @Environment(CentralClient.self) private var client
    @Environment(Router.self) private var router
    @Environment(\.dismiss) private var dismiss
    @State private var title = ""
    @State private var renameText = ""
    @State private var renaming = false
    @State private var saving = false
    @State private var error: String?
    @State private var confirmEnd = false
    @State private var confirmDelete = false
    @State private var deleting = false
    @State private var document: ConversationDocument?
    @State private var loading = false
    @State private var exporting = false
    @State private var copied = false
    @State private var showConversation = false

    /// OpenCode is Codex on a `pool-go/` model, and only a live run names its model.
    private var agent: String {
        guard session.isCodex else { return "Claude" }
        let isOpen = client.active?.machineId == machineId && client.active?.sessionId == session.sessionId
        let model = ModelLabel.explicit(client.runSettings?.model) ?? ModelLabel.explicit(client.runSettings?.activeModel)
        return isOpen && AgentModels.isGoModel(model) ? "OpenCode" : "Codex"
    }
    private var run: ActiveRunInfo? { client.runFor(machineId: machineId, sessionId: session.sessionId) }
    private var markdown: String { document?.markdown(title: title, agent: agent) ?? "" }
    private var projectItems: [SessionItem] {
        ProjectGrouping.myItems(from: client.machines, viewerId: client.effectiveViewerId, runs: client.activeRuns)
            .filter { $0.session.project == session.project && $0.id != "\(machineId)::\(session.sessionId)" }
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(title).font(.system(.headline)).lineLimit(1).textSelection(.enabled)
                            .accessibilityIdentifier("session.menuTitle")
                        Text([session.project, agent].compactMap { $0 }.joined(separator: " · "))
                            .font(.system(.footnote)).foregroundStyle(Theme.textMuted)
                    }.padding(.bottom, 4)
                    VStack(spacing: 0) {
                        if canControl || canRename {
                            action(saving ? "Сохраняю…" : "Переименовать", "pencil", id: "session.rename") {
                                renameText = title; renaming = true
                            }.disabled(saving)
                            separator
                        }
                        action("Поиск по разговору", "magnifyingglass", id: "session.search") {
                            showConversation = true
                            if document == nil { Task { await loadDocument() } }
                        }
                        separator
                        action(copied ? "Скопировано" : "Копировать разговор", copied ? "checkmark" : "doc.on.doc", id: "session.copy") {
                            Task {
                                await loadDocument()
                                guard document != nil, error == nil else { return }
                                copyToPasteboard(markdown); copied = true; Haptics.success()
                            }
                        }.disabled(loading)
                        separator
                        action("Сохранить Markdown", "square.and.arrow.up", id: "session.export") {
                            Task {
                                await loadDocument()
                                if document != nil, error == nil { exporting = true }
                            }
                        }.disabled(loading)
                        if canControl, session.cwd != nil {
                            separator
                            action(deleting ? "Удаляю…" : "Удалить", "trash", id: "session.delete") {
                                confirmDelete = true
                            }.disabled(deleting).foregroundStyle(Theme.negative)
                        }
                    }
                    .background(Theme.surface, in: RoundedRectangle(cornerRadius: Theme.radiusLg))
                    if loading { ProgressView("Загружаю разговор…").font(.footnote) }
                    if document?.limited == true {
                        Text("Доступны последние 2000 сообщений. Поиск и экспорт охватывают эту часть разговора.")
                            .font(.footnote).foregroundStyle(Theme.textMuted)
                    }
                    if let error {
                        Text(error).font(.footnote).foregroundStyle(Theme.negative)
                        Button("Повторить загрузку") { Task { await loadDocument() } }
                    }
                    if session.project != nil {
                        NavigationLink {
                            projectSessions
                        } label: {
                            HStack(spacing: 12) {
                                Image(systemName: "folder").frame(width: 22)
                                Text("Другие сессии проекта")
                                Spacer(minLength: 0)
                                Image(systemName: "chevron.right").font(.caption).foregroundStyle(Theme.textMuted)
                            }.font(.subheadline)
                                .frame(maxWidth: .infinity, minHeight: 48, alignment: .leading)
                                .padding(.horizontal, 16)
                        }.buttonStyle(.plain)
                        .background(Theme.surface, in: RoundedRectangle(cornerRadius: Theme.radiusLg))
                        .accessibilityIdentifier("session.projectSessions")
                    }
                    DisclosureGroup("Технические сведения") {
                        VStack(alignment: .leading, spacing: 12) {
                            fact("Машина", machineName)
                            if let cwd = session.cwd { fact("Папка", cwd) }
                            if let branch = session.gitBranch { fact("Ветка", branch) }
                            fact("ID", session.sessionId)
                            if let version = session.cliVersion { fact("Версия агента", version) }
                            if let created = session.createdAt { fact("Создана", date(created)) }
                            fact("Обновлена", date(session.lastModified))
                        }.padding(.top, 12)
                    }.font(.subheadline).padding(16)
                        .background(Theme.surface, in: RoundedRectangle(cornerRadius: Theme.radiusLg))
                        .accessibilityIdentifier("session.technical")
                    if canDrive, run != nil || session.isLive {
                        VStack(alignment: .leading, spacing: 4) {
                            Button(role: .destructive) { confirmEnd = true } label: {
                                HStack(spacing: 12) {
                                    Image(systemName: "stop.circle").frame(width: 22)
                                    Text("Завершить запуск").font(.subheadline)
                                }.frame(maxWidth: .infinity, minHeight: 48, alignment: .leading)
                                    .padding(.horizontal, 16)
                            }.buttonStyle(.plain)
                                .foregroundStyle(Theme.negative)
                                .background(Theme.surface, in: RoundedRectangle(cornerRadius: Theme.radiusLg))
                                .accessibilityIdentifier("session.end")
                            Text("История сохранится")
                                .font(.caption).foregroundStyle(Theme.textMuted)
                                .padding(.horizontal, 16).padding(.top, 4)
                        }
                    }
                }.padding(.horizontal, 20).padding(.top, 12).padding(.bottom, 24)
            }
            .foregroundStyle(Theme.text).background(Theme.bg)
            .navigationTitle("Сессия").inlineTitle()
            .toolbar {
                bareToolbarItem(placement: .trailingActions) {
                    Button { dismiss() } label: {
                        Image(systemName: "xmark").font(.system(size: 14, weight: .semibold))
                            .foregroundStyle(Theme.textMuted)
                            .frame(width: 32, height: 32)
                            .background(Theme.surface, in: Circle())
                            .frame(width: 44, height: 44)
                            .contentShape(Rectangle())
                    }.buttonStyle(.plain).accessibilityLabel("Закрыть")
                        .accessibilityIdentifier("session.menuClose")
                }
            }
            .navigationDestination(isPresented: $showConversation) {
                ConversationSearchView(document: document, agent: agent, loading: loading)
            }
            .alert("Переименовать сессию", isPresented: $renaming) {
                TextField("Название", text: $renameText)
                Button("Отмена", role: .cancel) {}
                Button("Сохранить") { Task { await rename() } }
                    .disabled(renameText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
            .confirmationDialog(ProjectAdmin.deleteSessionConfirmation, isPresented: $confirmDelete,
                                titleVisibility: .visible) {
                Button("Удалить", role: .destructive) { Task { await deleteSession() } }
                Button("Отмена", role: .cancel) {}
            }
            .alert("Завершить запуск?", isPresented: $confirmEnd) {
                Button("Завершить запуск", role: .destructive) {
                    if let run { client.closeRun(runId: run.runId) }
                    else { client.endSession(machineId: machineId, sessionId: session.sessionId) }
                    dismiss()
                }
                Button("Отмена", role: .cancel) {}
            } message: { Text("Текущая работа остановится. История разговора сохранится.") }
            .fileExporter(isPresented: $exporting, document: ConversationMarkdown(text: markdown),
                          contentType: UTType(filenameExtension: "md") ?? .plainText,
                          defaultFilename: "Разговор-\(session.sessionId.prefix(8))") { result in
                if case .failure(let failure) = result { error = "Не удалось сохранить: \(failure.localizedDescription)" }
            }
        }
        .presentationDetents([.fraction(0.78), .large])
        .presentationDragIndicator(.visible)
        .presentationBackground(Theme.bg)
        .presentationCornerRadius(28)
        .task {
            title = client.navigationTitles.label(machineId: machineId, session: session)
        }
    }

    private var separator: some View {
        Theme.border.opacity(0.35).frame(height: 0.5).padding(.leading, 50)
    }

    private func action(_ title: String, _ icon: String, id: String, perform: @escaping () -> Void) -> some View {
        Button(action: perform) {
            HStack(spacing: 12) {
                Image(systemName: icon).frame(width: 22)
                Text(title)
            }.font(.system(.subheadline))
                .frame(maxWidth: .infinity, minHeight: 48, alignment: .leading).padding(.horizontal, 16)
        }.buttonStyle(.plain).accessibilityIdentifier(id)
    }

    private func fact(_ label: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label).font(.caption).foregroundStyle(Theme.textMuted)
            Text(value).font(.system(.footnote, design: .monospaced)).textSelection(.enabled)
        }
    }
    private func date(_ value: Double) -> String {
        Date(timeIntervalSince1970: value / 1000).formatted(date: .abbreviated, time: .shortened)
    }
    private var projectSessions: some View {
        List {
            if projectItems.isEmpty { Text("Других сессий пока нет").foregroundStyle(Theme.textMuted) }
            ForEach(projectItems) { item in
                Button {
                    dismiss()
                    router.openSession(machineId: item.machineId, sessionId: item.session.sessionId)
                } label: {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(client.navigationTitles.label(machineId: item.machineId, session: item.session)).lineLimit(1)
                        Text(item.machineName).font(.caption).foregroundStyle(Theme.textMuted)
                    }
                }.accessibilityIdentifier("session.related.\(item.id)")
            }
        }.navigationTitle(session.project ?? "Проект").inlineTitle()
    }
    private func rename() async {
        guard let cwd = session.cwd else { return }
        saving = true
        defer { saving = false }
        let value = renameText.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            try await client.renameSession(machineId: machineId, cwd: cwd, sessionId: session.sessionId,
                                           title: value, source: session.source)
            title = value
            client.rescan(machineId: machineId)
            Haptics.success()
        } catch { self.error = "Не удалось переименовать: \(error.localizedDescription)" }
    }
    /// Как в вебе: запись уходит с машины (живой ран агент гасит сам), экран
    /// удалённой сессии закрывается, список обновляется пересканом.
    private func deleteSession() async {
        guard let cwd = session.cwd else { return }
        deleting = true
        defer { deleting = false }
        do {
            try await client.deleteSession(machineId: machineId, cwd: cwd, sessionId: session.sessionId,
                                           source: session.source)
            client.rescan(machineId: machineId)
            Haptics.success()
            dismiss()
            if router.currentSession?.id == "\(machineId)::\(session.sessionId)" { router.home() }
        } catch { self.error = "Не удалось удалить: \(error.localizedDescription)" }
    }
    private func loadDocument() async {
        guard let cwd = session.cwd else { error = "Папка сессии ещё не получена."; return }
        loading = true; error = nil
        defer { loading = false }
        do {
            let history = try await client.sessionMessages(machineId: machineId, cwd: cwd,
                sessionId: session.sessionId, source: session.source, limit: SessionHistory.maximumTail)
            try Task.checkCancellation()
            let focused = client.active?.machineId == machineId && client.active?.sessionId == session.sessionId
            document = ConversationDocument(history: history, lines: focused ? client.lines : [],
                                            limited: history.count >= SessionHistory.maximumTail)
        } catch is CancellationError {} catch {
            self.error = "Не удалось загрузить разговор: \(error.localizedDescription)"
        }
    }
}

private struct ConversationMarkdown: FileDocument {
    static var readableContentTypes: [UTType] { [.plainText, UTType(filenameExtension: "md") ?? .plainText] }
    var text: String
    init(text: String) { self.text = text }
    init(configuration: ReadConfiguration) throws {
        text = String(decoding: configuration.file.regularFileContents ?? Data(), as: UTF8.self)
    }
    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper {
        FileWrapper(regularFileWithContents: Data(text.utf8))
    }
}

private struct ConversationSearchView: View {
    let document: ConversationDocument?
    let agent: String
    let loading: Bool
    @State private var query = ""
    var body: some View {
        List {
            HStack {
                Image(systemName: "magnifyingglass").foregroundStyle(Theme.textMuted)
                TextField("Слово или фраза", text: $query)
                    .accessibilityIdentifier("session.query")
            }
            if loading { ProgressView("Загружаю разговор…") }
            else if document == nil { Text("Разговор недоступен. Вернитесь и повторите загрузку.") }
            else if query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                Text("Введите слово или фразу").foregroundStyle(Theme.textMuted)
            } else {
                let matches = document?.matching(query) ?? []
                Text("Найдено: \(matches.count)").font(.footnote).foregroundStyle(Theme.textMuted)
                ForEach(matches) { entry in
                    NavigationLink {
                        ScrollView {
                            VStack(alignment: .leading, spacing: 16) {
                                let entries = document?.entries ?? []
                                if let index = entries.firstIndex(where: { $0.id == entry.id }) {
                                    ForEach(Array(entries[max(0, index - 1)...min(entries.count - 1, index + 1)])) { nearby in
                                        VStack(alignment: .leading, spacing: 8) {
                                            Text(nearby.human ? "Пользователь" : agent).font(.footnote.bold())
                                            MarkdownText(text: nearby.text).textSelection(.enabled)
                                        }.padding(12)
                                            .background(nearby.id == entry.id ? Theme.surfaceSunken : .clear,
                                                        in: RoundedRectangle(cornerRadius: Theme.radiusMd))
                                    }
                                }
                            }.padding(16)
                        }.navigationTitle("Фрагмент разговора").inlineTitle()
                    } label: {
                        VStack(alignment: .leading, spacing: 6) {
                            Text(entry.human ? "Пользователь" : agent).font(.caption).foregroundStyle(Theme.textMuted)
                            Text(entry.text).lineLimit(3).font(.subheadline)
                        }
                    }.accessibilityIdentifier("session.searchResult.\(entry.id)")
                }
            }
            if document?.limited == true { Text("Поиск в последних 2000 сообщениях").font(.footnote) }
        }.navigationTitle("Поиск по разговору").inlineTitle()
            .scrollDismissesKeyboard(.interactively)
    }
}
