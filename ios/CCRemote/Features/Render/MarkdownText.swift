import SwiftUI
import MarkdownUI

/// Assistant prose rendered as GFM markdown, themed to the design system.
/// Shared by history and the throttled streaming tail.
struct MarkdownText: View, Equatable {
    let text: String
    var activityURL: URL? = nil
    var activityCount: Int = 0

    private var content: String {
        guard let activityURL else { return text }
        let chrome = ActivityChromeCache.shared.chrome(for: text)
        return chrome.markdown + (chrome.inline ? " " : "\n\n")
            + "[⚙︎\u{00A0}**\(activityCount)**](\(activityURL.absoluteString))"
    }
    var body: some View {
        Markdown(content)
            .markdownTheme(.ccRemote)
            .markdownSoftBreakMode(.lineBreak)
            .markdownTextStyle { ForegroundColor(Theme.text) }
            // The agent's answer is the thing people most want to take out of
            // this app, and SwiftUI `Text` is NOT selectable unless asked. Tool
            // output already had this (`ToolViews.swift`), so the transcript was
            // inconsistent: a command's output could be copied and the sentences
            // explaining it could not. Reported from the Mac app — "нельзя
            // скопировать ответ, в целом нельзя текст выделять".
            //
            // It is an environment modifier, so one call covers every `Text`
            // MarkdownUI builds underneath — paragraphs, list items, code spans.
            .textSelection(.enabled)
    }
}

/// Разбор прозы ради ссылки «⚙ N»: канонический Markdown и «ссылка в строку или отдельным
/// абзацем». Два разбора (Markdown и HTML) плюс регулярка — на каждый проход body, а body
/// строки с механикой идёт и на каждую смену окружения. Результат зависит только от текста,
/// поэтому лежит в ограниченном кэше по тексту; ссылка и число собираются после него.
private final class ActivityChromeCache {
    static let shared = ActivityChromeCache()

    final class Entry {
        let markdown: String
        let inline: Bool
        init(markdown: String, inline: Bool) {
            self.markdown = markdown
            self.inline = inline
        }
    }

    private let cache: NSCache<NSString, Entry> = {
        let cache = NSCache<NSString, Entry>()
        cache.countLimit = 256
        return cache
    }()

    private static let trailingClosers = try? NSRegularExpression(pattern: "(?:\\s*</(?:li|ul|ol|blockquote)>)+$")

    func chrome(for text: String) -> Entry {
        let key = text as NSString
        if let hit = cache.object(forKey: key) { return hit }
        // Canonical Markdown closes fences and emphasis before adding chrome.
        // Prose/list endings keep the link on their final line; tables and code
        // get a separate suffix so the action never becomes executable text.
        let parsed = MarkdownContent(text)
        let markdown = parsed.renderMarkdown().trimmingCharacters(in: .whitespacesAndNewlines)
        let html = parsed.renderHTML().trimmingCharacters(in: .whitespacesAndNewlines)
        let ending = Self.trailingClosers?.stringByReplacingMatches(
            in: html, range: NSRange(html.startIndex..., in: html), withTemplate: "") ?? html
        let prose = ["</p>", "</h1>", "</h2>", "</h3>", "</h4>", "</h5>", "</h6>"]
            .contains { ending.hasSuffix($0) }
        let tightList = ending != html && !ending.hasSuffix(">")
        let made = Entry(markdown: markdown, inline: prose || tightList)
        cache.setObject(made, forKey: key)
        return made
    }
}

