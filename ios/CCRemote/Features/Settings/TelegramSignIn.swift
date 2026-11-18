import SwiftUI
import UIKit
import CCRemoteKit

// «Войти через Telegram» on the phone. The hub's half is
// server-rs/src/telegram_login{,_api}.rs, the bot's tgbot/src/login.ts, the
// web's web/src/components/TelegramSignIn.tsx — this one mirrors the web.
//
// The app starts a login, SHOWS the two-digit number, opens
// `t.me/<bot>?start=login_<code>` in Telegram, and polls. iOS suspends the
// app while the person is in Telegram, so the poll loop also runs once the
// moment the app is active again (`poke()` from `scenePhase`) — coming back
// from Telegram lands the person signed in, without a two-second wait.

/// The sign-in state machine. One per sheet.
@MainActor
@Observable
final class TelegramSignInModel {
    enum Phase: Equatable {
        case starting
        case waiting(TelegramLoginStart)
        case signedIn
        /// A link: Telegram says who pressed; the account must say «да».
        case confirmLink(TelegramLoginStart, telegram: String)
        case linking(telegram: String)
        case linked(telegram: String)
        case failed(String)
    }

    private(set) var phase: Phase = .starting
    /// Filled when the hub approves: the session and who it belongs to.
    var onApproved: ((_ session: String, _ userId: String, _ telegram: String, _ name: String) -> Void)?
    /// Filled when a LINK was made: the `@username` now a way into the account.
    var onLinked: ((_ telegram: String) -> Void)?
    /// Set for «Привязать Telegram»: the session of the account to link to.
    private var linkSession: String?

    private var loop: Task<Void, Never>?
    /// A poll is on the wire. The hub hands an approval out ONCE; cancelling
    /// the request carrying it would lose the sign-in for good.
    private var inFlight = false
    /// The sheet went away. A request already on the wire is left to land —
    /// cancelling it could drop the one-time approval — and an approval that
    /// lands after this still signs in: the person pressed the number.
    private var stopped = false
    /// Which `start` a loop belongs to: a loop left to finish its request
    /// must not keep polling after a restart began a new login.
    private var generation = 0
    private var client: TelegramAuthClient?
    /// Measured on THIS device from the start — a phone clock that is off
    /// must not end the login early. The hub's own `expired` normally
    /// arrives first (its TTL is 10 minutes).
    private var deadline = Date.distantFuture

    func start(hubURL: String, device: String, linkSession: String? = nil) {
        stop()
        stopped = false
        self.linkSession = linkSession
        generation += 1
        let mine = generation
        phase = .starting
        guard let client = TelegramAuthClient(hubURL: hubURL) else {
            phase = .failed("Не удалось разобрать адрес хаба.")
            return
        }
        self.client = client
        loop = Task { [weak self] in
            do {
                let login: TelegramLoginStart
                if let linkSession {
                    login = try await client.startLink(device: device, session: linkSession)
                } else {
                    login = try await client.start(device: device)
                }
                guard let self, !Task.isCancelled else { return }
                self.phase = .waiting(login)
                self.deadline = Date().addingTimeInterval(11 * 60)
                await self.pollUntilDone(login, generation: mine)
            } catch let refused as TelegramAuthClient.Refused {
                self?.phase = .failed(refused.words)
            } catch {
                if !Task.isCancelled { self?.phase = .failed("Нет связи с сервером. Проверьте сеть и попробуйте ещё раз.") }
            }
        }
    }

    /// The app is active again (the person is back from Telegram): ask now
    /// instead of waiting out the interval.
    func poke() {
        // A request already on the wire may be the one carrying the approval:
        // let it land rather than cancel it.
        guard case .waiting(let login) = phase, !inFlight else { return }
        loop?.cancel()
        let mine = generation
        loop = Task { [weak self] in await self?.pollUntilDone(login, generation: mine, immediately: true) }
    }

    func stop() {
        stopped = true
        // Only a loop that is NOT mid-request is cancelled; one that is will
        // see `stopped` when its request lands.
        if !inFlight { loop?.cancel() }
        loop = nil
    }

    var isLinking: Bool {
        if case .linking = phase { return true }
        return false
    }

    /// «Да, это мой @username» — the account makes the link the press proposed.
    func confirmLink() {
        guard case .confirmLink(let login, let telegram) = phase,
              let client, let linkSession else { return }
        phase = .linking(telegram: telegram)
        loop = Task { [weak self] in
            do {
                let linked = try await client.finishLink(login.pollToken, session: linkSession)
                let name = linked.isEmpty ? telegram : linked
                self?.phase = .linked(telegram: name)
                self?.onLinked?(name)
            } catch let refused as TelegramAuthClient.Refused {
                self?.phase = .failed(refused.words)
            } catch {
                self?.phase = .failed("Нет связи с сервером. Проверьте сеть и попробуйте ещё раз.")
            }
        }
    }

