import SwiftUI
import CCRemoteKit

enum SettingsPage: String {
    case account, appearance, defaults, notifications, advanced, privacy, about
    var title: String {
        switch self {
        case .account: "Управление аккаунтом"
        case .appearance: "Внешний вид"
        case .defaults: "Новые чаты"
        case .notifications: "Уведомления"
        case .advanced: "Дополнительно"
        case .privacy: "Конфиденциальность"
        case .about: "О приложении"
        }
    }
}

/// Focused settings pages reuse the existing account, consent and connection actions.
struct SettingsView: View {
    var onboarding: Bool = false
    var page: SettingsPage = .account

    @Environment(AppSettings.self) private var settings
    @Environment(CentralClient.self) private var client
    @Environment(HegaiAuth.self) private var auth

    @State private var draftURL = ""
    @State private var draftToken = ""
    /// Поля «хаб + сырой токен» — служебный вход, а не парадный.
    @State private var showAdvanced = false

    @State private var cacheSummary: String?
    @State private var legacyAvailable = false
    @State private var confirmRecovery = false
    /// «Войти через Telegram» — its sheet (TelegramSignIn.swift).
    @State private var showTelegram = false
    @State private var showAccountDeletion = false
    @State private var showSignInOptions = false
    /// What the configured hub offers (`/api/public-config`); nil until it
    /// answers, and for a hub that never does — then the usual buttons.
    @State private var hubConfig: HubPublicConfig?
    /// The hub `hubConfig` was fetched from: a config is only ever used for that hub.
    @State private var hubConfigHub = ""
    /// `/api/public-config` of a non-default hub did not answer (the login buttons
    /// are withheld then, «Повторить» refetches).
    @State private var hubConfigFailed = false
    @State private var configRetry = 0
    @State private var showServerSheet = false
    /// «Подключиться» is checking the typed server's `/health`.
    @State private var probing = false
    /// Why the last «Подключиться» did not save the typed server.
    @State private var hubProbeError: (draft: String, text: String)?

