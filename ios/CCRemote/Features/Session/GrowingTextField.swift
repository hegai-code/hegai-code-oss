import SwiftUI
import UIKit

// Растёт до шести строк, затем прокручивается за кареткой после ввода.
// Layout измеряет высоту, но сам по себе не меняет позицию прокрутки:
// иначе ручной скролл и системная анимация UITextView запускают друг друга.

/// `UITextView`, который сообщает наружу о каждом проходе вёрстки.
///
/// Нужен потому, что ширина поля известна только после layout: на первом
/// проходе `bounds.width == 0`, и высота, посчитанная тогда, — это высота
/// одной строки независимо от текста. Без этого сигнала поле, в которое
/// восстановили длинный черновик, открывалось схлопнутым до одной строки.
final class LayoutReportingTextView: UITextView {
    var onLayout: (() -> Void)?
    private static let unboundedHeight: CGFloat = 10_000_000

    #if DEBUG
    // Observe UIKit geometry from the UI test without replacing the text value.
    override var accessibilityLabel: String? {
        get {
            guard ProcessInfo.processInfo.environment["CC_EDITOR_GEOMETRY"] == "1",
                  let range = selectedTextRange else { return super.accessibilityLabel }
            let caret = caretRect(for: range.end)
            let values: [String: Double] = [
                "caretTop": caret.minY, "caretBottom": caret.maxY,
                "visibleTop": bounds.minY + adjustedContentInset.top,
                "visibleBottom": bounds.maxY - adjustedContentInset.bottom,
                "contentWidth": contentSize.width, "width": bounds.width,
                "height": bounds.height, "offset": contentOffset.y,
                "insetBottom": adjustedContentInset.bottom]
            guard values.values.allSatisfy(\.isFinite),
                  let data = try? JSONSerialization.data(withJSONObject: values) else {
                return super.accessibilityLabel
            }
            return String(data: data, encoding: .utf8)
        }
        set { super.accessibilityLabel = newValue }
    }
    #endif

    override func layoutSubviews() {
        super.layoutSubviews()
        // With scrolling off, UITextView sizes its text container to its own
        // bounds. TextKit 2 drops the line fragments that did not fit and does
        // not lay them out again when SwiftUI later grows the field: a draft
        // restored into a one-line field ended up six lines tall with the
        // sixth line blank until the next keystroke. The frame already clips
        // the text, so the container itself needs no height limit.
        if textContainer.size.height < Self.unboundedHeight {
            textContainer.size.height = Self.unboundedHeight
        }
        onLayout?()
    }
}

struct GrowingTextField: UIViewRepresentable {
    @Binding var text: String
    /// Текущая высота поля. Пишется отсюда, читается местом вызова как
    /// `.frame(height:)` — вид не может задать себе высоту сам.
    @Binding var height: CGFloat
    /// Потолок роста. Выше него поле начинает прокручиваться.
    let maxHeight: CGFloat
    /// Report actual keyboard focus to the composer.
    var onFocusChange: (Bool) -> Void = { _ in }
    /// Focus once when enabled, after the text view joins its window.
    /// Updates after manual keyboard dismissal must not steal focus again.
    var autoFocus: Bool = false

    /// Тот же Dynamic Type, что у остального интерфейса.
    static var font: UIFont {
        let base = UIFont(name: "Onest-Regular", size: Theme.sizeBody)
            ?? .systemFont(ofSize: Theme.sizeBody)
        return UIFontMetrics(forTextStyle: .body).scaledFont(for: base)
    }

    /// Высота поля под `lines` строк — то, из чего место вызова считает свой
    /// потолок, чтобы «шесть строк» не превратилось в шесть строк ПРОШЛОГО
    /// кегля при крупном системном тексте.
    static func height(lines: Int) -> CGFloat {
        ceil(font.lineHeight * CGFloat(lines))
    }

    func makeUIView(context: Context) -> LayoutReportingTextView {
        let view = LayoutReportingTextView()
        view.delegate = context.coordinator
        view.backgroundColor = .clear
        view.textContainerInset = .zero
        view.textContainer.lineFragmentPadding = 0
        view.isScrollEnabled = false
        view.alwaysBounceVertical = false
        view.adjustsFontForContentSizeCategory = true
        view.keyboardDismissMode = .interactive
        view.returnKeyType = .default
        // Иначе поле требует себе ширину всего набранного текста и выдавливает
        // из строки композера кнопку отправки — ровно на 375pt, где её и так
        // некуда деть.
        view.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        view.setContentHuggingPriority(.defaultLow, for: .horizontal)
        view.onLayout = { [weak view] in
            guard let view else { return }
            context.coordinator.measure(view)
            context.coordinator.requestFocus(view)
        }
        return view
    }

