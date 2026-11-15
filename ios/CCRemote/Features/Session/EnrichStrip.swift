import SwiftUI
import CCRemoteKit

/// The suggestion strip (web `EnrichStrip.tsx`): one-tap moves for the turn the
/// agent just finished. Pinned directly above the composer by the screen that
/// mounts it (13.10.2026 — at the transcript's tail it was easy to miss and was
/// read as part of the paragraph above).
///
/// Two rows, because the buttons are not one kind of thing. `answer` and `next`
/// continue the thread — the reply to the question just asked, the step this
/// work implies — and a tap SENDS the text. `idea` proposes something nobody
/// asked for: it sits in its own row, wears a lamp and a dashed edge, and a tap
/// only drops its text into the composer for the person to read, edit and send.
/// Starting a tangent in one tap is how somebody fires work meaning to agree.
///
/// A button shows what it sends — `send`, never `label` — so there is nothing
/// to be afraid of under a thumb. At most three (the caller passes the result
/// of `Enrichment.shown`, which already caps and de-duplicates).
///
/// Pure view — deciding WHEN it shows and where a tap goes belongs to the screen
/// that mounts it (the chat sends into the run or resumes, or drafts an idea;
/// the mirror force-takes the session over and shows no ideas).
struct EnrichStrip: View {
    let enrichment: Enrichment
    /// A tap on an answer / next step. `reply.send` is exactly what was shown.
    let onReply: (Enrichment.QuickReply) -> Void
    /// A tap on an idea. Nil = this screen has no composer to put it in, so
    /// ideas are not rendered at all.
    var onIdea: ((Enrichment.QuickReply) -> Void)? = nil
    /// The ✕: hide the strip for this turn.
    let onDismiss: () -> Void
    /// The mirror's warning that a reply takes the session over. The web puts
    /// it in a tooltip; a phone has none, so it reads as a line under the buttons.
    var replyHint: String? = nil

    private var all: [Enrichment.QuickReply] {
        (enrichment.quickReplies ?? []).compactMap { r -> Enrichment.QuickReply? in
            let text = r.send.trimmingCharacters(in: .whitespacesAndNewlines)
            return text.isEmpty ? nil : Enrichment.QuickReply(label: text, send: text, kind: r.kind)
        }
        .prefix(Enrichment.maxReplies).map { $0 }
    }
    /// Absent `kind` means `answer`: what keeps a hub that predates the field
    /// rendering exactly as it did.
    private var moves: [Enrichment.QuickReply] { all.filter { !$0.isIdea } }
    private var ideas: [Enrichment.QuickReply] { onIdea == nil ? [] : all.filter(\.isIdea) }

    var body: some View {
        if !moves.isEmpty || !ideas.isEmpty {
            VStack(alignment: .leading, spacing: Theme.s1) {
                // Status, not a summary: one line saying whether the agent is
                // done or waiting on you. The ✕ floats over its trailing end as
                // a 44pt target without making the row taller.
                Text(enrichment.headline ?? " ")
                    .font(.ui(Theme.sizeMeta)).foregroundStyle(Theme.textMuted)
                    .lineLimit(1)
                    .frame(maxWidth: .infinity, minHeight: 24, alignment: .leading)
                    .padding(.trailing, Theme.tapTarget)
                    .overlay(alignment: .trailing) { dismissButton.padding(.vertical, -10) }
                // Wrapped, not a sideways scroll (20.10.2026: «листать вбок
                // неудобно»); small type keeps it to a line or two.
                WrapRow(spacing: Theme.s2) {
                    ForEach(Array(moves.enumerated()), id: \.offset) { i, reply in
                        QuickReplyButton(text: reply.send, style: i == 0 ? .primary : .quiet) { onReply(reply) }
                    }
                    if let onIdea {
                        ForEach(Array(ideas.enumerated()), id: \.offset) { _, reply in
                            QuickReplyButton(text: reply.send, style: .idea) { onIdea(reply) }
                        }
                    }
                }
                if let replyHint, !moves.isEmpty {
                    Text(replyHint).font(.ui(Theme.sizeMicro)).foregroundStyle(Theme.textFaint)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, Theme.s3)
            .padding(.top, Theme.s1)
            .padding(.bottom, Theme.s1)
            .frame(maxWidth: Theme.readingWidth)
            .frame(maxWidth: .infinity)
            // Opaque: the transcript must not show through under the buttons.
            .background(Theme.bg)
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("enrich.strip")
        }
    }

    private var dismissButton: some View {
        Button { onDismiss(); Haptics.light() } label: {
            Image(systemName: "xmark").font(.system(size: 13, weight: .semibold))  // бокс глифа
                .foregroundStyle(Theme.textMuted)
                .frame(width: Theme.tapTarget, height: 24)
                .padding(.vertical, 10)  // 24 drawn, 44 under the thumb
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Скрыть подсказки")
        .accessibilityIdentifier("enrich.dismiss")
    }
}

/// A rectangle, not a pill (DESIGN.md). The first move is the action colour; the
/// other moves stand on the `chip` plate (the human turn's surface) with a
/// `border` and `text` ink; an idea is the quietest — sunken well, dashed edge,
/// a lamp, `textMuted` (≥6:1) — and says out loud that it only fills the field.
/// Since 20.10.2026 (owner: «шрифты большие, залезает на текст»): small type,
/// up to two lines, ≥36pt drawn / 44pt hit, wrapped (no sideways scroll); the first
/// move is the `chip` plate with a firmer edge, not a black slab.
private struct QuickReplyButton: View {
    enum Style { case primary, quiet, idea }
    let text: String
    let style: Style
    let action: () -> Void

    private var shape: RoundedRectangle { RoundedRectangle(cornerRadius: Theme.radiusSm, style: .continuous) }
    private var ink: Color {
        switch style {
        case .primary: return Theme.text
        case .quiet: return Theme.text
        case .idea: return Theme.textMuted
        }
    }
    private var fill: Color {
        switch style {
        case .primary: return Theme.chip
        case .quiet: return Theme.surfaceRaised
        case .idea: return Theme.surfaceSunken
        }
    }

    var body: some View {
        Button { action(); Haptics.light() } label: {
            HStack(alignment: .firstTextBaseline, spacing: Theme.s2) {
                if style == .idea {
                    Image(systemName: "lightbulb").font(.system(size: 12, weight: .medium))  // бокс глифа
                        .foregroundStyle(Theme.orangeText)
                }
                Text(text)
                    .font(.ui(Theme.sizeSmall, weight: style == .primary ? .semibold : .regular))
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
                    .foregroundStyle(ink)
            }
            .padding(.horizontal, Theme.s3)
            .padding(.vertical, 6)
            .frame(minWidth: Theme.tapTarget, minHeight: 36)
            .background(fill, in: shape)
            .overlay {
                switch style {
                case .primary: shape.stroke(Theme.text.opacity(0.35), lineWidth: 1)
                case .quiet: shape.stroke(Theme.border, lineWidth: 1)
                case .idea: shape.stroke(Theme.border, style: StrokeStyle(lineWidth: 1, dash: [4, 3]))
                }
            }
            .padding(.vertical, 4)  // 36 drawn, 44 under the thumb
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityHint(style == .idea ? "Добавит в поле ввода, не отправит" : "")
    }
}
