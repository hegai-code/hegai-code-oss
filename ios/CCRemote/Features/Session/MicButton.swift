import SwiftUI
import CCRemoteKit

/// Dictation control: **tap to start, tap to stop** (the ChatGPT shape).
///
/// It used to be hold-to-talk, and that is the whole reason dictation "did not
/// work" on the phone: a microphone button is something people click, and a click
/// released before the permission callback returned tore the recognizer down
/// before it ever recorded — silently, with nothing on screen. Tapping has no such
/// race, and the recording state is visible in the button itself (mic → stop).
struct MicButton: View {
    @Binding var text: String
    @Binding var baseText: String
    let dictation: SpeechDictation
    var size: CGFloat = 36
    /// When false, the resting button is transparent (sits inside the composer pill).
    var filled: Bool = true

    var body: some View {
        Button {
            if !dictation.active { baseText = text }
            dictation.toggle()
        } label: {
            Group {
                if dictation.recording {
                    Image(systemName: "stop.fill")
                        .font(.system(size: 12, weight: .medium))
                        .frame(width: 24, height: 24)
                } else {
                    ComposerGlyph(symbol: .microphone)
                }
            }
                .foregroundStyle(dictation.recording ? Theme.textOnColor : Theme.text)
                .frame(width: size, height: size)
                // Скруглённый прямоугольник, а не круг: кругов в этой системе
                // нет вообще («Прямоугольники, никогда не круги»). Микрофон был
                // последним — и самым заметным, потому что стоит в одном ряду
                // с квадратной кнопкой отправки.
                .background(dictation.recording ? Theme.red : (filled ? Theme.surfaceSunken : Color.clear),
                            in: RoundedRectangle(cornerRadius: Theme.radiusMd, style: .continuous))
                // Рисуется на `size`, нажимается на 44.
                .frame(width: max(size, Theme.tapTarget), height: max(size, Theme.tapTarget))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(dictation.finalizing)
        .animation(Theme.ease, value: dictation.recording)
        .accessibilityLabel(dictation.finalizing ? "Распознавание" : dictation.active ? "Остановить запись" : "Начать запись")
    }
}

/// The live audio meter shown while dictating: a row of bars fed by the mic's own
/// RMS, so it reacts to the voice instead of animating on a timer and pretending.
struct DictationWaveform: View {
    let levels: [Float]
    var height: CGFloat = 44

    var body: some View {
        HStack(alignment: .center, spacing: 2) {
            ForEach(Array(levels.enumerated()), id: \.offset) { _, level in
                // Столбик прибора, а не пилюля: у шкал в этой системе концы
                // квадратные.
                RoundedRectangle(cornerRadius: Theme.statusDotRadius, style: .continuous)
                    .fill(Theme.red)
                    .frame(height: max(4, CGFloat(level) * height))
                    .frame(maxWidth: .infinity)
            }
        }
        .frame(height: height)
        .frame(maxWidth: .infinity)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Уровень записи")
        .accessibilityIdentifier("composer.waveform")
    }
}
