import SwiftUI
import CCRemoteKit

/// Interactive plan-mode tools rendered as real UI instead of a raw JSON
/// allow/deny (mirrors the web `QuestionModal`):
///  - EnterPlanMode   → enter planning / stay in the current mode.
///  - ExitPlanMode    → reviewed edits / auto-accepted edits / keep planning.
///  - AskUserQuestion → the question(s) with tappable options (+ "Other").
///
/// Both arrive through the normal tool-approval path (`tool_request`); the chosen
/// answer / approval travels back via `decideTool`'s `updatedInput`
/// (PermissionResult.updatedInput). For any other tool this sheet is not used —
/// SessionDetailView routes those to `ToolApprovalSheet`.
struct QuestionSheet: View {
    let request: ToolRequest
    /// (allow, updatedInput, permissionMode) — mode is selected on plan approval.
    let onDecide: (Bool, JSONValue?, PermissionMode?) -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        if request.tool == "ExitPlanMode" {
            PlanBody(request: request, onDecide: decideAndDismiss)
        } else if request.tool == "EnterPlanMode" {
            EnterPlanBody(request: request, onDecide: decideAndDismiss)
        } else {
            AskBody(request: request, onDecide: decideAndDismiss)
        }
    }

    private func decideAndDismiss(_ allow: Bool, _ updated: JSONValue?, _ mode: PermissionMode?) {
        if allow { Haptics.success() } else { Haptics.rigid() }
        onDecide(allow, updated, mode)
        dismiss()
    }
}

// MARK: - Plan review (ExitPlanMode)

private struct PlanBody: View {
    let request: ToolRequest
    let onDecide: (Bool, JSONValue?, PermissionMode?) -> Void

    private var plan: String { request.input["plan"]?.stringValue ?? "" }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Theme.s3) {
                    if plan.isEmpty {
                        Text("Готовы двигаться по плану?")
                            .font(.ui(Theme.sizeSmall)).foregroundStyle(Theme.text)
                    } else {
                        Text(markdown(plan))
                            .font(.ui(Theme.sizeSmall)).foregroundStyle(Theme.text)
                            .textSelection(.enabled)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(Theme.s4)
            }
            .background(Theme.bg)
            .navigationTitle("Ревью плана")
            .inlineTitle()
            .safeAreaInset(edge: .bottom) {
                VStack(spacing: Theme.s2) {
                    Button { onDecide(true, request.input, .default) } label: {
                        choice("Approve and review edits", "Ask before changes that require approval")
                    }
                    .buttonStyle(.borderedProminent)
                    Button { onDecide(true, request.input, .acceptEdits) } label: {
                        choice("Approve and auto-accept edits", "Apply file edits without asking again")
                    }
                    .buttonStyle(.bordered)
                    Button(role: .destructive) { onDecide(false, nil, nil) } label: {
                        choice("Keep planning", "Continue refining the plan")
                    }
                    .buttonStyle(.bordered)
                }
                .padding(Theme.s3)
                .background(.ultraThinMaterial)
            }
        }
        .sheetSize()
    }

    private func choice(_ title: String, _ detail: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title).font(.ui(Theme.sizeSmall, weight: .semibold))
            Text(detail).font(.ui(Theme.sizeMicro)).opacity(0.8)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: - Enter plan mode

private struct EnterPlanBody: View {
    let request: ToolRequest
    let onDecide: (Bool, JSONValue?, PermissionMode?) -> Void

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: Theme.s4) {
                Text(request.title ?? "Claude wants to inspect the project and prepare a plan before making changes.")
                    .font(.ui(Theme.sizeSmall)).foregroundStyle(Theme.text)
                Button { onDecide(true, request.input, nil) } label: {
                    Label("Enter plan mode", systemImage: "list.clipboard")
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .buttonStyle(.borderedProminent)
                Button(role: .cancel) { onDecide(false, nil, nil) } label: {
                    Text("Остаться в текущем режиме").frame(maxWidth: .infinity, alignment: .leading)
                }
                .buttonStyle(.bordered)
                Spacer()
            }
            .padding(Theme.s4)
            .background(Theme.bg)
            .navigationTitle("Режим плана")
            .inlineTitle()
        }
        .sheetSize(detents: [.medium])
    }
}

// MARK: - Question (AskUserQuestion)

private struct AUQOption: Identifiable {
    let label: String
    let description: String?
    var id: String { label }
}
private struct AUQQuestion: Identifiable {
    let index: Int
    let answerKey: String
    let question: String
    let header: String?
    let options: [AUQOption]
    let multiSelect: Bool
    let isSecret: Bool
    var id: Int { index }
}

/// Sentinel label for the auto-provided free-text choice (mapped to typed text
/// before submit); must never equal a real option label.
private let OTHER = "cc-other"

private struct AskBody: View {
    let request: ToolRequest
    let onDecide: (Bool, JSONValue?, PermissionMode?) -> Void

    @State private var picked: [Int: Set<String>] = [:]
    @State private var otherText: [Int: String] = [:]

