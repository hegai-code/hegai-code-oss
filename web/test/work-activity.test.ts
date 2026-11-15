import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toolActivity, workActivity } from '../src/workActivity.js';

/**
 * The same table lives in `ios/CCRemoteTests/WorkActivityTests.swift`: the
 * Swift port is a copy, and copies drift silently unless a shared table pins
 * them. Add a row to both.
 */
const TOOLS: Array<[string, string]> = [
  ['Read {"file_path":"/srv/a.ts"}', 'Читаю файл'],
  ['Grep {"pattern":"x"}', 'Ищу в коде'],
  ['Edit {"file_path":"a","old_string":"x","new_string":"y"}', 'Пишу код'],
  ['WebFetch {"url":"https://www.github.com/x/y","prompt":"p"}', 'Читаю сайт · github.com'],
  ['WebSearch {"query":"q"}', 'Ищу в интернете'],
  ['Agent {"prompt":"p"}', 'Работает помощник'],
  ['TodoWrite {"todos":[]}', 'Составляю план'],
  ['mcp__hegai__plan {"todos":[]}', 'Составляю план'],
  ['mcp__claude_ai_Google_Drive__search_files {"q":"pitch"}', 'Смотрю Google Drive'],
  ['Bash {"command":"npm test"}', 'Прогоняю тесты'],
  ['Bash {"command":"git push origin main"}', 'Работаю с git'],
  ['Bash {"command":"curl -s https://x"}', 'Смотрю сайт'],
  ['Bash {"command":"ssh hub-main-box uptime"}', 'Работаю на другой машине'],
  ['Bash {"command":"grep -rn foo src"}', 'Ищу в коде'],
  ['Bash {"command":"sed -n 1,20p a.ts"}', 'Читаю файлы'],
  ['Bash {"command":"hegai-stt run a.m4a"}', 'Расшифровываю запись'],
  ['Bash {"command":"echo hi"}', 'Запускаю команду'],
  ['Bash {"command":"git push orig', 'Работаю с git'],
  ['$ cargo test -p hub', 'Прогоняю тесты'],
  ['edit src/a.rs, src/b.rs', 'Пишу код'],
  ['web_search: swift shimmer', 'Ищу в интернете'],
  ['mcp: figma', 'Смотрю figma'],
  ['SomethingNew {}', 'Работаю'],
];

test('work activity: each tool reads as a short verb', () => {
  for (const [text, want] of TOOLS) assert.equal(toolActivity(text), want, text);
});

test('work activity: the turn tail decides, earlier turns do not', () => {
  assert.equal(workActivity([]), 'Думаю');
  assert.equal(workActivity([{ kind: 'tool_use', text: 'Read {}' }, { kind: 'user', text: 'ещё' }]), 'Думаю');
  assert.equal(workActivity([{ kind: 'user', text: 'a' }, { kind: 'tool_use', text: 'Read {}' }]), 'Читаю файл');
  assert.equal(
    workActivity([{ kind: 'tool_use', text: 'Read {}' }, { kind: 'status', text: 'stderr' }]),
    'Читаю файл',
  );
  assert.equal(
    workActivity([{ kind: 'tool_use', text: '$ npm run build' }, { kind: 'status', text: 'ok', code: 'command_output' }]),
    'Думаю',
  );
  assert.equal(workActivity([{ kind: 'status', text: '', code: 'compact_started' }]), 'Сжимаю контекст');
  assert.equal(workActivity([{ kind: 'assistant', text: 'Смотрю', streaming: true }]), 'Пишу ответ');
  assert.equal(workActivity([{ kind: 'assistant', text: 'Готово.' }]), 'Думаю');
});
