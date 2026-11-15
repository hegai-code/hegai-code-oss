import SwiftUI
import CCRemoteKit

// A picture the agent drew, in the transcript: the finished image inline
// (`GeneratedImageView`), and its live twin while it is being drawn
// (`ImageGenCardView`, one per `image_gen` id). Bytes always come through
// `session.image` by ref; the store and the full-screen viewer are the ones the
// attachments use (TranscriptImageView.swift).

extension TranscriptImageStore {
    /// `session.image` answers an empty body for a ref it cannot resolve YET —
    /// the transcript line can land a moment after the live event. One attempt
    /// here; the view retries (`GeneratedImageView.load`) in its own
    /// cancellable task, so a shared in-flight request never outlives its
    /// viewers. Nothing is cached for an empty answer: the store only keeps
    /// what decoded.
    @MainActor
    static func fetch(_ client: CentralClient, _ key: Key) async throws -> SessionImageResult {
        try await client.sessionImage(machineId: key.source.machineId, sessionId: key.source.sessionId,
                                      ref: key.ref, source: key.source.source)
    }
}

/// The finished picture: full column width, its own aspect ratio, the prompt
/// under it in two lines; a tap opens the whole-screen viewer (zoom, share).
struct GeneratedImageView: View {
    let ref: String
    var prompt: String? = nil
    /// The ref just arrived live: an empty answer is retried (3 tries, 2 s).
    var fresh = false
    @Environment(CentralClient.self) private var client
    @Environment(\.transcriptImageSource) private var source
    @State private var image: UIImage?
    @State private var loadedKey: TranscriptImageStore.Key?
    @State private var loading = true
    @State private var retry = 0
    /// Which `load()` owns the state: only the newest one may write it.
    @State private var generation = 0
    @State private var showing = false

    private var key: TranscriptImageStore.Key? {
        guard let source, !ref.isEmpty else { return nil }
        return .init(scope: client.storageScope, source: source, ref: ref)
    }
    private var shown: UIImage? { loadedKey == key ? image : nil }

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.s2) {
            Button {
                if shown != nil { showing = true; Haptics.light() }
                else if !loading { retry += 1 }
            } label: { picture }
            .buttonStyle(.plain)
            .accessibilityLabel(shown != nil ? "Открыть картинку" : loading ? "Загрузка картинки" : "Картинка недоступна")
            .accessibilityHint(prompt ?? "")
            .accessibilityIdentifier(shown != nil ? "transcript.generated.\(ref)" : "transcript.generated.placeholder")
            if let prompt, !prompt.isEmpty {
                Text(prompt)
                    .font(.ui(Theme.sizeMeta)).foregroundStyle(Theme.textMuted)
                    .lineLimit(2).frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityHidden(true)
            }
        }
        .task(id: key) { await load() }
        .task(id: retry) { if retry > 0 { await load() } }
        .fullScreenCover(isPresented: $showing) {
            TranscriptImageViewer(refs: [ref], initialIndex: 0,
                                  seed: loadedKey.flatMap { key in image.map { .init(key: key, image: $0) } })
        }
    }

    @ViewBuilder private var picture: some View {
        Group {
            if let shown {
                Image(uiImage: shown).resizable()
                    .aspectRatio(shown.size, contentMode: .fit)
                    .accessibilityHidden(true)
            } else {
                ZStack {
                    Theme.chip
                    VStack(spacing: Theme.s2) {
                        if loading { ProgressView() }
                        else { Image(systemName: key == nil ? "photo" : "arrow.clockwise").font(.system(size: 22)) }
                        Text(loading ? "Загрузка картинки…" : key == nil ? "Картинка недоступна" : "Картинка недоступна · повторить")
                            .font(.system(.caption)).multilineTextAlignment(.center)
                    }
                    .foregroundStyle(Theme.textMuted).padding(Theme.s3)
                }
                .aspectRatio(1, contentMode: .fit)
            }
        }
        .frame(maxWidth: .infinity)
        .clipShape(RoundedRectangle(cornerRadius: Theme.radiusLg, style: .continuous))
        .overlay { RoundedRectangle(cornerRadius: Theme.radiusLg, style: .continuous).strokeBorder(Theme.rim, lineWidth: 0.5) }
        .contentShape(Rectangle())
    }

    private func load() async {
        guard let key else { image = nil; loadedKey = nil; loading = false; return }
        if loadedKey == key, image != nil { loading = false; return }
        generation += 1
        let mine = generation
        loading = true
        var next: UIImage?
        for attempt in 0..<(fresh ? 3 : 1) {
            if attempt > 0 { try? await Task.sleep(for: .seconds(2)) }
            if Task.isCancelled || key != self.key { break }
            next = await TranscriptImageStore.shared.load(key) { try await TranscriptImageStore.fetch(client, key) }
            if next != nil || Task.isCancelled || key != self.key { break }
        }
        // A newer load owns the placeholder. Otherwise this one must leave it
        // settled even when cancelled (row scrolled away, live line rebuilt):
        // `loading` left true with no task behind it was an eternal
        // «Загрузка картинки…» (11.11.2026). Settled, the tap retries.
        guard mine == generation else { return }
        if Task.isCancelled || key != self.key { loading = false; return }
        image = next; loadedKey = key; loading = false
    }
}

