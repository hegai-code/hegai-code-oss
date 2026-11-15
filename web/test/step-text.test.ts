import { test } from 'node:test';
import assert from 'node:assert/strict';
import { humanAction, humanStep, humanToolLine } from '../src/stepText.js';

test('step text: a Bash description is the step, the command stays as detail', () => {
  const s = humanStep('Bash', { command: 'du -sh ~/*', description: 'размер папок в домашней директории' });
  assert.equal(s.text, 'Размер папок в домашней директории');
  assert.equal(s.detail, 'du -sh ~/*');
});

test('step text: a command without description reads by what it does', () => {
  const rows: Array<[string, string]> = [
    ["cd /srv/main-source; deploy/term.sh dev-mac-mini-001 150 'du -sk'", 'Смотрю размер папок на dev-mac-mini-001'],
    ['ssh -o BatchMode=yes hub-main-box uptime', 'Проверяю состояние hub-main-box'],
    ['until pgrep -x du; do sleep 5; done', 'Жду запуска du'],
    ['npm test', 'Прогоняю тесты'],
    ['grep -rn foo src', 'Ищу в коде'],
    ['node scripts/x.mjs', 'Запускаю скрипт x.mjs'],
  ];
  for (const [cmd, want] of rows) assert.equal(humanStep('Bash', { command: cmd }).text, want, cmd);
});

test('step text: a wait names what it waits for', () => {
  const rows: Array<[string, string]> = [
    ['sleep 30', 'Жду 30 с'],
    ['sleep 120', 'Жду 2 мин'],
    ['sleep 60; curl -s -o /dev/null -w "%{http_code}" https://legal.acme.test/api/me', 'Жду 1 мин, потом проверяю legal.acme.test'],
    ['sleep 1; cat /tmp/agents-0/x/tasks/b22y0x2tz.output', 'Жду 1 с, потом читаю b22y0x2tz.output'],
    [`until [ "$(curl -s -o /dev/null -w '%{http_code}' -X POST https://legal.acme.test/api/x)" != 405 ]; do sleep 15; done; curl -s https://legal.acme.test/api/me`, 'Жду ответа legal.acme.test'],
    ['until [ -s /tmp/agents-0/x/tasks/b22y0x2tz.output ]; do sleep 5; done; cat /tmp/agents-0/x/tasks/b22y0x2tz.output', 'Жду фоновую задачу'],
    [`for i in $(seq 1 18); do r=$(git ls-remote origin refs/heads/release | cut -c1-7); [ "$r" != 538d0e0 ] && break; sleep 20; done; ssh prod 'curl -s 127.0.0.1:3002'`, 'Жду ветку release'],
    [`for i in $(seq 1 55); do if git ls-remote origin "refs/ci-ok/7de54047" | grep -q .; then echo ok; fi; sleep 20; done`, 'Жду зелёный CI'],
    ['while pgrep -x cargo >/dev/null; do sleep 5; done', 'Жду, пока завершится cargo'],
    ['until ssh -o BatchMode=yes stage true; do sleep 10; done', 'Жду сервер stage'],
    ['until [ -f /srv/out/done.flag ]; do sleep 2; done', 'Жду файл done.flag'],
    ['while true; do sleep 5; done', 'Жду'],
    ['sleep $T', 'Жду'],
    ['sleep 30; ssh stage uptime', 'Жду 30 с, потом проверяю состояние stage'],
    ['while true\ndo\n  sleep 5\ndone', 'Жду'],
    ['until curl -sf https://x.acme.test/health\ndo sleep 5\ndone', 'Жду ответа x.acme.test'],
    ['while ! pgrep -x cargo; do sleep 1; done', 'Жду запуска cargo'],
    ['while [ -f /tmp/x.lock ]; do sleep 1; done', 'Жду, пока исчезнет x.lock'],
    ['while [ ! -f /tmp/x.flag ]; do sleep 1; done', 'Жду файл x.flag'],
    ['sleep 30; until curl -sf https://a.b; do sleep 5; done', 'Жду 30 с, потом проверяю a.b'],
  ];
  for (const [cmd, want] of rows) assert.equal(humanStep('Bash', { command: cmd }).text, want, cmd);
});