extension MarkdownUI.Theme {
    static let ccRemote = MarkdownUI.Theme()
        // Shared compact reading size for streamed and completed answers.
        .text {
            ForegroundColor(Theme.text)
            FontSize(Theme.sizeChatBody)
        }
        // Paragraph spacing stays distinct from spacing between wrapped lines.
        .paragraph { config in
            config.label
                .fixedSize(horizontal: false, vertical: true)
                .lineSpacing(Theme.leading(Theme.lhRead, Theme.sizeChatBody))
                .markdownMargin(top: .em(0.0), bottom: .em(0.8))
        }
        .code {
            FontFamilyVariant(.monospaced)
            // 14.5, как `--size-small` в вебе: код ВНУТРИ строки читают вместе
            // с ней, и 13 среди 16 проваливается.
            FontSize(Theme.sizeSmall)
            ForegroundColor(Theme.text)
            BackgroundColor(Theme.surfaceSunken)
        }
        .link {
            ForegroundColor(Theme.linkProse)
            UnderlineStyle(.single)
        }
        .strong { ActivityCountOrStrongStyle() }
        // Headings follow the conversation size, with a small step and weight.
        .heading1 { config in
            config.label
                .markdownTextStyle { FontWeight(.bold); FontSize(Theme.sizeChatBody + 2) }
                .markdownMargin(top: .em(1.0), bottom: .em(0.5))
        }
        .heading2 { config in
            config.label
                .markdownTextStyle { FontWeight(.bold); FontSize(Theme.sizeChatBody + 1) }
                .markdownMargin(top: .em(0.9), bottom: .em(0.5))
        }
        .heading3 { config in
            config.label
                .markdownTextStyle { FontWeight(.semibold); FontSize(Theme.sizeChatBody) }
                .markdownMargin(top: .em(0.8), bottom: .em(0.4))
        }
        // A list item's label has to be told it may grow vertically. Without
        // this the row is laid out at one line's height and the text is
        // truncated mid-sentence with an ellipsis — the item silently loses its
        // ending, which is worse than wrapping badly because nothing signals it.
        .listItem { config in
            config.label
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
                .markdownMargin(top: .em(0.12), bottom: .em(0.12))
        }
        // Код внутри ответа ЕДЕТ ВБОК сам — тем же способом, что и `CodeBlock`
        // служебных строк. Без этого длинная строка либо переносилась посреди
        // команды, либо (у MarkdownUI — именно так) обрезалась молча: на
        // телефоне мера чтения короче любой реальной команды, и код без
        // бокового хода нечитаем в принципе. `sidewaysScroller` заодно
        // отбирает свайп у шторки, иначе каждое протаскивание кода открывало
        // список сессий.
        .codeBlock { config in
            ScrollView(.horizontal, showsIndicators: false) {
                config.label
                    .padding(Theme.s2)
                    .font(.mono(Theme.sizeMeta))
                    .foregroundStyle(Theme.text)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.surfaceSunken, in: RoundedRectangle(cornerRadius: Theme.radiusSm))
            .sidewaysScroller()
            .markdownMargin(top: .em(0.5), bottom: .em(0.5))
        }
        // Цитата — отступ и приглушённый тон, без смены гарнитуры.
        //
        // Здесь был серифный курсив (один из «трёх голосов» DESIGN.md). Он ушёл
        // вместе с остальным серифом: посреди системного текста курсивная
        // антиква читается вставкой из другого документа, а не тихой цитатой.
        // Полоска слева осталась — она и есть тот знак, которым цитату
        // отбивают везде, включая референс.
        .blockquote { config in
            config.label
                .padding(.leading, Theme.s3)
                .overlay(alignment: .leading) {
                    Rectangle().fill(Theme.divider).frame(width: 2)
                }
                .foregroundStyle(Theme.textMuted)
        }
}

/// The generated count is a styled span inside one tappable link. Ordinary
/// bold Markdown keeps its weight and size, including inside external links.
private struct ActivityCountOrStrongStyle: TextStyle {
    func _collectAttributes(in attributes: inout AttributeContainer) {
        if attributes.link?.scheme == "ccremote-activity" {
            FontSize(Theme.sizeMeta)._collectAttributes(in: &attributes)
            FontWeight(.medium)._collectAttributes(in: &attributes)
        } else {
            FontWeight(.semibold)._collectAttributes(in: &attributes)
        }
    }
}

/// Limit parsing to eight updates per second while keeping Markdown visible.
/// The final snapshot bypasses the throttle (a finished line is a `MarkdownText`, not this
/// view); cancellation ends work offscreen.
///
/// Trailing throttle, event-driven: a new text arms ONE ~125 ms wait and the wait publishes
/// whatever is latest by then. There used to be a loop that woke every 125 ms for as long as
/// the view was mounted, text moving or not — 480 timer wakeups a minute per streaming answer.
struct StreamingMarkdownText: View {
    let text: String
    var activityURL: URL? = nil
    var activityCount: Int = 0
    @State private var rendered: String
    /// An update is waiting for its tick; also the `.task` identity that runs the wait.
    @State private var waiting = false
    /// Newest text, readable by the wait without invalidating the view on every delta.
    @State private var latest = LatestText()

    final class LatestText {
        var text = ""
    }

    init(text: String, activityURL: URL? = nil, activityCount: Int = 0) {
        self.text = text
        self.activityURL = activityURL
        self.activityCount = activityCount
        _rendered = State(initialValue: text)
    }

    var body: some View {
        MarkdownText(text: rendered, activityURL: activityURL, activityCount: activityCount).equatable()
            .onChange(of: text, initial: true) { _, value in
                latest.text = value
                if value != rendered, !waiting { waiting = true }
            }
            .task(id: waiting) {
                guard waiting else { return }
                try? await Task.sleep(for: .milliseconds(125))
                // Cancelled offscreen: `waiting` stays set, so the wait restarts on return.
                guard !Task.isCancelled else { return }
                if rendered != latest.text { rendered = latest.text }
                waiting = false
            }
    }
}
