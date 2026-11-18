import SwiftUI
import CCRemoteKit

/// «Свой сервер» на экране входа: адрес (или QR-код), который выдал хаб, и
/// «Подключиться». Без раскрытия служебных полей в «Дополнительно» — туда
/// остался только сырой токен. Сканированный код лишь ЗАПОЛНЯЕТ поле: переключает
/// человек, глядя на крупно показанный адрес.
struct HubServerSheet: View {
    @Environment(AppSettings.self) private var settings
    @Environment(CentralClient.self) private var client
    @Environment(\.dismiss) private var dismiss

    @State private var draft = ""
    @State private var scanning = false
    @State private var connecting = false
    @State private var failure: String?

    /// What the field parses to (`HubLink` accepts a bare host, a link or the hub's QR text).
    private var parsedHub: String? { HubLink.parse(draft) }
    private var typedSomething: Bool { !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Theme.s4) {
                    Text("Введите адрес своего сервера Hegai Code или отсканируйте QR-код, который показывает ваш хаб.")
                        .font(SettingsStyle.body).foregroundStyle(Theme.textMuted)
                    VStack(spacing: 0) {
                        TextField("Адрес сервера, например code.example.com", text: $draft)
                            .keyboardType(.URL)
                            .textFieldStyle(.plain)
                            .font(SettingsStyle.body)
                            .plainTextEntry()
                            .padding(Theme.s3)
                            .frame(minHeight: SettingsStyle.rowHeight)
                            .accessibilityIdentifier("hubServer.address")
                    }
                    .settingsCard()
                    if let hub = parsedHub {
                        Text(HubSwitchPlan.label(hub))
                            .font(.ui(Theme.sizePage, weight: .bold)).foregroundStyle(Theme.text)
                            .lineLimit(1).truncationMode(.middle)
                    } else if typedSomething {
                        Text("Это не адрес сервера Hegai Code")
                            .font(SettingsStyle.caption).foregroundStyle(Theme.negative)
                    }
                    if let failure {
                        Text(failure).font(SettingsStyle.caption).foregroundStyle(Theme.negative)
                    }
                    ActionButton("Сканировать QR-код", systemImage: "qrcode.viewfinder", kind: .quiet, wide: true,
                                 enabled: !connecting) { scanning = true }
                    ActionButton("Подключиться", wide: true, enabled: parsedHub != nil && !connecting) {
                        Task { await connect() }
                    }
                    if connecting { HStack { Spacer(); ProgressView(); Spacer() } }
                }
                .padding(Theme.s4)
                .frame(maxWidth: Theme.readingWidth)
                .frame(maxWidth: .infinity)
            }
            .background(Theme.settingsBackground)
            .navigationTitle("Свой сервер").inlineTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Отмена") { dismiss() } }
            }
        }
        .fullScreenCover(isPresented: $scanning) {
            QRScannerScreen(accept: { HubLink.parse($0) != nil },
                            hint: "Наведите камеру на QR-код вашего сервера Hegai Code",
                            onCode: { text in
                                scanning = false
                                if let hub = HubLink.parse(text) { draft = HegaiAuth.apiBase(hubURL: hub)?.absoluteString ?? HubSwitchPlan.label(hub) }
                                failure = nil
                            }, onCancel: { scanning = false })
        }
    }

    private func connect() async {
        guard let hub = parsedHub,
              let plan = HubSwitchPlan.make(currentHub: settings.hubURL, currentToken: settings.token,
                                            draftHub: hub, draftToken: "") else { return }
        // Same server as now: nothing to switch (and an empty token on the same
        // hub would mean «sign out»).
        guard plan.switching else { dismiss(); return }
        failure = nil
        connecting = true
        let reason = await HubSwitcher.connect(plan, settings: settings, client: client)
        connecting = false
        if let reason { failure = reason; Haptics.rigid(); return }
        dismiss()
    }
}
