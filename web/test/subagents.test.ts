import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { HistoryMessage } from '@cc-remote/shared';
import { agentCallsFromBlocks, agentCallsFromLines, agentNotices, toolStep } from '../src/render/Subagents.js';

test('a live Agent line becomes a card anchored on its call id', () => {
  const calls = agentCallsFromLines([
    { id: 1, kind: 'tool_use', text: 'Read {"file_path":"/a"}' },
    { id: 2, kind: 'tool_use', text: 'Agent {"description":"Проверить вход","subagent_type":"Explore","prompt":"…"}', data: { id: 'toolu_A' } },
  ]);
  assert.deepEqual(calls, [{ toolUseId: 'toolu_A', kind: 'Explore', description: 'Проверить вход' }]);
});

test('history: a foreground result ends the card, a background one waits for its notice', () => {
  const history: HistoryMessage[] = [
    { type: 'assistant', uuid: 'a', blocks: [
      { kind: 'tool_use', id: 'fg', name: 'Agent', input: { description: 'fg' } },
      { kind: 'tool_use', id: 'bg', name: 'Agent', input: { description: 'bg' } },
    ] },
    { type: 'user', uuid: 'r', blocks: [
      { kind: 'tool_result', toolUseId: 'fg', text: 'Вход работает.' },
      { kind: 'tool_result', toolUseId: 'bg', text: 'Async agent launched successfully.\nagentId: x' },
    ] },
  ];
  let n = agentNotices(history);
  assert.equal(n.get('fg')?.status, 'completed');
  assert.equal(n.get('fg')?.summary, 'Вход работает.');
  assert.equal(n.get('bg')?.status, undefined);
  assert.equal(n.get('bg')?.async, true);
  history.push({ type: 'user', uuid: 'n', blocks: [{ kind: 'text', text:
    '<task-notification>\n<task-id>x</task-id>\n<tool-use-id>bg</tool-use-id>\n<status>completed</status>\n<summary>Agent "bg" finished</summary>\n<result>Нашёл три места.</result>\n</task-notification>' }] });
  n = agentNotices(history);
  assert.equal(n.get('bg')?.status, 'completed');
  assert.equal(n.get('bg')?.summary, 'Нашёл три места.');
  assert.deepEqual(agentCallsFromBlocks(history[0]!.blocks).map((c) => c.toolUseId), ['fg', 'bg']);
});

test('toolStep words a live tool line as a sentence, the raw call kept as detail', () => {
  assert.deepEqual(toolStep('Bash {"command":"git status","description":"x"}'), { text: 'X', detail: 'git status' });
  assert.deepEqual(toolStep('Read {"file_path":"/srv/a.ts"}'), { text: 'Читаю a.ts', detail: '/srv/a.ts' });
  assert.equal(toolStep('$ ls -la').text, 'Смотрю, что в папке');
  assert.equal(toolStep('edit src/a.ts src/b.ts').text, 'Правлю a.ts, b.ts');
  assert.equal(toolStep('web_search: bifrost 1.6').text, 'Ищу в интернете: bifrost 1.6');
  assert.equal(toolStep('TodoWrite {"todos":[]}').text, 'Обновляю план');
  assert.equal(toolStep('mcp__hegai__plan {"todos":[]}').text, 'Обновляю план');
  // A clipped line still reads.
  assert.equal(toolStep('Bash {"command":"git sta').text, 'Смотрю git');
  assert.ok(toolStep(`Bash ${JSON.stringify({ command: 'x'.repeat(400) })}`).text.length <= 160);
});
