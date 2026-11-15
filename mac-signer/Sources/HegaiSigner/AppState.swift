import AppKit
import HegaiSignerCore
import ServiceManagement
import SwiftUI
import UserNotifications

@MainActor
final class AppState: NSObject, ObservableObject, UNUserNotificationCenterDelegate {
    @Published var pending: PendingRelease?
    @Published var status = ""
    @Published var statusIsError = false
    @Published var busy = false
    @Published var hasKey = false
    @Published var keyFilesExist = false
    @Published var pubLine = ""
    @Published var openTick = 0
    @Published var launchAtLogin = false

    let vault = KeyVault(dir: KeyVault.defaultDir, provider: SecureEnclaveProvider())
    let hub = HubClient()
    private var started = false
    private let notifiedKey = "notifiedPending"

    var awaiting: Bool { pending.map { !$0.signed } ?? false }

    func start() {
        guard !started else { return }
        started = true
        refreshKey()
        launchAtLogin = SMAppService.mainApp.status == .enabled
        let c = UNUserNotificationCenter.current()
        c.delegate = self
        c.requestAuthorization(options: [.alert, .sound]) { _, _ in }
        Task { [weak self] in
            while !Task.isCancelled {
                await self?.poll()
                try? await Task.sleep(nanoseconds: 15 * 60 * 1_000_000_000)
            }
        }
    }

    func refreshKey() {
        hasKey = vault.hasKey
        keyFilesExist = vault.anyKeyFiles
        pubLine = (try? vault.publicKeyLine()) ?? ""
    }

    func poll() async {
        do {
            let p = try await hub.fetchPending()
            // never swap the release under a signing in progress
            if !busy { pending = p; setStatus("", error: false) }
            if let p, !p.signed { notifyOnce(p) }
        } catch {
            if !busy { setStatus(error.localizedDescription, error: true) }
        }
    }

    private func notifyOnce(_ p: PendingRelease) {
        let id = "\(p.version)/\(p.sha256)"
        guard UserDefaults.standard.string(forKey: notifiedKey) != id else { return }
        UserDefaults.standard.set(id, forKey: notifiedKey)
        let content = UNMutableNotificationContent()
        content.title = "Релиз \(p.version) ждёт подписи"
        content.body = "Hegai Signer: откройте окно и подпишите Touch ID."
        content.sound = .default
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: id, content: content, trigger: nil))
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                            withCompletionHandler completionHandler: @escaping () -> Void) {
        Task { @MainActor in self.openTick += 1 }
        completionHandler()
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                            withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .sound])
    }

    func setStatus(_ s: String, error: Bool) { status = s; statusIsError = error }

    func createKey() {
        do {
            pubLine = try vault.createKey()
            hasKey = true
            keyFilesExist = true
            setStatus("Ключ создан.", error: false)
        } catch { refreshKey(); setStatus(error.localizedDescription, error: true) }
    }

    func rotateKey() {
        do {
            let b = try vault.backupAndRemove()
            refreshKey()
            setStatus("Старый ключ перенесён в \(b.path). Создайте новый.", error: false)
        } catch { setStatus(error.localizedDescription, error: true) }
    }

    func toggleLaunchAtLogin(_ on: Bool) {
        do {
            if on { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
        } catch { setStatus("Автозапуск: \(error.localizedDescription)", error: true) }
        launchAtLogin = SMAppService.mainApp.status == .enabled
    }

    /// `version`/`sha256` are what the screen showed when the button was pressed.
    func signPending(version: String, sha256: String) async {
        guard let p = pending, !p.signed, !busy, p.version == version, p.sha256 == sha256 else {
            setStatus("Релиз на экране изменился — проверьте данные и нажмите ещё раз.", error: true)
            return
        }
        busy = true
        defer { busy = false }
        do {
            setStatus("Скачиваю сборку…", error: false)
            let bytes = try await hub.download(p.bundleURL)
            setStatus("Проверяю сборку…", error: false)
            let manifest = try BundleChecks.verify(bytes: bytes, expectedSha256: p.sha256, expectedVersion: p.version)
            guard pending?.sha256 == p.sha256, pending?.version == p.version else {
                throw SignerError.badPending("релиз изменился во время проверки")
            }
            setStatus("Ожидаю Touch ID…", error: false)
            let vault = self.vault
            let reason = "Подписать релиз Hegai Code \(p.version) (sha256 \(p.sha256.prefix(8))…\(p.sha256.suffix(8)))"
            let sig = try await Task.detached { try vault.sign(manifest: manifest, reason: reason) }.value
            setStatus("Отправляю подпись…", error: false)
            try await hub.postSignature(version: p.version, sha256: p.sha256, signature: sig)
            if pending?.sha256 == p.sha256 { pending?.signed = true }
            setStatus("Готово: релиз \(p.version) подписан и отправлен.", error: false)
        } catch {
            setStatus(error.localizedDescription, error: true)
        }
    }
}
