#if DEBUG
import SwiftUI
import CCRemoteKit

// ============================================================================
// Витрина дизайн-системы — DEBUG-экран, на котором её принимают и по которому
// ловят регрессии в следующих фазах.
//
// Зачем он существует. Токен нельзя проверить чтением: `Font.custom` на
// неизвестном имени молча отдаёт системный SF, цвет с недостаточным контрастом
// выглядит нормально, пока не встанет рядом с фоном своей темы, а квадратная
// метка отличается от круглой на восьми пикселях. Всё это видно только глазами
// и только рядом друг с другом.
//
// Поэтому экран устроен как сверка, а не как каталог: там, где ошибка
// молчаливая, рядом стоит эталон, с которым результат должен НЕ совпасть
// (системный SF под строкой Onest) или совпасть (кадры пульса).
//
// Открывается `CC_GALLERY=1` в окружении запуска. Не выбрасывать: следующие
// фазы принимают вёрстку его скриншотами.
// ============================================================================

struct GalleryView: View {
    /// Открыт ли демонстрационный продуктовый лист (`CC_GALLERY=sheet`).
    @State private var sheetShown = false

    /// Разбор переменной окружения. Минимальный намеренно: полный набор
    /// launch-аффордансов — фаза 2, но галерею нечем принять, если в неё нет
    /// входа уже сейчас.
    ///
    /// `CC_GALLERY=1` — вся витрина; `CC_GALLERY=<секция>` — одна секция на
    /// весь экран. Второе не удобство, а условие приёмки: скриншот снимает
    /// ВИДИМЫЙ кадр, а витрина в несколько экранов длиной, и прокрутить её
    /// снаружи нечем. Посекционная съёмка заодно делает диф следующих фаз
    /// читаемым — меняется одна картинка, а не длина всего полотна.
    /// `CC_GALLERY=…` остаётся рабочим (его уже знают скрипты фазы 1), но
    /// `CC_SCREEN=gallery` — тот же запрос в семье новых имён.
    static var isRequested: Bool {
        LaunchAffordances.current.screen == .gallery
    }

    private static var requestedSection: String {
        ProcessInfo.processInfo.environment["CC_GALLERY"] ?? "1"
    }

    /// Ключи для `CC_GALLERY=<секция>`.
    private var sections: [(key: String, view: AnyView)] {
        [("voices", AnyView(voices)),
         ("type", AnyView(typeLadder)),
         ("roles", AnyView(colourRoles)),
         ("here", AnyView(hereVersusSelected)),
         ("surfaces", AnyView(surfaces)),
         ("status", AnyView(statusMarks)),
         ("primitives", AnyView(primitives)),
         ("semantics", AnyView(semantics)),
         ("geometry", AnyView(geometry)),
         ("sheet", AnyView(productSheetDemo))]
    }

