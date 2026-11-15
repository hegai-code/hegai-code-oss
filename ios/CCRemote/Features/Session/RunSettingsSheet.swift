import SwiftUI
import CCRemoteKit

/// Shared presentation for the start and live composers. Values change only
/// through explicit choices, never from an onChange echo of a runtime update.
struct RunSettingsSheet<Content: View>: View {
    let onDone: () -> Void
    @ViewBuilder let content: () -> Content

    var body: some View {
        VStack(spacing: 0) {
            Text("Модель и задача")
                .font(.system(.headline)).foregroundStyle(Theme.drawerText)
                .padding(.top, 28).padding(.bottom, 20)
            ScrollView {
                VStack(spacing: Theme.s4, content: content)
                    .padding(.horizontal, 20).padding(.bottom, 20)
            }
            Button(action: onDone) {
                Text("Готово")
                    .font(.system(.headline))
                    .foregroundStyle(Theme.settingsGroup)
                    .frame(maxWidth: .infinity, minHeight: 50)
                    .background(Theme.drawerText, in: Capsule())
                    .contentShape(Capsule())
            }
                .buttonStyle(.plain)
                .padding(20)
                .accessibilityIdentifier("runSettings.done")
        }
        .background(Theme.settingsBackground)
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
        .presentationCornerRadius(32)
    }
}

struct RunSettingsSummary: View {
    let model: String
    var effort: String? = nil

    var body: some View {
        HStack(spacing: 4) {
            (Text(model).foregroundStyle(Theme.drawerText)
             + Text(effort.map { " \($0)" } ?? "").foregroundStyle(Theme.drawerSecondary))
                .font(.system(.subheadline))
                .lineLimit(1).minimumScaleFactor(0.8)
            Image(systemName: "chevron.right")
                .font(.system(size: 9, weight: .semibold))
                .foregroundStyle(Theme.drawerSecondary)
        }
        .frame(minHeight: Theme.tapTarget)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}

struct RunSettingChoice: View {
    let title: String
    var subtitle: String? = nil
    let selected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(title).foregroundStyle(Theme.drawerText)
                    if let subtitle {
                        Text(subtitle).font(.system(.subheadline))
                            .foregroundStyle(Theme.drawerSecondary)
                    }
                }
                Spacer(minLength: 8)
                if selected {
                    Image(systemName: "checkmark").foregroundStyle(Theme.drawerText)
                }
            }
            .font(SettingsStyle.body)
            .padding(.horizontal, 16).padding(.vertical, 16)
            .frame(minHeight: 54).contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

struct RunSettingGroup<Content: View>: View {
    @ViewBuilder let content: () -> Content
    var body: some View {
        VStack(spacing: 0, content: content)
            .background(Theme.settingsGroup, in: RoundedRectangle(cornerRadius: SettingsStyle.cornerRadius))
    }
}

struct RunSettingMenu<Content: View>: View {
    let title: String
    @ViewBuilder let content: () -> Content
    var body: some View {
        SettingsMenuRow(title: title, content: content)
        .padding(.horizontal, 16)
        .frame(minHeight: 54)
    }
}

extension EffortLevel {
    var composerLabel: String {
        switch self {
        case .low: "Низкое"
        case .medium: "Среднее"
        case .high: "Высокое"
        case .xhigh: "Очень высокое"
        }
    }
}

extension EffortChoice {
    var composerLabel: String { effort?.composerLabel ?? "Ultracode" }
}
