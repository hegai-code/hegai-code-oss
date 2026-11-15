import SwiftUI
import CCRemoteKit
#if canImport(UIKit)
import UIKit
#endif

/// «Ввести код пары» - pairs this phone with a private machine (docs/E2EE.md).
///
/// The code is the machine's key (`hcp1.<machine>.<key>`, printed - and drawn as
/// a QR - by `node agent.mjs --pair` on the machine). Two ways in: scan the QR,
/// or paste the text. It goes to the Keychain of THIS phone, never off it, and is
/// not kept as text. Whoever sees the code reads the sessions: it is not for chats.
struct PairKeySheet: View {
    let request: PairRequest
    @Environment(CentralClient.self) private var client
    @Environment(\.dismiss) private var dismiss
    @State private var code = ""
    @State private var error: String?
    @State private var scanning = false
    @FocusState private var focused: Bool

    private var hasKey: Bool { request.machineId.map { client.hasKey(for: $0) } ?? false }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Theme.s4) {
                    Text("Сессии этой машины зашифрованы: сервер хранит и передаёт их, но прочитать не может. На машине выполните `node agent.mjs --pair` и отсканируйте QR-код или вставьте напечатанный код.")
                        .font(SettingsStyle.body)
                    Text("Кто видит код, тот читает сессии. Не пересылайте его открытым текстом.")
                        .font(SettingsStyle.caption).foregroundStyle(Theme.textMuted)

                    ActionButton("Сканировать QR", systemImage: "qrcode.viewfinder", wide: true) {
                        error = nil
                        scanning = true
                    }
                    .accessibilityIdentifier("pair.scan")

                    VStack(alignment: .leading, spacing: Theme.s2) {
                        Text("Или код").font(SettingsStyle.caption).foregroundStyle(Theme.textMuted)
                        TextField("hcp1.…", text: $code, axis: .vertical)
                            .textFieldStyle(.plain).font(.system(.footnote, design: .monospaced))
                            .lineLimit(1...4)
                            .autocorrectionDisabled().plainTextEntry()
                            .focused($focused)
                            .padding(.horizontal, Theme.s3).padding(.vertical, Theme.s2)
                            .frame(minHeight: 44)
                            .background(Theme.surfaceSunken,
                                        in: RoundedRectangle(cornerRadius: Theme.radiusMd, style: .continuous))
                            .accessibilityIdentifier("pair.code")
                        #if canImport(UIKit)
                        Button("Вставить из буфера") {
                            if let s = UIPasteboard.general.string { code = s; error = nil }
                        }
                        .font(SettingsStyle.heading).foregroundStyle(Theme.link)
                        .frame(minHeight: Theme.tapTarget, alignment: .leading)
                        #endif
                    }

                    if let error {
                        Text(error).font(SettingsStyle.caption).foregroundStyle(Theme.negative)
                            .accessibilityIdentifier("pair.error")
                    }

                    ActionButton("Сохранить ключ", wide: true,
                                 enabled: !code.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) {
                        submit(code)
                    }
                    .accessibilityIdentifier("pair.save")

                    if hasKey, let machineId = request.machineId {
                        ActionButton("Забыть ключ этой машины", kind: .danger, wide: true) {
                            if client.forgetKey(machineId: machineId) { dismiss() }
                        }
                        .accessibilityIdentifier("pair.forget")
                    }
                }
                .foregroundStyle(Theme.text)
                .padding(Theme.s4)
            }
            .background(Theme.settingsBackground)
            .navigationTitle("Код пары\(request.machineName.map { " · \($0)" } ?? "")").inlineTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Отмена") { dismiss() } }
            }
        }
        #if canImport(UIKit)
        .fullScreenCover(isPresented: $scanning) {
            QRScannerScreen(onCode: { scanned in
                scanning = false
                code = scanned
                submit(scanned)
            }, onCancel: { scanning = false })
        }
        #endif
    }

    private func submit(_ text: String) {
        do {
            try client.pair(code: text, expectMachineId: request.machineId)
            #if canImport(UIKit)
            // The code is the key: do not leave it on the clipboard.
            if UIPasteboard.general.string?.trimmingCharacters(in: .whitespacesAndNewlines)
                == text.trimmingCharacters(in: .whitespacesAndNewlines) {
                UIPasteboard.general.string = ""
            }
            #endif
            code = ""
            Haptics.success()
            dismiss()
        } catch {
            self.error = error.localizedDescription
            Haptics.rigid()
        }
    }
}

