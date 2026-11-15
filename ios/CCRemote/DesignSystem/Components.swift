import SwiftUI
import CCRemoteKit

// ============================================================================
// Примитивы дизайн-системы. Канон — DESIGN.md.
//
// Что здесь держится и ломается молча, если не держать:
//
//   * Прямоугольники, никогда не круги. Каждая статусная метка — КВАДРАТ 8×8
//     с радиусом 2: круглая точка читается как HUD игры, квадратная — как
//     прибор, а это прибор. Иконочные кнопки — квадраты радиусом 12.
//   * Пилюля лицензирована ровно трём: тег, бейдж, АКТИВНЫЙ фильтр-чип.
//   * Eyebrow помечает СЕКЦИЮ, никогда не подпись поля — иначе самый
//     узнаваемый мотив системы превращается в обои.
//   * «Идёт прогон» говорит ПУЛЬС, а не оттенок.
//   * Градиентов нет; аватар — плоский тон с углом 28%.
// ============================================================================

// MARK: - Идентичность

/// Индекс тона аватара — четвёрка, привязанная к имени, чтобы сессия держала
/// свой цвет через любые пересортировки списка. Порт `avatarIdx` из
/// `web/src/lib.ts` (`h = h*31 + charCode`, беззнаковый, `% 4`).
func avatarIdx(_ name: String) -> Int {
    var h: UInt32 = 0
    for scalar in name.unicodeScalars {
        h = h &* 31 &+ UInt32(truncatingIfNeeded: scalar.value)
    }
    return Int(h % 4)
}

func initialOf(_ name: String?) -> String {
    guard let c = name?.trimmingCharacters(in: .whitespacesAndNewlines).first else { return "?" }
    return String(c).uppercased()
}

// `cleanTitle` живёт в CCRemoteKit (Protocol/CleanTitle.swift): сокет применяет
// его на приёме, поэтому он обязан компилироваться без UI-фреймворка.

/// Аватар сессии: плоская плашка тона с углом 28% и инициалом заголовка.
/// `seed` выбирает тон (проект или заголовок — что-то стабильное), `label`
/// даёт букву.
///
/// Не круг и не градиент: в системе нет ни того, ни другого. Чернила берутся
/// из ПАРЫ самого тона, поэтому каждый аватар — измеренный контраст, а не белое
/// поверх того, чем случайно кончился градиент.
struct Avatar: View {
    let seed: String
    let label: String?
    var size: CGFloat = Theme.avatarList
    var online: Bool = false
    /// Пульс метки — только для прогона, который действительно идёт.
    var pulsing: Bool = false
    /// Кегль буквы; по умолчанию 40% плашки. Это БОКС, а не ступень лестницы:
    /// глиф внутри фиксированного квадрата — единственное, чему позволено
    /// жить мимо неё.
    var labelSize: CGFloat? = nil

    private var tone: (bg: Color, fg: Color) { Theme.avatarPalette[avatarIdx(seed)] }

    var body: some View {
        RoundedRectangle(cornerRadius: size * Theme.avatarCornerRatio, style: .continuous)
            .fill(tone.bg)
            .frame(width: size, height: size)
            .overlay(
                Text(initialOf(label))
                    .font(.ui(labelSize ?? size * 0.4, weight: .semibold))
                    .foregroundStyle(tone.fg)
            )
            .overlay(alignment: .bottomTrailing) {
                if online { OnlineDot(online: true, pulsing: pulsing).offset(x: 2, y: 2) }
            }
            .accessibilityHidden(true)
    }
}

// MARK: - Статусные метки
//
// Одна геометрия на все: квадрат 8×8, радиус 2. Отличаются они не формой и не
// оттенком, а тем, ЧТО стоит за меткой — поэтому «идёт» здесь анимация.

/// Метка живого прогона поверх аватара: квадрат в кольце цвета поверхности,
/// чтобы читался на любом тоне под ним.
///
/// Цвет — тон ТЕКСТА (ink в светлой, ivory в тёмной), а не салатовый: `--live`
/// был самым частым зелёным в продукте, по квадрату на строку. Ember сюда
/// брать нельзя — ember означает «нужно внимание», и оба состояния стоят в
/// одной колонке.
struct OnlineDot: View {
    var online: Bool = true
    var pulsing: Bool = false
    var size: CGFloat = Theme.statusDot + 2

    var body: some View {
        RoundedRectangle(cornerRadius: Theme.statusDotRadius, style: .continuous)
            .fill(online ? Theme.live : Theme.textFaint)
            .frame(width: size, height: size)
            .overlay(
                RoundedRectangle(cornerRadius: Theme.statusDotRadius, style: .continuous)
                    .stroke(Theme.bg, lineWidth: 2)
            )
            .livePulse(pulsing)
            .accessibilityHidden(true)
    }
}

