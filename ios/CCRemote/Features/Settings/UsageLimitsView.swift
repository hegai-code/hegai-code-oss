import SwiftUI
import CCRemoteKit

/// One summary and one detail sheet, shared by home and settings.
struct UsageLimitsView: View {
    @Environment(CentralClient.self) private var client
    var compact = false
    var iconOnly = false
    var headerSummary = false
    /// Диаметр кольца в сводке. 32 — как было на главной; шапка шторки берёт 24,
    /// там рядом знак, два кольца и поиск на 307pt.
    var ringSize: CGFloat = 32
    /// Подпись «NN%» рядом с кольцом. В узкой шторке её нет — кольцо и так
    /// закрашено, а точное число лежит под нажатием.
    var showsPercent = true
    @State private var showDetails = false

    private var accounts: [UsageAccount] {
        UsageAccount.collect(machines: client.allMachines, gateway: client.gatewayUsage, budget: client.budgetUsage)
    }

    var body: some View {
        Group {
            if compact {
                Button { showDetails = true } label: {
                    if headerSummary { summary }
                    else if iconOnly {
                        Image(systemName: "gauge.with.dots.needle.50percent")
                            .frame(width: Theme.tapTarget, height: Theme.tapTarget)
                    } else {
                        HStack(spacing: Theme.s3) {
                            Image(systemName: "gauge.with.dots.needle.50percent").frame(width: 24)
                            Text("Лимиты").font(SettingsStyle.body)
                            Spacer()
                            SettingsChevron()
                        }.frame(minHeight: SettingsStyle.rowHeight).contentShape(Rectangle())
                    }
                }
                .foregroundStyle(Theme.text).buttonStyle(.plain)
                .accessibilityIdentifier("usage.open")
                .accessibilityLabel(headerSummary ? "Лимиты. Использовано" : "Лимиты")
                .accessibilityValue(headerSummary ? summaryLabel : "")
                .sheet(isPresented: $showDetails) {
                    NavigationStack {
                        ScrollView { details.padding(Theme.s4) }
                            .background(Theme.settingsBackground)
                            .navigationTitle("Лимиты").navigationBarTitleDisplayMode(.inline)
                            .toolbar {
                                ToolbarItem(placement: .topBarTrailing) {
                                    SheetCloseButton { showDetails = false }.accessibilityIdentifier("usage.done")
                                }
                            }
                    }.tint(Theme.text).presentationDetents([.large])
                }
            } else { details }
        }
    }

    private var summary: some View {
        HStack(spacing: Theme.s3) {
            usageSummary(claudeWeeklyLimit, isCodex: false)
            usageSummary(gatewayWindow.1, isCodex: true)
        }
        .fixedSize(horizontal: true, vertical: false)
        // The navigation bar has a fixed height. Larger accessibility text is
        // available without this cap in the full limits sheet.
        .dynamicTypeSize(...DynamicTypeSize.xxLarge)
        .frame(minHeight: Theme.tapTarget).contentShape(Rectangle())
        .accessibilityElement(children: .ignore)
        .accessibilityHint("Открыть все лимиты и время сброса")
    }

    private var summaryLabel: String {
        "Claude: неделя, использовано \(Self.percent(claudeWeeklyLimit)); Шлюз: \(gatewayWindow.0), использовано \(Self.percent(gatewayWindow.1))"
    }

    private func usageSummary(_ limit: UsageLimit?, isCodex: Bool) -> some View {
        let brand = isCodex ? Theme.codexActivity : Theme.claudeActivity
        // Всё, что внутри кольца, считается от его диаметра: толщина дуги и знак
        // рантайма (16 при 32), кегль подписи (subheadline при 32, footnote ниже).
        let small = ringSize < 32
        let stroke: CGFloat = small ? 2 : 2.5
        return HStack(spacing: Theme.s2) {
            ZStack {
                Circle().fill(Theme.surface)
                    .shadow(color: .black.opacity(0.08), radius: 3, y: 1)
                Circle().stroke(brand.opacity(0.14), lineWidth: stroke)
                if let used = limit?.percent, used.isFinite, used > 0 {
                    Circle().trim(from: 0, to: CGFloat(min(100, used)) / 100)
                        .stroke(ringTone(limit, brand: brand),
                                style: StrokeStyle(lineWidth: stroke, lineCap: .round))
                        .rotationEffect(.degrees(-90))
                }
                SessionActivityIcon(isCodex: isCodex, size: ringSize / 2)
            }.frame(width: ringSize, height: ringSize)
            if showsPercent {
                Text(Self.percent(limit))
                    .font(small ? Font.system(.footnote) : Font.system(.subheadline)).monospacedDigit().lineLimit(1)
                    .foregroundStyle(tone(limit))
            }
        }.fixedSize()
    }

    /// Кольцо — цвета рантайма, пока до потолка далеко; у края — предупреждение.
    private func ringTone(_ limit: UsageLimit?, brand: Color) -> Color {
        guard let value = limit?.percent, value.isFinite, value >= 75 else { return brand }
        return tone(limit)
    }