    private func pollUntilDone(_ login: TelegramLoginStart, generation mine: Int, immediately: Bool = false) async {
        guard let client else { return }
        var first = immediately
        while !Task.isCancelled {
            if !first {
                try? await Task.sleep(for: .seconds(max(1, login.interval)))
                if Task.isCancelled { return }
            }
            first = false
            if Date() > deadline {
                phase = .failed(TelegramLoginWords.end(.expired))
                return
            }
            let result: TelegramLoginPoll
            do {
                inFlight = true
                defer { inFlight = false }
                result = try await client.poll(login.pollToken)
            } catch {
                continue // offline for a moment: keep waiting, the hub decides
            }
            // Stopped or superseded while the request was out: only an approval
            // still matters (the hub will not hand it out again).
            let current = !stopped && mine == generation
            if !current {
                guard case .approved = result else { return }
            }
            switch result {
            case .approved(let session, let userId, let telegram, let account):
                // Acted on even if the sheet is going away: the hub has
                // handed out this session exactly once.
                phase = .signedIn
                onApproved?(session, userId, telegram, account.displayName)
                return
            case .pending:
                continue
            case .confirmLink(let telegram):
                // Only a link asks; a native sign-in never does.
                guard linkSession != nil else {
                    phase = .failed(TelegramLoginWords.end(.unknown))
                    return
                }
                phase = .confirmLink(login, telegram: telegram)
                return
            default:
                phase = .failed(TelegramLoginWords.end(result))
                return
            }
        }
    }
}

/// The sheet: the number first, then the button that opens Telegram.
struct TelegramSignInSheet: View {
    /// Set for «Привязать Telegram» (the signed-in session); nil signs in.
    var linkSession: String? = nil
    var onLinked: ((String) -> Void)? = nil
    @Environment(AppSettings.self) private var settings
    @Environment(CentralClient.self) private var client
    @Environment(\.openURL) private var openURL
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.dismiss) private var dismiss
    @State private var model = TelegramSignInModel()
    /// The hub this sign-in was started on. A `ccremote://connect` link can
    /// switch the hub while the person is away in Telegram; the session the old
    /// hub then issues must never be stored for — or sent to — the new one.
    @State private var startedHub = ""

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.s4) {
            HStack(spacing: Theme.s2) {
                RoundedRectangle(cornerRadius: 2, style: .continuous)
                    .fill(Theme.brand).frame(width: 8, height: 8)
                Text(linkSession == nil ? "ВХОД ЧЕРЕЗ TELEGRAM" : "ПРИВЯЗКА TELEGRAM")
                    .font(.mono(Theme.sizeMicro, weight: .medium))
                    .foregroundStyle(Theme.textMuted)
            }
            switch model.phase {
            case .starting:
                Text("Готовим вход…").font(SettingsStyle.body).foregroundStyle(Theme.textMuted)
            case .waiting(let login):
                Text("Откройте бота @\(login.bot) и нажмите в нём это число:")
                    .font(SettingsStyle.body).foregroundStyle(Theme.text)
                Text(login.match)
                    .font(.mono(Theme.sizeScreen, weight: .semibold))
                    .tracking(4)
                    .foregroundStyle(Theme.text)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, Theme.s4)
                    .background(Theme.here, in: RoundedRectangle(cornerRadius: Theme.radiusLg, style: .continuous))
                    .accessibilityLabel("Число для Telegram: \(login.match.map(String.init).joined(separator: " "))")
                ActionButton("Открыть Telegram", wide: true) {
                    if let url = login.link { openURL(url) }
                }
                Text("Ждём подтверждения в Telegram…")
                    .font(SettingsStyle.caption).foregroundStyle(Theme.textMuted)
                    .frame(maxWidth: .infinity)
            case .signedIn:
                Text("Вход подтверждён.").font(SettingsStyle.body).foregroundStyle(Theme.text)
            case .confirmLink(_, let telegram), .linking(let telegram):
                (Text("В Telegram подтвердил ") + Text(telegram).bold()
                    + Text(". Это ваш аккаунт? После привязки в эту учётку можно будет входить через него."))
                    .font(SettingsStyle.body).foregroundStyle(Theme.text)
                ActionButton("Да, привязать", wide: true, enabled: !model.isLinking) { model.confirmLink() }
                ActionButton("Нет, не мой", kind: .quiet, wide: true, enabled: !model.isLinking) { dismiss() }
            case .linked(let telegram):
                (Text("Telegram ") + Text(telegram).bold() + Text(" привязан — через него теперь можно входить."))
                    .font(SettingsStyle.body).foregroundStyle(Theme.text)
            case .failed(let message):
                Text(message).font(SettingsStyle.body).foregroundStyle(Theme.text)
                ActionButton("Начать заново", wide: true) { restart() }
            }
            Spacer(minLength: 0)
            ActionButton("Отмена", kind: .quiet, wide: true) { dismiss() }
        }
        .padding(Theme.s5)
        .background(Theme.settingsBackground.ignoresSafeArea())
        .onAppear {
            model.onApproved = { session, userId, telegram, name in
                guard HegaiAuth.sameHub(settings.hubURL, startedHub) else {
                    CentralClient.revoke(session: session, at: startedHub)
                    dismiss()
                    return
                }
                TelegramSignInMemo.remember(.init(telegram: telegram, name: name, userId: userId))
                SignOutCleanup.retire(hubURL: settings.hubURL, token: settings.token,
                                      replacingWith: session, client: client)
                settings.workspaceId = ""
                settings.token = session
                client.connect(endpoint: settings.hubURL, token: session, workspaceId: nil)
                Haptics.success()
                dismiss()
            }
            model.onLinked = { telegram in
                Haptics.success()
                onLinked?(telegram)
            }
            restart()
        }
        .onDisappear { model.stop() }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { model.poke() }
        }
        .presentationDetents([.medium, .large])
    }

    private func restart() {
        let device = UIDevice.current.userInterfaceIdiom == .pad ? "iPad" : "iPhone"
        startedHub = settings.hubURL
        model.start(hubURL: startedHub, device: device, linkSession: linkSession)
    }
}

