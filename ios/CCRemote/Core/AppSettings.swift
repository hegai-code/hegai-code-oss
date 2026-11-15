import Foundation
import Observation
import SwiftUI
import CCRemoteKit

/// App-wide appearance preference. `system` follows the OS; `light`/`dark` pin it.
enum ThemePreference: String, CaseIterable, Sendable {
    case system, light, dark
    var label: String {
        switch self {
        case .system: return "Как в системе"
        case .light: return "Светлая"
        case .dark: return "Тёмная"
        }
    }
    /// nil => follow the system (no override).
    var colorScheme: ColorScheme? {
        switch self {
        case .system: return nil
        case .light: return .light
        case .dark: return .dark
        }
    }
}

/// User-facing settings. Token lives in the Keychain (not UserDefaults);
/// favorites + hub URL + notification toggle + theme live in UserDefaults.
@MainActor
@Observable
final class AppSettings {
    /// Full ws endpoint the client connects to; the app only appends `?token=`.
    /// Production default lands on the dedicated mobile path (added in M5).
    var hubURL: String {
        didSet { defaults.set(hubURL, forKey: Keys.hubURL) }
    }

    /// `"machineId::sessionId"` keys — same format as the web's `cc-favs`.
    var favorites: Set<String> {
        didSet { defaults.set(Array(favorites), forKey: Keys.favorites) }
    }

    /// Drawer projects this person hid, by `DrawerModel.Project.id`
    /// (machine + folder). Per device, like the web's `cc-hidden-projects`.
    var hiddenProjects: Set<String> {
        didSet { defaults.set(Array(hiddenProjects), forKey: Keys.hiddenProjects) }
    }

    var notificationsEnabled: Bool {
        didSet { defaults.set(notificationsEnabled, forKey: Keys.notificationsEnabled) }
    }

    /// System / light / dark. Drives `.preferredColorScheme` at the app root.
    var themePreference: ThemePreference {
        didSet { defaults.set(themePreference.rawValue, forKey: Keys.themePreference) }
    }
    var colorScheme: ColorScheme? { themePreference.colorScheme }

    /// Defaults applied to every run this client opens ("" = the SDK's own
    /// default). Shown and edited in Settings so «что сейчас по дефолту» is a
    /// fact on screen, not folklore.
    var defaultModel: String {
        didSet { defaults.set(defaultModel, forKey: Keys.defaultModel) }
    }
    var defaultEffort: String {
        didSet { defaults.set(defaultEffort, forKey: Keys.defaultEffort) }
    }
    /// Which agent the start screen offers by default ("claude" | "codex" |
    /// "opencode") — the web's `cc-agent`. Advisory: the hub still decides for
    /// `member`s. "opencode" is client-local only (a Codex session on a
    /// `pool-go/` model) and is never sent on the wire.
    var preferredAgent: String {
        didSet { defaults.set(preferredAgent, forKey: Keys.preferredAgent) }
    }
    /// The Columns split, `machineId::sessionId` per pane (the web's
    /// `cc-columns`). Web semantics: clearing the screen must not erase the
    /// remembered set — an empty value never overwrites a stored non-empty one.
    var columnRefs: [String] {
        didSet {
            if columnRefs.isEmpty,
               !(defaults.stringArray(forKey: Keys.columnRefs) ?? []).isEmpty { return }
            defaults.set(columnRefs, forKey: Keys.columnRefs)
        }
    }

    /// The workspace session minted by HegAI SSO (or, for dev builds, a fleet
    /// token typed by hand). Kept out of UserDefaults — mirror of the Keychain.
    var token: String {
        didSet {
            if token.isEmpty { KeychainStore.deleteToken() }
            else { KeychainStore.saveToken(token, hub: hubURL) }
        }
    }

    /// Last workspace the user looked at, so a relaunch lands where they left.
    var workspaceId: String {
        didSet { defaults.set(workspaceId, forKey: Keys.workspaceId) }
    }

    private let defaults = UserDefaults.standard
    private enum Keys {
        static let hubURL = "hubURL"
        static let favorites = "favorites"
        static let hiddenProjects = "hiddenProjects"
        static let notificationsEnabled = "notificationsEnabled"
        static let themePreference = "themePreference"
        static let workspaceId = "workspaceId"
        static let defaultModel = "defaultModel"
        static let defaultEffort = "defaultEffort"
        static let preferredAgent = "preferredAgent"
        /// Left by the removed personal home (1.0.21–1.0.28); only ever deleted.
        static let legacyHomeMode = "homeMode"
        static let legacyTapeEnabledHint = "tapeEnabledHint"
        static let columnRefs = "columnRefs"
    }

