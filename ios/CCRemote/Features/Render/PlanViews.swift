import SwiftUI
import CCRemoteKit

// План сессии на виду (07.11.2026): «3/7 · прогоняю тесты» над полем ввода,
// пока ход идёт, и та же строка на карточке работающего помощника.
// Чистая часть — `PlanProgress.swift` в Kit (порт `shared/src/plan.ts`);
// здесь только рисунок. Ни одна из этих вью не `Equatable`: у `PlanStrip` есть
// `@State`, а `Equatable` на вью с `@State` замораживает его на iOS.

/// Тонкая линия прогресса: 3pt, закруглённая, ширина анимируется.
struct PlanProgressBar: View {
    let fraction: Double
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Capsule().fill(Theme.surfaceSunken)
                Capsule().fill(Theme.brand)
                    .frame(width: max(0, geo.size.width * min(1, max(0, fraction))))
            }
        }
        .frame(height: 3)
        .animation(reduceMotion ? nil : .easeOut(duration: 0.25), value: fraction)
        .accessibilityHidden(true)
    }
}

/// «3/5 · active» и линия под ним — карточка помощника.
struct PlanLine: View {
    let plan: PlanProgress

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(PlanText.line(count: plan.count, active: plan.active))
                .font(.ui(Theme.sizeMicro))
                .monospacedDigit()
                .foregroundStyle(Theme.textMuted)
                .lineLimit(1)
                .truncationMode(.tail)
            PlanProgressBar(fraction: plan.fraction)
        }
        .padding(.leading, 16)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(PlanText.spoken(plan: plan, active: plan.active))
        .accessibilityValue(PlanText.percent(plan.fraction))
    }
}

/// Закреплённая полоса над композером: одна строка и линия; нажатие раскрывает
/// весь список над ней.
struct PlanStrip: View {
    let plan: CurrentPlan
    @State private var expanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.s2) {
            if expanded {
                TodoListView(todos: plan.items.map {
                    .object(["content": .string($0.content), "status": .string($0.status.rawValue)])
                })
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityIdentifier("plan.list")
            }
            Button { withAnimation(.easeOut(duration: 0.2)) { expanded.toggle() } } label: {
                VStack(alignment: .leading, spacing: 5) {
                    HStack(spacing: Theme.s2) {
                        Text(PlanText.line(count: plan.progress.count, active: plan.activeLine))
                            .font(.ui(Theme.sizeMeta))
                            .monospacedDigit()
                            .foregroundStyle(Theme.textMuted)
                            .lineLimit(1)
                            .truncationMode(.tail)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        Image(systemName: expanded ? "chevron.down" : "chevron.up")
                            .font(.system(size: 10, weight: .semibold))
                            .foregroundStyle(Theme.textFaint)
                    }
                    PlanProgressBar(fraction: plan.progress.fraction)
                }
                .padding(.vertical, Theme.s2)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(PlanText.spoken(plan: plan.progress, active: plan.activeLine))
            .accessibilityValue(PlanText.percent(plan.progress.fraction))
            .accessibilityHint(expanded ? "Свернуть список" : "Показать весь список")
            .accessibilityIdentifier("plan.strip")
        }
        .padding(.horizontal, Theme.s3)
        .padding(.top, Theme.s1)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.surface)
    }
}

enum PlanText {
    static func line(count: String, active: String?) -> String {
        guard let active, !active.isEmpty else { return count }
        return "\(count) · \(active)"
    }

    static func spoken(plan: PlanProgress, active: String?) -> String {
        let base = "План: \(plan.done) из \(plan.total)"
        guard let active, !active.isEmpty else { return base }
        return "\(base), сейчас: \(active)"
    }

    static func percent(_ fraction: Double) -> String {
        "\(Int((fraction * 100).rounded())) %"
    }
}