/// Who just signed in through Telegram — kept until the person acknowledges
/// it, so the banner survives the reconnect that follows a sign-in.
struct TelegramSignInMemo: Codable, Equatable {
    let telegram: String
    let name: String
    /// The account it opened: the banner never shows over a different one.
    let userId: String

    private static let key = "tg-signed-in"

    static func remember(_ memo: TelegramSignInMemo) {
        if let data = try? JSONEncoder().encode(memo) {
            UserDefaults.standard.set(data, forKey: key)
        }
        NotificationCenter.default.post(name: .telegramSignInChanged, object: nil)
    }

    static func read() -> TelegramSignInMemo? {
        guard let data = UserDefaults.standard.data(forKey: key) else { return nil }
        return try? JSONDecoder().decode(TelegramSignInMemo.self, from: data)
    }

    static func forget() {
        UserDefaults.standard.removeObject(forKey: key)
        NotificationCenter.default.post(name: .telegramSignInChanged, object: nil)
    }
}

extension Notification.Name {
    static let telegramSignInChanged = Notification.Name("net.hegai.ccremote.telegramSignInChanged")
}

/// «Вы вошли через Telegram как @x» — once, over whatever screen follows a
/// Telegram sign-in, with a way out. The last line against a code seen on
/// someone else's screen: if a stranger pressed the number first, this phone
/// is now signed into THEIR account, and this is where the person finds out.
/// «Это не я — выйти» ends the session on the hub, not just on the phone.
struct TelegramSignedInBanner: View {
    @Environment(AppSettings.self) private var settings
    @Environment(CentralClient.self) private var client
    @State private var memo = TelegramSignInMemo.read()
    @State private var signingOut = false
    @State private var error: String?

    var body: some View {
        Group {
            if let memo, !belongsToAnotherAccount(memo) {
                VStack(alignment: .leading, spacing: Theme.s2) {
                    (Text("Вы вошли через Telegram как ") + Text(memo.telegram).bold()
                        + Text(memo.name.isEmpty ? "." : " · \(memo.name)."))
                        .font(SettingsStyle.body).foregroundStyle(Theme.text)
                    if let error {
                        Text(error).font(SettingsStyle.caption).foregroundStyle(Theme.negative)
                    }
                    HStack(spacing: Theme.s2) {
                        ActionButton("Это не я — выйти", kind: .quiet, enabled: !signingOut) { notMe() }
                        ActionButton("Понятно") { TelegramSignInMemo.forget() }
                    }
                }
                .padding(Theme.s4)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: Theme.radiusLg, style: .continuous))
                // The floating card of the design system: raised surface, ink
                // shadow, the dark theme's rim — no hand-made shadow.
                .floating(Theme.shadowLg, radius: Theme.radiusLg)
                .padding(.horizontal, Theme.s3)
                .accessibilityElement(children: .contain)
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: .telegramSignInChanged)) { _ in
            memo = TelegramSignInMemo.read()
        }
        .onChange(of: client.viewer?.userId) { _, _ in
            // A different account is signed in now: this banner was never
            // about it.
            if let memo, belongsToAnotherAccount(memo) { TelegramSignInMemo.forget() }
        }
    }

    private func belongsToAnotherAccount(_ memo: TelegramSignInMemo) -> Bool {
        guard let viewer = client.viewer else { return false }
        return viewer.userId != memo.userId
    }

    private func notMe() {
        signingOut = true
        error = nil
        let token = settings.token
        Task {
            // The flag goes only once the hub has ended the session: if it
            // could not be told, the way out stays on screen.
            let revoked = await client.revokeSession()
            signingOut = false
            // A different session arrived meanwhile: this banner was about the
            // old one, and must not sign the new one out.
            guard settings.token == token else {
                TelegramSignInMemo.forget()
                return
            }
            guard revoked else {
                error = "Не получилось выйти — нажмите ещё раз."
                return
            }
            TelegramSignInMemo.forget()
            SignOutCleanup.retire(hubURL: settings.hubURL, token: token, replacingWith: "", client: client)
            settings.token = ""
            settings.workspaceId = ""
            Haptics.rigid()
        }
    }
}