/// Знаки рантаймов. В сборках TestFlight (флаг `PROVIDER_MARKS`, см.
/// project.yml) — настоящие лого Claude и OpenAI, те же векторы Simple Icons,
/// что в вебе (`AgentMark.tsx`); вернули по просьбе владельца 31.10.2026.
/// Сборка для ревью App Store (`STORE_BUILD=1`) остаётся на своих знаках ниже:
/// с лого Apple отклоняла бету по 4.1(a).
///
/// Свои знаки (09.10.2026, по просьбе владельца: «посимпатичней, не
/// похожие на их лого»). Claude — тёплый четырёхлепестковый цветок: круглый и
/// мягкий, без лучей звезды; Codex — скруглённая плитка с вырезанной подсказкой
/// `>_`. Одноцветные шаблоны: цвет даёт роль (`claudeActivity`/`codexActivity`),
/// форма различает рантаймы и без цвета. Рисуются один раз на размер.
/// Inline attachments keep the symbol inside the title rather than a spare column.
struct SessionActivityIcon: View {
    let isCodex: Bool
    /// OpenCode Go: a Codex thread with its own mark (implies `isCodex`).
    var isOpenCode: Bool = false
    var size: CGFloat = 13

    @MainActor private static var cache: [String: UIImage] = [:]

    @MainActor static func mark(isCodex: Bool, isOpenCode: Bool = false, size: CGFloat) -> UIImage {
        let key = "\(isCodex)-\(isOpenCode)-\(size)"
        if let hit = cache[key] { return hit }
        if isOpenCode {
            let box = CGSize(width: size, height: size)
            #if PROVIDER_MARKS
            if let logo = UIImage(named: "AgentOpenCode") {
                let image = UIGraphicsImageRenderer(size: box).image { _ in
                    logo.draw(in: CGRect(origin: .zero, size: box))
                }.withRenderingMode(.alwaysTemplate)
                cache[key] = image
                return image
            }
            #endif
            // Store build (no third-party logos, 4.1(a)) or missing asset: a
            // neutral code glyph.
            let config = UIImage.SymbolConfiguration(pointSize: size * 0.85, weight: .semibold)
            let symbol = UIImage(systemName: "chevron.left.forwardslash.chevron.right", withConfiguration: config)?
                .withTintColor(.black, renderingMode: .alwaysOriginal)
            let image = UIGraphicsImageRenderer(size: box).image { _ in
                guard let symbol else { return }
                let k = min(box.width / symbol.size.width, box.height / symbol.size.height)
                let w = symbol.size.width * k, h = symbol.size.height * k
                symbol.draw(in: CGRect(x: (box.width - w) / 2, y: (box.height - h) / 2, width: w, height: h))
            }.withRenderingMode(.alwaysTemplate)
            cache[key] = image
            return image
        }
        #if PROVIDER_MARKS
        if let logo = UIImage(named: isCodex ? "AgentOpenAI" : "AgentClaude") {
            let box = CGSize(width: size, height: size)
            let image = UIGraphicsImageRenderer(size: box).image { _ in
                logo.draw(in: CGRect(origin: .zero, size: box))
            }.withRenderingMode(.alwaysTemplate)
            cache[key] = image
            return image
        }
        #endif
        // Знаки из макета — картинками в каталоге; рисованные пути ниже —
        // запасной вариант, если ассета вдруг нет.
        if let asset = UIImage(named: isCodex ? "CodexMark" : "ClaudeMark") {
            let box = CGSize(width: size, height: size)
            let image = UIGraphicsImageRenderer(size: box).image { _ in
                asset.draw(in: CGRect(origin: .zero, size: box))
            }.withRenderingMode(.alwaysTemplate)
            cache[key] = image
            return image
        }
        let box = CGSize(width: size, height: size)
        let image = UIGraphicsImageRenderer(size: box).image { context in
            let cg = context.cgContext
            UIColor.black.setFill()
            if isCodex {
                drawCodex(cg, size)
            } else {
                cg.addPath(claudePath(size))
                cg.fillPath(using: .winding)
            }
        }.withRenderingMode(.alwaysTemplate)
        cache[key] = image
        return image
    }

    /// Восемь лепестков-капель от центра: узкие у середины, круглые на концах.
    private static func claudePath(_ s: CGFloat) -> CGPath {
        let path = CGMutablePath()
        let c = s / 2
        for i in 0..<8 {
            let angle = CGFloat(i) * .pi / 4
            let t = CGAffineTransform(translationX: c, y: c).rotated(by: angle)
            // Капля: круглая головка на конце и сужение к центру. Точки
            // считаются руками — у всех лепестков один обход, и `.winding`
            // не вырезает пересечения.
            let head = s * 0.095, tipY = -s * 0.05, headY = -s * 0.36
            let petal = CGMutablePath()
            petal.move(to: CGPoint(x: 0, y: tipY))
            petal.addLine(to: CGPoint(x: head, y: headY))
            for k in 1...12 {
                let th = CGFloat(k) / 12 * .pi
                petal.addLine(to: CGPoint(x: head * cos(th), y: headY - head * sin(th)))
            }
            petal.closeSubpath()
            path.addPath(petal, transform: t)
        }
        return path
    }

