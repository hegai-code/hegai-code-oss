import SwiftUI
import CCRemoteKit

// Шаги словами (20.10.2026, просьба владельца) — общие куски карточки хода,
// карточки помощника и «Что сделано». Порт `Trail` / `WhoLine` / `TurnRecap`
// из web/src/render/Subagents.tsx (c80e7c7f). Моноширинного нет: шаг — фраза
// гарнитурой текста, сырая команда остаётся в `Step.detail`.

/// Лента шагов, старые сверху, на тонкой вертикальной линии. С `live` последний
/// шаг ещё идёт: он — основным цветом и с пульсирующей меткой на линии, прошлые
/// — приглушённым.
struct StepTrail: View {
    let steps: [Step]
    var live: Bool = false
    /// Длинный список листается внутри себя, а не растягивает ленту.
    var scrollable: Bool = false

    var body: some View {
        if steps.isEmpty {
            EmptyView()
        } else if scrollable && steps.count > 12 {
            ScrollView { trail }
                .frame(maxHeight: 300)
        } else {
            trail
        }
    }

    private var trail: some View {
        HStack(alignment: .top, spacing: 0) {
            Rectangle().fill(Theme.divider).frame(width: 1)
            VStack(alignment: .leading, spacing: 2) {
                ForEach(Array(steps.enumerated()), id: \.offset) { index, step in
                    StepLine(step: step, now: live && index == steps.count - 1)
                }
            }
            .padding(.leading, 12)
        }
        .padding(.leading, 3)
    }
}

private struct StepLine: View {
    let step: Step
    let now: Bool

    var body: some View {
        Text(step.text)
            .font(.ui(Theme.sizeMeta))
            .foregroundStyle(now ? Theme.text : Theme.textMuted)
            .lineLimit(1)
            .truncationMode(.tail)
            .frame(maxWidth: .infinity, alignment: .leading)
            .overlay(alignment: .leading) {
                // Метка стоит НА линии, как метка в шапке карточки.
                if now { SubagentStatusMark(status: .running).offset(x: -15.5) }
            }
            .accessibilityAddTraits(now ? .updatesFrequently : [])
    }
}

/// «Explore · Sonnet 5.5» — кто работает и на какой модели одной тихой строкой.
struct WhoLine: View {
    var kind: String? = nil
    var model: String? = nil

    var body: some View {
        // A bare alias («opus») reads as a name: «Opus».
        let shown = model.map { $0.range(of: #"^[a-z]+$"#, options: .regularExpression) != nil ? $0.prefix(1).uppercased() + $0.dropFirst() : $0 }
        let parts: [String] = [kind, shown].compactMap { $0 }.filter { !$0.isEmpty }
        if !parts.isEmpty {
            Text(parts.joined(separator: " · "))
                .font(.ui(Theme.sizeMicro))
                .foregroundStyle(Theme.textFaint)
                .lineLimit(1)
                .padding(.leading, 16)
        }
    }
}

/// «✓ Что сделано · 14 шагов · 5:28» — карточка законченного хода в одну строку;
/// по нажатию раскрывается в список всех шагов словами.
struct TurnRecapView: View {
    let data: TurnRecapData
    @State private var open = false

    var body: some View {
        let meta = recapMeta(steps: data.calls.count, ms: data.ms)
        VStack(alignment: .leading, spacing: 0) {
            Button {
                withAnimation(.easeInOut(duration: 0.18)) { open.toggle() }
            } label: {
                HStack(spacing: Theme.s2) {
                    Image(systemName: "checkmark")
                        .font(.system(size: 10, weight: .bold))
                        .foregroundStyle(Theme.positive)
                        .frame(width: 8)
                    Text("Что сделано")
                        .font(.ui(Theme.sizeSmall))
                        .foregroundStyle(open ? Theme.text : Theme.textMuted)
                        .lineLimit(1)
                    Spacer(minLength: Theme.s2)
                    Text(meta)
                        .font(.ui(Theme.sizeMicro))
                        .monospacedDigit()
                        .foregroundStyle(Theme.textMuted)
                        .lineLimit(1)
                    Image(systemName: "chevron.down")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(Theme.textFaint)
                        .rotationEffect(.degrees(open ? 180 : 0))
                }
                .padding(.horizontal, 14)
                .frame(minHeight: Theme.tapTarget)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Что сделано, \(meta)")
            .accessibilityHint(open ? "Свернуть список шагов" : "Показать список шагов")
            .accessibilityIdentifier("turn.recap")
            if open {
                StepTrail(steps: data.steps, scrollable: true)
                    .padding(.leading, 17)
                    .padding(.trailing, 14)
                    .padding(.bottom, 12)
            }
        }
        .card(radius: Theme.radiusMd)
        .padding(.top, Theme.s2)
        .padding(.bottom, Theme.s1)
    }
}