/// What a session of a private machine shows while this phone holds no key:
/// not broken or empty content, but what is wrong and the way out.
struct LockedSessionView: View {
    let machineId: String
    let machineName: String
    @Environment(CentralClient.self) private var client

    var body: some View {
        VStack(spacing: Theme.s4) {
            Spacer(minLength: Theme.s6)
            Image(systemName: "lock.fill").font(.system(size: 36)).foregroundStyle(Theme.textMuted)
            Text("Зашифровано на машине — нужен ключ")
                .font(SettingsStyle.heading).foregroundStyle(Theme.text)
                .multilineTextAlignment(.center)
            Text("«\(machineName)» хранит сессии в зашифрованном виде: сервер не может их прочитать, и этот телефон тоже, пока не получит ключ с машины.")
                .font(SettingsStyle.caption).foregroundStyle(Theme.textMuted)
                .multilineTextAlignment(.center)
            ActionButton("Ввести код пары", systemImage: "key.fill") {
                client.requestPairing(machineId: machineId)
            }
            .accessibilityIdentifier("pair.open")
            Spacer(minLength: Theme.s6)
        }
        .padding(.horizontal, Theme.s5)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.bg)
        .accessibilityIdentifier("session.locked")
    }
}

/// The machine is not private any more but this phone still holds its key: a
/// phone with a key refuses clear content for that machine, so to read its now
/// clear output the key has to go.
struct LeftoverKeyBanner: View {
    let machineId: String
    @Environment(CentralClient.self) private var client

    var body: some View {
        HStack(spacing: Theme.s2) {
            Image(systemName: "key").font(.system(size: 13))
            Text("Машина больше не зашифрована, а ключ остался на телефоне.").font(.ui(Theme.sizeMicro))
            Spacer()
            Button("Забыть ключ") { client.forgetKey(machineId: machineId) }
                .font(.ui(Theme.sizeMicro)).foregroundStyle(Theme.link)
        }
        .foregroundStyle(Theme.textMuted)
        .padding(.horizontal, Theme.s3).padding(.vertical, Theme.s3)
        .background(.bar)
        .accessibilityIdentifier("session.leftoverKey")
    }
}

/// The machine card's line: private / key held, and the way to pair or forget.
struct MachinePrivacyRow: View {
    let machineId: String
    let machineName: String
    @Environment(CentralClient.self) private var client

    var body: some View {
        let isPrivate = client.machines.first { $0.machine.machineId == machineId }?.machine.isPrivate == true
        let hasKey = client.hasKey(for: machineId)
        if isPrivate || hasKey {
            HStack(spacing: Theme.s2) {
                Image(systemName: hasKey ? "lock.open.fill" : "lock.fill").font(.system(.caption))
                Text(isPrivate ? (hasKey ? "Зашифрована · ключ на этом телефоне" : "Зашифрована · нужен ключ")
                               : "Ключ остался · машина не зашифрована")
                    .font(SettingsStyle.caption)
                Spacer()
                Button(hasKey ? "Ключ" : "Ввести код пары") { client.requestPairing(machineId: machineId) }
                    .font(SettingsStyle.heading).foregroundStyle(Theme.link)
                    .frame(minHeight: Theme.tapTarget)
                    .accessibilityIdentifier("hardware.pair.\(machineId)")
            }
            .foregroundStyle(Theme.textMuted)
        }
    }
}
