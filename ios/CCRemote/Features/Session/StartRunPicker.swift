import SwiftUI
import CCRemoteKit

/// Model, permissions and reasoning for a session that does not exist yet.
///
/// The start-screen twin of `SessionRunPicker`: same three
/// settings, same labels, same order (Модель · Разрешения · Рассуждение),
/// because they are the same decision. What is new at start is only that the
/// FIRST turn already runs under them — which is what makes the permission mode
/// worth choosing here at all: asking for «Plan» after the model has started
/// editing is not planning.
///
/// Two narrowings against the live control, both deliberate:
///
///  - no `ultracode`. It is an escalation you reach for once you have watched
///    the model struggle, and `new_session` carries no flag for it; a session
///    can be raised to it a turn later, where the control already is.
///  - the model list may be missing. `models.list` answers from the RUNTIME
///    only once something on that machine has reported, so an idle machine
///    offers the curated fallback and a machine we cannot reach offers nothing
///    but «Как в аккаунте». That IS a working start; one that hangs waiting for
///    a list is not.
struct StartRunPicker: View {
    let machineId: String
    /// Which runtime the session will start under. Keys the model list and
    /// narrows the modes — Codex's ids are not Claude's.
    let isCodex: Bool
    /// "claude" | "codex" | "opencode". OpenCode is a Codex session on a
    /// `pool-go/` model: same runtime (`isCodex`), but its own rows, no
    /// account-default row, and a model that is never left unset.
    var agent = ""
    /// Passed through to the in-sheet `AgentPicker`.
    var showsOpenCode = false
    var agentSelection: String?
    var onAgentPick: ((String) -> Void)?
    @Binding var value: StartRunSettings
    var showsAgentPicker = false
    var agentIsFixed = false
    var fixedAgentLabel = "Codex · шлюз"
    var categories: [SessionCategory] = []
    @Binding var category: SessionCategory?

    @Environment(CentralClient.self) private var client

    /// The machine's own answer. Nil = nobody has answered yet, which is what
    /// licenses the built-in fallback below.
    @State private var fetched: [ModelInfoLite]?
    /// Did that answer come from the RUNTIME? Not cosmetic: the curated fallback
    /// carries no effort data at all, so "this model named no efforts" may only
    /// be read as "it takes none" when a real CLI said so.
    @State private var fetchedFromRuntime = false

    private var engine: String { isCodex ? "codex" : "claude" }
    private var cacheKey: String { "\(client.storageScope)::\(machineId)::\(engine)" }
    private var loadKey: String { "\(cacheKey)::\(client.connectionEpoch)::\(client.status == .open)" }

    @State private var showSheet = false

    /// ОДИН контрол вместо трёх коробок.
    ///
    /// Владелец про 0.7.2: «уебские блоки с выбором модели, рамблинг, итд —
    /// надо как-то красивей сделать». Их было три в ряд, каждая — прямоугольник
    /// с заливкой и рамкой, и на 375pt они занимали всю ширину под композером:
    /// три коробки ради настроек, которые трогают раз в неделю.
    ///
    /// Свёрнуто так же, как это уже решено в вебе (`web/src/components/
    /// RunPicker.tsx`): «Model and reasoning effort as ONE control». Там это
    /// вынужденно (фокус в `<select>` мельче 16px заставляет Safari зумить
    /// страницу), здесь — по той же причине, по какой так делают ChatGPT и
    /// Claude: модель — это подпись к разговору, а не панель управления. Три
    /// настройки — одно решение «как думать над этим сообщением», и читать их
    /// надо вместе.
    ///
    /// Нажатие открывает лист со всеми тремя списками. Лист, а не меню: у меню
    /// нет заголовков секций, и три группы без подписей читаются одной кашей.
    var body: some View {
        Button { showSheet = true; Haptics.light() } label: {
            RunSettingsSummary(model: pick.modelLabel,
                               effort: pick.effortOff ? nil : value.effort?.composerLabel)
        }
            .buttonStyle(.plain)
            .accessibilityIdentifier("composer.settings")
            .sheet(isPresented: $showSheet) { sheet }
        .task(id: loadKey) { await loadModels() }
        // A pick remembered for another machine may name a mode THIS box
        // withholds — `bypassPermissions` is exactly what the field exists to
        // withhold. Carrying it over would defeat the machine's own answer (the
        // hub drops it anyway), and a chip naming a mode no row offers is a
        // control lying about its value. Never acted on while the machine is
        // still missing from the snapshot: "not heard yet" is not "said no".
        .onChange(of: modes, initial: true) { _, offered in
            guard let mode = value.permissionMode, machineKnown, !offered.contains(mode)
            else { return }
            value.permissionMode = nil
        }
    }