    var body: some View {
        @Bindable var settings = settings
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.s5) {
                if onboarding { welcome; AccountDeletionStatusView() }

                if onboarding || page == .account {
                    section("Аккаунт") {
                        statusRow
                        if let viewer = client.viewer {
                            rowDivider
                            identityRow(viewer)
                        }
                        rowDivider
                        if onboarding || client.viewer == nil {
                            serverRow
                            rowDivider
                            signInButton
                        } else {
                            DisclosureGroup("Войти в другой аккаунт", isExpanded: $showSignInOptions) {
                                if showSignInOptions { signInButton }
                            }.font(SettingsStyle.body).tint(Theme.text).padding(Theme.s3)
                        }
                        if !onboarding, client.viewer != nil {
                            rowDivider
                            signOutRow
                        }
                    }

                    // Every way into this one account, and adding the rest
                    // (SignInMethodsSection.swift).
                    if !onboarding, client.viewer != nil {
                        section("Способы входа") { SignInMethodsSection() }
                    }

                    if let viewer = client.viewer, !viewer.teams.isEmpty {
                        section("Мои команды") {
                            ForEach(Array(viewer.teams.enumerated()), id: \.element.id) { index, workspace in
                                if index > 0 { rowDivider }
                                let current = workspace.workspaceId == viewer.workspace.workspaceId
                                Button {
                                    WorkspaceSwitch.select(workspace, client: client, settings: settings)
                                } label: {
                                    HStack(spacing: Theme.s2) {
                                        Text(workspace.displayName)
                                            .font(.ui(Theme.sizeSmall, weight: current ? .semibold : .regular))
                                            .foregroundStyle(Theme.text)
                                        Text(workspace.role)
                                            .font(SettingsStyle.caption).foregroundStyle(Theme.drawerSecondary)
                                        Spacer()
                                        if current {
                                            Image(systemName: "checkmark")
                                                .font(.system(size: 13, weight: .semibold))  // бокс глифа
                                                .foregroundStyle(Theme.textMuted)
                                        }
                                    }
                                    .padding(.horizontal, Theme.s3)
                                    .frame(minHeight: SettingsStyle.rowHeight)
                                    .contentShape(Rectangle())
                                    // Текущее пространство — навигационное «ты
                                    // здесь», а не выбор из палитры: тинт, дети
                                    // своего цвета.
                                    .hereTint(current, radius: Theme.radiusSm)
                                }
                                .buttonStyle(.plain)
                            }
                        }
                    }

                    if client.authWarning {
                        HStack(alignment: .top, spacing: Theme.s2) {
                            Image(systemName: "exclamationmark.triangle.fill")
                                .font(.system(size: 13))  // бокс глифа
                                .foregroundStyle(Theme.orangeText)
                            Text("Не удалось авторизоваться — проверьте адрес и токен.")
                                .font(SettingsStyle.body).foregroundStyle(Theme.textMuted)
                        }
                        .padding(Theme.s3)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(Theme.orange.opacity(0.12),
                                    in: RoundedRectangle(cornerRadius: Theme.radiusMd, style: .continuous))
                    }

                    if !onboarding {
                        NavigationLink { ProfileView().navigationTitle("Моя активность").inlineTitle() } label: {
                            SettingsNavigationRow("Моя активность", icon: "chart.bar")
                        }.buttonStyle(.plain).settingsCard()
                    }
                }

                if !onboarding && page == .appearance {
                    section("Внешний вид") {
                        Picker("Тема", selection: $settings.themePreference) {
                            ForEach(ThemePreference.allCases, id: \.self) { pref in
                                Text(pref.label).tag(pref)
                            }
                        }
                        .pickerStyle(.segmented)
                        .padding(Theme.s3)
                    }

                }
                if !onboarding && page == .defaults {
                    // Чем начинается новая сессия — видимый факт, а не фольклор.
                    // "" = ничего не закреплено, решает аккаунт на машине.
                    section("Для новых сессий") {
                        pickerRow("Модель") {
                            Picker("Модель", selection: $settings.defaultModel) {
                                Text("Не закреплять").tag("")
                                ForEach(DEFAULT_MODELS) { m in Text(m.name ?? m.id).tag(m.id) }
                            }
                        }
                        rowDivider
                        pickerRow("Рассуждение") {
                            Picker("Усилие", selection: $settings.defaultEffort) {
                                Text("Не закреплять").tag("")
                                ForEach(EffortChoice.allCases) { e in Text(e.label).tag(e.rawValue) }
                            }
                        }
                        rowDivider
                        hint("Для новых задач. Если модель не закреплена, используется настройка аккаунта на сервере.")
                    }

                }
                if !onboarding && page == .advanced {
                    section("Списки") {
                        toggleRow("Показывать автоматические сессии", isOn: Binding(
                            get: { client.showAutomated },
                            set: { client.showAutomated = $0 }
                        ))
                        rowDivider
                        hint(client.showAutomated
                             ? "Автоматические запуски видны вместе с вашими задачами."
                             : (client.automatedHidden > 0
                                ? "Скрыто сейчас: \(client.automatedHidden). Автоматические запуски скрыты из списков."
                                : "Автоматические запуски скрыты из списков."))
                    }

                }
                if !onboarding && page == .notifications {
                    section("Уведомления") {
                        toggleRow("Присылать пуши", isOn: $settings.notificationsEnabled)
                        rowDivider
                        hint("Сообщать о запросах решения, ошибках и завершённых задачах.")
                    }

                }
                if !onboarding && page == .advanced {
                    section("Офлайн-копия") {
                        cacheRow
                        if legacyAvailable, client.viewer != nil {
                            rowDivider
                            ActionButton("Восстановить старые сообщения", wide: true) { confirmRecovery = true }
                                .padding(Theme.s3)
                        }
                    }

                }
                if onboarding || page == .advanced {
                    section("Хаб") {
                        Button { withAnimation(Theme.easeFast) { showAdvanced.toggle() } } label: {
                            HStack {
                                Text("Другой хаб / токен")
                                    .font(SettingsStyle.body).foregroundStyle(Theme.text)
                                Spacer()
                                Image(systemName: showAdvanced ? "chevron.down" : "chevron.right")
                                    .font(.system(size: 11, weight: .semibold))  // бокс глифа
                                    .foregroundStyle(Theme.drawerSecondary)
                            }
                            .padding(.horizontal, Theme.s3)
                            .frame(minHeight: SettingsStyle.rowHeight)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        if showAdvanced {
                            rowDivider
                            field(placeholder: "Адрес сервера, например code.example.com", text: $draftURL, secure: false)
                            if let hint = hubHint {
                                Text(hint)
                                    .font(SettingsStyle.caption).foregroundStyle(Theme.negative)
                                    .padding(.horizontal, Theme.s3).padding(.bottom, Theme.s2)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                            }
                            rowDivider
                            field(placeholder: "Токен доступа", text: $draftToken, secure: true)
                            rowDivider
                            ActionButton(client.status == .open ? "Переподключиться" : "Подключиться",
                                         wide: true, enabled: canApply && !probing) { Task { await apply() } }
                                .padding(Theme.s3)
                        }
                    }

                }
                if !onboarding && page == .privacy, client.viewer != nil {
                    section("Конфиденциальность") {
                        Button("Удалить аккаунт") { showAccountDeletion = true }
                            .font(SettingsStyle.body).foregroundStyle(Theme.negative)
                            .padding(Theme.s3).accessibilityIdentifier("settings.deleteAccount")
                        rowDivider
                        Button { client.aiConsentRequested = true } label: {
                            HStack {
                                Text("Передача данных AI")
                                Spacer()
                                Text(client.aiDataSharingAllowed ? "Разрешена" : "Не разрешена")
                                    .foregroundStyle(Theme.textMuted)
                            }
                            .font(SettingsStyle.body).padding(Theme.s3)
                        }
                        .accessibilityIdentifier("settings.aiConsent")
                        if client.aiDataSharingAllowed {
                            rowDivider
                            Button("Отозвать согласие") {
                                do { try client.withdrawAIDataSharing() }
                                catch { client.flashError("Не удалось отозвать согласие: \(error.localizedDescription)") }
                            }
                            .font(SettingsStyle.body).foregroundStyle(Theme.negative)
                            .padding(Theme.s3)
                            .accessibilityIdentifier("settings.withdrawAIConsent")
                        }
                    }
                }

                if onboarding || page == .about || page == .privacy {
                section("О приложении") {
                    infoRow("Версия", appVersion)
                    rowDivider
                    legalLink("Политика конфиденциальности", url: HegaiAuth.hubPageURL(hubURL: settings.hubURL, path: "/api/privacy"), identifier: "settings.privacy")
                    rowDivider
                    legalLink("Поддержка", url: HegaiAuth.hubPageURL(hubURL: settings.hubURL, path: "/api/support"), identifier: "settings.support")
                }
                }
            }
            .padding(Theme.s4)
            .frame(maxWidth: Theme.readingWidth)
            .frame(maxWidth: .infinity)
        }
        .background(Theme.settingsBackground)
        .navigationTitle(onboarding ? "Вход" : page.title)
        .inlineTitle()
        .onAppear {
            draftURL = settings.hubURL
            draftToken = settings.token
            legacyAvailable = ((try? client.legacyPendingCount()) ?? 0) > 0 || DraftStore.legacyCount > 0
        }
        .task(id: "\(settings.hubURL)#\(configRetry)") {
            let hub = settings.hubURL
            hubConfig = nil
            hubConfigFailed = false
            let fetched = await HubPublicConfig.fetch(hubURL: hub)
            if settings.hubURL == hub {
                hubConfig = fetched
                hubConfigHub = hub
                hubConfigFailed = fetched == nil
            }
        }
        // The server may change under this screen (server sheet, connect link):
        // the hidden fields must follow, not keep the old hub's address / token.
        .onChange(of: settings.hubURL) { _, hub in
            draftURL = hub
            draftToken = settings.token
        }
        .sheet(isPresented: $showServerSheet) { HubServerSheet() }
        .sheet(isPresented: $showAccountDeletion) { AccountDeletionView() }
        .sheet(isPresented: $showTelegram) { TelegramSignInSheet() }
        .alert("Восстановить в этот аккаунт?", isPresented: $confirmRecovery) {
            Button("Восстановить") {
                do {
                    try client.recoverLegacyPending()
                    DraftStore.recoverLegacy(scope: client.storageScope)
                    legacyAvailable = false
                } catch { client.flashError("Не удалось восстановить сообщения: \(error.localizedDescription)") }
            }
            Button("Отмена", role: .cancel) {}
        } message: {
            Text("Старые сообщения и черновики не привязаны к аккаунту. Подтвердите, что они принадлежат \(client.viewer?.email ?? "вам") и пространству \(client.viewer?.workspace.name ?? "текущему"). Сообщения из очереди отправятся при подключении к машине.")
        }
    }

    private func legalLink(_ title: String, url: URL, identifier: String) -> some View {
        Link(destination: url) {
            HStack {
                Text(title).font(SettingsStyle.body).foregroundStyle(Theme.text)
                Spacer()
                Image(systemName: "arrow.up.right")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(Theme.drawerSecondary)
            }
            .padding(.horizontal, Theme.s3)
            .frame(minHeight: SettingsStyle.rowHeight)
            .contentShape(Rectangle())
        }
        .accessibilityIdentifier(identifier)
    }

    // MARK: Куски

    private var welcome: some View {
        VStack(alignment: .leading, spacing: Theme.s2) {
            HegaiMark(size: 36)
            Text("Войдите в Hegai Code")
                .font(.ui(Theme.sizePage, weight: .bold)).foregroundStyle(Theme.text)
            Text("Приложение работает под вашей учётной записью: вы видите свои машины и проекты, которыми с вами поделились.")
                .font(SettingsStyle.body).foregroundStyle(Theme.textMuted)
        }
        .padding(.bottom, Theme.s2)
    }

    /// Парадный вход. Вошедший открывает его только чтобы сменить аккаунт.
    private var signInButton: some View {
        // On a hub that is not ours the Google / Telegram / Apple buttons do not
        // work, and which ones the hub has is in its public config: draw nothing
        // until it answered, and offer a retry if it did not. The default hub
        // keeps its buttons whatever the config says.
        let configKnown = hubConfig != nil && hubConfigHub == settings.hubURL
        return Group {
            if isDefaultHub || configKnown {
                signInButtons
            } else if hubConfigFailed {
                VStack(alignment: .leading, spacing: Theme.s2) {
                    Text("Сервер \(HubSwitchPlan.label(settings.hubURL)) не ответил")
                        .font(SettingsStyle.body).foregroundStyle(Theme.negative)
                    ActionButton("Повторить", kind: .quiet, wide: true) { configRetry += 1 }
                }
                .padding(Theme.s3)
            } else {
                HStack { Spacer(); ProgressView(); Spacer() }
                    .frame(minHeight: Theme.tapTarget)
                    .padding(Theme.s3)
            }
        }
    }

    private var isDefaultHub: Bool { HegaiAuth.sameHub(settings.hubURL, AppSettings.defaultHubURL) }

    /// Строка «Сервер: host» на экране входа: куда войдёт кнопка ниже, и дверь
    /// к «своему серверу» (`HubServerSheet`) без раскрытия служебных полей.
    private var serverRow: some View {
        HStack(spacing: Theme.s2) {
            Text("Сервер: \(HubSwitchPlan.label(settings.hubURL))")
                .font(SettingsStyle.body).foregroundStyle(Theme.text)
                .lineLimit(1).truncationMode(.middle)
            Spacer()
            Button(isDefaultHub ? "Свой сервер" : "Изменить") { showServerSheet = true }
                .font(SettingsStyle.body).foregroundStyle(Theme.link)
                .accessibilityIdentifier("settings.changeServer")
        }
        .padding(.horizontal, Theme.s3)
        .frame(minHeight: SettingsStyle.rowHeight)
    }

    private var signInButtons: some View {
        VStack(spacing: 0) {
            Button {
                Task { await signIn() }
            } label: {
                HStack(spacing: Theme.s2) {
                    if auth.signingIn { ProgressView().controlSize(.small).tint(Theme.onAction) }
                    Text(client.viewer == nil ? (hubConfig?.usesHubSignInPage == true ? "Войти" : "Войти через Google") : "Сменить аккаунт")
                        .font(SettingsStyle.heading)
                }
                .foregroundStyle(Theme.onAction)
                .frame(maxWidth: .infinity, minHeight: Theme.tapTarget)
                .background(Theme.action,
                            in: RoundedRectangle(cornerRadius: Theme.radiusMd, style: .continuous))
            }
            .buttonStyle(.plain)
            .disabled(auth.signingIn)
            .padding(Theme.s3)
            if let error = auth.lastError {
                Text(error).font(SettingsStyle.caption).foregroundStyle(Theme.negative)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, Theme.s3).padding(.bottom, Theme.s3)
            }
            // The second way in: no HegAI account needed. Quiet next to the
            // primary, and hidden while an HegAI sheet is up.
            // A customer's hub shows only the ways in it has switched on.
            let ownPage = hubConfig?.usesHubSignInPage == true
            if !ownPage || hubConfig?.auth.telegram == true {
                ActionButton("Войти через Telegram", kind: .quiet, wide: true, enabled: !auth.signingIn) {
                    showTelegram = true
                }
                .padding(.horizontal, Theme.s3).padding(.bottom, Theme.s3)
            }
            if !ownPage || hubConfig?.auth.apple == true {
                AppleSignInView { session in
                    SignOutCleanup.retire(hubURL: settings.hubURL, token: settings.token,
                                          replacingWith: session, client: client)
                    TelegramSignInMemo.forget()
                    settings.workspaceId = ""
                    settings.token = session
                    draftToken = session
                    client.connect(endpoint: settings.hubURL, token: session)
                    Haptics.success()
                }
                .padding(.horizontal, Theme.s3).padding(.bottom, Theme.s3)
            }
        }
    }

    /// «Выйти» — отдельной строкой на странице аккаунта, а не в самом низу
    /// свёрнутых «Способов входа»: там её не находили (App Review её ищет).
    private var signOutRow: some View {
        Button { signOut() } label: {
            Text("Выйти")
                .font(SettingsStyle.emphasis).foregroundStyle(Theme.negative)
                .frame(maxWidth: .infinity, minHeight: Theme.tapTarget, alignment: .leading)
                .padding(.horizontal, Theme.s3)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("settings.signOut")
    }

    private func signIn() async {
        // The decision may not have arrived yet (a tap right after the screen
        // opens): ask once more rather than guess Google on a customer's hub.
        // Everything below is for the hub of THIS tap: a config fetched for
        // another hub is not used, and a session that lands after the hub was
        // switched is dropped rather than stored against the new one.
        let hub = settings.hubURL
        let config: HubPublicConfig?
        if let known = hubConfig, hubConfigHub == hub { config = known } else { config = await HubPublicConfig.fetch(hubURL: hub) }
        guard let session = await auth.signIn(hubURL: hub,
                                              hubPage: config?.usesHubSignInPage == true) else { return }
        guard settings.hubURL == hub else {
            // Not stored for the new hub — and not left alive on the old one.
            CentralClient.revoke(session: session, at: hub)
            return
        }
        // Another account now: whatever «вы вошли через Telegram» was waiting
        // to say is not about it.
        SignOutCleanup.retire(hubURL: hub, token: settings.token, replacingWith: session, client: client)
        TelegramSignInMemo.forget()
        settings.workspaceId = ""
        settings.token = session
        draftToken = session
        client.connect(endpoint: settings.hubURL, token: session,
                       workspaceId: settings.workspaceId.isEmpty ? nil : settings.workspaceId)
        Haptics.success()
    }

    private func signOut() {
        // End the session on the hub too (it used to live on for 90 days after
        // «Выйти»), then forget it here. Signing out does not wait for the hub:
        // a person who asked to leave is not held on screen by a bad network.
        SignOutCleanup.run(hubURL: settings.hubURL, token: settings.token)
        client.disconnect()
        TelegramSignInMemo.forget()
        settings.token = ""
        settings.workspaceId = ""
        draftToken = ""
        Haptics.rigid()
    }

    /// Что телефон скачал и сколько это весит. Обход идёт сам; строка есть,
    /// чтобы у «почему теперь открывается мгновенно» и «во что это обходится»
    /// был ответ.
    private var cacheRow: some View {
        VStack(spacing: 0) {
            HStack(spacing: Theme.s3) {
                Image(systemName: "arrow.down.circle")
                    .font(.system(size: 15))  // бокс глифа
                    .frame(width: 22).foregroundStyle(Theme.textMuted)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Сообщения на телефоне")
                        .font(SettingsStyle.body).foregroundStyle(Theme.text)
                    Text(client.prefetching
                         ? "Скачиваю \(client.prefetchDone) из \(client.prefetchTotal)…"
                         : (cacheSummary ?? "Считаю…"))
                        .font(SettingsStyle.caption).foregroundStyle(Theme.drawerSecondary)
                }
                Spacer()
                if client.prefetching { ProgressView().controlSize(.small) }
            }
            .padding(Theme.s3)
            rowDivider
            Button {
                Task {
                    await client.transcripts.clear()
                    cacheSummary = nil
                    await refreshCacheSummary()
                    client.prefetchTranscripts(force: true)
                    Haptics.rigid()
                }
            } label: {
                HStack {
                    Text("Очистить и скачать заново")
                        .font(SettingsStyle.body).foregroundStyle(Theme.link)
                    Spacer()
                }
                .padding(.horizontal, Theme.s3)
                .frame(minHeight: SettingsStyle.rowHeight)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        }
        .task(id: client.prefetchDone) { await refreshCacheSummary() }
    }

    private func refreshCacheSummary() async {
        let s = await client.transcripts.stats()
        let mb = Double(s.bytes) / 1_048_576
        cacheSummary = s.sessions == 0
            ? "Пока пусто"
            : String(format: "%d сессий · %.1f МБ", s.sessions, mb)
    }

    // MARK: Строки

    private func section<Content: View>(_ title: String,
                                        @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: Theme.s2) {
            SettingsSectionHeader(text: title)
            VStack(spacing: 0) { content() }
                .settingsCard()
        }
    }

    /// Волосяная линия ВНУТРИ карточки — `divider`, а не `border`: край
    /// карточки и шов между её строками не одна и та же линия.
    private var rowDivider: some View { Divider().overlay(Theme.divider) }

    private func field(placeholder: String, text: Binding<String>, secure: Bool) -> some View {
        Group {
            if secure {
                SecureField(placeholder, text: text)
            } else {
                TextField(placeholder, text: text).keyboardType(.URL)
            }
        }
        .textFieldStyle(.plain)
        .font(SettingsStyle.body)
        .plainTextEntry()
        .padding(Theme.s3)
        .frame(minHeight: SettingsStyle.rowHeight)
    }

    private func infoRow(_ label: String, _ value: String) -> some View {
        HStack {
            Text(label).font(SettingsStyle.body).foregroundStyle(Theme.text)
            Spacer()
            Text(value).font(SettingsStyle.body).foregroundStyle(Theme.textMuted)
        }
        .padding(.horizontal, Theme.s3)
        .frame(minHeight: SettingsStyle.rowHeight)
    }

    private func identityRow(_ viewer: ViewerContext) -> some View {
        HStack(spacing: Theme.s3) {
            Avatar(seed: viewer.userId, label: viewer.displayName, size: Theme.avatarCard)
            VStack(alignment: .leading, spacing: 1) {
                Text(viewer.displayName)
                    .font(SettingsStyle.heading).foregroundStyle(Theme.text)
                if let email = viewer.email {
                    Text(email)
                        .font(SettingsStyle.caption).foregroundStyle(Theme.drawerSecondary)
                        .lineLimit(1).truncationMode(.middle)
                }
            }
            Spacer()
        }
        .padding(.horizontal, Theme.s3)
        .frame(minHeight: Theme.tapTarget + Theme.s2)
    }

    /// Переключатель: подпись слева, тумблер справа.
    ///
    /// Тон тумблера — `positive`, и это не вкусовщина. Он был `primary`, то
    /// есть ember, а ember в этой системе означает «нужно внимание»: каждая
    /// ВКЛЮЧЁННАЯ настройка кричала об этом. Зелёный — семья success/live, и он
    /// единственный, на котором белый бегунок системного тумблера читается в
    /// обеих темах (`action` в тёмной переворачивается в ivory — бегунок исчез
    /// бы в дорожке).
    private func toggleRow(_ title: String, isOn: Binding<Bool>) -> some View {
        Toggle(isOn: isOn) {
            Text(title).font(SettingsStyle.body).foregroundStyle(Theme.text)
        }
        .tint(Theme.positive)
        .padding(.horizontal, Theme.s3)
        .frame(minHeight: SettingsStyle.rowHeight)
    }

    private func pickerRow<P: View>(_ title: String, @ViewBuilder picker: @escaping () -> P) -> some View {
        SettingsMenuRow(title: title, content: picker)
        .padding(.horizontal, Theme.s3)
        .frame(minHeight: SettingsStyle.rowHeight)
    }

    /// Поясняющая проза под строками секции.
    private func hint(_ text: String) -> some View {
        Text(text)
            .font(SettingsStyle.caption).foregroundStyle(Theme.drawerSecondary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(Theme.s3)
    }

    private var statusRow: some View {
        HStack(spacing: Theme.s2) {
            // Была `Circle()` — единственная во всём приложении. Метка
            // состояния здесь такая же квадратная, как в списке машин.
            StatusSquare(color: statusColor)
            Text(statusText)
                .font(SettingsStyle.emphasis).foregroundStyle(Theme.text)
            Spacer()
        }
        .padding(.horizontal, Theme.s3)
        .frame(minHeight: SettingsStyle.rowHeight)
    }

    /// Only a usable hub address is required: a signed-out or fresh install
    /// saves a customer hub with no token and signs in on it next.
    private var canApply: Bool { HubSwitchPlan.normalizedHub(draftURL) != nil }

    /// Why the button is grey (nothing while the field is empty), or the last probe failure.
    private var hubHint: String? {
        if let e = hubProbeError, e.draft == draftURL { return e.text }
        let t = draftURL.trimmingCharacters(in: .whitespacesAndNewlines)
        return t.isEmpty || canApply ? nil : HubSwitchPlan.invalidHubMessage
    }

    private var statusColor: Color {
        switch client.status {
        case .open: return Theme.live
        case .connecting: return Theme.orange
        case .closed: return Theme.textFaint
        }
    }
    private var statusText: String {
        switch client.status {
        case .open: return "Подключено"
        case .connecting: return "Подключаюсь…"
        case .closed: return "Нет связи"
        }
    }

    private var appVersion: String {
        let v = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "?"
        let b = Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "?"
        return "\(v) (\(b))"
    }

    private func apply() async {
        guard let plan = HubSwitchPlan.make(currentHub: settings.hubURL, currentToken: settings.token,
                                            draftHub: draftURL, draftToken: draftToken) else { return }
        hubProbeError = nil
        probing = true
        // Probe + switch live in `HubSwitcher`: the login-screen server sheet and
        // `ccremote://connect` links go through the very same code.
        let failure = await HubSwitcher.connect(plan, settings: settings, client: client)
        probing = false
        if let failure { hubProbeError = (draftURL, failure); Haptics.rigid(); return }
        if plan.switching {
            hubConfig = nil
            hubConfigHub = ""
        }
        draftURL = plan.hub
        draftToken = plan.token
    }
}