    private var claudeWeeklyLimit: UsageLimit? {
        // The main subscription is the one shared by the most machines, as on
        // web. The full sheet still includes every window and account.
        let account = accounts.filter { $0.provider == "Claude" }.max {
            $0.machines.count == $1.machines.count ? $0.peak < $1.peak : $0.machines.count < $1.machines.count
        }
        return account?.usage.normalizedLimits.first { $0.key == "weekly_all" }
    }
    private var gatewayWindow: (String, UsageLimit?) {
        let limits = accounts.first { $0.id == "gateway" }?.usage.normalizedLimits ?? []
        // Surface the window closest to its ceiling; retain its period for VoiceOver.
        let limit = limits.filter { $0.percent.isFinite }.max { $0.percent < $1.percent } ?? limits.first
        return (limit.map { Self.windowLabel($0.label) } ?? "", limit)
    }

    static func percent(_ limit: UsageLimit?) -> String {
        guard let value = limit?.percent, value.isFinite else { return "—" }
        return "\(Int(max(0, value).rounded()))%"
    }
    static func windowLabel(_ label: String) -> String {
        ["Session (5hr)": "5 часов", "Weekly (7 day)": "Неделя"][label] ?? label
    }
    private func tone(_ limit: UsageLimit?) -> Color {
        guard let value = limit?.percent, value.isFinite else { return Theme.textMuted }
        return value >= 90 ? Theme.negative : value >= 75 ? Theme.orangeText : Theme.text
    }

    private var details: some View {
        VStack(alignment: .leading, spacing: Theme.s4) {
            Text("Использовано от каждого лимита")
                .font(SettingsStyle.caption).foregroundStyle(Theme.textMuted)
            if accounts.isEmpty {
                Text("Данные о лимитах пока недоступны.")
                    .font(SettingsStyle.body).foregroundStyle(Theme.textMuted)
            }
            ForEach(accounts) { account in
                VStack(alignment: .leading, spacing: Theme.s4) {
                    HStack(alignment: .firstTextBaseline) {
                        Text(account.provider == "Gateway" ? "Шлюз" : account.provider).font(SettingsStyle.heading)
                        Spacer()
                        if let plan = account.usage.subscription {
                            Text(plan).font(SettingsStyle.caption).foregroundStyle(Theme.textMuted)
                        }
                    }
                    ForEach(account.usage.normalizedLimits) { limit in
                        VStack(alignment: .leading, spacing: Theme.s2) {
                            HStack(alignment: .firstTextBaseline) {
                                Text(Self.windowLabel(limit.label)).font(SettingsStyle.body)
                                Spacer(minLength: Theme.s2)
                                Text(Self.percent(limit)).font(SettingsStyle.emphasis).monospacedDigit()
                                    .foregroundStyle(tone(limit))
                            }
                            if limit.percent.isFinite {
                                ProgressView(value: min(100, max(0, limit.percent)), total: 100).tint(tone(limit))
                            }
                            if let reset = validDate(limit.resetsAt) {
                                TimelineView(.periodic(from: .now, by: 60)) { context in
                                    Text(Self.resetLabel(reset, now: context.date))
                                        .font(SettingsStyle.caption).foregroundStyle(Theme.textMuted)
                                }
                            }
                        }.accessibilityElement(children: .combine)
                    }
                    DisclosureGroup("Источник и обновление") {
                        VStack(alignment: .leading, spacing: Theme.s2) {
                            if let name = account.usage.account { Text(name) }
                            if !account.machines.isEmpty { Text(account.machines.joined(separator: " · ")) }
                            if let updated = validDate(account.usage.updatedAt) {
                                Text("Обновлено: \(updated.formatted(date: .abbreviated, time: .shortened))")
                            }
                            ForEach(account.usage.normalizedLimits) { limit in
                                if let reset = validDate(limit.resetsAt) {
                                    Text("\(Self.windowLabel(limit.label)): сброс \(reset.formatted(date: .abbreviated, time: .shortened))")
                                }
                            }
                        }.font(SettingsStyle.caption).foregroundStyle(Theme.textMuted)
                            .frame(maxWidth: .infinity, alignment: .leading).padding(.top, Theme.s2)
                    }.font(SettingsStyle.caption).tint(Theme.textMuted)
                }
                .foregroundStyle(Theme.text).padding(Theme.s4).settingsCard()
                .accessibilityIdentifier("usage.account.\(account.provider)")
            }
        }.frame(maxWidth: Theme.readingWidth, alignment: .leading).frame(maxWidth: .infinity)
    }
    private func validDate(_ stamp: Double?) -> Date? {
        guard let stamp, stamp.isFinite, stamp > 0 else { return nil }
        return Date(timeIntervalSince1970: stamp / 1000)
    }
    static func resetLabel(_ reset: Date, now: Date) -> String {
        let minutes = Int(ceil(max(0, reset.timeIntervalSince(now)) / 60))
        if minutes == 0 { return "Ожидается обновление лимита" }
        if minutes < 60 { return "Сброс через \(minutes) мин" }
        let hours = minutes / 60
        if hours < 24 { return "Сброс через \(hours) ч \(minutes % 60) мин" }
        return "Сброс через \(hours / 24) д \(hours % 24) ч"
    }
}
