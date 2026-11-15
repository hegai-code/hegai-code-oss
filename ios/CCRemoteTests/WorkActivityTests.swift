import XCTest
@testable import CCRemoteKit

/// Та же таблица, что в `web/test/work-activity.test.ts`: Swift-версия — копия,
/// и копии расходятся молча, если их не держит общая таблица. Строку — в обе.
final class WorkActivityTests: XCTestCase {
    private let tools: [(String, String)] = [
        (#"Read {"file_path":"/srv/a.ts"}"#, "Читаю файл"),
        (#"Grep {"pattern":"x"}"#, "Ищу в коде"),
        (#"Edit {"file_path":"a","old_string":"x","new_string":"y"}"#, "Пишу код"),
        (#"WebFetch {"url":"https://www.github.com/x/y","prompt":"p"}"#, "Читаю сайт · github.com"),
        (#"WebSearch {"query":"q"}"#, "Ищу в интернете"),
        (#"Agent {"prompt":"p"}"#, "Работает помощник"),
        (#"TodoWrite {"todos":[]}"#, "Составляю план"),
        (#"mcp__hegai__plan {"todos":[]}"#, "Составляю план"),
        (#"mcp__claude_ai_Google_Drive__search_files {"q":"pitch"}"#, "Смотрю Google Drive"),
        (#"Bash {"command":"npm test"}"#, "Прогоняю тесты"),
        (#"Bash {"command":"git push origin main"}"#, "Работаю с git"),
        (#"Bash {"command":"curl -s https://x"}"#, "Смотрю сайт"),
        (#"Bash {"command":"ssh hub-main-box uptime"}"#, "Работаю на другой машине"),
        (#"Bash {"command":"grep -rn foo src"}"#, "Ищу в коде"),
        (#"Bash {"command":"sed -n 1,20p a.ts"}"#, "Читаю файлы"),
        (#"Bash {"command":"hegai-stt run a.m4a"}"#, "Расшифровываю запись"),
        (#"Bash {"command":"echo hi"}"#, "Запускаю команду"),
        (#"Bash {"command":"git push orig"#, "Работаю с git"),
        ("$ cargo test -p hub", "Прогоняю тесты"),
        ("edit src/a.rs, src/b.rs", "Пишу код"),
        ("web_search: swift shimmer", "Ищу в интернете"),
        ("mcp: figma", "Смотрю figma"),
        ("SomethingNew {}", "Работаю"),
    ]

    func testEachToolReadsAsAShortVerb() {
        for (text, want) in tools { XCTAssertEqual(WorkActivity.tool(text), want, text) }
    }

    func testTheTurnTailDecides() {
        XCTAssertEqual(WorkActivity.label([]), "Думаю")
        XCTAssertEqual(WorkActivity.label([("tool_use", "Read {}", false, nil), ("user", "ещё", false, nil)]), "Думаю")
        XCTAssertEqual(WorkActivity.label([("user", "a", false, nil), ("tool_use", "Read {}", false, nil)]), "Читаю файл")
        XCTAssertEqual(WorkActivity.label([("tool_use", "Read {}", false, nil), ("status", "stderr", false, "stderr")]), "Читаю файл")
        XCTAssertEqual(WorkActivity.label([("tool_use", "$ npm run build", false, nil), ("status", "ok", false, "command_output")]), "Думаю")
        XCTAssertEqual(WorkActivity.label([("status", "", false, "compact_started")]), "Сжимаю контекст")
        XCTAssertEqual(WorkActivity.label([("assistant", "Смотрю", true, nil)]), "Пишу ответ")
        XCTAssertEqual(WorkActivity.label([("assistant", "Готово.", false, nil)]), "Думаю")
    }
}
