import SwiftUI

/// A draft speech bubble, not a transcript message. Disappears on cancellation
/// and hands its text back to the editor when recognition finishes.
struct DictationPreview: View {
    let text: String
    let finalizing: Bool
    @ScaledMetric(relativeTo: .body) private var maximumHeight: CGFloat = 144
    @State private var textHeight: CGFloat = 24

    var body: some View {
        HumanPlate(ts: nil) {
            VStack(alignment: .leading, spacing: 8) {
                Text(finalizing ? "Дописываю…" : text.isEmpty ? "Слушаю…" : "Диктовка")
                    .font(.system(.caption))
                    .foregroundStyle(Theme.textMuted)
                if !text.isEmpty {
                    ScrollViewReader { proxy in
                        ScrollView {
                            VStack(alignment: .leading, spacing: 0) {
                                Text(text)
                                    .font(.ui(Theme.sizeBody))
                                    .foregroundStyle(Theme.text)
                                    .lineSpacing(4)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .fixedSize(horizontal: false, vertical: true)
                                    .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { textHeight = $0 }
                                Color.clear.frame(height: 1).id("dictation.tail")
                            }
                        }
                        .frame(height: min(textHeight + 1, maximumHeight))
                        .defaultScrollAnchor(.bottom)
                        .onChange(of: text) { _, _ in proxy.scrollTo("dictation.tail", anchor: .bottom) }
                        .onChange(of: textHeight) { _, _ in proxy.scrollTo("dictation.tail", anchor: .bottom) }
                    }
                }
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(finalizing ? "Дописываю диктовку" : "Диктовка")
        .accessibilityValue(text)
        .accessibilityIdentifier("composer.dictationPreview")
    }
}
