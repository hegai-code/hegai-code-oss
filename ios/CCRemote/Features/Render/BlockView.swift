import SwiftUI
import CCRemoteKit

/// One render block — port of `BlockView` in web/src/render/Blocks.tsx.
struct BlockView: View {
    let block: RenderBlock
    /// The block was written moments ago, so a picture's bytes may trail it.
    var fresh = false

    var body: some View {
        switch block {
        case let .text(text):
            MarkdownText(text: text)
                .frame(maxWidth: .infinity, alignment: .leading)
        case let .thinking(text):
            // Размышление ничего не делает — это чтение вслух. Метка служебная
            // и потому бесцветная: три смысловых цвета принадлежат вызовам.
            CollapsibleBody(label: "размышление", labelColor: Theme.textFaint,
                            symbol: "brain", symbolColor: Theme.textFaint) {
                // Один из трёх узаконенных серифов: «человеческий голос».
                Text(text)
                    .font(.chatBody)
                    .lineSpacing(Theme.leading(Theme.lhHuman, Theme.sizeChatBody))
                    .foregroundStyle(Theme.textMuted)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .textSelection(.enabled)
            }
        case let .toolUse(_, name, input):
            ToolUseView(name: name, input: input)
        case let .toolResult(_, text, isError):
            // Ошибка — третий из трёх смысловых цветов, и единственный случай,
            // когда служебная строка вообще берёт цвет: результат без ошибки
            // это эхо вызова, а не новое событие.
            CollapsibleBody(label: isError ? "ошибка инструмента" : "результат",
                            labelColor: isError ? Theme.negative : Theme.textFaint,
                            symbol: isError ? "exclamationmark" : "arrow.turn.down.right",
                            symbolColor: isError ? ToolTone.fail.fill : Theme.textFaint,
                            symbolInk: isError ? ToolTone.fail.ink : Theme.textOnColor) {
                CodeBlock(text: String(text.prefix(4000)))
            }
        case let .image(ref):
            TranscriptImageView(ref: ref)
        case let .generatedImage(ref, prompt):
            GeneratedImageView(ref: ref, prompt: prompt, fresh: fresh)
        case .unknown:
            EmptyView()
        }
    }
}

/// Shared collapsed→open chrome for tool / thinking / result blocks.
///
/// Collapsed it is a **left machine row at the reading measure** (DESIGN.md
/// «Транскрипт»): the square tool mark, the label, a trailing chevron, on the
/// sunken well. It used to be a CENTERED CAPSULE, which was wrong twice — the
/// pill is licensed to tags, badges and active filter chips only, and a column
/// of centred lozenges gave the document a second, wandering left edge that
/// the eye had to re-find after every turn.
///
/// Open it becomes a full-width raised card. This is what keeps the transcript
/// reading as a conversation with service events between turns, not a log.
struct CollapsibleRow<Icon: View, Label: View, Content: View>: View {
    @ViewBuilder var icon: () -> Icon
    @ViewBuilder var label: () -> Label
    @ViewBuilder var content: () -> Content
    /// Ненулевой optional включает боковую шестерёнку вместо карточки.
    /// Значение — число вызовов для accessibility, на экране числа нет.
    var mark: Int? = nil
    @State private var expanded: Bool
    @State private var showDetails = false

    init(startExpanded: Bool = false,
         mark: Int? = nil,
         @ViewBuilder icon: @escaping () -> Icon,
         @ViewBuilder label: @escaping () -> Label,
         @ViewBuilder content: @escaping () -> Content) {
        self.icon = icon
        self.label = label
        self.content = content
        self.mark = mark
        _expanded = State(initialValue: startExpanded)
    }

    var body: some View {
        Group {
            if expanded { openCard }
            else if let mark { markChip(mark) }
            else { collapsedPill }
        }
        .sheet(isPresented: $showDetails) {
            NavigationStack {
                ScrollView {
                    VStack(alignment: .leading, spacing: Theme.s3) {
                        label()
                        content()
                    }
                    .padding(Theme.s4)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .background(Theme.bg)
                .navigationTitle("Действия")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .topBarTrailing) {
                        SheetCloseButton { showDetails = false }
                            .accessibilityIdentifier("toolActivity.done")
                    }
                }
            }
            .presentationDetents([.medium, .large])
            .presentationDragIndicator(.visible)
        }
    }

    /// Только шестерёнка в боковом поле сообщения; счётчик доступен VoiceOver
    /// и в заголовке деталей, но не занимает место в разговоре.
    private func markChip(_ count: Int) -> some View {
        Button { showDetails = true } label: {
            icon()
                .frame(width: 28, height: 24)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("transcript.toolActivity")
        .accessibilityLabel(count > 0 ? "Показать \(actionCount(count))" : "Показать вывод")
    }

    private var collapsedPill: some View {
        Button { expanded = true } label: {
            HStack(spacing: Theme.s2) {
                icon()
                label()
                Spacer(minLength: Theme.s2)
                Image(systemName: "chevron.right")
                    .font(.system(size: 9, weight: .semibold))  // бокс глифа
                    .foregroundStyle(Theme.textFaint)
            }
            .padding(.horizontal, Theme.s2)
            .padding(.vertical, 6)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.surfaceSunken,
                        in: RoundedRectangle(cornerRadius: Theme.radiusSm, style: .continuous))
            .contentShape(RoundedRectangle(cornerRadius: Theme.radiusSm, style: .continuous))
        }
        .buttonStyle(.plain)
    }

    private var openCard: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button { expanded = false } label: {
                HStack(spacing: Theme.s2) {
                    icon()
                    label()
                    Spacer(minLength: Theme.s2)
                    Image(systemName: "chevron.down")
                        .font(.system(size: 9, weight: .semibold))  // бокс глифа
                        .foregroundStyle(Theme.textFaint)
                }
                .padding(.horizontal, Theme.s3).padding(.vertical, Theme.s2)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Theme.surfaceSunken)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            content()
                .padding(Theme.s3)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .background(Theme.surface)
        .clipShape(RoundedRectangle(cornerRadius: Theme.radiusMd))
        .overlay(RoundedRectangle(cornerRadius: Theme.radiusMd).stroke(Theme.border, lineWidth: 1))
    }
}

/// A collapsed-by-default machine row with a plain text summary — thinking and
/// tool-result chrome.
struct CollapsibleBody<Content: View>: View {
    let label: String
    var labelColor: Color = Theme.textFaint
    var symbol: String = "ellipsis"
    var symbolColor: Color = Theme.textFaint
    /// Чернила глифа на `symbolColor`. Отдельным параметром, потому что ember
    /// требует ink, а зелёный и красный — ivory; одно фиксированное значение
    /// нечитаемо ровно на одном из трёх.
    var symbolInk: Color = Theme.textOnColor
    @ViewBuilder let content: () -> Content

    var body: some View {
        CollapsibleRow {
            Image(systemName: symbol)
                .font(.system(size: 9, weight: .bold))  // бокс глифа
                .foregroundStyle(symbolInk)
                .frame(width: 18, height: 18)
                .background(symbolColor, in: RoundedRectangle(cornerRadius: Theme.radiusSm))
        } label: {
            Text(label).font(.ui(Theme.sizeMeta)).foregroundStyle(labelColor)
        } content: {
            content()
        }
    }
}
