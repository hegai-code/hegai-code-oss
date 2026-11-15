import SwiftUI
import CCRemoteKit

/// A monospace code block (Bash command, Write content, pretty JSON fallback).
struct CodeBlock: View {
    let text: String
    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            Text(text)
                .font(.mono(Theme.sizeMeta))
                .foregroundStyle(Theme.text)
                .textSelection(.enabled)
                .padding(Theme.s2)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.surfaceSunken, in: RoundedRectangle(cornerRadius: Theme.radiusSm))
        // Едет вбок сам — и это САМАЯ заметная из возможных поломок жеста:
        // широкий код на телефоне читается только протаскиванием, и шторка,
        // дёргающаяся на каждое такое протаскивание, делает его нечитаемым.
        .sidewaysScroller()
    }
}

/// Смысл машинной строки, а НЕ личность инструмента.
///
/// Канон (DESIGN.md, «Транскрипт»): «Вызовы инструментов — левые машинные
/// строки на той же мере, **три семантических цвета**: зелёный — чтение
/// (безопасно), ember — запись и запуск (с последствиями), красный — ошибка.
/// Не палитра идентичности».
///
/// Цветов было шесть — по семейству на `Edit`, `Bash`, `Read`, `Web`, `Todo`
/// и `Task`. Шесть оттенков в колонке служебных строк кодируют то, что и так
/// написано буквами рядом (имя инструмента), и не кодируют единственное, что
/// нельзя прочитать за долю секунды: **изменит ли этот вызов что-нибудь**.
/// Поэтому ось развёрнута: цвет отвечает на «с последствиями?», имя — на «чем
/// именно».
enum ToolTone {
    /// Смотрит и не трогает: Read, Glob, Grep, Search, WebFetch, TodoWrite, `mcp__hegai__plan`.
    case read
    /// Меняет мир или запускает процесс: Edit, Write, Bash, `$`, Task, Skill.
    case act
    /// Инструмент вернул ошибку.
    case fail

    /// Заливка квадрата. На зелёном и красном — ivory, на ember — только ink
    /// (ivory на ember меряется 2.7:1).
    var fill: Color {
        switch self {
        case .read: return Theme.green
        case .act: return Theme.attn
        case .fail: return Theme.red
        }
    }

    var ink: Color {
        switch self {
        case .read, .fail: return Theme.textOnColor
        case .act: return Theme.onAttn
        }
    }

    /// Тон строки по имени инструмента — ДОСЛОВНЫЙ порт `toolFamily()` из
    /// `web/src/render/Blocks.tsx`. Два регэкспа скопированы целиком и в том же
    /// порядке специально: это ровно тот код, который расходится молча, если
    /// его пересказывать своими словами. Первая версия этого порта так и
    /// сделала — потеряла `monitor`, выдумала `deploy` и объявила незнакомый
    /// инструмент безопасным.
    ///
    /// `TodoWrite` и `mcp__hegai__plan` попадают в `read`, несмотря на «Write» в имени: список задач
    /// живёт внутри хода и наружу ничего не трогает. Классификация идёт по
    /// ПОСЛЕДСТВИЮ, а не по слову в имени, иначе ember достаётся плану и
    /// перестаёт что-либо значить.
    ///
    /// `nil` — не «безопасно», а «не знаю». Незнакомый MCP-инструмент может
    /// делать что угодно, и покрасить его зелёным — это утверждение, которого
    /// никто не проверял; такая строка остаётся служебно-серой, как и всякая
    /// машинерия без вызова.
    static func of(_ name: String) -> ToolTone? {
        if isPlanTool(name) { return .read }
        let n = name.lowercased()
        if n.range(of: "read|glob|grep|^ls$|search|web|fetch|todo|plan|question",
                   options: .regularExpression) != nil { return .read }
        if n == "$" || n.range(of: "edit|write|notebook|bash|terminal|kill|monitor|exec|shell|agent|task|workflow|skill",
                               options: .regularExpression) != nil { return .act }
        return nil
    }
}

/// Квадратная метка машинной строки: первая буква инструмента на его СМЫСЛЕ.
struct ToolSquare: View {
    let name: String
    var size: CGFloat = 18
    /// Переопределение тона — результат инструмента знает про ошибку то, чего
    /// имя вызова знать не может.
    var tone: ToolTone? = nil

