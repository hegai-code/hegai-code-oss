import SwiftUI
import CCRemoteKit

/// Harness plumbing the CLI injects into a turn's text — background-task
/// notifications, system reminders, the slash-command envelope. It is addressed
/// to the model, never to a reader; on a working session it outnumbers the
/// actual sentences several times over. Mirrors `stripHarnessNoise` in
/// `agent/src/history.ts` and `web/src/render/Blocks.tsx`.
private let harnessBlocks = [
    "task-notification", "system-reminder", "local-command-stdout",
    "local-command-caveat", "command-name", "command-message", "command-args",
]

private let harnessRegex: NSRegularExpression? = {
    let pattern = harnessBlocks.map { "<\($0)>[\\s\\S]*?</\($0)>" }.joined(separator: "|")
    return try? NSRegularExpression(pattern: pattern)
}()

func stripHarnessNoise(_ text: String) -> String {
    guard text.contains("<"), let regex = harnessRegex else { return text }
    let range = NSRange(text.startIndex..<text.endIndex, in: text)
    return regex
        .stringByReplacingMatches(in: text, range: range, withTemplate: "")
        .trimmingCharacters(in: .whitespacesAndNewlines)
}

/// Ход транскрипта из истории.
///
/// Композиция — вебовская (`SpeakerGutter.swift`, разбор наверху файла):
/// подписи нет ни у кого, реплика человека стоит плашкой справа со своим
/// штампом, ход агента идёт во всю меру без плашки и без времени. Проза агента
/// при этом осталась настоящим markdown с настоящей иерархией заголовков —
/// это та часть документной модели, которую редизайн не трогал и трогать
/// незачем: агент и правда возвращает документ.
///
/// Продолженный ход (`cont`, см. `groupHistory`) читается следующим абзацем
/// того же входа — теперь это только более плотный шов.
struct MessageView: View, Equatable {
    let msg: HistoryMessage
    var cont: Bool = false
    /// Which runtime is answering — the name on its turns.
    var agent: String = "Claude"
    /// The reader's own name, from the profile. Never «Вы» — see `SpeakerName`.
    var human: String = SpeakerName.unknown
    var activityURL: URL? = nil
    var activityCount: Int = 0

    static func == (a: MessageView, b: MessageView) -> Bool {
        a.msg == b.msg && a.cont == b.cont && a.agent == b.agent && a.human == b.human
            && a.activityURL == b.activityURL && a.activityCount == b.activityCount
    }

    var body: some View {
        // `system` turns are hook output and CLI caveats, not conversation — the
        // live stream already drops them, so history reads the same. A turn left
        // with nothing after the cleanup draws no empty chrome either.
        let blocks = cleanBlocks(msg.blocks)
        if msg.role == .system || blocks.isEmpty {
            EmptyView()
        } else {
            // A user message carrying only tool results is the runtime's output,
            // not a human turn — it speaks with the agent's voice.
            let isHuman = msg.role == .user && !isServiceOnly(blocks)
            TurnRow(speaker: TurnSpeaker(name: isHuman ? human : agent,
                                         isHuman: isHuman,
                                         ts: msg.ts),
                    cont: cont) {
                if isHuman {
                    HumanTurnBody(blocks: blocks, ts: msg.ts, activityURL: activityURL, activityCount: activityCount)
                } else {
                    VStack(alignment: .leading, spacing: Theme.s2) {
                        ForEach(Array(blocks.enumerated()), id: \.offset) { index, b in
                            if case let .text(text) = b {
                                VStack(alignment: .leading, spacing: 0) {
                                    MarkdownText(text: text, activityURL: index == blocks.count - 1 ? activityURL : nil, activityCount: activityCount)
                                    // Файлы, которые назвал ответ (скриншот, .md): миниатюра под текстом.
                                    FilePreviewStrip(text: text)
                                }
                            } else { BlockView(block: b, fresh: isFresh(msg.ts)) }
                        }
                        if let activityURL, !endsWithText(blocks) {
                            MarkdownText(text: "", activityURL: activityURL, activityCount: activityCount)
                        }
                    }
                }
            }
        }
    }
}

/// A turn written in the last two minutes: a generated picture's bytes may
/// still be on their way to the hub, so an empty answer is retried.
private func isFresh(_ ts: Double?) -> Bool {
    guard let ts else { return false }
    return Date().timeIntervalSince1970 * 1000 - ts < 120_000
}

private func endsWithText(_ blocks: [RenderBlock]) -> Bool {
    if case .text? = blocks.last { return true }
    return false
}

/// The human's words as the command they are, plus whatever else the turn
/// carried (attachments, an echoed result) as machine rows beneath.
private struct HumanTurnBody: View {
    let blocks: [RenderBlock]
    /// Время хода — уходит в конец ПОСЛЕДНЕГО абзаца, если абзацы есть.
    var ts: Double?
    var activityURL: URL? = nil
    var activityCount: Int = 0