test('step text: file and search tools name the file, not the path', () => {
  assert.equal(humanStep('Read', { file_path: '/srv/a/web/src/App.tsx' }).text, 'Читаю App.tsx');
  assert.equal(humanStep('Edit', { file_path: '/x/y.css' }).text, 'Правлю y.css');
  assert.equal(humanStep('Grep', { pattern: 'stepOf', path: '/srv/a/web' }).text, 'Ищу «stepOf» в web');
  assert.equal(humanStep('WebFetch', { url: 'https://www.github.com/a' }).text, 'Читаю github.com');
  assert.equal(humanStep('mcp__claude_ai_Google_Drive__search_files', {}).text, 'Смотрю Google Drive · search files');
});

test('step text: live lines, Claude and Codex shapes, clipped JSON', () => {
  assert.equal(humanToolLine('Bash {"command":"ls","description":"List files"}').text, 'List files');
  assert.equal(humanToolLine('Bash {"command":"ls -la","description":"List fi').text, 'List fi');
  assert.equal(humanToolLine('$ cargo test -p hub').text, 'Прогоняю тесты');
  assert.equal(humanToolLine('edit src/a.rs, src/b.rs').text, 'Правлю a.rs, b.rs');
  assert.equal(humanToolLine('web_search: swift shimmer').text, 'Ищу в интернете: swift shimmer');
});

test('step text: sub-agent «Tool · what» lines', () => {
  assert.equal(humanAction('Bash · List files in current directory').text, 'List files in current directory');
  assert.equal(humanAction('Bash · Смотрю логи').text, 'Смотрю логи');
  assert.equal(humanAction('Bash · git status && git log -3').text, 'Смотрю, что изменено в git');
  assert.equal(humanAction('Read · /srv/x/README.md').text, 'Читаю README.md');
  assert.equal(humanAction('Analyzing authentication module').text, 'Analyzing authentication module');
});

test('step text: reading commands name the file or folder', () => {
  assert.equal(humanStep('Bash', { command: 'cd /srv/acme; sed -n 1,20p src/lib/index.ts' }).text, 'Читаю index.ts');
  assert.equal(humanStep('Bash', { command: 'cd /srv/acme/src; ls scenarios' }).text, 'Смотрю папку scenarios');
  assert.equal(humanStep('Bash', { command: 'head -40 notes.txt | cut -c1-76' }).text, 'Читаю notes.txt');
  assert.equal(humanStep('Bash', { command: 'git log -1' }).text, 'Смотрю историю git');
  assert.equal(humanAction('$ npm test').text, 'Прогоняю тесты');
});

test('step text: ssh flags without an argument do not eat the host; Russian descriptions with pipes stay', () => {
  assert.equal(humanStep('Bash', { command: 'ssh -t stage uptime' }).text, 'Проверяю состояние stage');
  assert.equal(humanStep('Bash', { command: 'ssh -o BatchMode=yes -T hub-main-box systemctl status x' }).text, 'Проверяю службу x на hub-main-box');
  assert.equal(humanAction('Bash · Смотрю логи hub | последние 50').text, 'Смотрю логи hub | последние 50');
});

test('step text: Codex «Search · q» and ENV=x commands', () => {
  assert.equal(humanAction('Search · swift shimmer').text, 'Ищу в интернете: swift shimmer');
  assert.equal(humanAction('Bash · NODE_ENV=test npm test').text, 'Прогоняю тесты');
});

