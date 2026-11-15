import AppKit
import Security
import HegaiSignerCore
import SwiftUI

@main
struct HegaiSignerApp: App {
    init() {
        // `HegaiSigner --selftest`: proves the keychain entitlement works (create + delete an SE key, no prompt).
        if CommandLine.arguments.contains("--selftest") {
            let p = SecureEnclaveProvider(flags: [.privateKeyUsage], accessible: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly)
            do {
                let k = try p.create()
                p.delete(blob: k.blob)
                print("SELFTEST OK \(SecureEnclaveProvider.accessGroup)")
                do { let b = try SecureEnclaveProvider().create(); SecureEnclaveProvider().delete(blob: b.blob); print("biometric key: OK") }
                catch { print("biometric key: \(error.localizedDescription)") }
                exit(0)
            } catch { print("SELFTEST FAIL \(error.localizedDescription)"); exit(1) }
        }
    }

    @StateObject private var state = AppState()

    var body: some Scene {
        MenuBarExtra {
            MenuContent(state: state)
        } label: {
            MenuLabel(state: state)
        }
        Window("Hegai Signer", id: "main") {
            MainView(state: state)
                .frame(minWidth: 520, minHeight: 460)
        }
        .windowResizability(.contentSize)
    }
}

struct MenuLabel: View {
    @ObservedObject var state: AppState
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        HStack(spacing: 2) {
            Image(systemName: "checkmark.seal")
            if state.awaiting { Text("●") }
        }
        .task { state.start() }
        .onChange(of: state.openTick) { _ in show(openWindow) }
    }
}

@MainActor func show(_ open: OpenWindowAction) {
    open(id: "main")
    NSApp.activate(ignoringOtherApps: true)
}

struct MenuContent: View {
    @ObservedObject var state: AppState
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        if let p = state.pending, !p.signed {
            Text("Релиз \(p.version) ждёт подписи")
        }
        Button("Открыть окно") { show(openWindow) }
        Button("Проверить сейчас") { Task { await state.poll() } }
        Button("Публичный ключ") { show(openWindow) }
        Divider()
        Button("Выход") { NSApp.terminate(nil) }
    }
}

struct MainView: View {
    @ObservedObject var state: AppState
    @State private var confirmRotate = false

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            releaseSection
            Divider()
            keySection
            if !state.status.isEmpty {
                Text(state.status)
                    .foregroundColor(state.statusIsError ? .red : .secondary)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
            HStack {
                Button("Проверить сейчас") { Task { await state.poll() } }
                Spacer()
                Toggle("Запускать при входе", isOn: Binding(get: { state.launchAtLogin }, set: { state.toggleLaunchAtLogin($0) }))
            }
        }
        .padding(20)
        .confirmationDialog("Заменить ключ?", isPresented: $confirmRotate) {
            Button("Заменить (старый — в бэкап)", role: .destructive) { state.rotateKey() }
            Button("Отмена", role: .cancel) {}
        } message: {
            Text("Старый ключ будет перенесён в папку с датой. Новый публичный ключ нужно снова добавить в доверенные.")
        }
    }

    @ViewBuilder var releaseSection: some View {
        Text("Релиз").font(.headline)
        if let p = state.pending {
            Grid(alignment: .leadingFirstTextBaseline, horizontalSpacing: 12, verticalSpacing: 6) {
                GridRow { Text("Версия").foregroundColor(.secondary); Text(p.version).bold() }
                GridRow { Text("Коммит").foregroundColor(.secondary); Text(p.shortCommit).font(.system(.body, design: .monospaced)) }
                GridRow { Text("Дата").foregroundColor(.secondary); Text(p.createdAt ?? "—") }
                GridRow(alignment: .top) {
                    Text("sha256").foregroundColor(.secondary)
                    Text(Format.grouped(p.sha256)).font(.system(.body, design: .monospaced)).textSelection(.enabled)
                }
            }
            if p.signed {
                Text("Уже подписан.").foregroundColor(.green)
            } else {
                Button(state.busy ? "Работаю…" : "Подписать (Touch ID)") { Task { await state.signPending(version: p.version, sha256: p.sha256) } }
                    .keyboardShortcut(.defaultAction)
                    .disabled(state.busy || !state.hasKey)
                if !state.hasKey { Text("Сначала создайте ключ.").foregroundColor(.orange) }
            }
        } else {
            Text("Нет релизов, ожидающих подписи.").foregroundColor(.secondary)
        }
    }

    @ViewBuilder var keySection: some View {
        Text("Ключ подписи").font(.headline)
        if state.keyFilesExist && !state.hasKey {
            Text("Файлы ключа неполные — восстановите или сделайте «Новый ключ».").foregroundColor(.orange)
            Button("Новый ключ…") { confirmRotate = true }
        } else if state.hasKey {
            Text(state.pubLine).font(.system(.caption, design: .monospaced)).textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
            HStack {
                Button("Скопировать") {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(state.pubLine, forType: .string)
                }
                Button("Новый ключ…") { confirmRotate = true }
            }
            Text("Отправьте эту строку в чат — её добавят в доверенные.").font(.caption).foregroundColor(.secondary)
        } else {
            Text("Ключ привязан к Touch ID этого Mac: подпись возможна только по отпечатку, без пароля. Если вы добавите, удалите или перезапишете отпечатки либо потеряете Touch ID, ключ станет недоступен — придётся создать новый и заново добавить его в доверенные.")
                .font(.caption).foregroundColor(.secondary).fixedSize(horizontal: false, vertical: true)
            Button("Создать ключ") { state.createKey() }
        }
    }
}
