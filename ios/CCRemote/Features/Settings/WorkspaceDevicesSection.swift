import SwiftUI
import CCRemoteKit

/// «Подключить машину» + «Мои устройства» — половина настроек пространства,
/// которую веб держит на `/w/settings` (коды подключения, отзыв и возврат
/// устройства). Ездит на `client.team`.
///
/// Живёт в табе «Железо»: код подключения и список устройств — это разговор о
/// машинах, а не об аккаунте.
struct WorkspaceDevicesSection: View {
    @Environment(CentralClient.self) private var client
    @Environment(AppSettings.self) private var settings

    @State private var enrollment: EnrollmentCode?
    @State private var devices: [DeviceRecord] = []
    @State private var note: String?

    private var origin: String {
        HegaiAuth.apiBase(hubURL: settings.hubURL)?.absoluteString ?? ""
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            enrollRows
            Divider().overlay(Theme.divider)
            deviceRows
        }
        .task { await loadDevices() }
    }

    // MARK: Подключение

    @ViewBuilder private var enrollRows: some View {
        VStack(alignment: .leading, spacing: Theme.s3) {
            Text("Подключить машину")
                .font(SettingsStyle.heading).foregroundStyle(Theme.text)
            if let enrollment {
                HStack(spacing: Theme.s2) {
                    // Код — данные, и он читается как данные: моно, колодец,
                    // прямоугольник. Его переписывают глазами в терминал на
                    // другой машине, поэтому кегль тела, а не меты.
                    Text(enrollment.code)
                        .font(.mono(Theme.sizeBody, weight: .semibold)).foregroundStyle(Theme.text)
                        .textSelection(.enabled)
                    Spacer()
                    Text("до \(RelTime.short(enrollment.expiresAt))")
                        .font(SettingsStyle.caption).foregroundStyle(Theme.drawerSecondary)
                    Button {
                        copyToPasteboard(enrollment.code)
                        Haptics.success()
                    } label: {
                        Image(systemName: "doc.on.doc")
                            .font(.system(size: 14))  // бокс глифа
                            .foregroundStyle(Theme.textMuted)
                            .frame(width: Theme.tapTarget, height: Theme.tapTarget)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Скопировать код")
                }
                .padding(.leading, Theme.s3)
                .background(Theme.surfaceSunken,
                            in: RoundedRectangle(cornerRadius: Theme.radiusMd, style: .continuous))
                Text("Код одноразовый (15 минут). Инструкция по установке: \(origin)/install")
                    .font(SettingsStyle.caption).foregroundStyle(Theme.drawerSecondary)
                    .textSelection(.enabled)
            } else {
                Text("Получите одноразовый код, чтобы подключить компьютер к вашему пространству.")
                    .font(SettingsStyle.caption).foregroundStyle(Theme.drawerSecondary)
            }
            ActionButton(enrollment == nil ? "Выдать код" : "Выдать новый",
                         kind: enrollment == nil ? .primary : .quiet) {
                Task { await generate() }
            }
            if let note {
                Text(note).font(SettingsStyle.caption).foregroundStyle(Theme.negative)
            }
        }
        .padding(Theme.s3)
    }

    // MARK: Устройства

    @ViewBuilder private var deviceRows: some View {
        VStack(alignment: .leading, spacing: Theme.s3) {
            Text("Мои устройства")
                .font(SettingsStyle.heading).foregroundStyle(Theme.text)
            if devices.isEmpty {
                Text("Подключённых устройств пока нет.")
                    .font(SettingsStyle.caption).foregroundStyle(Theme.drawerSecondary)
            }
            ForEach(devices) { device in
                // Строка устройства переносит действие вниз, когда имя и кнопка
                // не встают рядом: на 375 с крупным шрифтом «Отозвать» уезжало
                // за край.
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: Theme.s2) { deviceText(device); Spacer(); deviceActions(device) }
                    VStack(alignment: .leading, spacing: Theme.s2) {
                        deviceText(device)
                        deviceActions(device)
                    }
                }
            }
        }
        .padding(Theme.s3)
    }

    private func deviceText(_ device: DeviceRecord) -> some View {
        HStack(spacing: Theme.s2) {
            StatusSquare(color: device.online ? Theme.live : Theme.textFaint.opacity(0.55))
            VStack(alignment: .leading, spacing: 1) {
                Text(device.name)
                    .font(SettingsStyle.emphasis).foregroundStyle(Theme.text)
                Text("\(device.os.rawValue) · \(RelTime.short(device.lastSeen))\(device.agentVersion.map { " · v\($0)" } ?? "")")
                    .font(SettingsStyle.caption).foregroundStyle(Theme.drawerSecondary)
            }
        }
    }

    /// Действие строки — ТЕКСТ, а не плашка. Устройств у этого аккаунта
    /// девять, и девять заполненных кнопок «Отозвать» подряд читались стеной
    /// аварии: красное в этой системе означает разрушение, а не «здесь можно
    /// нажать». Цель нажатия всё равно 44 — её держит рамка вокруг текста.
    @ViewBuilder private func deviceActions(_ device: DeviceRecord) -> some View {
        HStack(spacing: Theme.s2) {
            if device.revoked == true {
                Chip(text: "Доступ отозван", color: Theme.negative, mono: false)
                rowAction("Вернуть", tone: Theme.link) { Task { await restore(device) } }
            } else {
                rowAction("Отозвать", tone: Theme.negative) { Task { await revoke(device) } }
            }
        }
    }

    private func rowAction(_ title: String, tone: Color,
                           action: @escaping () -> Void) -> some View {
        Button {
            action()
            Haptics.light()
        } label: {
            Text(title)
                .font(SettingsStyle.heading).foregroundStyle(tone)
                .padding(.horizontal, Theme.s2)
                .frame(minHeight: SettingsStyle.rowHeight)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    // MARK: Действия

    private func generate() async {
        do { enrollment = try await client.team.enrollment() }
        catch { note = "Код не выдан: \(error.localizedDescription)" }
    }

    private func loadDevices() async {
        do { devices = try await client.team.devices() }
        catch { note = "Устройства недоступны: \(error.localizedDescription)" }
    }

    private func revoke(_ device: DeviceRecord) async {
        do {
            try await client.team.revokeDevice(machineId: device.machineId)
            await loadDevices()
        } catch { note = "Не отозвано: \(error.localizedDescription)" }
    }

    private func restore(_ device: DeviceRecord) async {
        do {
            try await client.team.restoreDevice(machineId: device.machineId)
            await loadDevices()
        } catch { note = "Не восстановлено: \(error.localizedDescription)" }
    }
}
