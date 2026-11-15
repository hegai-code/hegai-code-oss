import SwiftUI
import CCRemoteKit
import CryptoKit

struct AccountDeletionPreview: Codable {
    struct Transfer: Codable, Identifiable {
        let workspaceId: String
        let name: String
        let newOwnerUserId: String
        let newOwnerName: String
        var id: String { workspaceId }
    }
    let userId: String
    let transfers: [Transfer]
}

struct AccountDeletionView: View {
    @Environment(CentralClient.self) private var client
    @Environment(AppSettings.self) private var settings
    @Environment(\.dismiss) private var dismiss
    @State private var preview: AccountDeletionPreview?
    @State private var confirmation = ""
    @State private var error: String?
    @State private var working = false
    @FocusState private var confirmationFocused: Bool

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Theme.s4) {
                    Text("Удалить аккаунт Hegai Code?").font(SettingsStyle.heading)
                    Text("Доступ ко всем сессиям аккаунта будет отозван. Профиль, способы входа, память и ваши копии переписок в хабе будут удалены. Подключённые вами компьютеры отключатся; файлы на ваших собственных компьютерах останутся у вас.")
                    Text("Если у вас есть облачная рабочая среда Hegai Code, она и её резервные архивы также будут удалены. Удаление выполняется автоматически; при недоступном сервере оно продолжится после восстановления связи. Статус можно проверить на экране входа.")
                    Text("Доступ через персональный ключ шлюза Hegai Code будет удалён. Аккаунты HegAI, Telegram, Apple и внешних AI-провайдеров не удаляются. Обработка уже переданных провайдеру данных регулируется его политикой. Отменить начатое удаление нельзя.")
                    if let preview {
                        ForEach(preview.transfers) { transfer in
                            Text("Команда «\(transfer.name)» сохранится. Новый владелец: \(transfer.newOwnerName).")
                        }
                        Text("Для подтверждения введите УДАЛИТЬ")
                        TextField("УДАЛИТЬ", text: $confirmation)
                            .textInputAutocapitalization(.characters).autocorrectionDisabled()
                            .focused($confirmationFocused)
                            .submitLabel(.done)
                            .onSubmit { confirmationFocused = false }
                            .textFieldStyle(.roundedBorder)
                            .accessibilityIdentifier("account.deleteConfirmation")
                        Button(role: .destructive) { Task { await remove(preview) } } label: {
                            HStack {
                                if working { ProgressView() }
                                Text("Удалить аккаунт")
                            }
                            .frame(maxWidth: .infinity, minHeight: Theme.tapTarget)
                        }
                        .disabled(working || confirmation != "УДАЛИТЬ")
                        .accessibilityIdentifier("account.confirmDelete")
                    } else if error == nil { ProgressView() }
                    if let error { Text(error).foregroundStyle(Theme.negative) }
                    Button("Отмена") { dismiss() }.disabled(working)
                }
                .font(SettingsStyle.body).foregroundStyle(Theme.text).padding(Theme.s4)
            }
            .scrollDismissesKeyboard(.interactively)
            .background(Theme.settingsBackground)
            .navigationTitle("Удаление аккаунта").inlineTitle()
            .interactiveDismissDisabled(working)
            .task {
                do { preview = try await client.api.get("api/account/deletion", as: AccountDeletionPreview.self) }
                catch { self.error = "Не удалось загрузить условия удаления: \(error.localizedDescription)" }
            }
        }
    }

    private func remove(_ preview: AccountDeletionPreview) async {
        working = true
        defer { working = false }
        struct Request: Encodable {
            let userId: String
            let transfers: [AccountDeletionPreview.Transfer]
            let receipt: String
            let confirm = "DELETE"
        }
        struct Reply: Decodable { let status: String; let receipt: String }
        let endpoint = settings.hubURL
        let token = settings.token
        let scope = client.storageScope
        // Save before sending: a lost 202 response must not strand the user
        // after the server has already revoked every login session.
        let defaults = UserDefaults.standard
        let previous = defaults.string(forKey: "cc.deletion.endpoint") == endpoint
            && defaults.string(forKey: "cc.deletion.credentialHash") == AccountDeletionRecovery.fingerprint(token)
            ? defaults.string(forKey: "cc.deletion.receipt") : nil
        let receipt = previous.flatMap { $0.isEmpty ? nil : $0 }
            ?? (UUID().uuidString + UUID().uuidString).replacingOccurrences(of: "-", with: "").lowercased()
        defaults.set(receipt, forKey: "cc.deletion.receipt")
        defaults.set(endpoint, forKey: "cc.deletion.endpoint")
        defaults.set(AccountDeletionRecovery.fingerprint(token), forKey: "cc.deletion.credentialHash")
        defaults.set(Array(client.localAccountScopes.union([scope])), forKey: "cc.deletion.scopes")
        defaults.set(false, forKey: "cc.deletion.confirmed")
        do {
            let reply = try await client.api.post("api/account/deletion", body: Request(userId: preview.userId, transfers: preview.transfers, receipt: receipt), as: Reply.self)
            guard reply.status == "pending", reply.receipt == receipt else { throw ClientError.rpc("Удаление не подтверждено сервером") }
            defaults.set(true, forKey: "cc.deletion.confirmed")
            UserDefaults.standard.set(reply.receipt, forKey: "cc.deletion.receipt")
            UserDefaults.standard.set(endpoint, forKey: "cc.deletion.endpoint")
            if settings.token == token && settings.hubURL == endpoint {
                let scopes = client.localAccountScopes.union([scope])
                for value in scopes { DraftStore.erase(scope: value) }
                do { try await client.eraseLocalAccountData() }
                catch { UserDefaults.standard.set("Не удалось полностью очистить кэш на устройстве. Очистка повторится при следующем запуске приложения.", forKey: "cc.deletion.localError") }
                if settings.token == token && settings.hubURL == endpoint {
                    SignOutCleanup.retire(hubURL: settings.hubURL, token: token, replacingWith: "", client: client)
                    settings.token = ""
                    settings.workspaceId = ""
                    TelegramSignInMemo.forget()
                }
            }
            dismiss()
        } catch {
            if await AccountDeletionRecovery.resume(client: client, settings: settings) { dismiss() }
            else { self.error = "Сервер пока не подтвердил удаление: \(error.localizedDescription). Номер запроса сохранён; статус можно проверить после восстановления связи." }
        }
    }
}