/// One live `image_gen` card: placeholder while drawing, the picture in place
/// once `done`, a compact error row on `failed`.
struct ImageGenCardView: View {
    let card: ImageGenCard

    var body: some View {
        switch card.state {
        case .started:
            ImageGenPlaceholder(card: card)
        case .done:
            if let ref = card.ref {
                GeneratedImageView(ref: ref, prompt: card.prompt, fresh: true)
            } else {
                ImageGenErrorRow(text: "Картинка недоступна")
            }
        case .failed:
            ImageGenErrorRow(text: card.error.map { "Не удалось нарисовать: \($0)" } ?? "Не удалось нарисовать картинку")
        }
    }
}

/// Square placeholder with the client's own clock: no percentage exists
/// upstream, so the bar eases toward 92% (`ImageGenCard.progress`) and only
/// `done` finishes it.
private struct ImageGenPlaceholder: View {
    let card: ImageGenCard
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        SecondClock { now in
            let elapsed = now.timeIntervalSince1970 - card.origin / 1000
            let clock = ImageGenCard.clock(elapsed: elapsed)
            VStack(alignment: .leading, spacing: Theme.s2) {
                ZStack {
                    Theme.chip
                    // Блик гаснет и в Low Power Mode, и пока сцена не активна: репит-анимация
                    // сама не знает ни про то, ни про другое.
                    if !reduceMotion && !PowerState.shared.lowPower && scenePhase == .active { ImageGenShimmer() }
                    VStack(spacing: Theme.s3) {
                        Image(systemName: "photo").font(.system(size: 26)).foregroundStyle(Theme.textFaint)
                        Text("Рисую картинку · \(clock)")
                            .font(.ui(Theme.sizeSmall, weight: .medium)).monospacedDigit()
                            .foregroundStyle(Theme.textMuted)
                        ProgressView(value: ImageGenCard.progress(elapsed: elapsed))
                            .tint(Theme.textMuted)
                            .frame(maxWidth: 180)
                            .animation(reduceMotion ? nil : .linear(duration: 1), value: elapsed)
                    }
                    .padding(Theme.s4)
                }
                .aspectRatio(1, contentMode: .fit)
                .frame(maxWidth: .infinity)
                .clipShape(RoundedRectangle(cornerRadius: Theme.radiusLg, style: .continuous))
                .overlay { RoundedRectangle(cornerRadius: Theme.radiusLg, style: .continuous).strokeBorder(Theme.rim, lineWidth: 0.5) }
                if let prompt = card.prompt, !prompt.isEmpty {
                    Text(prompt)
                        .font(.ui(Theme.sizeMeta)).foregroundStyle(Theme.textMuted)
                        .lineLimit(2).frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Рисую картинку")
            .accessibilityValue(clock)
            .accessibilityHint(card.prompt ?? "")
            .accessibilityIdentifier("transcript.imagegen.placeholder")
        }
    }
}

/// A soft band sweeping across the placeholder. Not drawn under Reduce Motion.
private struct ImageGenShimmer: View {
    @State private var phase: CGFloat = -0.6

    var body: some View {
        GeometryReader { geometry in
            LinearGradient(colors: [.clear, Theme.text.opacity(0.07), .clear], startPoint: .leading, endPoint: .trailing)
                .frame(width: geometry.size.width * 0.6)
                .offset(x: phase * geometry.size.width)
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
        .onAppear {
            withAnimation(.linear(duration: 1.8).repeatForever(autoreverses: false)) { phase = 1 }
        }
    }
}

private struct ImageGenErrorRow: View {
    let text: String

    var body: some View {
        HStack(spacing: Theme.s2) {
            Image(systemName: "exclamationmark.triangle").font(.system(size: 13))
            Text(text).lineLimit(2).frame(maxWidth: .infinity, alignment: .leading)
        }
        .font(.ui(Theme.sizeMeta)).foregroundStyle(Theme.negative)
        .padding(.horizontal, Theme.s2).padding(.vertical, 6)
        .background(Theme.red.opacity(0.12), in: RoundedRectangle(cornerRadius: Theme.radiusSm, style: .continuous))
        .accessibilityIdentifier("transcript.imagegen.error")
    }
}