    private var questions: [AUQQuestion] { Self.parse(request.input["questions"]) }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Theme.s4) {
                    if questions.isEmpty {
                        Text(request.title ?? "Allow \(request.tool)?")
                            .font(.ui(Theme.sizeSmall)).foregroundStyle(Theme.text)
                    }
                    ForEach(questions) { q in questionBlock(q) }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(Theme.s4)
            }
            .background(Theme.bg)
            .navigationTitle("Вопрос")
            .inlineTitle()
            .safeAreaInset(edge: .bottom) { footer }
        }
        .sheetSize()
    }

    @ViewBuilder private func questionBlock(_ q: AUQQuestion) -> some View {
        VStack(alignment: .leading, spacing: Theme.s2) {
            if let h = q.header, !h.isEmpty {
                Text(h.uppercased()).font(.mono(Theme.sizeMicro)).foregroundStyle(Theme.textMuted)
            }
            Text(q.question).font(.ui(Theme.sizeSmall, weight: .medium)).foregroundStyle(Theme.text)
            ForEach(q.options) { opt in optionRow(q, opt.label, opt.description) }
            optionRow(q, OTHER, nil, displayLabel: "Other…")
            if (picked[q.index] ?? []).contains(OTHER) {
                if q.isSecret {
                    SecureField("Type your answer…", text: bindingOther(q.index))
                        .font(.ui(Theme.sizeBody)).textFieldStyle(.roundedBorder)
                } else {
                    TextField("Type your answer…", text: bindingOther(q.index), axis: .vertical)
                        .font(.ui(Theme.sizeBody)).textFieldStyle(.roundedBorder)
                }
            }
        }
    }

    @ViewBuilder private func optionRow(_ q: AUQQuestion, _ label: String, _ desc: String?, displayLabel: String? = nil) -> some View {
        let selected = (picked[q.index] ?? []).contains(label)
        Button { toggle(q, label) } label: {
            HStack(alignment: .top, spacing: Theme.s2) {
                Image(systemName: selected ? (q.multiSelect ? "checkmark.square.fill" : "largecircle.fill.circle")
                                           : (q.multiSelect ? "square" : "circle"))
                    .foregroundStyle(selected ? Theme.onSelect : Theme.textMuted)
                VStack(alignment: .leading, spacing: 2) {
                    Text(displayLabel ?? label).font(.ui(Theme.sizeSmall))
                        .selectedInk(selected, normal: Theme.text)
                    if let d = desc, !d.isEmpty {
                        Text(d).font(.ui(Theme.sizeMicro))
                            .foregroundStyle(selected ? Theme.onSelect.opacity(0.75) : Theme.textMuted)
                    }
                }
                Spacer(minLength: 0)
            }
            .padding(Theme.s3)
            .frame(maxWidth: .infinity, alignment: .leading)
            // Выбранный вариант — НАСТОЯЩИЙ выбор (канон: мультивыбор файлов,
            // строка маленького меню), то есть сплошная плашка `select` с
            // перевёрнутыми чернилами. Был ember-тинт 12%: «нужно внимание» на
            // том, что человек только что выбрал сам.
            .selectionPlate(selected, radius: Theme.radiusSm)
        }
        .buttonStyle(.plain)
    }

    private var footer: some View {
        HStack(spacing: Theme.s3) {
            Button { onDecide(false, nil, nil) } label: {
                Text("Cancel").frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered).tint(Theme.red)
            Button { submit() } label: {
                Text("Submit").frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .disabled(!allAnswered)
        }
        .padding(Theme.s3)
        .background(.ultraThinMaterial)
    }

    // MARK: logic

    private func bindingOther(_ qi: Int) -> Binding<String> {
        Binding(get: { otherText[qi] ?? "" }, set: { otherText[qi] = $0 })
    }

    private func toggle(_ q: AUQQuestion, _ label: String) {
        var cur = picked[q.index] ?? []
        if q.multiSelect {
            if cur.contains(label) { cur.remove(label) } else { cur.insert(label) }
        } else {
            cur = cur.contains(label) ? [] : [label]
        }
        picked[q.index] = cur
    }

    private func answer(for q: AUQQuestion) -> JSONValue? {
        let set = picked[q.index] ?? []
        let labels: [String] = set.compactMap { l in
            l == OTHER ? otherText[q.index]?.trimmingCharacters(in: .whitespacesAndNewlines) : l
        }.filter { !$0.isEmpty }
        guard !labels.isEmpty else { return nil }
        return q.multiSelect ? .array(labels.map { .string($0) }) : .string(labels[0])
    }

    private var allAnswered: Bool { questions.allSatisfy { answer(for: $0) != nil } }

    private func submit() {
        // Claude keys answers by question text; Codex supplies stable ids.
        var answers: [String: JSONValue] = [:]
        for q in questions { if let a = answer(for: q) { answers[q.answerKey] = a } }
        var obj = request.input.objectValue ?? [:]
        obj["answers"] = .object(answers)
        onDecide(true, .object(obj), nil)
    }

    /// Validate the arbitrary-JSON `questions` payload before rendering — drop
    /// malformed entries rather than trusting the shape.
    static func parse(_ raw: JSONValue?) -> [AUQQuestion] {
        guard let arr = raw?.arrayValue else { return [] }
        var out: [AUQQuestion] = []
        for (i, item) in arr.enumerated() {
            guard let question = item["question"]?.stringValue else { continue }
            let opts: [AUQOption] = (item["options"]?.arrayValue ?? []).compactMap { o in
                guard let label = o["label"]?.stringValue else { return nil }
                return AUQOption(label: label, description: o["description"]?.stringValue)
            }
            out.append(AUQQuestion(
                index: i,
                answerKey: item["id"]?.stringValue ?? question,
                question: question,
                header: item["header"]?.stringValue,
                options: opts,
                multiSelect: item["multiSelect"]?.boolValue ?? false,
                isSecret: item["isSecret"]?.boolValue ?? false
            ))
        }
        return out
    }
}

/// Best-effort markdown → AttributedString (full-document, so lists/line breaks
/// survive); falls back to the raw string if parsing fails.
private func markdown(_ s: String) -> AttributedString {
    (try? AttributedString(
        markdown: s,
        options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)
    )) ?? AttributedString(s)
}