    static let defaultHubURL = "wss://code.acme.test/mobile/ui"
    /// The pre-rename default. `hubURL` is persisted to UserDefaults the first
    /// time it is set, so changing `defaultHubURL` alone only ever reaches FRESH
    /// installs — every existing user would stay pointed at the old host forever.
    /// Rewriting the stored value is the only thing that moves them, and it is
    /// safe precisely because it only fires when the stored value is untouched
    /// (anyone who typed their own hub in Settings keeps it).
    static let legacyDefaultHubURL = "wss://claude.acme.test/mobile/ui"

    init() {
        let d = UserDefaults.standard
        let env = ProcessInfo.processInfo.environment
        // Provisioning affordance: launch env can pre-seed the hub URL + token so
        // the app connects without hand-typing (Simulator or a devicectl launch).
        // Env-provided values are PERSISTED below so they survive later launches.
        let storedHub = d.string(forKey: Keys.hubURL)
        let hub = env["CC_HUB_URL"]
            ?? (storedHub == Self.legacyDefaultHubURL ? Self.defaultHubURL : storedHub)
            ?? Self.defaultHubURL
        self.hubURL = hub
        self.favorites = Set(d.stringArray(forKey: Keys.favorites) ?? [])
        self.hiddenProjects = Set(d.stringArray(forKey: Keys.hiddenProjects) ?? [])
        self.notificationsEnabled = d.object(forKey: Keys.notificationsEnabled) as? Bool ?? true
        // Default to LIGHT to match the web's ChatGPT-style default; the picker
        // still offers system/light/dark. CC_THEME=dark|light|system is a launch
        // affordance for Simulator screenshots (like CC_DRAWER/CC_OPEN).
        self.themePreference = env["CC_THEME"].flatMap(ThemePreference.init)
            ?? d.string(forKey: Keys.themePreference).flatMap(ThemePreference.init) ?? .light
        // Playbooks are gone (see Models.swift). The stored blob is left in
        // UserDefaults rather than migrated away: it is a few hundred bytes, and
        // a deletion pass would be more code than the thing it removes.
        // Only a session stored for THIS hub: a token bound to another hub is
        // never sent here (see KeychainStore.loadToken(forHub:)).
        self.token = env["CC_TOKEN"] ?? KeychainStore.loadToken(forHub: hub) ?? ""
        self.workspaceId = d.string(forKey: Keys.workspaceId) ?? ""
        self.defaultModel = d.string(forKey: Keys.defaultModel) ?? ""
        self.defaultEffort = d.string(forKey: Keys.defaultEffort) ?? ""
        self.preferredAgent = d.string(forKey: Keys.preferredAgent) ?? "claude"
        // The personal home («Личное», the assistant's tape) is gone: home is
        // always the hub. A stored `.personal` choice and the cached «tape is
        // on» hint are dropped so nothing can bring the mode back.
        d.removeObject(forKey: Keys.legacyHomeMode)
        d.removeObject(forKey: Keys.legacyTapeEnabledHint)
        // CC_COLUMNS="machineId::sessionId,machineId::sessionId" seeds the Columns
        // split for a Simulator screenshot run (with CC_TAB=columns).
        // Like CC_THEME it is an override for THIS launch — not persisted, so a
        // screenshot run never overwrites the set the device remembers.
        self.columnRefs = env["CC_COLUMNS"].map { raw in
            raw.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        } ?? d.stringArray(forKey: Keys.columnRefs) ?? []
        // didSet doesn't fire during init — persist env-provided values explicitly.
        if let u = env["CC_HUB_URL"] { d.set(u, forKey: Keys.hubURL) }
        if let t = env["CC_TOKEN"] { KeychainStore.saveToken(t, hub: hub) }
    }

    func favKey(machineId: String, sessionId: String) -> String { "\(machineId)::\(sessionId)" }

    func isFavorite(machineId: String, sessionId: String) -> Bool {
        favorites.contains(favKey(machineId: machineId, sessionId: sessionId))
    }

    func toggleFavorite(machineId: String, sessionId: String) {
        let key = favKey(machineId: machineId, sessionId: sessionId)
        if favorites.contains(key) { favorites.remove(key) } else { favorites.insert(key) }
    }

    var isConfigured: Bool { !token.isEmpty && !hubURL.isEmpty }
}

