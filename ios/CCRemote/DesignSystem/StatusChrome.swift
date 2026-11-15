import SwiftUI
import CCRemoteKit

/// Две части фоновой обвязки соединения плюс оверлей, который решает, что
/// показать. (Раньше в этой доке стояло «общее для iOS-корня и окна Mac» —
/// нативного Mac-таргета больше нет, см. PlatformModifiers.swift.)
///
/// Состояние соединения — это ФОНОВЫЙ СТАТУС, а не ошибка: отсюда спокойная
/// пилюля с дебаунсом (переподключение, уложившееся в окно ожидания, не
/// показывает ничего), тогда как ошибка, о которой сказал хаб, — красный тост.
struct HubStatusOverlay: View {
    @Environment(CentralClient.self) private var client

    var body: some View {
        ZStack(alignment: .top) {
            if let err = client.lastError {
                ErrorToast(message: err.message)
                    .transition(.move(edge: .top).combined(with: .opacity))
            }
        }
        .animation(Theme.ease, value: client.lastError)
    }
}

/// Показывать ли «Соединение…» — одно решение на всё приложение (09.10.2026).
///
/// Как в Telegram: статус связи — это подпись В ШАПКЕ на месте заголовка, а не
/// пилюля над полем ввода (там она садилась на клавиатуру и закрывала
/// композер). И показывается он, только когда связи нет заметно долго:
/// 2,5 с без сокета, а после возврата в приложение — не раньше 5 с, потому
/// что переподключение после фона штатное и обычно укладывается в секунду-две.
/// Под подписью экран продолжает показывать кэш.
@MainActor @Observable
final class ConnectionIndicator {
    private(set) var showConnecting = false
    @ObservationIgnored private var open = true
    @ObservationIgnored private var graceUntil = Date.distantPast
    @ObservationIgnored private var pending: Task<Void, Never>?

    func update(open: Bool) {
        self.open = open
        schedule()
    }

    func appBecameActive() {
        graceUntil = Date().addingTimeInterval(5)
        showConnecting = false
        schedule()
    }

    private func schedule() {
        pending?.cancel()
        guard !open else { showConnecting = false; return }
        let delay = max(2.5, graceUntil.timeIntervalSinceNow)
        pending = Task { [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard let self, !Task.isCancelled else { return }
            self.showConnecting = !self.open
        }
    }
}

/// «Соединение…» в форме заголовка: маленький спиннер и подпись, тот же
/// остров шапки. Подставляется вместо названия сессии (`SessionTitle`) и
/// появляется по центру шапки главной (`HubTitleStatus`).
struct ConnectingTitleLabel: View {
    var body: some View {
        HStack(spacing: 6) {
            ProgressView().controlSize(.mini).tint(Theme.textMuted)
            Text("Соединение…")
                .font(.ui(Theme.sizeNavigationTitle, weight: .medium))
                .foregroundStyle(Theme.textMuted)
                .lineLimit(1)
        }
        .padding(.horizontal, Theme.s3)
        .frame(height: Theme.tapTarget)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Соединение с хабом")
        .accessibilityIdentifier("hub.connecting")
    }
}

/// Для шапок без заголовка: пусто, пока связь есть.
struct HubTitleStatus: View {
    @Environment(ConnectionIndicator.self) private var hub: ConnectionIndicator?

    var body: some View {
        if hub?.showConnecting == true {
            ConnectingTitleLabel().headerIsland()
        }
    }
}

struct ErrorToast: View {
    let message: String
    var body: some View {
        Text(message)
            // `red` — заливка под текстом (5.48:1). `redBright` сюда нельзя:
            // он только для графики, ivory на нём 4.09:1.
            .font(.ui(Theme.sizeMeta, weight: .medium))
            .foregroundStyle(Theme.textOnColor)
            .padding(.horizontal, Theme.s4)
            .padding(.vertical, Theme.s3)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.red,
                        in: RoundedRectangle(cornerRadius: Theme.radiusMd, style: .continuous))
            .padding(.horizontal, Theme.s4)
            .shadow(color: Theme.shadowLg.color, radius: Theme.shadowLg.radius, y: Theme.shadowLg.y)
    }
}