test('step text: ssh host scan is linear and quote-aware', () => {
  const t = Date.now();
  humanStep('Bash', { command: `ssh ${'-oX '.repeat(2000)}-` });
  assert.ok(Date.now() - t < 200);
  assert.equal(humanStep('Bash', { command: 'ssh -o "ProxyCommand=foo bar" actual-host uptime' }).text, 'Проверяю состояние actual-host');
  assert.equal(humanStep('Bash', { command: 'ssh -i ~/.ssh/k owner@buildbox uptime' }).text, 'Проверяю состояние buildbox');
});

test('step text: a lowercase English description is not run as a command', () => {
  assert.equal(humanAction('Bash · check generated files').text, 'Check generated files');
  assert.equal(humanAction('Bash · check status').text, 'Check status');
  assert.equal(humanAction('Bash · a quick check').text, 'A quick check');
  assert.equal(humanStep('Bash', { command: 'w' }).text, 'Запускаю w');
  assert.equal(humanAction('Bash · node build.mjs').text, 'Запускаю скрипт build.mjs');
});

test('step text: the program a command runs, worded', () => {
  const rows: Array<[string, string]> = [
    ['S=$(timeout 20 du -sk ~/x); echo $S', 'Смотрю размер папок'],
    ["sed -i 's/a/b/' src/app.ts", 'Правлю app.ts'],
    ["python3 - <<'EOF'", 'Запускаю скрипт на Python'],
    ['python3 scripts/run.py --fast', 'Запускаю скрипт run.py'],
    ['FOO=1 sudo xcodegen generate', 'Запускаю xcodegen'],
    ['-x', 'Выполняю команду'],
  ];
  for (const [cmd, want] of rows) assert.equal(humanStep('Bash', { command: cmd }).text, want, cmd);
});

test('step text: work on another machine is named by what is done there', () => {
  const rows: Array<[string, string]> = [
    ['ssh stage', 'Захожу на stage'],
    ['ssh -t owner@buildbox', 'Захожу на buildbox'],
    ["ssh stage 'journalctl -u cc-remote-hub -n 50' | tail -5", 'Читаю лог cc-remote-hub на stage'],
    ['ssh hub-main-box sudo systemctl restart cc-remote-hub.service', 'Перезапускаю cc-remote-hub на hub-main-box'],
    ["ssh stage 'cd /srv/x && git pull --ff-only'", 'Обновляю код на stage'],
    ['ssh stage cat /etc/nginx/nginx.conf && echo ok', 'Читаю nginx.conf на stage'],
    ["ssh stage bash -s <<'EOF'", 'Запускаю скрипт на stage'],
    ['ssh stage ssh inner uptime', 'Захожу на stage'],
    ["deploy/term.sh buildbox-pc 20 'Get-ScheduledTask HegaiSTT-Server'", 'Запускаю Get-ScheduledTask на buildbox-pc'],
    ["deploy/term.sh dev-mac-mini-001 30 'npm test'", 'Прогоняю тесты на dev-mac-mini-001'],
    ["deploy/term.sh dev-mac-mini-001 30 '-x'", 'Даю команду на dev-mac-mini-001'],
    ['rsync -a dist/ stage:/srv/x', 'Копирую файлы'],
    ['systemctl status', 'Проверяю службы'],
    ['rsync -e ssh file.txt stage:/x', 'Копирую файлы'],
    ['GIT_SSH_COMMAND=\"ssh -i k\" git pull', 'Работаю с git'],
    ["ssh stage 'systemctl status --no-pager'", 'Проверяю службы на stage'],
    ['systemctl --user restart --now hub', 'Перезапускаю hub'],
    ["systemctl status -n 50 hub", 'Проверяю службу hub'],
    ["ssh stage 'pm2 restart бот'", 'Выкатываю на stage'],
  ];
  for (const [cmd, want] of rows) assert.equal(humanStep('Bash', { command: cmd }).text, want, cmd);
});

test('step text: systemctl flag runs stay linear', () => {
  const t = Date.now();
  humanStep('Bash', { command: `systemctl ${'--a '.repeat(40)}list-units` });
  assert.ok(Date.now() - t < 200);
});