    /// Три сцепленных крючка вокруг треугольного просвета — «узел» Codex.
    /// Каждый крючок — короткое плечо, полукруг и длинное плечо; повёрнуты
    /// через 120°. Под каждым — вырез чуть шире штриха (`.clear`), отсюда
    /// просветы «над/под» в местах сцепления.
    private static func codexHooks(_ s: CGFloat) -> [CGPath] {
        let r = s * 0.14, short = s * 0.06, long = s * 0.22, out = s * 0.16
        return (0..<3).map { i in
            let a = 0.3 + CGFloat(i) * 2 * .pi / 3
            let hook = CGMutablePath()
            hook.move(to: CGPoint(x: -r, y: short - out))
            hook.addLine(to: CGPoint(x: -r, y: -out))
            hook.addArc(center: CGPoint(x: 0, y: -out), radius: r, startAngle: .pi, endAngle: 2 * .pi, clockwise: false)
            hook.addLine(to: CGPoint(x: r, y: long - out))
            var t = CGAffineTransform(translationX: s / 2, y: s / 2).rotated(by: a)
            return hook.copy(using: &t) ?? hook
        }
    }

    private static func drawCodex(_ cg: CGContext, _ s: CGFloat) {
        let line = max(1.3, s * 0.08), gap = max(0.6, s * 0.03)
        cg.setLineCap(.round); cg.setLineJoin(.round)
        for hook in codexHooks(s) {
            cg.setBlendMode(.clear); cg.setLineWidth(line + 2 * gap)
            cg.addPath(hook); cg.strokePath()
            cg.setBlendMode(.normal); cg.setLineWidth(line)
            cg.setStrokeColor(UIColor.black.cgColor)
            cg.addPath(hook); cg.strokePath()
        }
    }

    @MainActor private static func image(isCodex: Bool, isOpenCode: Bool, size: CGFloat) -> Image {
        Image(uiImage: mark(isCodex: isCodex, isOpenCode: isOpenCode, size: size)).renderingMode(.template)
    }

    @MainActor static func title(_ title: String, active: Bool, isCodex: Bool, isOpenCode: Bool = false,
                                 enlarged: Bool = false) -> Text {
        guard active else { return Text(title) }
        // Keep the mark inline; the header uses a slightly larger optical box.
        let mark = Text(image(isCodex: isCodex, isOpenCode: isOpenCode, size: enlarged ? 16 : 13))
            .baselineOffset(enlarged ? -3 : -1.5)
            .foregroundColor(isCodex ? Theme.codexActivity : Theme.claudeActivity)
        return Text("\(mark)\u{2002}\(title)")
    }

    var body: some View {
        Self.image(isCodex: isCodex, isOpenCode: isOpenCode, size: size)
            .resizable().frame(width: size, height: size)
            .foregroundStyle(isCodex ? Theme.codexActivity : Theme.claudeActivity)
            .accessibilityLabel(isOpenCode ? "OpenCode работает" : isCodex ? "Codex работает" : "Claude работает")
    }
}

/// Ведущая статусная метка строки списка — то, что стоит на месте бывшего
/// аватара-буквы. Тон текста, пока прогон жив (с пульсом, пока он реально
/// работает), иначе приглушённая метка, чтобы у строки осталась ровная левая
/// колонка. Без кольца: она сидит на строке, а не поверх аватара.
///
/// `selected` — про СПЛОШНУЮ плашку настоящего выбора, где метка обязана
/// перевернуться в чернила плашки. Навигационное «ты здесь» (`Theme.here`) —
/// это тинт, дети на нём остаются своего цвета, и сюда его передавать НЕ надо.
struct LeadStatusDot: View {
    var live: Bool = false
    var working: Bool = false
    var selected: Bool = false

    private var fill: Color {
        if live || working { return selected ? Theme.onSelect : Theme.live }
        return selected ? Theme.onSelect.opacity(0.6) : Theme.textFaint.opacity(0.55)
    }

    var body: some View {
        RoundedRectangle(cornerRadius: Theme.statusDotRadius, style: .continuous)
            .fill(fill)
            .frame(width: Theme.statusDot, height: Theme.statusDot)
            .livePulse(working)
            .accessibilityHidden(true)
    }
}

/// Needs-attention как непрочитанное: ember-плашка, чернильные цифры.
/// Ivory на ember меряется 2.7:1, поэтому здесь только ink.
/// Пилюля лицензирована: это бейдж.
struct UnreadBadge: View {
    let count: Int
    var body: some View {
        Text(count > 99 ? "99+" : "\(count)")
            // nano — глиф в фиксированном боксе, а не ступень текста.
            .font(.ui(Theme.sizeNano, weight: .bold))
            .foregroundStyle(Theme.onAttn)
            .padding(.horizontal, 6)
            .frame(minWidth: Theme.unreadBadge, minHeight: Theme.unreadBadge)
            .background(Theme.attn, in: Capsule())
            // Озвучивалось «1 непрочитанных». Бейдж рисует «99+», но говорит
            // точное число, и на единице форма слышна.
            .accessibilityLabel(counted(count, "непрочитанное", "непрочитанных", "непрочитанных"))
    }
}