    private var texts: [String] {
        blocks.compactMap { if case let .text(t) = $0 { return t } else { return nil } }
    }
    private var rest: [RenderBlock] {
        blocks.filter {
            switch $0 { case .text, .image: return false; default: return true }
        }
    }
    private var images: [String?] {
        blocks.reduce(into: []) { refs, block in
            if case let .image(ref) = block { refs.append(ref) }
        }
    }

    var body: some View {
        VStack(alignment: .trailing, spacing: Theme.s2) {
            if !images.isEmpty {
                HStack(spacing: 0) {
                    Spacer(minLength: Theme.s6 * 2)
                    TranscriptImageGallery(refs: images)
                }
            }
            if !texts.isEmpty || !rest.isEmpty {
                HumanPlate(ts: texts.isEmpty ? ts : nil) { textBody }
                    .accessibilityIdentifier("transcript.user.text")
            } else {
                if let ts {
                    Text(TurnTime.hhmm(ts)).font(.mono(Theme.sizeMicro))
                        .foregroundStyle(Theme.textFaint).accessibilityHidden(true)
                }
                if let activityURL { MarkdownText(text: "", activityURL: activityURL, activityCount: activityCount) }
            }
        }
    }

    private var textBody: some View {
        VStack(alignment: .leading, spacing: Theme.s2) {
            let texts = self.texts
            if !texts.isEmpty {
                VStack(alignment: .leading, spacing: Theme.s1) {
                    ForEach(Array(texts.enumerated()), id: \.offset) { i, t in
                        // A human turn is PLAIN text: CLI-injected context is
                        // full of `#` lines that must not explode into
                        // headings (the web renders user turns the same way).
                        UserText(text: t, stamp: i == texts.count - 1 ? ts : nil,
                                 activityURL: i == texts.count - 1 ? activityURL : nil, activityCount: activityCount)
                    }
                }
            }
            ForEach(Array(rest.enumerated()), id: \.offset) { _, b in
                BlockView(block: b)
            }
            if texts.isEmpty, let activityURL { MarkdownText(text: "", activityURL: activityURL, activityCount: activityCount) }
        }
    }
}

/// Текст реплики человека — то, что лежит ВНУТРИ плашки (`HumanPlate`).
///
/// Вес — читательский, а не «на ступень темнее ответа»: маркирует теперь
/// плашка, и полужирный внутри залитой коробки читается криком. Ровно это
/// сказано в вебе одной строкой — `.msg.user > .usertext .usertext-body
/// { font-weight: 450 }` — и ровно этим 17.09 закончился спор, который до
/// того шёл про вес.
///
/// Длинные вставленные промпты (CLI вклеивает списки файлов и целые файлы)
/// сворачиваются в предпросмотр с «Показать всё», а псевдотеги `<image …>` —
/// в чипы вложений: иначе стена машинного контекста топит сам разговор.
struct UserText: View {
    let text: String
    /// Время хода. Вплывает в КОНЕЦ последней строки, а не встаёт своей.
    var stamp: Double? = nil
    var activityURL: URL? = nil
    var activityCount: Int = 0
    @State private var expanded = false

    private static let longChars = 700
    private static let longLines = 9

