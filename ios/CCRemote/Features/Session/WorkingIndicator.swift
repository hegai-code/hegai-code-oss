import SwiftUI
import CCRemoteKit

/// Карточка работы сессии — порт `SessionWorkCard` (web/src/render/Subagents.tsx).
///
/// До 08.10.2026 здесь была плашка «работает · 8:25 · 5250.4k ток.», потом одно
/// серое слово «Думаю · 1:42» с бликом. 20.10.2026 (просьба владельца:
/// «внятный текст, а не команды; блок виднее») — приподнятая карточка:
/// пульсирующая метка и слово `WorkActivity` заголовком, справа «N шагов ·
/// m:ss», под ним модель тихой строкой и три последних шага ХОДА словами
/// (`StepText`) на тонкой линии; текущий — основным цветом и с пульсом на линии.
/// Токенов нет (их никто не читал); сырых команд нет — они в `Step.detail`.
///
/// Тикают только часы; транскрипт не перегруппировывается каждую секунду.
struct WorkingIndicator: View {
    let progress: TurnProgress?
    let activity: String
    var work: TurnWork = .none
    var model: String? = nil

    var body: some View {
        SecondClock { now in
            let clock = progress?.elapsed(at: now) ?? "0:00"
            let meta = metaText(clock: clock)
            VStack(alignment: .leading, spacing: 4) {
                HStack(alignment: .firstTextBaseline, spacing: Theme.s2) {
                    SubagentStatusMark(status: .running)
                        .alignmentGuide(.firstTextBaseline) { $0.height }
                    Text(activity)
                        .font(.ui(Theme.sizeSmall, weight: .semibold))
                        .foregroundStyle(Theme.text)
                        .lineLimit(1)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Text(meta)
                        .font(.ui(Theme.sizeMicro))
                        .monospacedDigit()
                        .foregroundStyle(Theme.textMuted)
                        .lineLimit(1)
                        .fixedSize()
                }
                WhoLine(model: model)
                StepTrail(steps: Array(work.steps.suffix(TurnWork.shown)), live: work.current)
                    .padding(.top, Theme.s1)
            }
            .padding(.horizontal, 14)
            .padding(.top, 10)
            .padding(.bottom, 12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .card(radius: Theme.radiusMd)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(activity)
            .accessibilityValue(clock)
            .accessibilityHint(accessibilityHint)
            .accessibilityIdentifier("chat.working")
        }
        .padding(.vertical, Theme.s1)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// «5 шагов · 1:42»; шагов нет — одни часы.
    private func metaText(clock: String) -> String {
        let count = work.stepCount
        guard count > 0 else { return clock }
        return "\(count) \(plural(count, "шаг", "шага", "шагов")) · \(clock)"
    }

    /// Число шагов и текущий — в подсказке: подпись и значение остаются «слово» и «часы».
    private var accessibilityHint: String {
        let count = work.stepCount
        guard count > 0 else { return "" }
        let steps = "\(count) \(plural(count, "шаг", "шага", "шагов"))"
        guard work.current, let step = work.steps.last else { return steps }
        return "\(steps). \(step.text)"
    }
}

// «в фоне: … · m:ss» (`BackgroundIndicator`) gave way to the «В фоне · N»
// panel on 10.10.2026 — `SubagentPanel` in Features/Render/SubagentViews.swift.