/// Статусная метка сама по себе: квадрат 8×8 с радиусом 2, цвет — снаружи.
///
/// Существует потому, что эта же четвёрка строк (`RoundedRectangle` + радиус +
/// заливка + `frame`) была скопирована в пяти местах — и в шестом оказалась
/// `Circle()`. Круг в списке машин отличить от квадрата на глаз почти нельзя,
/// поэтому правило «кругов нет» держится не взглядом, а тем, что метку неоткуда
/// нарисовать иначе.
struct StatusSquare: View {
    var color: Color
    var size: CGFloat = Theme.statusDot

    var body: some View {
        RoundedRectangle(cornerRadius: Theme.statusDotRadius, style: .continuous)
            .fill(color)
            .frame(width: size, height: size)
            .accessibilityHidden(true)
    }
}

/// Кнопка с настоящей заливкой — там, где до этого стоял стоковый `Button("…")`.
///
/// Стоковая кнопка берёт `tint` приложения (ember) и рисуется системным
/// текстом: «Выдать код», «Отозвать» и «Опубликовать» выглядели тремя
/// одинаковыми оранжевыми словами — без веса, без роли и без цели нажатия в 44.
/// Здесь роль названа явно:
///
///   `.primary` — заливка `action` (чернила с ivory). Главное действие карточки.
///   `.quiet`   — чип: второе действие рядом с главным.
///   `.danger`  — красный ТЕКСТ на чипе, а не красная заливка: отзыв и удаление
///                стоят в строках списка, и десять красных плашек подряд
///                читались бы как авария, а не как доступное действие.
struct ActionButton: View {
    enum Kind { case primary, quiet, danger }

    let title: String
    var systemImage: String? = nil
    var kind: Kind = .primary
    /// Во всю ширину — для главной кнопки карточки; иначе кнопка жмётся к тексту.
    var wide: Bool = false
    var enabled: Bool = true
    let action: () -> Void

    init(_ title: String, systemImage: String? = nil, kind: Kind = .primary,
         wide: Bool = false, enabled: Bool = true, action: @escaping () -> Void) {
        self.title = title
        self.systemImage = systemImage
        self.kind = kind
        self.wide = wide
        self.enabled = enabled
        self.action = action
    }

    /// Выключенная кнопка — чип с приглушённым ТЕКСТОМ, а не полупрозрачная
    /// заливка действия. `actionMuted` (35% чернил) задуман под ivory-СТРЕЛКУ
    /// композера; под словом он даёт ivory на светло-сером — «Выдать ссылку»
    /// читалось как пятно. Мера обязана держаться в обоих состояниях, а не
    /// только во включённом.
    private var ink: Color {
        guard enabled else { return Theme.textFaint }
        switch kind {
        case .primary: return Theme.onAction
        case .quiet: return Theme.text
        case .danger: return Theme.negative
        }
    }
    private var fill: Color {
        guard enabled else { return Theme.chip }
        switch kind {
        case .primary: return Theme.action
        case .quiet, .danger: return Theme.chip
        }
    }

    var body: some View {
        Button {
            action()
            Haptics.light()
        } label: {
            HStack(spacing: Theme.s1 + 2) {
                if let systemImage {
                    Image(systemName: systemImage)
                        .font(.system(size: 12, weight: .semibold))  // бокс глифа, не ступень
                }
                Text(title).font(.ui(Theme.sizeSmall, weight: .semibold))
            }
            .foregroundStyle(ink)
            .padding(.horizontal, Theme.s4)
            .frame(maxWidth: wide ? .infinity : nil, minHeight: Theme.tapTarget)
            .background(fill, in: RoundedRectangle(cornerRadius: Theme.radiusMd, style: .continuous))
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
    }
}

/// Компактная пилюля состояния прогона для плотных поверхностей. Заливка
/// приходит из `AttentionState.pillColor`, чернила — из `pillInk`: `live`
/// работает и заливкой тоже и переворачивается между темами, поэтому
/// фиксированный цвет текста на нём был бы нечитаем в одной из двух.
///
/// Пульсирует МЕТКА, а не пилюля целиком. Это не вкусовщина: первая версия
/// гасила всю пилюню до 0.55, и вместе с плашкой гасла её подпись — ivory на
/// полупрозрачных чернилах проваливается ниже 4.5:1 ровно в тёмной фазе. Веб
/// говорит то же самое своим набором селекторов: `ccpulse` висит на точках и
/// метках (`.hpr-dot.live`, `.sb-dot.busy`, `.cat-dot`) и ни разу — на
/// элементе, несущем текст.
struct StatusPill: View {
    let state: AttentionState

