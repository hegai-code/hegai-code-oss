import SwiftUI
import CCRemoteKit

struct AIDataConsentView: View {
    @Environment(CentralClient.self) private var client
    @Environment(AppSettings.self) private var settings
    @Environment(\.dismiss) private var dismiss
    @State private var error: String?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Theme.s4) {
                    Text("Как используются данные")
                        .font(SettingsStyle.heading)
                    Text("Чтобы выполнить задачу, Hegai Code передаёт сообщения, вложенные изображения, выбранный код и контекст чата вашему хабу и подключённому компьютеру, а затем настроенному AI-провайдеру.")
                    Text("Claude Code использует Anthropic. Codex обычно использует OpenAI или провайдера, настроенного владельцем компьютера или шлюза. Автоматические заголовки и подсказки также передают текст провайдеру AI, настроенному в хабе. Если вы подключились к чужому хабу, уточните его провайдеров у владельца.")
                    Text("Эти данные нужны для ответов, выполнения команд, сжатия контекста и заголовков. Не отправляйте данные, которыми вы не вправе делиться. Условия хранения у внешних провайдеров зависят от их политики и настроек аккаунта.")
                    Text("Отдельно: при диктовке распознавание речи может выполняться Apple. Текст становится сообщением только после отправки.")
                    Link("Политика конфиденциальности Hegai Code", destination: HegaiAuth.hubPageURL(hubURL: settings.hubURL, path: "/api/privacy"))
                    Link("Политика Anthropic", destination: URL(string: "https://www.anthropic.com/legal/privacy")!)
                    Link("Политика OpenAI", destination: URL(string: "https://openai.com/policies/privacy-policy/")!)
                    Text("Без согласия можно читать историю. Отозвать согласие можно в настройках; это остановит новые AI-запросы из приложения, но не уже запущенную работу на компьютере.")
                        .foregroundStyle(Theme.textMuted)
                    if let error { Text(error).foregroundStyle(Theme.negative) }
                    ActionButton("Разрешить передачу данных AI", wide: true, enabled: client.viewer != nil) {
                        do { try client.acceptAIDataSharing(); dismiss() }
                        catch { self.error = "Не удалось сохранить согласие. Попробуйте ещё раз." }
                    }
                    .accessibilityIdentifier("privacy.allowAI")
                    Button("Не сейчас") { dismiss() }
                        .frame(maxWidth: .infinity, minHeight: Theme.tapTarget)
                        .accessibilityIdentifier("privacy.declineAI")
                }
                .font(SettingsStyle.body).foregroundStyle(Theme.text)
                .padding(Theme.s4)
            }
            .background(Theme.settingsBackground)
            .navigationTitle("Передача данных AI").inlineTitle()
        }
    }
}