    private var visible: [(key: String, view: AnyView)] {
        let want = Self.requestedSection
        let picked = sections.filter { $0.key == want }
        return picked.isEmpty ? sections : picked
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.s6) {
                header
                ForEach(visible, id: \.key) { $0.view }
            }
            .padding(Theme.s4)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .background(Theme.bg)
        .onAppear {
            // Витрина не зависит от хаба вообще: она «устоялась» в тот момент,
            // когда нарисовалась. Без этого харнес ждал бы сокет, которого здесь
            // нет, и помечал готовый кадр как несостоявшийся.
            HarnessSignals.settled("gallery")
        }
    }

    // MARK: Шапка

    private var header: some View {
        VStack(alignment: .leading, spacing: Theme.s2) {
            HStack(spacing: Theme.s3) {
                HegaiMark(size: 28)
                Text("Дизайн-система")
                    .font(.ui(Theme.sizePage, weight: .semibold))
                    .tracking(Theme.track(Theme.lsTitle, Theme.sizePage))
                    .foregroundStyle(Theme.text)
            }
            Text("Hegai Code — a.test в плотном control plane")
                .font(.ui(Theme.sizeSmall))
                .foregroundStyle(Theme.textMuted)
        }
    }

    // MARK: Три голоса

    private var voices: some View {
        Section(eyebrow: "Три голоса") {
            VStack(alignment: .leading, spacing: Theme.s3) {
                voice("Onest — структура", Text(Self.pangram).font(.ui(Theme.sizeBody)))
                voice("Onest 500 — кнопки и акцент",
                      Text(Self.pangram).font(.ui(Theme.sizeBody, weight: .semibold)))
                voice("IBM Plex Mono — данные",
                      Text("09:05 · 128 сессий · ~/hegainews/deploy").font(.mono(Theme.sizeMeta)))
                voice("Source Serif 4 italic — человеческий голос",
                      Text("Кажется, я понял, в чём дело.").font(.serif(Theme.sizeCard)))

                Divider().background(Theme.divider)

                // Эталон для сверки. Если Onest не зарегистрировался, СТРОКА ВЫШЕ
                // и эта станут неотличимы — а иначе подмена на SF не видна вообще
                // ничем: ни ошибкой, ни предупреждением, ни падением.
                voice("системный SF — строка сверки, она обязана ОТЛИЧАТЬСЯ",
                      Text(Self.pangram).font(.system(size: Theme.sizeBody)))
            }
        }
    }

    private static let pangram = "Съешь ещё этих мягких французских булок"

    private func voice(_ label: String, _ sample: Text) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label)
                .font(.mono(Theme.sizeNano, weight: .medium))
                .tracking(Theme.track(Theme.lsCaps, Theme.sizeNano))
                .foregroundStyle(Theme.textFaint)
            sample.foregroundStyle(Theme.text)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    // MARK: Лестница типов

    private var typeLadder: some View {
        Section(eyebrow: "Лестница типов") {
            VStack(alignment: .leading, spacing: Theme.s3) {
                ladderStep("screen", 28, .ui(Theme.sizeScreen, weight: .semibold))
                ladderStep("page", 24, .ui(Theme.sizePage, weight: .semibold))
                ladderStep("title", 20, .ui(Theme.sizeTitle, weight: .semibold))
                ladderStep("lead", 18, .ui(Theme.sizeLead))
                ladderStep("card", 17, .ui(Theme.sizeCard))
                ladderStep("body", 16, .ui(Theme.sizeBody))
                ladderStep("small", 14.5, .ui(Theme.sizeSmall))
                ladderStep("meta", 13, .mono(Theme.sizeMeta))
                ladderStep("micro", 12, .mono(Theme.sizeMicro))
                Text("nano 10 — только глиф в квадратном боксе, не ступень текста")
                    .font(.ui(Theme.sizeMeta))
                    .foregroundStyle(Theme.textFaint)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private func ladderStep(_ name: String, _ size: CGFloat, _ font: Font) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: Theme.s3) {
            Text("\(name) \(size.clean)")
                .font(.mono(Theme.sizeNano))
                .foregroundStyle(Theme.textFaint)
                .frame(width: 74, alignment: .leading)
            Text("Сессия как запись")
                .font(font)
                .foregroundStyle(Theme.text)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    // MARK: Четыре роли цвета

    private var colourRoles: some View {
        Section(eyebrow: "Четыре роли цвета") {
            VStack(alignment: .leading, spacing: Theme.s3) {
                // Кнопка. Чернила с ivory — на заливках зелёного нет.
                WrapRow(spacing: Theme.s2) {
                    Text("Новая сессия")
                        .font(.ui(Theme.sizeSmall, weight: .semibold))
                        .foregroundStyle(Theme.onAction)
                        .padding(.horizontal, Theme.s4)
                        .frame(minHeight: 40)
                        .background(Theme.action,
                                    in: RoundedRectangle(cornerRadius: Theme.radiusMd, style: .continuous))
                    SendCircle(enabled: true) {}
                    SendCircle(enabled: false) {}
                    SendCircle(stop: true) {}
                    ActionFAB {}
                }
                caption("action / onAction — только кнопки; ivory на чернилах 15.8:1")

                // Круги композера — отдельная роль, бургунди (08.10.2026).
                WrapRow(spacing: Theme.s2) {
                    SendCircle(round: true, size: Theme.composerActionSize) {}
                    SendCircle(round: true, enabled: false, size: Theme.composerActionSize) {}
                    SendCircle(round: true, stop: true, size: Theme.composerActionSize) {}
                    Text("Чат")
                        .font(.ui(Theme.sizeSmall, weight: .semibold))
                        .foregroundStyle(Theme.onDrawerCreateAction)
                        .padding(.horizontal, Theme.s4)
                        .frame(minHeight: 36)
                        .background(Theme.drawerCreateAction, in: Capsule())
                }
                caption("composerAction / drawerCreateAction — отправка, стоп, «Чат»; белый 9.2:1")

                WrapRow(spacing: Theme.s2) {
                    swatch("action", Theme.action, ink: Theme.onAction)
                    swatch("select", Theme.select, ink: Theme.onSelect)
                    swatch("attn", Theme.attn, ink: Theme.onAttn)
                    swatch("live", Theme.live, ink: Theme.onLive)
                }
                caption("на ember — только ink: ivory на нём 2.7:1")

                WrapRow(spacing: Theme.s2) {
                    SectionLabel(text: "Секция")
                    SectionLabel(text: "С счётчиком", count: 12)
                    SectionLabel(text: "Без точки — не секция", eyebrow: false)
                }
                caption("eyebrow: моно-капс + квадрат 8×8. Точка метит СЕКЦИЮ, не подпись поля")
            }
        }
    }

    // MARK: «Ты здесь» против «выбрано»

    private var hereVersusSelected: some View {
        Section(eyebrow: "«Ты здесь» ≠ «выбрано»") {
            VStack(alignment: .leading, spacing: Theme.s2) {
                fakeRow(here: false, selected: false)
                fakeRow(here: true, selected: false)
                fakeRow(here: false, selected: true)
                caption("подложка 9% (14% в тёмной) — дети остаются своего цвета; "
                        + "сплошная плашка перекрашивает их все")
            }
        }
    }

    /// Строка списка ровно настолько, чтобы показать разницу: у подложки
    /// «ты здесь» время и бейдж держат свой цвет, у плашки выбора — нет.
    private func fakeRow(here: Bool, selected: Bool) -> some View {
        HStack(spacing: Theme.s3) {
            LeadStatusDot(live: true, working: false, selected: selected)
            VStack(alignment: .leading, spacing: 1) {
                Text(here ? "ты здесь — подложка" : selected ? "выбрано — плашка" : "обычная строка")
                    .font(.ui(Theme.sizeSmall, weight: here || selected ? .semibold : .regular))
                    .selectedInk(selected, normal: Theme.text)
                Text("vps-box-1 · 12 мин")
                    .font(.mono(Theme.sizeMeta))
                    .selectedInk(selected, normal: Theme.textFaint)
            }
            Spacer(minLength: Theme.s2)
            UnreadBadge(count: 3)
        }
        .padding(.horizontal, Theme.s3)
        .padding(.vertical, Theme.s2)
        .hereTint(here)
        .selectionPlate(selected)
    }

    // MARK: Поверхности

    private var surfaces: some View {
        Section(eyebrow: "Поверхности") {
            VStack(alignment: .leading, spacing: Theme.s3) {
                WrapRow(spacing: Theme.s2) {
                    swatch("bg", Theme.bg, ink: Theme.text, bordered: true)
                    swatch("surface", Theme.surface, ink: Theme.text, bordered: true)
                    swatch("raised", Theme.surfaceRaised, ink: Theme.text, bordered: true)
                    swatch("sunken", Theme.surfaceSunken, ink: Theme.text, bordered: true)
                    swatch("chip", Theme.chip, ink: Theme.text, bordered: true)
                    swatch("here", Theme.here, ink: Theme.text, bordered: true)
                }
                VStack(alignment: .leading, spacing: Theme.s1) {
                    Text("Карточка без границы")
                        .font(.ui(Theme.sizeCard, weight: .semibold))
                        .foregroundStyle(Theme.text)
                    Text("отделяет тень, а в тёмной теме — внутренняя кромка rim")
                        .font(.ui(Theme.sizeMeta))
                        .foregroundStyle(Theme.textMuted)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(Theme.s4)
                .frame(maxWidth: .infinity, alignment: .leading)
                .card()
            }
        }
    }

    // MARK: Статусные метки и пульс

    private var statusMarks: some View {
        Section(eyebrow: "Статус — квадрат 8×8") {
            VStack(alignment: .leading, spacing: Theme.s3) {
                WrapRow(spacing: Theme.s4) {
                    markSample("idle", LeadStatusDot(live: false))
                    markSample("live", LeadStatusDot(live: true))
                    markSample("working", LeadStatusDot(live: true, working: true))
                    markSample("attn", Rectangle().fill(Theme.attn)
                        .frame(width: Theme.statusDot, height: Theme.statusDot)
                        .clipShape(RoundedRectangle(cornerRadius: Theme.statusDotRadius)))
                }

                // Пульс — это ДВИЖЕНИЕ, и неподвижный скриншот его не поймает.
                // Поэтому рядом с живой меткой стоят оба её кадра: если пульса
                // нет, живая метка совпадёт с левым кадром и не отличится ни от
                // чего. Так состояние проверяемо и на стоп-кадре.
                WrapRow(spacing: Theme.s4) {
                    markSample("пульс", LeadStatusDot(live: true, working: true))
                    markSample("кадр 1.0", staticMark(opacity: 1))
                    markSample("кадр 0.35", staticMark(opacity: 0.35))
                }
                caption("«идёт прогон» говорит пульс, а не оттенок — ember здесь занят вниманием")

                WrapRow(spacing: Theme.s2) {
                    StatusPill(state: .working)
                    StatusPill(state: .needs_attention)
                    StatusPill(state: .idle)
                    StatusPill(state: .error)
                }
            }
        }
    }

    private func staticMark(opacity: Double) -> some View {
        RoundedRectangle(cornerRadius: Theme.statusDotRadius, style: .continuous)
            .fill(Theme.live)
            .frame(width: Theme.statusDot, height: Theme.statusDot)
            .opacity(opacity)
    }

    private func markSample(_ label: String, _ mark: some View) -> some View {
        VStack(spacing: Theme.s1) {
            mark.frame(height: Theme.statusDot)
            Text(label)
                .font(.mono(Theme.sizeNano))
                .foregroundStyle(Theme.textFaint)
        }
    }

    // MARK: Примитивы

    private var primitives: some View {
        Section(eyebrow: "Примитивы") {
            VStack(alignment: .leading, spacing: Theme.s3) {
                WrapRow(spacing: Theme.s2) {
                    ForEach(["Аврора", "Бета", "Гамма", "Дельта"], id: \.self) { name in
                        Avatar(seed: name, label: name, size: Theme.avatarList)
                    }
                    Avatar(seed: "Аврора", label: "Аврора", size: Theme.avatarList,
                           online: true, pulsing: true)
                }
                caption("четыре плоских тона, угол 28% — не круг и не градиент")

                WrapRow(spacing: Theme.s2) {
                    UnreadBadge(count: 3)
                    UnreadBadge(count: 128)
                    LiveBadge()
                    CodexBadge(active: true)
                    Chip(text: "main", systemImage: "arrow.triangle.branch")
                    Chip(text: "рамблинг", color: Theme.catRambling, mono: false)
                }

                WrapRow(spacing: Theme.s2) {
                    FolderChip(title: "Список", count: 125, active: true) {}
                    FolderChip(title: "Flow", count: 8, active: false) {}
                    FolderChip(title: "Колонки", active: false) {}
                }
                caption("пилюля лицензирована тегу, бейджу и АКТИВНОМУ фильтр-чипу")

                TranscriptDivider(label: "сегодня")

                WrapRow(spacing: Theme.s3) {
                    ScrollToBottomButton {}
                    HegaiMark(size: 32)
                    HegaiMark(size: 24, mono: Theme.text)
                }
            }
        }
    }

    // MARK: Семантика

    private var semantics: some View {
        Section(eyebrow: "Семантика") {
            VStack(alignment: .leading, spacing: Theme.s3) {
                WrapRow(spacing: Theme.s2) {
                    tone("positive", Theme.positive)
                    tone("negative", Theme.negative)
                    tone("orangeText", Theme.orangeText)
                    tone("link", Theme.link)
                    tone("brand", Theme.brand)
                }
                caption("зелёный — git/success/live, ember — акцент и внимание")

                WrapRow(spacing: Theme.s2) {
                    tone("code", Theme.ftypeCode)
                    tone("doc", Theme.ftypeDoc)
                    tone("media", Theme.ftypeMedia)
                    tone("data", Theme.ftypeData)
                }
                caption("тона типов файлов — каждый измерен против канвы СВОЕЙ темы")

                Text("Ошибка: не удалось прочитать файл")
                    .font(.ui(Theme.sizeMeta, weight: .medium))
                    .foregroundStyle(Theme.textOnColor)
                    .padding(.horizontal, Theme.s3)
                    .padding(.vertical, Theme.s2)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Theme.red,
                                in: RoundedRectangle(cornerRadius: Theme.radiusMd, style: .continuous))
            }
        }
    }

    // MARK: Геометрия

    private var geometry: some View {
        Section(eyebrow: "Геометрия") {
            VStack(alignment: .leading, spacing: Theme.s3) {
                WrapRow(spacing: Theme.s2) {
                    radiusSample("8", Theme.radiusSm)
                    radiusSample("12", Theme.radiusMd)
                    radiusSample("16", Theme.radiusLg)
                    radiusSample("20", Theme.radiusXl)
                    radiusSample("999", Theme.pill)
                    radiusSample("48", Theme.radiusDevice)
                }
                caption("лестница 8/12/16/20/999 плюс radiusDevice 48 — угол самого телефона, "
                        + "не ступень лестницы")

                HStack(alignment: .bottom, spacing: Theme.s2) {
                    ForEach([Theme.s1, Theme.s2, Theme.s3, Theme.s4, Theme.s5, Theme.s6, Theme.s8],
                            id: \.self) { step in
                        VStack(spacing: Theme.s1) {
                            Rectangle()
                                .fill(Theme.brand)
                                .frame(width: step, height: step)
                            Text("\(Int(step))")
                                .font(.mono(Theme.sizeNano))
                                .foregroundStyle(Theme.textFaint)
                        }
                    }
                }
                caption("сетка 4 / 8")
            }
        }
    }

    // MARK: Мелочи витрины

    private func swatch(_ name: String, _ fill: Color, ink: Color, bordered: Bool = false) -> some View {
        Text(name)
            .font(.mono(Theme.sizeNano, weight: .medium))
            .foregroundStyle(ink)
            .padding(.horizontal, Theme.s3)
            .frame(minWidth: 68, minHeight: 40)
            .background(fill, in: RoundedRectangle(cornerRadius: Theme.radiusSm, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: Theme.radiusSm, style: .continuous)
                    .strokeBorder(bordered ? Theme.divider : .clear, lineWidth: 1)
            )
    }

    private func tone(_ name: String, _ color: Color) -> some View {
        HStack(spacing: Theme.s1) {
            RoundedRectangle(cornerRadius: Theme.statusDotRadius, style: .continuous)
                .fill(color)
                .frame(width: Theme.statusDot, height: Theme.statusDot)
            Text(name)
                .font(.mono(Theme.sizeMeta))
                .foregroundStyle(color)
        }
    }

    private func radiusSample(_ label: String, _ radius: CGFloat) -> some View {
        VStack(spacing: Theme.s1) {
            RoundedRectangle(cornerRadius: radius, style: .continuous)
                .fill(Theme.chip)
                .frame(width: 44, height: 44)
            Text(label)
                .font(.mono(Theme.sizeNano))
                .foregroundStyle(Theme.textFaint)
        }
    }

    private func caption(_ text: String) -> some View {
        Text(text)
            .font(.ui(Theme.sizeMeta))
            .foregroundStyle(Theme.textFaint)
            .fixedSize(horizontal: false, vertical: true)
    }

    /// Продуктовый лист — и единственный способ СНЯТЬ его в приёмке.
    ///
    /// Лист «О сессии» поднимается из открытого разговора, то есть из-за живого
    /// хаба: симулятор этой машины его не резолвит, а подделывать сессию ради
    /// одного кадра — это строить второй продукт. Витрина же ничего ни у кого
    /// не спрашивает, и лист в ней тот же самый, с тем же модификатором.
    ///
    /// `CC_GALLERY=sheet` открывает его сразу: снять надо не кнопку, а то, что
    /// над ней, — панель, затемнение позади и пустой слой сверху, тап по
    /// которому закрывает.
    private var productSheetDemo: some View {
        Section(eyebrow: "Лист, закрываемый тапом снаружи") {
            VStack(alignment: .leading, spacing: Theme.s3) {
                Text("Панель занимает нижнюю долю экрана; всё, что выше неё, — "
                     + "слой с обработчиком тапа. Лист, которым принимают решение "
                     + "(подтверждение инструмента, вопрос), так НЕ поднимается.")
                    .font(.ui(Theme.sizeMeta)).foregroundStyle(Theme.textMuted)
                ActionButton("О сессии") { sheetShown = true }
            }
            .productSheet(isPresented: $sheetShown) {
                VStack(alignment: .leading, spacing: Theme.s3) {
                    SectionLabel(text: "О сессии")
                    Text("Факты о сессии: машина, проект, ветка, папка, дата.")
                        .font(.ui(Theme.sizeBody)).foregroundStyle(Theme.text)
                    Text("Тап по пустому месту выше закрывает.")
                        .font(.ui(Theme.sizeMeta)).foregroundStyle(Theme.textMuted)
                    Spacer(minLength: 0)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(Theme.s4)
            }
            .onAppear { if Self.requestedSection == "sheet" { sheetShown = true } }
        }
    }

    /// Секция витрины: eyebrow плюс содержимое.
    private struct Section<Content: View>: View {
        let eyebrow: String
        @ViewBuilder let content: () -> Content

        var body: some View {
            VStack(alignment: .leading, spacing: Theme.s3) {
                SectionLabel(text: eyebrow)
                content()
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

private extension CGFloat {
    /// «14.5» и «16», а не «14.5» и «16.0».
    var clean: String {
        self == rounded() ? String(Int(self)) : String(format: "%.1f", self)
    }
}
#endif