    var body: some View {
        HStack(spacing: Theme.s1 + 2) {
            if state.pulses {
                RoundedRectangle(cornerRadius: Theme.statusDotRadius, style: .continuous)
                    .fill(state.pillInk)
                    .frame(width: 6, height: 6)
                    .livePulse()
            }
            Text(state.label)
                .font(.mono(Theme.sizeMicro, weight: .medium))
                .tracking(Theme.track(Theme.lsTech, Theme.sizeMicro))
        }
        .foregroundStyle(state.pillInk)
        .padding(.horizontal, 9)
        .padding(.vertical, 2)
        .background(state.pillColor, in: Capsule())
    }
}

/// Сессия, которую держит редактор (`livePid`). Золото — графика и «изменено»;
/// под текстом стоит доступный `orangeText`.
struct LiveBadge: View {
    var body: some View {
        Text("LIVE")
            .font(.mono(Theme.sizeMicro, weight: .semibold))
            .tracking(Theme.track(Theme.lsCaps, Theme.sizeMicro))
            .foregroundStyle(Theme.orangeText)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(Theme.orange.opacity(0.18), in: Capsule())
    }
}

/// Сессия от OpenAI Codex (а не Claude Code). `active` добавляет квадратную
/// метку для недавно тронутого rollout'а — квадратную, потому что круглых
/// точек в системе нет.
struct CodexBadge: View {
    var active: Bool = false
    var body: some View {
        HStack(spacing: 4) {
            if active {
                RoundedRectangle(cornerRadius: Theme.statusDotRadius, style: .continuous)
                    .fill(Theme.tealDark)
                    .frame(width: 5, height: 5)
            }
            Text("CODEX")
                .font(.mono(Theme.sizeMicro, weight: .semibold))
                .tracking(Theme.track(Theme.lsCaps, Theme.sizeMicro))
        }
        .foregroundStyle(Theme.tealDark)
        .padding(.horizontal, 6)
        .padding(.vertical, 2)
        .background(Theme.teal.opacity(0.18), in: Capsule())
    }
}

/// Мелкий чип метаданных (ветка, проект, путь). Моно там, где содержимое
/// похоже на путь или код; `mono: false` — для прозы. Пилюля лицензирована:
/// это тег.
struct Chip: View {
    let text: String
    var systemImage: String? = nil
    var color: Color = Theme.textMuted
    var mono: Bool = true
    var body: some View {
        HStack(spacing: 4) {
            if let systemImage {
                Image(systemName: systemImage).font(.system(size: 9))  // бокс глифа, не ступень
            }
            Text(text)
                .font(mono ? .mono(Theme.sizeMicro) : .ui(Theme.sizeMicro))
                .lineLimit(1)
        }
        .foregroundStyle(color)
        .padding(.horizontal, 6)
        .padding(.vertical, 2)
        .background(Theme.chip, in: Capsule())
    }
}

// MARK: - Навигационная обвязка

/// Фильтр-чип: пилюля на колодце чипов, сплошная плашка выбора — когда активен.
///
/// Активный фильтр-чип — это НАСТОЯЩИЙ выбор, поэтому он берёт `select`
/// (чернила с ivory), а не цвет внимания: ember-плашка заставила бы каждый
/// включённый фильтр выглядеть так, будто он чего-то требует. И это одно из
/// трёх мест, где пилюля разрешена вообще.
struct FolderChip: View {
    let title: String
    var count: Int? = nil
    let active: Bool
    let action: () -> Void

    var body: some View {
        Button {
            action()
            Haptics.light()
        } label: {
            HStack(spacing: 5) {
                Text(title)
                    .font(.ui(Theme.sizeMeta, weight: .semibold))
                    .lineLimit(1)
                if let count {
                    Text("\(count)")
                        .font(.mono(Theme.sizeMicro, weight: .medium))
                        // `onSelect`, а не чернила ember: активная плашка — это
                        // `select`, и счётчик, покрашенный чернилами ember,
                        // рисовался тёмным по тёмному — «Список 125» читалось
                        // как «Список».
                        .foregroundStyle(active ? Theme.onSelect.opacity(0.65) : Theme.textFaint)
                }
            }
            .foregroundStyle(active ? Theme.onSelect : Theme.textMuted)
            .padding(.horizontal, Theme.s3)
            .frame(minHeight: 30)
            .background(active ? Theme.select : Theme.chip, in: Capsule())
        }
        .buttonStyle(.plain)
    }
}

/// Горизонтальный ряд фильтр-чипов.
struct FolderChipRow<Item: Identifiable, Label: View>: View {
    let items: [Item]
    @ViewBuilder let chip: (Item) -> Label

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: Theme.s2) {
                ForEach(items) { chip($0) }
            }
            .padding(.horizontal, Theme.s3)
        }
        // Ряд чипов едет вбок — значит, свайп по нему принадлежит ему.
        .sidewaysScroller()
    }
}

/// Кнопка действия — новая сессия. Квадрат 56 радиусом 16, ЧЕРНИЛЬНЫЙ с ivory.
/// Это кнопка, поэтому она берёт роль кнопки (`action`), а не внимания, и на
/// заливке нет зелёного.
struct ActionFAB: View {
    var systemImage: String = "square.and.pencil"
    let action: () -> Void
    var body: some View {
        Button {
            action()
            Haptics.light()
        } label: {
            Image(systemName: systemImage)
                .font(.system(size: 22, weight: .medium))  // бокс глифа
                .foregroundStyle(Theme.onAction)
                .frame(width: Theme.fab, height: Theme.fab)
                .background(Theme.action,
                            in: RoundedRectangle(cornerRadius: Theme.radiusLg, style: .continuous))
                .floating(Theme.shadowLg, radius: Theme.radiusLg)
        }
        .buttonStyle(.plain)
    }
}