    private var sheet: some View {
        RunSettingsSheet(onDone: { showSheet = false }) {
            if showsAgentPicker {
                AgentPicker(isMember: agentIsFixed, height: Theme.tapTarget, fixedLabel: fixedAgentLabel,
                            showsOpenCode: showsOpenCode, selection: agentSelection,
                            onPick: onAgentPick)
            }
            RunSettingGroup {
                // OpenCode has no account default: left unset it would land on
                // the machine's non-Go model.
                if !isOpenCode {
                    RunSettingChoice(title: "По умолчанию", subtitle: pick.accountLabel,
                                     selected: value.model == nil) { pickModel(nil) }
                }
                ForEach(pick.picks) { model in
                    if !isOpenCode || model.id != pick.picks.first?.id { Divider().padding(.horizontal, 16) }
                    RunSettingChoice(title: model.name ?? model.id, selected: shownModel == model.id) {
                        pickModel(model.id)
                    }
                }
            }
            if !categories.isEmpty {
                RunSettingGroup {
                    RunSettingMenu(title: "Режим задачи") {
                        Picker("Режим задачи", selection: $category) {
                            Text("Обычный").tag(Optional<SessionCategory>.none)
                            ForEach(categories) { item in Text(item.label).tag(Optional(item)) }
                        }
                    }
                }
            }
            RunSettingGroup {
                RunSettingMenu(title: "Рассуждение") {
                    if pick.effortOff {
                        Text("Не поддерживается").foregroundStyle(Theme.drawerSecondary)
                    } else {
                        Picker("Рассуждение", selection: $value.effort) {
                            Text("Как в аккаунте").tag(Optional<EffortLevel>.none)
                            ForEach(pick.efforts) { level in
                                Text(level.composerLabel).tag(Optional(level))
                            }
                        }
                    }
                }
                Divider().padding(.horizontal, 16)
                RunSettingMenu(title: "Разрешения") {
                    Picker("Разрешения", selection: $value.permissionMode) {
                        ForEach(modes, id: \.self) { mode in
                            Text(mode.label).tag(mode == .default ? nil : Optional(mode))
                        }
                    }
                }
            }
        }
    }

    private func pickModel(_ id: String?) {
        value.model = id
        Haptics.light()
    }

    private func pickEffort(_ level: EffortLevel?) {
        value.effort = level
        Haptics.light()
    }

    // MARK: Derivation

    private var currentMode: PermissionMode { value.permissionMode ?? .default }

    /// Both runtimes use their own machine-advertised capabilities.
    /// Older Codex agents retain the default/plan fallback.
    private var modes: [PermissionMode] {
        return client.machines
            .first { $0.machine.machineId == machineId }?
            .machine.offeredPermissionModes(isCodex: isCodex)
            ?? (isCodex ? [.default, .plan] : PermissionMode.exposed)
    }

    /// Is `modes` this machine's actual answer, or the safe default we show
    /// while its snapshot has not arrived?
    private var machineKnown: Bool {
        client.machines.contains { $0.machine.machineId == machineId }
    }

    /// The built-in fallback is a CLAUDE list. Offering it on a Codex start
    /// would hand the app-server ids it has never heard of, so Codex falls back
    /// to nothing and the control names only «Как в аккаунте».
    private var models: [ModelInfoLite] {
        let all = fetched ?? (isCodex ? [] : DEFAULT_MODELS)
        // Claude's list has no Go rows, so only a Codex list needs the split.
        return isCodex ? AgentModels.rows(all, for: agent) : all
    }

    private var isOpenCode: Bool { agent == AgentModels.opencode }

