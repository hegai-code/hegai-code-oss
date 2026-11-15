import SwiftUI
import CCRemoteKit

/// Таб «Профиль» — профиль строителя (веб `Profile.tsx`): как этот человек на
/// самом деле работает с ИИ, посчитано ЛОКАЛЬНО на каждой машине по её
/// собственным транскриптам. Наружу уходят только агрегаты, и подвал говорит об
/// этом прямо — в этом вся история доверия к экрану.
struct ProfileView: View {
    @Environment(CentralClient.self) private var client
    @State private var machineId: String?
    @ScaledMetric(relativeTo: .subheadline) private var metricWidth: CGFloat = 104

    private var available: [(id: String, name: String)] {
        client.machines
            .filter { client.profiles[$0.machine.machineId] != nil }
            .map { ($0.machine.machineId, $0.machine.name) }
            .sorted { $0.1.localizedCaseInsensitiveCompare($1.1) == .orderedAscending }
    }

    private var profile: BuilderProfile? {
        if let machineId { return client.profiles[machineId] }
        return available.first.flatMap { client.profiles[$0.id] }
    }

    var body: some View {
        Group {
            if let profile {
                ScrollView {
                    VStack(alignment: .leading, spacing: Theme.s5) {
                        header(profile)
                        archetypeCard(profile)
                        metaRow(profile)
                        scoresCard(profile)
                        cadenceCard(profile)
                        leaderboards(profile)
                        footer(profile)
                    }
                    .padding(Theme.s4)
                    .frame(maxWidth: Theme.readingWidth, alignment: .leading)
                    .frame(maxWidth: .infinity)
                }
            } else {
                VStack(spacing: Theme.s2) {
                    Image(systemName: "gauge")
                        .font(.system(size: 28))  // бокс глифа
                        .foregroundStyle(Theme.drawerSecondary)
                    Text("Статистика пока не готова")
                        .font(SettingsStyle.emphasis).foregroundStyle(Theme.textMuted)
                    Text("Она появится после подключения устройства с историей сессий.")
                        .font(SettingsStyle.caption).foregroundStyle(Theme.drawerSecondary)
                        .multilineTextAlignment(.center)
                }
                .padding(Theme.s6)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .background(Theme.settingsBackground)
    }

    // MARK: Секции

    /// Шапка таба — не заголовок экрана: слово «Профиль» уже написано на чипе,
    /// по которому сюда нажали. Здесь стоит то, чего чип сказать не может: чья
    /// это машина и когда счёт последний раз пересчитывался.
    private func header(_ p: BuilderProfile) -> some View {
        VStack(alignment: .leading, spacing: Theme.s2) {
            Text("посчитан \(RelTime.short(p.generatedAt)) · \(Int(p.transcriptsScanned)) транскриптов")
                .font(SettingsStyle.caption).foregroundStyle(Theme.drawerSecondary)
            if available.count > 1 {
                FolderChipRow(items: available.map { MachinePick(id: $0.id, name: $0.name) }) { pick in
                    FolderChip(title: pick.name,
                               active: (machineId ?? available.first?.id) == pick.id) {
                        machineId = pick.id
                    }
                }
                // Ряд чипов ездит вбок сам и ест горизонтальные отступы карточки —
                // поэтому он вынесен из общей меры и выровнен своей.
                .padding(.horizontal, -Theme.s4)
            } else {
                Text(p.machine).font(SettingsStyle.body).foregroundStyle(Theme.textMuted)
            }
        }
    }

    private struct MachinePick: Identifiable { let id: String; let name: String }

    private func archetypeCard(_ p: BuilderProfile) -> some View {
        VStack(alignment: .leading, spacing: Theme.s2) {
            SettingsSectionHeader(text: "Архетип")
            Text(p.archetype.primary)
                .font(SettingsStyle.metric).foregroundStyle(Theme.text)
            if !p.archetype.badges.isEmpty {
                // Бейджи переносятся, а не уезжают за край: их бывает четыре, и
                // на 375 с крупным шрифтом третий уже не помещался.
                WrapRow(spacing: Theme.s2) {
                    ForEach(p.archetype.badges, id: \.self) { Chip(text: $0, mono: false) }
                }
            }
        }
        .padding(Theme.s4)
        .frame(maxWidth: .infinity, alignment: .leading)
        .settingsCard()
    }

    private func metaRow(_ p: BuilderProfile) -> some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: metricWidth), spacing: Theme.s3)],
                  alignment: .leading, spacing: Theme.s3) {
            metric("\(Int(p.sessions))", "сессий")
            metric("\(Int(p.messages.user + p.messages.assistant))", "сообщений")
            metric("\(Int(p.span.activeDays))", "активных дней")
            metric("\(Int(p.span.longestStreakDays))", "дней подряд")
            metric("\(Int(p.cadence.nightOwlShare * 100))%", "ночной работы")
        }
    }

    /// Одно большое ЧИСЛО на плитке — верхняя ступень лестницы; подпись под ним
    /// прозой, а не моно: моно здесь носит данные, а это имя данных.
    private func metric(_ value: String, _ label: String) -> some View {
        VStack(alignment: .leading, spacing: Theme.s1) {
            Text(value)
                .font(SettingsStyle.metric).foregroundStyle(Theme.text)
                .monospacedDigit().lineLimit(1).minimumScaleFactor(0.7)
            Text(label).font(SettingsStyle.caption).foregroundStyle(Theme.drawerSecondary)
                .lineLimit(2, reservesSpace: true)
        }
        .padding(Theme.s3)
        .frame(maxWidth: .infinity, alignment: .leading)
        .settingsCard()
    }

    private func scoresCard(_ p: BuilderProfile) -> some View {
        VStack(alignment: .leading, spacing: Theme.s3) {
            SettingsSectionHeader(text: "Оценки")
            scoreBar("Управление", p.scores.steering)
            scoreBar("Выполнение", p.scores.execution)
            scoreBar("Разработка", p.scores.engineering)
            scoreBar("Планирование", p.scores.planning)
            scoreBar("Продукт", p.scores.product, caveat: "оценка по интерфейсу и документации")
        }
        .padding(Theme.s4)
        .frame(maxWidth: .infinity, alignment: .leading)
        .settingsCard()
    }

    /// Подпись, шкала, число. Оговорка живёт ПОД строкой: в строке она отнимала
    /// у шкалы половину ширины, и полоса переставала быть шкалой.
    private func scoreBar(_ title: String, _ value: Double, caveat: String? = nil) -> some View {
        VStack(alignment: .leading, spacing: Theme.s1) {
            HStack(spacing: Theme.s2) {
                Text(title).font(SettingsStyle.caption).foregroundStyle(Theme.textMuted)
                Spacer(minLength: Theme.s2)
                Text(String(format: "%.1f", value))
                    .font(SettingsStyle.caption.weight(.semibold)).foregroundStyle(Theme.text)
                    .monospacedDigit().fixedSize()
            }
            ProgressView(value: min(10, max(0, value)), total: 10).tint(Theme.action)
            if let caveat {
                Text(caveat).font(SettingsStyle.caption).foregroundStyle(Theme.drawerSecondary)
            }
        }
    }

    private func cadenceCard(_ p: BuilderProfile) -> some View {
        VStack(alignment: .leading, spacing: Theme.s3) {
            SettingsSectionHeader(text: "Ритм")
            // Рядом в широком окне, стопкой на телефоне. `minWidth` на
            // горизонтальном варианте — то, что заставляет `ViewThatFits`
            // выбирать: гибкие гистограммы сообщают крошечную идеальную ширину,
            // и без порога строка «влезала» в любой экран.
            ViewThatFits(in: .horizontal) {
                HStack(alignment: .top, spacing: Theme.s5) {
                    hourBlock(p)
                    weekBlock(p).frame(width: 220)
                }
                .frame(minWidth: 520)
                VStack(alignment: .leading, spacing: Theme.s3) {
                    hourBlock(p)
                    weekBlock(p)
                }
            }
            Text("в среднем \(Int(p.cadence.avgSessionMessages)) сообщений · \(Int(p.cadence.avgSessionMinutes)) мин на сессию")
                .font(SettingsStyle.caption).foregroundStyle(Theme.drawerSecondary)
        }
        .padding(Theme.s4)
        .frame(maxWidth: .infinity, alignment: .leading)
        .settingsCard()
    }

    private func hourBlock(_ p: BuilderProfile) -> some View {
        VStack(alignment: .leading, spacing: Theme.s1) {
            SettingsSectionHeader(text: "По часам")
            histogram(p.cadence.hourHistogram, height: 44)
            HStack {
                Text("0").font(SettingsStyle.caption).foregroundStyle(Theme.drawerSecondary)
                Spacer()
                Text("12").font(SettingsStyle.caption).foregroundStyle(Theme.drawerSecondary)
                Spacer()
                Text("23").font(SettingsStyle.caption).foregroundStyle(Theme.drawerSecondary)
            }
        }
    }

    private func weekBlock(_ p: BuilderProfile) -> some View {
        VStack(alignment: .leading, spacing: Theme.s1) {
            SettingsSectionHeader(text: "По дням недели")
            histogram(p.cadence.weekdayHistogram, height: 44)
            HStack {
                ForEach(["вс", "пн", "вт", "ср", "чт", "пт", "сб"], id: \.self) { d in
                    Text(d).font(SettingsStyle.caption).foregroundStyle(Theme.drawerSecondary)
                        .frame(maxWidth: .infinity)
                }
            }
        }
    }

    /// Столбики с КВАДРАТНЫМИ концами, зазор 2 — прибор, а не украшение.
    private func histogram(_ values: [Double], height: CGFloat) -> some View {
        let peak = max(values.max() ?? 1, 1)
        return HStack(alignment: .bottom, spacing: 2) {
            ForEach(Array(values.enumerated()), id: \.offset) { _, v in
                Rectangle()
                    .fill(v > 0 ? Theme.action : Theme.chip)
                    .frame(height: max(2, height * CGFloat(v / peak)))
                    .frame(maxWidth: .infinity)
            }
        }
        .frame(height: height, alignment: .bottom)
        .accessibilityHidden(true)
    }

    private func leaderboards(_ p: BuilderProfile) -> some View {
        let topTools = p.tools.counts.sorted { $0.value > $1.value }.prefix(8)
            .map { NamedCount(name: $0.key, count: $0.value) }
        let topModels = p.models.histogram.sorted { $0.value > $1.value }.prefix(6)
            .map { NamedCount(name: $0.key, count: $0.value) }
        return LazyVGrid(columns: [GridItem(.adaptive(minimum: 280), spacing: Theme.s3)],
                         alignment: .leading, spacing: Theme.s3) {
            board("Инструменты", rows: topTools)
            board("Языки", rows: Array(p.engineering.topLanguages.prefix(8)))
            board("Модели", rows: topModels)
            board("Скиллы", rows: Array(p.planning.topSkills.prefix(8)))
        }
    }

    private func board(_ title: String, rows: [NamedCount]) -> some View {
        VStack(alignment: .leading, spacing: Theme.s2) {
            SettingsSectionHeader(text: title)
            if rows.isEmpty {
                Text("нет данных").font(SettingsStyle.caption).foregroundStyle(Theme.drawerSecondary)
            } else {
                let peak = max(rows.map(\.count).max() ?? 1, 1)
                ForEach(rows, id: \.name) { row in
                    HStack(spacing: Theme.s2) {
                        Text(row.name).font(SettingsStyle.caption).foregroundStyle(Theme.textMuted)
                            .lineLimit(1).truncationMode(.middle)
                            .frame(width: 104, alignment: .leading)
                        GeometryReader { geo in
                            Rectangle()
                                .fill(Theme.avatarPalette[avatarIdx(title)].bg)
                                .frame(width: max(2, geo.size.width * CGFloat(row.count / peak)))
                                .frame(maxHeight: .infinity, alignment: .center)
                        }
                        .frame(height: 8)
                        Text("\(Int(row.count))")
                            .font(SettingsStyle.caption).foregroundStyle(Theme.drawerSecondary)
                            .monospacedDigit()
                            .frame(width: 44, alignment: .trailing)
                    }
                }
            }
        }
        .padding(Theme.s4)
        .frame(maxWidth: .infinity, alignment: .leading)
        .settingsCard()
    }

    private func footer(_ p: BuilderProfile) -> some View {
        HStack(alignment: .top, spacing: Theme.s2) {
            Image(systemName: "lock")
                .font(.system(size: 12))  // бокс глифа
                .foregroundStyle(Theme.drawerSecondary)
            Text("Профиль считается локально на «\(p.machine)» из её собственных транскриптов; наружу уходят только эти агрегаты. План-режим в \(Int(p.planning.planModeShare * 100))% сессий, TodoWrite в \(Int(p.planning.todoShare * 100))%.")
                .font(SettingsStyle.caption).foregroundStyle(Theme.drawerSecondary)
        }
        .padding(Theme.s3)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.surfaceSunken,
                    in: RoundedRectangle(cornerRadius: Theme.radiusMd, style: .continuous))
    }
}
