import SwiftUI
import CCRemoteKit

struct MacStartGreeting: View {
    let fullName: String?

    private var line: String {
        if let name = fullName?.split(separator: " ").first, !name.isEmpty {
            return "Рад видеть, \(name)"
        }
        return "Что делаем?"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.s1) {
            Text(line)
                .font(.ui(26, weight: .bold)).foregroundStyle(Theme.text)
            Text("Опишите задачу — сессия начнётся на выбранной машине.")
                .font(.ui(13)).foregroundStyle(Theme.text3)
        }
        .padding(.top, Theme.s6)
    }
}

struct MacStartComposer: View {
    @Binding var target: StartTarget?
    @Binding var task: String
    @Binding var attachments: [ImageAttachment]
    let dictation: SpeechDictation
    @Binding var category: SessionCategory?
    @Binding var showPicker: Bool
    @Binding var pickerQuery: String
    @Binding var customMode: Bool
    @Binding var customPath: String
    @Binding var customMachineId: String
    /// Model / permissions / reasoning for the session about to start. Owned by
    /// the pane, which is what remembers it per machine+engine.
    @Binding var startRun: StartRunSettings

    let targets: [StartTarget]
    let onlineMachines: [MachineSnapshot]
    let isMember: Bool
    /// The runtime this start will land on, which is NOT always the picked
    /// agent — a member is put on Codex whatever the wire asks.
    let isCodex: Bool
    let starting: Bool
    let canSend: Bool
    let composerFocus: FocusState<Bool>.Binding
    let onStart: () -> Void

    /// Work types the CHOSEN machine can actually run. A category rewrites the
    /// first turn to `/<skill> …`, so a chip whose skill is missing there does
    /// not start a workflow — it leaves a stray slash-command in the transcript
    /// and looks like it worked.
    private var pickableCategories: [SessionCategory] {
        let skills = onlineMachines
            .first { $0.machine.machineId == target?.machineId }?
            .machine.skills
        return SessionCategory.pickable.filter { $0.runnable(on: skills) }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.s3) {
            MacStartTargetSelector(
                target: $target,
                showPicker: $showPicker,
                pickerQuery: $pickerQuery,
                customMode: $customMode,
                customPath: $customPath,
                customMachineId: $customMachineId,
                targets: targets,
                onlineMachines: onlineMachines
            )
            if !attachments.isEmpty { AttachmentStrip(attachments: $attachments) }
            HStack(alignment: .bottom, spacing: Theme.s1) {
                AttachButton(attachments: $attachments, size: 32, filled: false)
                if dictation.recording {
                    DictationWaveform(levels: dictation.levels)
                        .padding(.leading, Theme.s2)
                } else {
                    TextField("Опишите задачу…", text: $task, axis: .vertical)
                        .textFieldStyle(.plain)
                        .font(.ui(15))
                        .foregroundStyle(Theme.text)
                        .focused(composerFocus)
                        .lineLimit(1...8)
                        .padding(.vertical, Theme.s2)
                        .padding(.leading, Theme.s1)
                        .onSubmit { onStart() }
                }
                if task.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || dictation.active {
                    MicButton(text: $task, dictation: dictation, size: 32, filled: false)
                }
                if starting {
                    ProgressView().controlSize(.small)
                        .frame(width: 36, height: 36)
                } else {
                    SendCircle(enabled: canSend, size: 36) { onStart() }
                }
            }
            .padding(.leading, Theme.s2)
            .padding(.trailing, 6)
            .padding(.vertical, Theme.s1)
            .background(Theme.surface2,
                        in: RoundedRectangle(cornerRadius: Theme.composerRadius, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: Theme.composerRadius, style: .continuous)
                    .stroke(composerFocus.wrappedValue ? Theme.focusRing : Theme.border,
                            lineWidth: composerFocus.wrappedValue ? 1.5 : 1)
            )
            // Same as the session composer: a file dragged from Finder is a
            // valid way to start a task with a screenshot.
            .attachmentDrop($attachments)
            MacStartOptions(category: $category, categories: pickableCategories, isMember: isMember)
            // Its own line rather than a fourth item in the row above: these
            // three belong to the MACHINE the target selector just chose, and
            // the category chips already scroll for room at this measure.
            if let machineId = target?.machineId {
                StartRunPicker(machineId: machineId, isCodex: isCodex,
                               value: $startRun, height: 26)
            }
        }
        .padding(Theme.s4)
        .card()
        // Switching projects can move the composer to a machine that cannot run
        // the chosen type; keeping it would send `/mobile` somewhere nothing
        // handles it, with no chip on screen to explain why.
        .onChange(of: target) { _, _ in
            if let cat = category, !pickableCategories.contains(cat) { category = nil }
        }
    }
}