struct AccountDeletionStatusView: View {
    @AppStorage("cc.deletion.receipt") private var receipt = ""
    @AppStorage("cc.deletion.endpoint") private var endpoint = ""
    @AppStorage("cc.deletion.localError") private var localError = ""
    @AppStorage("cc.deletion.confirmed") private var confirmed = false
    @State private var status = "unknown"
    @State private var error: String?
    var body: some View {
        if !receipt.isEmpty {
            VStack(alignment: .leading, spacing: Theme.s2) {
                Text(status == "deleted" ? "Аккаунт Hegai Code удалён" : (confirmed ? "Удаление аккаунта выполняется" : "Проверка запроса на удаление"))
                    .font(SettingsStyle.heading)
                if let error { Text(error).font(SettingsStyle.caption) }
                if !localError.isEmpty { Text(localError).font(SettingsStyle.caption) }
                if status == "deleted" {
                    Button("Понятно") { receipt = "" }
                        .disabled(!localError.isEmpty)
                } else {
                    Button("Проверить статус") { Task { await refresh() } }
                }
            }
            .padding(Theme.s3).settingsCard()
            .task { await refresh() }
        }
    }
    private func refresh() async {
        let rest = RestClient(); rest.configure(hubURL: endpoint, token: "")
        struct Reply: Decodable { let status: String }
        do {
            status = try await rest.post("api/account/deletion/status", body: ["receipt":receipt], as: Reply.self).status
            confirmed = status == "pending" || status == "deleted"
            error = nil
        } catch { self.error = "Статус пока недоступен. Повторите проверку позже или напишите в поддержку." }
    }
}

@MainActor
enum AccountDeletionRecovery {
    static func fingerprint(_ token: String) -> String {
        SHA256.hash(data: Data(token.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    @discardableResult
    static func resume(client: CentralClient, settings: AppSettings) async -> Bool {
        let defaults = UserDefaults.standard
        guard let receipt = defaults.string(forKey: "cc.deletion.receipt"), !receipt.isEmpty,
              let endpoint = defaults.string(forKey: "cc.deletion.endpoint") else { return false }
        let token = settings.token
        if !defaults.bool(forKey: "cc.deletion.confirmed") {
            let rest = RestClient(); rest.configure(hubURL: endpoint, token: "")
            struct Reply: Decodable { let status: String }
            guard let reply = try? await rest.post("api/account/deletion/status", body: ["receipt": receipt], as: Reply.self),
                  reply.status == "pending" || reply.status == "deleted" else { return false }
        }
        defaults.set(true, forKey: "cc.deletion.confirmed")
        let matchesCurrent = !token.isEmpty && settings.token == token && settings.hubURL == endpoint
            && defaults.string(forKey: "cc.deletion.credentialHash") == fingerprint(token)
        let scopes = Set(defaults.stringArray(forKey: "cc.deletion.scopes") ?? [])
            .union(matchesCurrent ? client.localAccountScopes : [])
        for scope in scopes { DraftStore.erase(scope: scope) }
        do {
            try await client.eraseStoredAccountData(scopes: scopes)
            defaults.removeObject(forKey: "cc.deletion.localError")
            defaults.removeObject(forKey: "cc.deletion.scopes")
        } catch {
            defaults.set("Не удалось полностью очистить кэш. Очистка повторится при следующем запуске.", forKey: "cc.deletion.localError")
        }
        if matchesCurrent && settings.token == token && settings.hubURL == endpoint {
            SignOutCleanup.retire(hubURL: settings.hubURL, token: token, replacingWith: "", client: client)
            settings.token = ""; settings.workspaceId = ""
            TelegramSignInMemo.forget()
        }
        return true
    }
}
