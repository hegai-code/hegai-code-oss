import SwiftUI

/// One AskUserQuestion: option buttons (single-select answers at once, multi
/// toggles + «Отправить») and a free-text «Свой ответ» field (dictation).
struct QuestionView: View {
    let question: WatchQuestion
    /// Called with the chosen answer; the caller decides how to send it.
    let onAnswer: (AnswerValue) -> Void

    @State private var picked: Set<String> = []
    @State private var custom = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(question.question).font(.footnote).foregroundStyle(WatchTheme.ivory)
            ForEach(question.options, id: \.self) { option in
                Button {
                    if question.multiSelect {
                        if picked.contains(option) { picked.remove(option) } else { picked.insert(option) }
                    } else {
                        onAnswer(.one(option))
                    }
                } label: {
                    HStack {
                        if question.multiSelect {
                            Image(systemName: picked.contains(option) ? "checkmark.square.fill" : "square")
                        }
                        Text(option)
                    }
                }
                .buttonStyle(WatchButtonStyle(prominent: question.multiSelect && picked.contains(option)))
            }
            if question.multiSelect {
                Button("Отправить") {
                    // Keep the order the hub listed them in.
                    onAnswer(.many(question.options.filter { picked.contains($0) }))
                }
                .buttonStyle(WatchButtonStyle(prominent: true))
                .disabled(picked.isEmpty)
            }
            TextField("Свой ответ", text: $custom)
                .submitLabel(.send)
                .onSubmit {
                    let t = custom.trimmingCharacters(in: .whitespacesAndNewlines)
                    guard !t.isEmpty else { return }
                    onAnswer(.one(t))
                    custom = ""
                }
        }
    }
}