    /// The model the chip and the checkmark show. For OpenCode that is the
    /// model the start will send (see `AgentModels.defaultGoModel`), not a
    /// blank that reads as «Модель аккаунта».
    private var shownModel: String? {
        isOpenCode ? AgentModels.defaultGoModel(models: models, remembered: value.model) : value.model
    }

    private var pick: RunPick {
        RunPick(models: models, fromRuntime: fetchedFromRuntime,
                model: shownModel, effort: value.effort)
    }

    // MARK: Loading

    private func loadModels() async {
        if let cached = StartModelCache.cached(cacheKey) {
            fetched = cached
            fetchedFromRuntime = true
            // The Codex list also decides OpenCode, whose rows can appear after
            // this was cached, so it paints from the cache and still asks.
            if !isCodex { return }
        } else {
            fetched = nil
            fetchedFromRuntime = false
        }
        guard !machineId.isEmpty, client.status == .open else { return }
        // Agent offline, too old, or simply silent: keep the fallback. A start
        // screen that refuses to draw because a list did not arrive is worse
        // than one that offers the account's own default.
        guard let list = try? await client.listModels(machineId: machineId,
                                                      source: isCodex ? "codex" : nil),
              !Task.isCancelled, !list.isEmpty
        else { return }
        // Only the runtime's own answer carries `resolved`, and only it is worth
        // caching — pinning the curated fallback to this machine would outlive
        // the run that could have replaced it.
        let runtime = list.contains { $0.resolved != nil }
        if runtime { StartModelCache.remember(cacheKey, list) }
        fetched = list
        fetchedFromRuntime = runtime
    }
}

/// Everything the control renders, derived from a model list plus the current
/// pick. Pure, so the start screen reaches its labels by the same rules the live
/// control does and cannot end up naming a model the session then isn't on.
struct RunPick {
    /// Rows to offer, with the runtime's placeholder "default" row removed.
    let picks: [ModelInfoLite]
    /// What the unpinned choice is CALLED — the runtime's own name for it when
    /// it published one.
    let accountLabel: String
    /// What the chip shows: the model that will run, never the word "default".
    let modelLabel: String
    let efforts: [EffortLevel]
    /// This model takes no reasoning effort at all.
    let effortOff: Bool

    init(models: [ModelInfoLite], fromRuntime: Bool, model: String?, effort: EffortLevel?) {
        // Drop the runtime's own "default" row: it is a placeholder that
        // resolves to the same wire id as a real row, and listing it twice is
        // how every control in the app came to read "default" whatever was
        // selected.
        let picks = models.filter { $0.id != "default" }
        let row = model.flatMap { id in picks.first { $0.id == id } }

        self.picks = picks
        self.accountLabel = ModelLabel.name(models: models, model: nil)
        self.modelLabel = ModelLabel.name(models: models, model: model)
        // Only the levels this model takes, plus whatever is already picked — a
        // control whose value has no row renders blank, which is worse than one
        // row too many.
        let allowed = row?.efforts
        self.efforts = EffortLevel.allCases.filter { level in
            level == effort || (allowed.map { $0.contains(level.rawValue) } ?? true)
        }
        // The CLI omits `supportsEffort` rather than sending false, so on a
        // runtime list an effortless model is one that named no levels. Never
        // inferred from the curated fallback, which carries no effort data at
        // all and would read as "nothing supports reasoning".
        self.effortOff = row?.supportsEffort == false
            || (row != nil && fromRuntime && (row?.efforts?.isEmpty ?? true))
    }
}

/// Model lists already answered for, keyed by machine AND runtime.
///
/// One box runs both agents and their ids do not overlap — a single key served
/// a Codex start screen the Claude list. Cached for the life of the app rather
/// than per view: the start screen is rebuilt on every project switch, and an
/// RPC per rebuild is a round trip to a far machine for an answer that has not
/// changed. Only RUNTIME answers land here (see `loadModels`).
@MainActor
enum StartModelCache {
    private static var byKey: [String: [ModelInfoLite]] = [:]

    static func cached(_ key: String) -> [ModelInfoLite]? { byKey[key] }
    static func remember(_ key: String, _ models: [ModelInfoLite]) { byKey[key] = models }
}
