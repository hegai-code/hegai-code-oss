import SwiftUI
import CCRemoteKit

/// «Способы входа» on the account page: every way into this ONE account
/// (`GET /api/me/identities`), «Отвязать» for each (never the last one), and
/// «Привязать» for Telegram, Apple and Google. The web has the same section
/// (web/src/components/SignInMethods.tsx); the hub's half is
/// server-rs/src/identity.rs.
///
/// Every link is bound on the hub to the session this app holds: Telegram and
/// Apple carry it as a bearer, Google through a one-use ticket minted with it
/// (`POST /api/auth/google/link`) — the web sheet carries no session of ours.
/// A way in that already opened an EMPTY account of its own (an earlier
/// sign-in made one) is moved here, and that empty account is closed.
struct SignInMethodsSection: View {
    @Environment(CentralClient.self) private var client
    @Environment(AppSettings.self) private var settings
    @Environment(HegaiAuth.self) private var auth

    @State private var data: IdentitiesResponse?
    @State private var note: String?
    @State private var error: String?
    @State private var busy: String?
    @State private var showTelegram = false
    @State private var confirmUnlink: LinkedIdentity?

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.s3) {
            Text("Всё это — входы в одну и ту же учётку: можно входить любым из них.")
                .font(SettingsStyle.caption).foregroundStyle(Theme.drawerSecondary)
            if data == nil, error == nil {
                Text("Загружаю…").font(SettingsStyle.caption).foregroundStyle(Theme.drawerSecondary)
            }
            if let data {
                ForEach(data.identities) { identity in
                    ViewThatFits(in: .horizontal) {
                        HStack(spacing: Theme.s2) { identityText(identity); Spacer(); unlinkButton(identity, of: data) }
                        VStack(alignment: .leading, spacing: Theme.s2) {
                            identityText(identity)
                            unlinkButton(identity, of: data)
                        }
                    }
                }
                linkButtons(data)
            }
            if let note {
                Text(note).font(SettingsStyle.caption).foregroundStyle(Theme.positive)
            }
            if let error {
                Text(error).font(SettingsStyle.caption).foregroundStyle(Theme.negative)
            }
        }
        .padding(Theme.s3)
        .task(id: settings.token) { await load() }
        .sheet(isPresented: $showTelegram) {
            TelegramSignInSheet(linkSession: settings.token) { telegram in
                note = "Telegram \(telegram) привязан — через него теперь можно входить."
                Task { await load() }
            }
        }
        .alert("Отвязать способ входа?", isPresented: Binding(
            get: { confirmUnlink != nil },
            set: { if !$0 { confirmUnlink = nil } }
        ), presenting: confirmUnlink) { identity in
            Button("Отвязать", role: .destructive) { Task { await unlink(identity) } }
            Button("Отмена", role: .cancel) {}
        } message: { identity in
            Text("Входить в эту учётку через \(identity.providerName) будет нельзя.")
        }
    }

    private func identityText(_ identity: LinkedIdentity) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(identity.providerName)
                .font(SettingsStyle.emphasis).foregroundStyle(Theme.text)
            Text([identity.label, "привязан \(RelTime.short(identity.linkedAt))"]
                .compactMap { $0 }.joined(separator: " · "))
                .font(SettingsStyle.caption).foregroundStyle(Theme.drawerSecondary)
                .lineLimit(1).truncationMode(.middle)
        }
    }

    /// Text, not a filled button, like «Отозвать» on devices. The last way in
    /// has none: an account nobody can open is lost, not protected.
    @ViewBuilder private func unlinkButton(_ identity: LinkedIdentity, of data: IdentitiesResponse) -> some View {
        if data.identities.count > 1 {
            Button { confirmUnlink = identity } label: {
                Text("Отвязать")
                    .font(SettingsStyle.heading).foregroundStyle(Theme.negative)
                    .padding(.horizontal, Theme.s2)
                    .frame(minHeight: SettingsStyle.rowHeight)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(busy != nil)
        }
    }

    @ViewBuilder private func linkButtons(_ data: IdentitiesResponse) -> some View {
        let has = Set(data.identities.map(\.provider))
        if data.available.telegram, !has.contains("telegram") {
            ActionButton("Привязать Telegram", kind: .quiet, wide: true, enabled: busy == nil) {
                showTelegram = true
            }
        }
        if data.available.google, !has.contains("google") {
            ActionButton("Привязать Google", kind: .quiet, wide: true, enabled: busy == nil && !auth.signingIn) {
                Task { await linkGoogle() }
            }
        }
        if data.available.apple, !has.contains("apple") {
            AppleSignInView(onSignIn: { _ in }, linkSession: settings.token) {
                note = "Apple привязан — через него теперь можно входить."
                Haptics.success()
                Task { await load() }
            }
        }
    }

    // MARK: Действия

    private func load() async {
        guard !settings.token.isEmpty else { return }
        do {
            data = try await client.api.get("api/me/identities", as: IdentitiesResponse.self)
            error = nil
        } catch {
            self.error = "Способы входа недоступны: \(error.localizedDescription)"
        }
    }

    private func linkGoogle() async {
        note = nil
        error = nil
        busy = "google"
        defer { busy = nil }
        do {
            let ticket = try await client.api.post("api/auth/google/link",
                                                   body: RestClient.EmptyBody(),
                                                   as: GoogleLinkTicket.self)
            switch await auth.link(hubURL: settings.hubURL, startPath: ticket.path) {
            case .confirm(let result):
                struct Linked: Decodable { let linked: String }
                _ = try await client.api.post("api/auth/google/link/confirm",
                                              body: ["result": result], as: Linked.self)
                note = "Google привязан — через него теперь можно входить."
                Haptics.success()
                await load()
            case .linked:
                note = "Google привязан — через него теперь можно входить."
                Haptics.success()
                await load()
            case .cancelled:
                break
            case .refused(let code):
                error = IdentityWords.error(code)
            }
        } catch ClientError.rpc(let code) {
            error = IdentityWords.error(code)
        } catch {
            self.error = IdentityWords.error(nil)
        }
    }

    private func unlink(_ identity: LinkedIdentity) async {
        note = nil
        error = nil
        busy = identity.id
        defer { busy = nil }
        do {
            try await client.api.post("api/me/identities/unlink",
                                      body: ["provider": identity.provider, "subject": identity.subject])
            note = "\(identity.providerName) отвязан."
            Haptics.rigid()
            await load()
        } catch ClientError.rpc(let code) {
            error = IdentityWords.error(code)
        } catch {
            self.error = IdentityWords.error(nil)
        }
    }
}