private struct MacStartTargetSelector: View {
    private static let maximumVisibleTargets = 40

    @Binding var target: StartTarget?
    @Binding var showPicker: Bool
    @Binding var pickerQuery: String
    @Binding var customMode: Bool
    @Binding var customPath: String
    @Binding var customMachineId: String

    let targets: [StartTarget]
    let onlineMachines: [MachineSnapshot]

    var body: some View {
        Button {
            customMode = false
            pickerQuery = ""
            showPicker = true
        } label: {
            HStack(spacing: Theme.s2) {
                Image(systemName: "folder").font(.system(size: 12)).foregroundStyle(Theme.text2)
                if let target {
                    Text(target.label).font(.ui(14, weight: .semibold)).foregroundStyle(Theme.text)
                    Text(target.machineName).font(.mono(11)).foregroundStyle(Theme.text3)
                    Text(target.cwd).font(.mono(11)).foregroundStyle(Theme.text3)
                        .lineLimit(1).truncationMode(.head)
                        .frame(maxWidth: 260, alignment: .leading)
                } else {
                    Text("Выбрать проект").font(.ui(14, weight: .semibold)).foregroundStyle(Theme.text2)
                }
                Image(systemName: "chevron.down")
                    .font(.system(size: 10, weight: .semibold)).foregroundStyle(Theme.text3)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .popover(isPresented: $showPicker, arrowEdge: .bottom) {
            pickerContent.frame(width: 400, height: customMode ? 220 : 420)
        }
    }

    @ViewBuilder
    private var pickerContent: some View {
        if customMode {
            customFolderForm
        } else {
            VStack(spacing: 0) {
                TextField("Поиск проекта…", text: $pickerQuery)
                    .textFieldStyle(.plain).font(.ui(13))
                    .padding(Theme.s3)
                Divider()
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        ForEach(filteredTargets) { target in
                            Button { self.target = target; showPicker = false } label: {
                                HStack(spacing: Theme.s2) {
                                    Text(target.label).font(.ui(13, weight: .medium)).foregroundStyle(Theme.text)
                                    Spacer()
                                    Text(target.machineName).font(.mono(10)).foregroundStyle(Theme.text3)
                                    if self.target?.id == target.id {
                                        Image(systemName: "checkmark")
                                            .font(.system(size: 11, weight: .semibold))
                                            .foregroundStyle(Theme.positive)
                                    }
                                }
                                .padding(.horizontal, Theme.s3).padding(.vertical, 6)
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                        }
                        if filteredTargets.isEmpty {
                            // An empty list has two very different causes and
                            // only one of them is a search. With no machines at
                            // all, "ничего не нашлось" reads as "your query is
                            // wrong" and hides the actual missing step.
                            Text(onlineMachines.isEmpty
                                 ? "Нет подключённых компьютеров. Подключите машину в «Настройки → Подключить машину» на code.acme.test"
                                 : "Ничего не нашлось")
                                .font(.ui(12)).foregroundStyle(Theme.text3)
                                .multilineTextAlignment(.leading)
                                .padding(Theme.s3)
                        }
                    }
                    .padding(.vertical, Theme.s1)
                }
                Divider()
                Button {
                    customMachineId = target?.machineId ?? onlineMachines.first?.machine.machineId ?? ""
                    customPath = ""
                    customMode = true
                } label: {
                    Label("Другая папка…", systemImage: "folder.badge.plus")
                        .font(.ui(13)).foregroundStyle(Theme.text2)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(Theme.s3)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
    }

    private var filteredTargets: [StartTarget] {
        let query = pickerQuery.trimmingCharacters(in: .whitespaces).lowercased()
        guard !query.isEmpty else { return Array(targets.prefix(Self.maximumVisibleTargets)) }
        return Array(targets.filter {
            $0.label.lowercased().contains(query) || $0.machineName.lowercased().contains(query)
                || $0.cwd.lowercased().contains(query)
        }.prefix(Self.maximumVisibleTargets))
    }

    private var customFolderForm: some View {
        VStack(alignment: .leading, spacing: Theme.s3) {
            Text("Другая папка").font(.ui(14, weight: .semibold)).foregroundStyle(Theme.text)
            Picker("Сервер", selection: $customMachineId) {
                ForEach(onlineMachines) { machine in
                    Text(machine.machine.name).tag(machine.machine.machineId)
                }
            }
            TextField("/absolute/path", text: $customPath)
                .textFieldStyle(.roundedBorder).font(.mono(12))
            HStack {
                Button("Назад") { customMode = false }
                Spacer()
                Button("Выбрать") { useCustom() }
                    .keyboardShortcut(.defaultAction)
                    .disabled(customMachineId.isEmpty ||
                              customPath.trimmingCharacters(in: .whitespaces).isEmpty)
            }
        }
        .padding(Theme.s4)
    }

    private func useCustom() {
        let directory = customPath.trimmingCharacters(in: .whitespaces)
        guard !customMachineId.isEmpty, !directory.isEmpty else { return }
        let machineName = onlineMachines.first { $0.machine.machineId == customMachineId }?.machine.name
            ?? customMachineId
        target = StartTarget(machineId: customMachineId, machineName: machineName, cwd: directory,
                             label: (directory as NSString).lastPathComponent,
                             lastModified: 0, count: 0)
        showPicker = false
        customMode = false
    }
}

private struct MacStartOptions: View {
    @Binding var category: SessionCategory?
    /// Already filtered to what the selected machine can run — see
    /// `MacStartComposer.pickableCategories`.
    let categories: [SessionCategory]
    let isMember: Bool

    var body: some View {
        HStack(spacing: Theme.s2) {
            categoryChips
            Spacer()
            AgentPicker(isMember: isMember, height: 26)
        }
    }

    /// The row scrolls because the category labels plus the agent segment do not
    /// fit the reading measure without truncating the category names.
    private var categoryChips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: Theme.s2) {
                ForEach(categories) { categoryOption in
                    Button {
                        category = (category == categoryOption) ? nil : categoryOption
                    } label: {
                        HStack(spacing: 5) {
                            RoundedRectangle(cornerRadius: Theme.macCategoryMarkRadius, style: .continuous)
                                .fill(categoryOption.color).frame(width: 6, height: 6)
                            Text(categoryOption.label).font(.ui(12, weight: .medium))
                                .fixedSize()
                        }
                        .foregroundStyle(category == categoryOption ? Theme.onSelect : Theme.text2)
                        .padding(.horizontal, Theme.s3)
                        .frame(height: 26)
                        .background(category == categoryOption ? Theme.select : Theme.surface3, in: Capsule())
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

}

struct MacStartQuickActions: View {
    let recentItems: [SessionItem]

    @Environment(Router.self) private var router

    var body: some View {
        HStack(spacing: Theme.s2) {
            quickButton("Открыть доску", systemImage: "rectangle.split.3x1") {
                router.destination = .board
            }
            if recentItems.count > 1 {
                quickButton("Открыть колонки", systemImage: "rectangle.split.2x1") {
                    router.destination = .columns
                }
            }
            quickButton("Поиск сессий  ⌘K", systemImage: "magnifyingglass") {
                router.paletteOpen = true
            }
            if let last = recentItems.first {
                quickButton("Продолжить последнюю", systemImage: "arrow.uturn.forward") {
                    router.openSession(machineId: last.machineId, sessionId: last.session.sessionId)
                }
            }
        }
    }

    private func quickButton(_ title: String, systemImage: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: Theme.s2) {
                Image(systemName: systemImage).font(.system(size: 12)).foregroundStyle(Theme.text2)
                Text(title).font(.ui(12, weight: .medium)).foregroundStyle(Theme.text2)
            }
            .padding(.horizontal, Theme.s3)
            .frame(height: 30)
            .background(Theme.surface2,
                        in: RoundedRectangle(cornerRadius: Theme.radiusMd, style: .continuous))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}