/// Composer send/stop uses a burgundy circle with a white glyph. Other controls
/// retain their rounded square. The hit target stays at least 44pt.
struct SendCircle: View {
    var round: Bool = false
    var enabled: Bool = true
    var stop: Bool = false
    var size: CGFloat = Theme.sendButton
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: stop ? "stop.fill" : "arrow.up")
                .font(.system(size: round ? (stop ? 11 : 17) : (stop ? size * 0.3 : size * 0.36), weight: .semibold))
                // Выключенная остаётся ВИДИМОЙ кнопкой отправки: прежняя
                // заливка чипом отличалась от композера на ~1.5% светлоты.
                .foregroundStyle(round ? Theme.onComposerAction : (stop ? Theme.text : Theme.onAction.opacity(enabled ? 1 : 0.7)))
                .frame(width: size, height: size)
                .background(round ? Theme.composerAction.opacity(enabled || stop ? 1 : 0.35) : (stop ? Theme.chip : (enabled ? Theme.action : Theme.actionMuted)),
                            in: RoundedRectangle(cornerRadius: round ? size / 2 : Theme.radiusMd, style: .continuous))
                .frame(width: max(size, Theme.tapTarget), height: max(size, Theme.tapTarget))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!enabled && !stop)
        .accessibilityLabel(stop ? "Прервать" : "Отправить")
    }
}

/// Заголовок секции: моно ALL-CAPS с трекингом.
///
/// **Оранжевого квадрата перед ним больше нет.** Он был «самым узнаваемым
/// знаком системы» по DESIGN.md, и владелец, посмотрев 0.7.3, попросил убрать
/// именно его — у надписи «СЕЙЧАС В РАБОТЕ» в шторке. Это второй заход: в
/// прошлый раз ember сняли с кнопок и обводок, а эта точка осталась, потому
/// что искали по кнопкам.
///
/// Почему снятие безопасно: точка не несла состояния. Она отмечала «это
/// заголовок секции» — то же самое, что уже сказано капсом, трекингом,
/// моноширинным начертанием и приглушённым тоном. Оранжевый в продукте
/// остаётся ровно за одним смыслом — «ждёт моего ответа», — и когда он
/// одновременно означает «тут начинается раздел», он перестаёт звать.
///
/// Параметр `eyebrow` оставлен и ничего не рисует: он читается в дюжине мест
/// как «это не заголовок секции», и вычищать его — отдельная правка, которая
/// к просьбе не относится.
struct SectionLabel: View {
    let text: String
    var count: Int? = nil
    var eyebrow: Bool = true

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: Theme.s2) {
            Text(text.uppercased())
                .font(.mono(Theme.sizeMicro, weight: .medium))
                .tracking(Theme.track(Theme.lsCaps, Theme.sizeMicro))
                .foregroundStyle(Theme.textFaint)
            if let count {
                Text("\(count)")
                    .font(.mono(Theme.sizeMicro))
                    .foregroundStyle(Theme.textFaint)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
    }
}

// MARK: - Табы

/// Полоса табов: подписи в ряд, под активной — линия.
///
/// **Здесь стояли фильтр-чипы, и это был не стиль, а неверное слово.** Пилюля
/// с заливкой означает ФИЛЬТР — «из этого списка показывай такие»; она
/// включается и выключается, их можно помыслить несколько сразу, и у каждой
/// есть счётчик, потому что фильтр отвечает «сколько останется». Настройки и
/// Команда фильтруют ноль чего-либо: их четыре подписи — это четыре РАЗНЫХ
/// ЭКРАНА, из которых виден ровно один. Чип на этом месте обещал операцию,
/// которой нет, а ряд включённо-выключенных пилюль читался «выбери сколько
/// хочешь» там, где выбрать можно одно.
///
/// Линия под подписью — то, чем таб называют все большие приложения, и она же
/// самая дешёвая: не тратит заливку, не требует перекрашивать текст ради
/// контраста поверх плашки и не врёт про множественность.
///
/// Ряд едет вбок (подписей может не хватить ширины на 375pt) и помечен как
/// едущий: свайп по табам — это табы, а не шторка.
struct TabStrip<Tab: Hashable & Identifiable>: View {
    let tabs: [Tab]
    let label: (Tab) -> String
    @Binding var active: Tab

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 0) {
                ForEach(tabs) { tab in
                    let on = tab == active
                    Button {
                        active = tab
                        Haptics.light()
                    } label: {
                        VStack(spacing: 0) {
                            Text(label(tab))
                                .font(.ui(Theme.sizeSmall, weight: on ? .semibold : .medium))
                                .foregroundStyle(on ? Theme.text : Theme.textMuted)
                                .padding(.horizontal, Theme.s3)
                                .frame(minHeight: Theme.tapTarget)
                            // Линия есть ВСЕГДА, и у неактивного таба она
                            // прозрачная. Иначе подпись прыгала бы на два
                            // пункта вверх в момент переключения — ряд табов
                            // дёргался целиком на каждом касании.
                            Rectangle()
                                .fill(on ? Theme.brand : Color.clear)
                                .frame(height: 2)
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(on ? [.isSelected] : [])
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, Theme.s3)
        }
        .sidewaysScroller()
        // Волосяная линия под всей полосой: активная линия обязана стоять НА
        // ней, а не висеть над пустотой — так читается, что переключается
        // содержимое под полосой, а не сама полоса.
        .overlay(alignment: .bottom) { Rectangle().fill(Theme.border).frame(height: 1) }
    }
}

