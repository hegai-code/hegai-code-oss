import XCTest
@testable import CCRemoteKit

/// Те же случаи, что в `web/test/step-text.test.ts`: Swift-версия — копия, и
/// копии расходятся молча, если их не держит общая таблица. Строку — в обе.
final class StepTextTests: XCTestCase {
    private func bash(_ command: String) -> Step {
        StepText.human(name: "Bash", input: ["command": command])
    }

    func testBashDescriptionIsTheStepAndCommandStaysAsDetail() {
        let s = StepText.human(name: "Bash", input: ["command": "du -sh ~/*",
                                                     "description": "размер папок в домашней директории"])
        XCTAssertEqual(s.text, "Размер папок в домашней директории")
        XCTAssertEqual(s.detail, "du -sh ~/*")
    }

    func testCommandWithoutDescriptionReadsByWhatItDoes() {
        let rows: [(String, String)] = [
            ("cd /srv/main-source; deploy/term.sh dev-mac-mini-001 150 'du -sk'", "Смотрю размер папок на dev-mac-mini-001"),
            ("ssh -o BatchMode=yes hub-main-box uptime", "Проверяю состояние hub-main-box"),
            ("until pgrep -x du; do sleep 5; done", "Жду запуска du"),
            ("npm test", "Прогоняю тесты"),
            ("grep -rn foo src", "Ищу в коде"),
            ("node scripts/x.mjs", "Запускаю скрипт x.mjs"),
        ]
        for (cmd, want) in rows { XCTAssertEqual(bash(cmd).text, want, cmd) }
    }

    func testPlanToolsReadAsPlanUpdate() {
        XCTAssertEqual(StepText.human(name: "TodoWrite", input: ["todos": []]).text, "Обновляю план")
        XCTAssertEqual(StepText.human(name: "mcp__hegai__plan", input: ["todos": []]).text, "Обновляю план")
    }