/// Model, reasoning effort and permission mode for a session that does not
/// exist yet.
///
/// Every field is optional and an absent one means «как в аккаунте» — the
/// machine's own default stays in force, which is what every session did before
/// the start-time picker existed. That is why the empty pick has to DELETE the
/// field rather than carry `""`: "unpinned" must stay a state you can return to.
struct StartRunSettings: Codable, Equatable, Sendable {
    var model: String?
    var effort: EffortLevel?
    var permissionMode: PermissionMode?

    var isEmpty: Bool { model == nil && effort == nil && permissionMode == nil }
}

/// The last start-time pick, remembered per machine AND engine.
///
/// Per PAIR because neither list is portable: a Codex model id means nothing to
/// Claude, and `bypassPermissions` offered on one box is withheld on the next.
/// One global pick carried across them would silently ask for something the
/// target cannot honour — the hub then drops it, and the picker would be
/// claiming a setting the session never had.
///
/// Client-local on purpose, the same shelf `preferredAgent` sits on: the run's
/// own settings are per-RUN and die with it, and the hub has no per-user
/// preference store. Key shape matches the web's `cc-start-run::…` localStorage.
enum StartRunStore {
    static func key(machineId: String, engine: String) -> String {
        "cc-start-run::\(machineId)::\(engine)"
    }

    /// Tolerates anything that is not a pick: the value is free-form and a
    /// previous build may have written something else there. A start screen that
    /// throws on a stored preference is worse than one that forgets it.
    static func load(machineId: String, engine: String) -> StartRunSettings {
        guard !machineId.isEmpty,
              let data = UserDefaults.standard.data(forKey: key(machineId: machineId, engine: engine)),
              let value = try? JSONDecoder().decode(StartRunSettings.self, from: data)
        else { return StartRunSettings() }
        return value
    }

    static func save(_ value: StartRunSettings, machineId: String, engine: String) {
        guard !machineId.isEmpty else { return }
        let k = key(machineId: machineId, engine: engine)
        // The empty pick IS the default; storing it would only make the next
        // read parse something to learn nothing.
        guard !value.isEmpty, let data = try? JSONEncoder().encode(value) else {
            UserDefaults.standard.removeObject(forKey: k)
            return
        }
        UserDefaults.standard.set(data, forKey: k)
    }
}

/// Per-session composer drafts. Leaving a session (or the app dying) must not
/// eat a half-typed message — the draft persists keyed by machine::session and
/// clears itself the moment the message is actually sent.
enum DraftStore {
    static func erase(scope: String) {
        for key in UserDefaults.standard.dictionaryRepresentation().keys where key.hasPrefix("cc-draft-account::\(scope)::") {
            UserDefaults.standard.removeObject(forKey: key)
        }
    }

    static var legacyCount: Int {
        UserDefaults.standard.dictionaryRepresentation().filter {
            $0.key.hasPrefix("cc-draft::") && ($0.value as? String)?.isEmpty == false
        }.count
    }

    static func recoverLegacy(scope: String) {
        for (key, value) in UserDefaults.standard.dictionaryRepresentation() {
            guard key.hasPrefix("cc-draft::"), let text = value as? String, !text.isEmpty else { continue }
            let destination = String(key.dropFirst("cc-draft::".count))
            let existing = load(destination, scope: scope)
            save(destination, existing.isEmpty || existing == text ? text : existing + "\n\n" + text, scope: scope)
            UserDefaults.standard.set(text, forKey: "cc-draft-backup::" + destination)
            UserDefaults.standard.removeObject(forKey: key)
        }
    }

    private static func key(_ k: String, scope: String?) -> String {
        scope.map { "cc-draft-account::\($0)::\(k)" } ?? "cc-draft::\(k)"
    }
    /// Пустой ключ — это «место ещё не известно» (стартовый экран до описи), а
    /// не место с пустым именем. Такой слот не читается и не пишется: иначе
    /// черновики всех мест, у которых момент неизвестности случился, сложились
    /// бы в одну общую кучу под `cc-draft::`.
    static func load(_ k: String, scope: String? = nil) -> String {
        guard !k.isEmpty else { return "" }
        return UserDefaults.standard.string(forKey: key(k, scope: scope)) ?? ""
    }
    static func save(_ k: String, _ text: String, scope: String? = nil) {
        guard !k.isEmpty else { return }
        if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            UserDefaults.standard.removeObject(forKey: key(k, scope: scope))
        } else {
            UserDefaults.standard.set(text, forKey: key(k, scope: scope))
        }
    }
}