    /// Split off `<image …>` pseudo-tags; what remains is what the human typed.
    private var parts: (images: [String], body: String) {
        var images: [String] = []
        var body = text
        let pattern = "<image\\b[^>\\n]*>"
        while let range = body.range(of: pattern, options: .regularExpression) {
            let tag = String(body[range])
            let name = tag.replacingOccurrences(of: "name=\\[?([^\\]\">]*?)\\]?(\\s|>)",
                                                with: "$1", options: .regularExpression)
            images.append(name.isEmpty ? "изображение" : name)
            body.replaceSubrange(range, with: "")
        }
        body = body.replacingOccurrences(of: "</image>", with: "")
        return (images, body.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    private var isLong: Bool {
        let body = parts.body
        return body.count > Self.longChars
            || body.split(separator: "\n", omittingEmptySubsequences: false).count > Self.longLines
    }

    var body: some View {
        let p = parts
        VStack(alignment: .leading, spacing: Theme.s1) {
            if !p.images.isEmpty {
                HStack(spacing: Theme.s1) {
                    ForEach(Array(p.images.enumerated()), id: \.offset) { _, name in
                        // An attachment chip is a TAG — one of the three licensed pills.
                        Label(name, systemImage: "photo")
                            .font(.ui(Theme.sizeMicro)).foregroundStyle(Theme.textMuted)
                            .padding(.horizontal, 6).padding(.vertical, 2)
                            .background(Theme.chip, in: Capsule())  // пилюля: тег
                    }
                }
            }
            if !p.body.isEmpty {
                // Штамп приклеен К ТЕКСТУ, а не положен под него.
                //
                // В вебе он вплывает `float: right` в конец собственного
                // абзаца и поэтому не стоит ни строки; здесь его несёт
                // СКЛЕЙКА `Text + Text`, которая переносится по тем же
                // правилам, что и слова: есть место в последней строке —
                // едет в ней, нет — уходит на следующую. Раньше он стоял
                // своей строкой, и каждая реплика человека была на строку
                // выше, чем в вебе.
                //
                // Под обрезанным длинным текстом склейки нет: `lineLimit`
                // отрезал бы именно хвост, то есть сам штамп. Там он
                // остаётся отдельной строкой — ниже, под кнопкой «Показать
                // всё», где его ничто не режет.
                //
                // Неразрывные пробелы (`\u{2007}`) — чтобы отбивка не
                // схлопнулась и чтобы штамп не оторвался от текста в
                // отдельную строку сам по себе.
                let clamped = isLong && !expanded
                let body = Text(Self.linkified(p.body))
                let stamped: Text = {
                    guard let stamp, !clamped else { return body }
                    return body
                        + Text("\u{2007}\u{2007}")
                        + Text(TurnTime.hhmm(stamp))
                            .font(.mono(Theme.sizeMicro, weight: .medium))
                            .foregroundStyle(Theme.textFaint)
                }()
                (stamped + activitySuffix)
                    // Вес чтения, интерлиньяж ЧТЕНИЯ: в вебе `.usertext-body`
                    // идёт на `--lh-read` (1.7), тем же, что и проза агента, —
                    // реплика человека здесь такой же читаемый текст, а не
                    // подпись. Тяжёлого начертания нет: его работу забрала
                    // плашка.
                    .font(.chatBody)
                    .lineSpacing(Theme.leading(Theme.lhRead, Theme.sizeChatBody))
                    .foregroundStyle(Theme.text)
                    .lineLimit(clamped ? Self.longLines : nil)
                    // Your own turn is worth copying too — re-sending a prompt
                    // to another session is the common reason. See MarkdownText.
                    .textSelection(.enabled)
                if isLong {
                    Button(expanded ? "Свернуть" : "Показать всё") {
                        withAnimation(Theme.easeFast) { expanded.toggle() }
                    }
                    .font(.ui(Theme.sizeMeta, weight: .semibold))
                    .foregroundStyle(Theme.link)
                    .buttonStyle(.plain)
                    if clamped, activityURL != nil { activitySuffix }
                }
                // Обрезанный текст склейку бы съел — штамп тогда своей строкой,
                // по внутреннему краю плашки. Тот же запасной путь, что и у
                // веба для хода без текста.
                if let stamp, clamped {
                    Text(TurnTime.hhmm(stamp))
                        .font(.mono(Theme.sizeMicro, weight: .medium))
                        .monospacedDigit()
                        .foregroundStyle(Theme.textFaint)
                        .frame(maxWidth: .infinity, alignment: .trailing)
                        .accessibilityHidden(true)
                }
            }
        }
    }

    /// Один детектор на процесс: создание `NSDataDetector` — это загрузка словарей и
    /// автомата, а `linkified` зовётся из body каждой строки человека.
    private static let linkDetector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue)

    /// Адреса в том, что набрал человек, нажимаются и видны: `Text(String)`
    /// ссылок не распознаёт. Синий с подчёркиванием — как в прозе агента.
    /// Атрибуты строки сильнее `.foregroundStyle` у `Text`, так что цвет
    /// остального текста задаётся снаружи, как раньше.
    static func linkified(_ text: String) -> AttributedString {
        var out = AttributedString(text)
        // Адресу нужна точка, двоеточие или «@»; обычной фразе детектор не нужен вовсе.
        guard text.contains(where: { $0 == "." || $0 == ":" || $0 == "@" }), let detector = Self.linkDetector else {
            return out
        }
        let ns = text as NSString
        for match in detector.matches(in: text, range: NSRange(location: 0, length: ns.length)) {
            guard let url = match.url,
                  let range = Range(match.range, in: text),
                  let lower = AttributedString.Index(range.lowerBound, within: out),
                  let upper = AttributedString.Index(range.upperBound, within: out) else { continue }
            out[lower..<upper].link = url
            out[lower..<upper].foregroundColor = Theme.linkProse
            out[lower..<upper].underlineStyle = .single
        }
        return out
    }

    private var activitySuffix: Text {
        guard let activityURL else { return Text("") }
        var suffix = AttributedString(" ⚙︎\u{00A0}\(activityCount)")
        if let countRange = suffix.range(of: String(activityCount), options: .backwards) {
            suffix[countRange].font = .ui(Theme.sizeMeta, weight: .medium)
        }
        suffix.link = activityURL
        suffix.foregroundColor = Theme.textFaint
        return Text(suffix)
    }
}