    func updateUIView(_ view: LayoutReportingTextView, context: Context) {
        context.coordinator.parent = self
        context.coordinator.requestFocus(view)
        if view.text != text {
            view.text = text
            context.coordinator.revealSelectionAfterLayout(view)
        }
        let font = Self.font
        if view.font != font { view.font = font }
        // Цвета — динамические UIColor из токенов: поле обязано переворачиваться
        // вместе с темой, а `UIColor(Color)` разрешение по trait сохраняет.
        view.textColor = UIColor(Theme.text)
        // Курсор — в цвете текста, а не ember: веб `caret-color` не задаёт, и
        // каретка там наследует `color: var(--text)`. Ember — внимание, а не
        // «здесь печатают».
        view.tintColor = UIColor(Theme.text)
        context.coordinator.measure(view)
    }

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    final class Coordinator: NSObject, UITextViewDelegate {
        var parent: GrowingTextField
        /// Последняя отданная наружу высота — чтобы не будить SwiftUI на
        /// каждом проходе вёрстки одним и тем же числом.
        private var reported: CGFloat = 0
        private var heightUpdatePending = false
        private var selectionUpdatePending = false
        private var measuredWidth: CGFloat = 0
        private var focusRequested = false

        func requestFocus(_ view: UITextView) {
            guard parent.autoFocus else { focusRequested = false; return }
            guard !focusRequested, view.window != nil else { return }
            focusRequested = true
            DispatchQueue.main.async { [weak self, weak view] in
                guard let self, self.parent.autoFocus, let view, view.window != nil else { return }
                view.becomeFirstResponder()
            }
        }

        init(_ parent: GrowingTextField) { self.parent = parent }

        func measure(_ view: UITextView) {
            let width = view.bounds.width
            guard width > 0 else { return }
            if abs(width - measuredWidth) > 0.5 {
                measuredWidth = width
                revealSelectionAfterLayout(view)
            }
            let fits = view.sizeThatFits(CGSize(width: width,
                                                height: .greatestFiniteMagnitude)).height
            let line = view.font?.lineHeight ?? GrowingTextField.font.lineHeight
            // Потолок — ЦЕЛОЕ число строк, а не просьба места вызова как есть.
            // Окно в 6.4 строки показывает шесть строк и огрызок седьмой, и
            // огрызком оказывается ровно та строка, в которой стоит каретка:
            // текст виден, а курсор наполовину срезан нижним краем.
            let ceiling = max(line, (parent.maxHeight / line).rounded(.down) * line)
            // Каретка входит в измерение, а не только текст.
            //
            // `sizeThatFits` не считает ПУСТУЮ последнюю строку: после Return
            // она ещё не содержит глифов, и высота возвращается за прежние
            // строки. Поле поэтому оставалось на строку короче, чем нужно
            // каретке, — и ровно на пятом Return (шестая строка, она же
            // потолок) это переставало быть заметным ростом и становилось
            // «печатаю вслепую»: курсор стоял ниже нижнего края окна.
            let caretBottom = caretExtent(view)
            let needed = max(fits, caretBottom)
            let clamped = min(max(needed, ceil(line)), ceiling)

            // Скролл ровно на пределе и ни секундой раньше: включённый на
            // коротком тексте, он заставляет поле ёрзать на одной строке.
            let overflows = needed > ceiling + 0.5
            if view.isScrollEnabled != overflows {
                view.isScrollEnabled = overflows
            }
            guard abs(clamped - reported) > 0.5 else { return }
            reported = clamped
            revealSelectionAfterLayout(view)
            // Несколько правок за один кадр отдают только последнюю высоту.
            // Binding обновляется вне layoutSubviews / updateUIView.
            guard !heightUpdatePending else { return }
            heightUpdatePending = true
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                self.heightUpdatePending = false
                self.parent.height = self.reported
            }
        }

        /// Низ каретки в координатах содержимого, включая нижний отступ
        /// контейнера. `.null` — пока нет выделения или каретка не вычислима.
        private func caretExtent(_ view: UITextView) -> CGFloat {
            guard let selection = view.selectedTextRange else { return 0 }
            let caret = view.caretRect(for: selection.end)
            guard !caret.isNull, !caret.isInfinite else { return 0 }
            return caret.maxY + view.textContainerInset.bottom
        }

        func revealSelectionAfterLayout(_ view: UITextView) {
            guard !selectionUpdatePending else { return }
            selectionUpdatePending = true
            DispatchQueue.main.async { [weak self, weak view] in
                guard let self, let view else { return }
                self.selectionUpdatePending = false
                view.layoutIfNeeded()
                // НЕ спрашиваем `isScrollEnabled`. Он включается только когда
                // текст перерос потолок, а каретка выходит за нижний край РАНЬШЕ
                // этого — на самой границе, где поле уже не растёт, а строка
                // ещё не переполнила его. Именно там этот guard и запирал
                // единственный путь вернуть курсор в поле зрения. Прокрутка
                // содержимого программно работает и при выключенном скролле:
                // `isScrollEnabled` запрещает жест, а не `setContentOffset`.
                guard !view.isTracking, !view.isDragging, !view.isDecelerating,
                      let selection = view.selectedTextRange else { return }
                // Реальная каретка включает пустую строку после Return.
                // contentSize на этом кадре может ещё описывать прежний текст.
                // Без анимации: новая строка должна быть видна сразу, а не
                // после очередной серии scrollRangeToVisible из layout.
                let caret = view.caretRect(for: selection.end)
                guard !caret.isNull, !caret.isInfinite else { return }
                var offset = view.contentOffset
                if caret.maxY > view.bounds.maxY {
                    offset.y = caret.maxY - view.bounds.height
                } else if caret.minY < view.bounds.minY {
                    offset.y = caret.minY
                }
                offset.y = max(0, offset.y)
                // UITextView может уже анимировать системный автоскролл.
                // Прямая установка также останавливает эту старую анимацию.
                view.setContentOffset(offset, animated: false)
            }
        }

        func textViewDidChange(_ textView: UITextView) {
            parent.text = textView.text
            measure(textView)
            revealSelectionAfterLayout(textView)
        }

        func textViewDidChangeSelection(_ textView: UITextView) {
            revealSelectionAfterLayout(textView)
        }

        func textViewDidBeginEditing(_ textView: UITextView) { parent.onFocusChange(true) }
        func textViewDidEndEditing(_ textView: UITextView) { parent.onFocusChange(false) }
    }
}