    var body: some View {
        let tone = self.tone ?? ToolTone.of(name)
        Text(String(name.prefix(1)).uppercased())
            .font(.ui(size * 0.61, weight: .bold))
            // Без тона — служебно-серый, как и всякая машинерия: см. `ToolTone.of`.
            .foregroundStyle(tone?.ink ?? Theme.textOnColor)
            .frame(width: size, height: size)
            .background(tone?.fill ?? Theme.textFaint,
                        in: RoundedRectangle(cornerRadius: Theme.radiusSm))
    }
}

/// TodoWrite checklist: ✓ completed / ▸ in_progress / ○ pending.
struct TodoListView: View {
    let todos: [JSONValue]
    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            ForEach(Array(todos.enumerated()), id: \.offset) { _, t in
                let status = t["status"]?.stringValue ?? "pending"
                let content = t["content"]?.stringValue ?? ""
                HStack(alignment: .top, spacing: Theme.s2) {
                    Text(mark(status)).font(.mono(Theme.sizeMeta)).foregroundStyle(color(status))
                    Text(content).font(.ui(Theme.sizeSmall)).foregroundStyle(textColor(status))
                        .strikethrough(status == "completed", color: Theme.textFaint)
                }
            }
        }
    }
    private func mark(_ s: String) -> String {
        s == "completed" ? "✓" : s == "in_progress" ? "▸" : "○"
    }
    private func color(_ s: String) -> Color {
        s == "completed" ? Theme.positive : s == "in_progress" ? Theme.orangeText : Theme.textFaint
    }
    private func textColor(_ s: String) -> Color {
        s == "completed" ? Theme.textFaint : s == "in_progress" ? Theme.orangeText : Theme.text
    }
}

/// Edit diff: old lines as `- ` on red tint, new lines as `+ ` on green tint.
struct DiffView: View {
    let oldStr: String
    let newStr: String
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(oldStr.split(separator: "\n", omittingEmptySubsequences: false).enumerated()), id: \.offset) { _, l in
                diffLine("- " + l, tint: Theme.diffDelBg, ink: Theme.negative)
            }
            ForEach(Array(newStr.split(separator: "\n", omittingEmptySubsequences: false).enumerated()), id: \.offset) { _, l in
                diffLine("+ " + l, tint: Theme.diffAddBg, ink: Theme.positive)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .clipShape(RoundedRectangle(cornerRadius: Theme.radiusSm))
    }
    private func diffLine(_ s: String, tint: Color, ink: Color) -> some View {
        Text(s)
            .font(.mono(Theme.sizeMeta))
            .foregroundStyle(ink)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, Theme.s2).padding(.vertical, 1)
            .background(tint)
    }
}

/// A collapsible tool_use block — TodoWrite/Edit/Write/Bash renderers + subtitle,
/// port of `ToolUse` in web/src/render/Blocks.tsx.
struct ToolUseView: View {
    let name: String
    let input: JSONValue

    private var subtitle: String {
        input["file_path"]?.stringValue ?? input["description"]?.stringValue ?? ""
    }

    /// A Codex shell call: no tool name, the command IS the label.
    private var shellCommand: String? {
        name == "$" ? input["command"]?.stringValue : nil
    }

    /// The plan tool's registered name is `mcp__hegai__plan`: a reader sees «План».
    private var title: String { name == planToolName ? "План" : name }

    var body: some View {
        CollapsibleRow(startExpanded: isPlanTool(name), icon: { ToolSquare(name: title, tone: ToolTone.of(name)) }) {
            Text(shellCommand.map { "$ \($0)" } ?? (subtitle.isEmpty ? title : "\(title) · \(subtitle)"))
                .font(.ui(Theme.sizeMeta))
                .foregroundStyle(Theme.textMuted)
                .lineLimit(1)
                .truncationMode(.middle)
        } content: {
            body(for: name)
        }
    }

    @ViewBuilder private func body(for name: String) -> some View {
        if let cmd = shellCommand {
            CodeBlock(text: cmd)
        } else if isPlanTool(name), let todos = input["todos"]?.arrayValue {
            TodoListView(todos: todos)
        } else if name == "Edit", let oldS = input["old_string"]?.stringValue {
            DiffView(oldStr: oldS, newStr: input["new_string"]?.stringValue ?? "")
        } else if (name == "Write" || name == "NotebookEdit"), let content = input["content"]?.stringValue {
            CodeBlock(text: content)
        } else if name == "Bash", let cmd = input["command"]?.stringValue {
            CodeBlock(text: cmd)
        } else {
            CodeBlock(text: input.prettyString)
        }
    }
}
