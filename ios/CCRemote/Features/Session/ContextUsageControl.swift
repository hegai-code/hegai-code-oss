import SwiftUI
import CCRemoteKit

/// Контекст рядом с моделью; действие находится на самом индикаторе.
struct ContextUsageControl: View {
    let usage: ContextUsageInfo
    @Environment(CentralClient.self) private var client
    @State private var presented = false

    private var percentage: Int { min(100, max(0, Int(usage.percentage.rounded()))) }
    private var tint: Color { usage.isNearLimit ? Theme.orange : Theme.drawerSecondary }
    private var actionTitle: String {
        switch client.compactionState {
        case .requested: return "Запрошено…"
        case .running: return "Сжимаю…"
        default: return "Сжать контекст"
        }
    }

    var body: some View {
        Button { presented = true; Haptics.light() } label: {
            ZStack {
                Circle().stroke(Theme.drawerRim, lineWidth: 2)
                Circle().trim(from: 0, to: CGFloat(percentage) / 100)
                    .stroke(tint, style: StrokeStyle(lineWidth: 2, lineCap: .round))
                    .rotationEffect(.degrees(-90))
            }
            .frame(width: 18, height: 18)
            .frame(width: Theme.tapTarget, height: Theme.tapTarget)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("composer.context")
        .accessibilityLabel("Использование контекста")
        .accessibilityValue("\(percentage)%")
        .accessibilityHint("Открывает сведения и сжатие контекста")
        .sheet(isPresented: $presented) {
            VStack(alignment: .leading, spacing: 20) {
                HStack {
                    Text("Контекст").font(.system(.headline))
                    Spacer()
                    Text("\(percentage)%").monospacedDigit().foregroundStyle(tint)
                }
                Text("\(usage.totalTokens.formatted()) из \(usage.maxTokens.formatted()) токенов")
                    .font(.system(.subheadline)).foregroundStyle(Theme.drawerSecondary)
                Text(statusText)
                    .font(.system(.subheadline)).foregroundStyle(Theme.drawerSecondary)
                Button {
                    client.compact()
                    Haptics.light()
                } label: {
                    Text(actionTitle).font(.system(.headline))
                        .frame(maxWidth: .infinity, minHeight: 50)
                        .foregroundStyle(Theme.drawerBackground)
                        .background(Theme.drawerText, in: Capsule())
                }
                .disabled(client.status != .open || client.active?.runId == nil || client.compactionState.pending)
                .opacity(client.compactionState.pending ? 0.6 : 1)
                .accessibilityIdentifier("context.compact")
            }
            .padding(24)
            .foregroundStyle(Theme.drawerText)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .padding(.top, 12)
            .background(Theme.settingsBackground)
            .presentationDetents([.height(300), .large])
            .presentationDragIndicator(.visible)
            .presentationCornerRadius(32)
        }
    }

    private var statusText: String {
        switch client.compactionState {
        case .requested, .running:
            return "Команда отправлена. Если модель занята, сжатие может начаться после текущего ответа."
        case .completed:
            return "Контекст сжат. Можно продолжать разговор."
        case .failed:
            return "Не удалось подтвердить сжатие. Проверьте сообщения в сессии перед повторной попыткой."
        case .idle:
            return "Ранние сообщения будут сведены в краткое содержание, чтобы освободить место для продолжения."
        }
    }
}