// MARK: - Раскладка

/// Перенос по строкам: ряд заполняется, дальше — со следующей строки.
///
/// Одна на продукт. Их было ТРИ — `WrapRow` внутри `#if DEBUG` витрины (то есть
/// недоступная приложению), приватный `WrapLayout` в полосе обогащения и
/// «HStack, который как-нибудь поместится» в остальных местах. Третий вариант —
/// тот, который разваливается: на крупном accessibility-размере чип становится
/// втрое шире, и нeпереносящий ряд уезжает за край вместе с половиной
/// содержимого.
///
/// `maxItemWidth` — потолок ширины ОДНОГО элемента: без него `Text` сообщает
/// свою однострочную идеальную ширину и не переносится внутри себя никогда.
struct WrapRow: Layout {
    var spacing: CGFloat = Theme.s2
    var maxItemWidth: CGFloat = .infinity

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let rowWidth = proposal.width ?? maxItemWidth
        var x: CGFloat = 0, y: CGFloat = 0, rowHeight: CGFloat = 0, widest: CGFloat = 0
        for view in subviews {
            let size = view.sizeThatFits(ProposedViewSize(width: min(rowWidth, maxItemWidth), height: nil))
            if x > 0, x + size.width > rowWidth {
                widest = max(widest, x - spacing)
                x = 0
                y += rowHeight + spacing
                rowHeight = 0
            }
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
        }
        widest = max(widest, x - spacing)
        return CGSize(width: min(widest, rowWidth), height: y + rowHeight)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize,
                       subviews: Subviews, cache: inout ()) {
        var x = bounds.minX, y = bounds.minY, rowHeight: CGFloat = 0
        for view in subviews {
            let size = view.sizeThatFits(ProposedViewSize(width: min(bounds.width, maxItemWidth),
                                                          height: nil))
            if x > bounds.minX, x + size.width > bounds.maxX {
                x = bounds.minX
                y += rowHeight + spacing
                rowHeight = 0
            }
            view.place(at: CGPoint(x: x, y: y), anchor: .topLeading,
                       proposal: ProposedViewSize(size))
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
        }
    }
}

// MARK: - Поверхности

/// Плавающая поверхность: тень ВМЕСТЕ с внутренней кромкой.
///
/// Две половины одного правила, и порознь они не работают. В тёмной теме тень
/// на почти чёрном не читается — объём даёт кромка; в светлой кромка прозрачна
/// и ничего не стоит — работает тень. Поэтому это один модификатор, а не два
/// вызова, которые кто-нибудь однажды применит по отдельности.
struct Floating: ViewModifier {
    let elevation: Theme.Elevation
    let radius: CGFloat

    func body(content: Content) -> some View {
        content
            .shadow(color: elevation.color, radius: elevation.radius, y: elevation.y)
            .overlay(
                RoundedRectangle(cornerRadius: radius, style: .continuous)
                    .strokeBorder(Theme.rim, lineWidth: 1)
            )
    }
}

extension View {
    func floating(_ elevation: Theme.Elevation = Theme.shadowLg,
                  radius: CGFloat = Theme.radiusLg) -> some View {
        modifier(Floating(elevation: elevation, radius: radius))
    }
}

/// Покоящаяся карточка: приподнятая поверхность БЕЗ границы — её отделяет
/// зелёно-чернильная тень, а в тёмной теме кромка `rim`. Граница у карточки
/// была бы четвёртой линией там, где хватает одной.
struct CardBackground: ViewModifier {
    var fill: Color = Theme.surfaceRaised
    var radius: CGFloat = Theme.radiusLg
    func body(content: Content) -> some View {
        content
            .background(fill, in: RoundedRectangle(cornerRadius: radius, style: .continuous))
            .floating(Theme.shadowSm, radius: radius)
    }
}

extension View {
    func card(fill: Color = Theme.surfaceRaised, radius: CGFloat = Theme.radiusLg) -> some View {
        modifier(CardBackground(fill: fill, radius: radius))
    }
}

/// Сплошная плашка НАСТОЯЩЕГО выбора — чернильная, ivory поверх.
///
/// Для навигационного «ты здесь» это НЕ тот модификатор: см. `hereTint`.
/// Разница не косметическая — сплошная плашка тащит за собой переопределение
/// цвета у каждого ребёнка строки.
struct SelectionPlate: ViewModifier {
    var selected: Bool
    var radius: CGFloat = Theme.radiusMd
    func body(content: Content) -> some View {
        content.background(selected ? Theme.select : Color.clear,
                           in: RoundedRectangle(cornerRadius: radius, style: .continuous))
    }
}