    func testWaitNamesWhatItWaitsFor() {
        let rows: [(String, String)] = [
            ("sleep 30", "Жду 30 с"),
            ("sleep 120", "Жду 2 мин"),
            (#"sleep 60; curl -s -o /dev/null -w "%{http_code}" https://legal.acme.test/api/me"#, "Жду 1 мин, потом проверяю legal.acme.test"),
            ("sleep 1; cat /tmp/agents-0/x/tasks/b22y0x2tz.output", "Жду 1 с, потом читаю b22y0x2tz.output"),
            (#"until [ "$(curl -s -o /dev/null -w '%{http_code}' -X POST https://legal.acme.test/api/x)" != 405 ]; do sleep 15; done; curl -s https://legal.acme.test/api/me"#, "Жду ответа legal.acme.test"),
            ("until [ -s /tmp/agents-0/x/tasks/b22y0x2tz.output ]; do sleep 5; done; cat /tmp/agents-0/x/tasks/b22y0x2tz.output", "Жду фоновую задачу"),
            (#"for i in $(seq 1 18); do r=$(git ls-remote origin refs/heads/release | cut -c1-7); [ "$r" != 538d0e0 ] && break; sleep 20; done; ssh prod 'curl -s 127.0.0.1:3002'"#, "Жду ветку release"),
            (#"for i in $(seq 1 55); do if git ls-remote origin "refs/ci-ok/7de54047" | grep -q .; then echo ok; fi; sleep 20; done"#, "Жду зелёный CI"),
            ("while pgrep -x cargo >/dev/null; do sleep 5; done", "Жду, пока завершится cargo"),
            ("until ssh -o BatchMode=yes stage true; do sleep 10; done", "Жду сервер stage"),
            ("until [ -f /srv/out/done.flag ]; do sleep 2; done", "Жду файл done.flag"),
            ("while true; do sleep 5; done", "Жду"),
            ("sleep $T", "Жду"),
            ("sleep 30; ssh stage uptime", "Жду 30 с, потом проверяю состояние stage"),
            ("while true\ndo\n  sleep 5\ndone", "Жду"),
            ("until curl -sf https://x.acme.test/health\ndo sleep 5\ndone", "Жду ответа x.acme.test"),
            ("while ! pgrep -x cargo; do sleep 1; done", "Жду запуска cargo"),
            ("while [ -f /tmp/x.lock ]; do sleep 1; done", "Жду, пока исчезнет x.lock"),
            ("while [ ! -f /tmp/x.flag ]; do sleep 1; done", "Жду файл x.flag"),
            ("sleep 30; until curl -sf https://a.b; do sleep 5; done", "Жду 30 с, потом проверяю a.b"),
        ]
        for (cmd, want) in rows { XCTAssertEqual(bash(cmd).text, want, cmd) }
        // За Int.max — не падение (веб пишет число целиком, Swift — 1e+20).
        XCTAssertTrue(bash("sleep 99999999999999999999").text.hasPrefix("Жду "))
    }

    func testFileAndSearchToolsNameTheFileNotThePath() {
        XCTAssertEqual(StepText.human(name: "Read", input: ["file_path": "/srv/a/web/src/App.tsx"]).text, "Читаю App.tsx")
        XCTAssertEqual(StepText.human(name: "Edit", input: ["file_path": "/x/y.css"]).text, "Правлю y.css")
        XCTAssertEqual(StepText.human(name: "Grep", input: ["pattern": "stepOf", "path": "/srv/a/web"]).text, "Ищу «stepOf» в web")
        XCTAssertEqual(StepText.human(name: "WebFetch", input: ["url": "https://www.github.com/a"]).text, "Читаю github.com")
        XCTAssertEqual(StepText.human(name: "mcp__claude_ai_Google_Drive__search_files", input: [String: Any]()).text,
                       "Смотрю Google Drive · search files")
    }

    func testJSONValueInputReadsTheSame() {
        let input: JSONValue = .object(["file_path": .string("/srv/a/web/src/App.tsx")])
        XCTAssertEqual(StepText.human(name: "Read", input: input).text, "Читаю App.tsx")
    }

    func testLiveLinesClaudeAndCodexShapesClippedJSON() {
        XCTAssertEqual(StepText.toolLine(#"Bash {"command":"ls","description":"List files"}"#).text, "List files")
        XCTAssertEqual(StepText.toolLine(#"Bash {"command":"ls -la","description":"List fi"#).text, "List fi")
        XCTAssertEqual(StepText.toolLine("$ cargo test -p hub").text, "Прогоняю тесты")
        XCTAssertEqual(StepText.toolLine("edit src/a.rs, src/b.rs").text, "Правлю a.rs, b.rs")
        XCTAssertEqual(StepText.toolLine("web_search: swift shimmer").text, "Ищу в интернете: swift shimmer")
    }

    func testSubagentToolWhatLines() {
        XCTAssertEqual(StepText.action("Bash · List files in current directory").text, "List files in current directory")
        XCTAssertEqual(StepText.action("Bash · Смотрю логи").text, "Смотрю логи")
        XCTAssertEqual(StepText.action("Bash · git status && git log -3").text, "Смотрю, что изменено в git")
        XCTAssertEqual(StepText.action("Read · /srv/x/README.md").text, "Читаю README.md")
        XCTAssertEqual(StepText.action("Analyzing authentication module").text, "Analyzing authentication module")
    }

    func testReadingCommandsNameTheFileOrFolder() {
        XCTAssertEqual(bash("cd /srv/acme; sed -n 1,20p src/lib/index.ts").text, "Читаю index.ts")
        XCTAssertEqual(bash("cd /srv/acme/src; ls scenarios").text, "Смотрю папку scenarios")
        XCTAssertEqual(bash("head -40 notes.txt | cut -c1-76").text, "Читаю notes.txt")
        XCTAssertEqual(bash("git log -1").text, "Смотрю историю git")
        XCTAssertEqual(StepText.action("$ npm test").text, "Прогоняю тесты")
    }

    func testSshFlagsWithoutArgumentDoNotEatTheHostAndRussianPipesStay() {
        XCTAssertEqual(bash("ssh -t stage uptime").text, "Проверяю состояние stage")
        XCTAssertEqual(bash("ssh -o BatchMode=yes -T hub-main-box systemctl status x").text, "Проверяю службу x на hub-main-box")
        XCTAssertEqual(StepText.action("Bash · Смотрю логи hub | последние 50").text, "Смотрю логи hub | последние 50")
    }

    func testCodexSearchAndEnvCommands() {
        XCTAssertEqual(StepText.action("Search · swift shimmer").text, "Ищу в интернете: swift shimmer")
        XCTAssertEqual(StepText.action("Bash · NODE_ENV=test npm test").text, "Прогоняю тесты")
    }

    func testSshHostScanIsLinearAndQuoteAware() {
        let started = Date()
        _ = bash("ssh " + String(repeating: "-oX ", count: 2000) + "-")
        XCTAssertLessThan(Date().timeIntervalSince(started), 0.2)
        XCTAssertEqual(bash(#"ssh -o "ProxyCommand=foo bar" actual-host uptime"#).text, "Проверяю состояние actual-host")
        XCTAssertEqual(bash("ssh -i ~/.ssh/k owner@buildbox uptime").text, "Проверяю состояние buildbox")
    }

    func testLowercaseEnglishDescriptionIsNotRunAsACommand() {
        XCTAssertEqual(StepText.action("Bash · check generated files").text, "Check generated files")
        XCTAssertEqual(StepText.action("Bash · check status").text, "Check status")
        XCTAssertEqual(StepText.action("Bash · node build.mjs").text, "Запускаю скрипт build.mjs")
    }

    func testProgramOfACommandWorded() {
        let rows: [(String, String)] = [
            ("S=$(timeout 20 du -sk ~/x); echo $S", "Смотрю размер папок"),
            ("sed -i 's/a/b/' src/app.ts", "Правлю app.ts"),
            ("python3 - <<'EOF'", "Запускаю скрипт на Python"),
            ("python3 scripts/run.py --fast", "Запускаю скрипт run.py"),
            ("FOO=1 sudo xcodegen generate", "Запускаю xcodegen"),
            ("-x", "Выполняю команду"),
        ]
        for (cmd, want) in rows {
            XCTAssertEqual(StepText.human(name: "Bash", input: ["command": cmd]).text, want, cmd)
        }
    }

    func testWorkOnAnotherMachineIsNamedByWhatIsDoneThere() {
        let rows: [(String, String)] = [
            ("ssh stage", "Захожу на stage"),
            ("ssh -t owner@buildbox", "Захожу на buildbox"),
            ("ssh stage 'journalctl -u cc-remote-hub -n 50' | tail -5", "Читаю лог cc-remote-hub на stage"),
            ("ssh hub-main-box sudo systemctl restart cc-remote-hub.service", "Перезапускаю cc-remote-hub на hub-main-box"),
            ("ssh stage 'cd /srv/x && git pull --ff-only'", "Обновляю код на stage"),
            ("ssh stage cat /etc/nginx/nginx.conf && echo ok", "Читаю nginx.conf на stage"),
            ("ssh stage bash -s <<'EOF'", "Запускаю скрипт на stage"),
            ("ssh stage ssh inner uptime", "Захожу на stage"),
            ("deploy/term.sh buildbox-pc 20 'Get-ScheduledTask HegaiSTT-Server'", "Запускаю Get-ScheduledTask на buildbox-pc"),
            ("deploy/term.sh dev-mac-mini-001 30 'npm test'", "Прогоняю тесты на dev-mac-mini-001"),
            ("deploy/term.sh dev-mac-mini-001 30 '-x'", "Даю команду на dev-mac-mini-001"),
            ("rsync -a dist/ stage:/srv/x", "Копирую файлы"),
            ("systemctl status", "Проверяю службы"),
            (#"rsync -e ssh file.txt stage:/x"#, "Копирую файлы"),
            (#"GIT_SSH_COMMAND="ssh -i k" git pull"#, "Работаю с git"),
            (#"ssh stage 'systemctl status --no-pager'"#, "Проверяю службы на stage"),
            (#"systemctl --user restart --now hub"#, "Перезапускаю hub"),
            (#"systemctl status -n 50 hub"#, "Проверяю службу hub"),
            (#"ssh stage 'pm2 restart бот'"#, "Выкатываю на stage"),
        ]
        for (cmd, want) in rows { XCTAssertEqual(bash(cmd).text, want, cmd) }
    }

    func testSystemctlFlagRunsStayLinear() {
        let started = Date()
        _ = bash("systemctl " + String(repeating: "--a ", count: 40) + "list-units")
        XCTAssertLessThan(Date().timeIntervalSince(started), 0.2)
    }
}
