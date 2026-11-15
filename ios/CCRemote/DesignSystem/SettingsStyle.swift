import SwiftUI

/// Shared typography and surfaces for the settings hierarchy.
enum SettingsStyle {
    static let body = Font.system(.subheadline)
    static let emphasis = Font.system(.subheadline, weight: .medium)
    static let heading = Font.system(.subheadline, weight: .semibold)
    static let caption = Font.system(.footnote)
    static let metric = Font.system(.title3, weight: .semibold)
    static let rowHeight: CGFloat = 48
    static let cornerRadius: CGFloat = Theme.radiusXl
}

struct SettingsSectionHeader: View {
    let text: String
    var count: Int? = nil

    var body: some View {
        HStack(spacing: Theme.s2) {
            Text(text)
            if let count { Text("\(count)").monospacedDigit() }
        }
        .font(SettingsStyle.heading)
        .foregroundStyle(Theme.drawerSecondary)
        .accessibilityAddTraits(.isHeader)
    }
}

extension View {
    func settingsCard() -> some View {
        background(Theme.settingsGroup,
                   in: RoundedRectangle(cornerRadius: SettingsStyle.cornerRadius, style: .continuous))
    }
}

struct SettingsChevron: View {
    var body: some View {
        Image(systemName: "chevron.right").font(.system(.caption, weight: .semibold))
            .foregroundStyle(Theme.textFaint).accessibilityHidden(true)
    }
}

struct SettingsNavigationRow: View {
    let title: String
    let icon: String
    var external = false
    init(_ title: String, icon: String, external: Bool = false) {
        self.title = title; self.icon = icon; self.external = external
    }
    var body: some View {
        HStack(spacing: Theme.s3) {
            Image(systemName: icon).font(.system(.body)).frame(width: 24).accessibilityHidden(true)
            Text(title).font(SettingsStyle.body).frame(maxWidth: .infinity, alignment: .leading)
            if external {
                Image(systemName: "arrow.up.right").font(.system(.caption)).foregroundStyle(Theme.textFaint)
            } else { SettingsChevron() }
        }
        .foregroundStyle(Theme.text).padding(.horizontal, Theme.s4).padding(.vertical, Theme.s2)
        .frame(minHeight: SettingsStyle.rowHeight).contentShape(Rectangle())
    }
}

struct SheetCloseButton: View {
    let action: () -> Void
    var body: some View {
        Button(action: action) { Image(systemName: "xmark").font(.system(.subheadline, weight: .semibold)) }
            .tint(Theme.text).accessibilityLabel("Закрыть")
    }
}

/// Preserve readable labels and menu values when Dynamic Type needs two rows.
struct SettingsMenuRow<Content: View>: View {
    let title: String
    @ViewBuilder let content: () -> Content

    var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: Theme.s3) {
                Text(title).foregroundStyle(Theme.text).fixedSize()
                Spacer(minLength: Theme.s2)
                content().fixedSize()
            }
            VStack(alignment: .leading, spacing: Theme.s1) {
                Text(title).foregroundStyle(Theme.text)
                content().fixedSize(horizontal: false, vertical: true)
            }.frame(maxWidth: .infinity, alignment: .leading)
        }
        .labelsHidden().pickerStyle(.menu).tint(Theme.textMuted)
        .font(SettingsStyle.body).padding(.vertical, Theme.s2)
    }
}