/// «Ты здесь»: подложка навигационного состояния — выбранная сессия, активный
/// проект, чип машины, текущая папка.
///
/// Тинт, а не плашка. Сплошная чёрная полоса в списке сессий была самым
/// заметным объектом экрана и требовала перекрасить заголовок, время, бейджи и
/// метки — дюжину цветов — только чтобы они читались поверх неё. Тинт говорит
/// то же самое, дети остаются своего цвета, а выделение держит полужирное
/// начертание.
struct HereTint: ViewModifier {
    var here: Bool
    var radius: CGFloat = Theme.radiusMd
    func body(content: Content) -> some View {
        content.background(here ? Theme.here : Color.clear,
                           in: RoundedRectangle(cornerRadius: radius, style: .continuous))
    }
}

extension View {
    func selectionPlate(_ selected: Bool, radius: CGFloat = Theme.radiusMd) -> some View {
        modifier(SelectionPlate(selected: selected, radius: radius))
    }

    /// Навигационное состояние. Дети НЕ перекрашиваются — в этом весь смысл.
    func hereTint(_ here: Bool, radius: CGFloat = Theme.radiusMd) -> some View {
        modifier(HereTint(here: here, radius: radius))
    }

    /// Чернила для содержимого, сидящего на (возможно) выбранной ПЛАШКЕ.
    /// С `hereTint` не используется.
    func selectedInk(_ selected: Bool, normal: Color) -> some View {
        foregroundStyle(selected ? Theme.onSelect : normal)
    }

    /// Фокус-гало — ember, и в этом смысл разведения ролей: зелёное кольцо на
    /// зелёной плашке невидимо.
    func focusRing(_ focused: Bool, radius: CGFloat = Theme.radiusMd) -> some View {
        overlay(
            RoundedRectangle(cornerRadius: radius, style: .continuous)
                .strokeBorder(focused ? Theme.focusRing : .clear, lineWidth: 2)
        )
    }
}

// MARK: - Бренд

/// Знак Hegai (brand book v2): восемь скруглённых лучей вокруг ПУСТОГО центра,
/// чередование длинный/короткий каждые 45°. По умолчанию двухцветный; бренд
/// предписывает `mono` на 24pt и ниже. Геометрия 1:1 из `HegaiMark.tsx`
/// (viewBox 102 = 2·(9+42), ширина луча 11, длинный 42 / короткий 29, угол 5.5).
struct HegaiMark: View {
    var size: CGFloat = 24
    var mono: Color? = nil

    var body: some View {
        let unit = size / 102
        ZStack {
            ForEach(0..<8, id: \.self) { i in
                let long = i % 2 == 0
                let height = (long ? 42.0 : 29.0) * unit
                let distance = (9.0 * unit) + height / 2
                let angle = Double(i) * 45 * .pi / 180
                RoundedRectangle(cornerRadius: 5.5 * unit)  // off-ladder: геометрия знака 1:1 из HegaiMark.tsx
                    .fill(mono ?? (long ? Theme.brand : Theme.orange))
                    .frame(width: 11 * unit, height: height)
                    .rotationEffect(.degrees(Double(i) * 45))
                    .offset(x: -distance * sin(angle), y: distance * cos(angle))
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

// MARK: - Транскрипт

/// Разделитель секции транскрипта — граница дня или шов «продолжение» между
/// файлом и живым потоком: волосяная линия, моно-капс, волосяная линия.
/// Не капсула: пилюли — только тегам, бейджам и активным фильтр-чипам.
struct TranscriptDivider: View {
    let label: String

    var body: some View {
        HStack(spacing: Theme.s3) {
            Rectangle().fill(Theme.divider).frame(height: 1)
            Text(label.uppercased())
                .font(.mono(Theme.sizeMicro, weight: .medium))
                .tracking(Theme.track(Theme.lsCaps, Theme.sizeMicro))
                .foregroundStyle(Theme.textFaint)
                .fixedSize()
            Rectangle().fill(Theme.divider).frame(height: 1)
        }
        .padding(.top, Theme.s4)
        .padding(.bottom, Theme.s2)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(label)
    }
}

/// «Вниз» — висит над транскриптом, пока читатель оторван от живого конца.
/// Круг 32pt по центру над вводом; область нажатия остаётся 44pt.
struct ScrollToBottomButton: View {
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: "arrow.down")
                .font(.system(size: 16, weight: .medium))
                .foregroundStyle(Theme.textMuted)
                .frame(width: Theme.iconButton, height: Theme.iconButton)
                .background(Theme.surfaceRaised, in: Circle())
                .overlay(Circle().strokeBorder(Theme.drawerRim, lineWidth: 1))
                .shadow(color: Theme.shadowSm.color, radius: Theme.shadowSm.radius, y: Theme.shadowSm.y)
                .frame(width: Theme.tapTarget, height: Theme.tapTarget)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Вниз")
        .accessibilityHint("К последнему сообщению")
    }
}

/// Словесный знак «hegai.code»: имя жирным, точка — цвет кнопок, «code» тише.
struct HegaiWordmark: View {
    var size: CGFloat = 26
    var body: some View {
        (Text("hegai").font(.ui(size, weight: .bold)).foregroundColor(Theme.text)
         + Text(".").font(.ui(size, weight: .bold)).foregroundColor(Theme.composerAction)
         + Text("code").font(.ui(size, weight: .regular)).foregroundColor(Theme.textMuted))
            .kerning(-0.3)
            .accessibilityLabel("Hegai Code")
    }
}
