import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupHistory, groupLive } from '../src/render/Blocks.js';
import { turnRecaps } from '../src/render/turnRecaps.js';
import type { HistoryMessage } from '@cc-remote/shared';

const msg = (uuid: string, type: 'user' | 'assistant', blocks: HistoryMessage['blocks'], ts: number): HistoryMessage =>
  ({ uuid, type, blocks, ts }) as HistoryMessage;

test('turn recaps: one block after each finished turn, none for the running one', () => {
  const history = [
    msg('u1', 'user', [{ kind: 'text', text: 'посмотри' }], 1000),
    msg('a1', 'assistant', [{ kind: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/a/b.ts' } }], 2000),
    msg('r1', 'user', [{ kind: 'tool_result', toolUseId: 't1', text: 'ok', isError: false }], 2500),
    msg('a2', 'assistant', [{ kind: 'text', text: 'готово' }], 61000),
    msg('u2', 'user', [{ kind: 'text', text: 'ещё' }], 70000),
    msg('a3', 'assistant', [{ kind: 'tool_use', id: 't2', name: 'Bash', input: { command: 'ls', description: 'List' } }], 71000),
  ] as HistoryMessage[];
  const items = groupHistory(history);
  const busy = turnRecaps(items, groupLive([]), true);
  assert.equal(busy.size, 1);
  const first = [...busy.values()][0]!;
  assert.deepEqual(first.steps.map((s) => s.text), ['Читаю b.ts']);
  assert.equal(first.ms, 60000);
  const idle = turnRecaps(items, groupLive([]), false);
  assert.equal(idle.size, 2);
  assert.ok(idle.has(items[items.length - 1]!.id));
});

test('turn recaps: a turn straddling history and the live tail counts once', () => {
  const history = [
    msg('u1', 'user', [{ kind: 'text', text: 'go' }], 1000),
    msg('a1', 'assistant', [{ kind: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/a.ts' } }], 2000),
  ] as HistoryMessage[];
  const live = groupLive([
    { id: 1, kind: 'tool_use', text: '$ npm test' },
    { id: 2, kind: 'assistant', text: 'done', ts: 9000 },
  ]);
  const r = turnRecaps(groupHistory(history), live, false);
  assert.equal(r.size, 1);
  assert.deepEqual([...r.values()][0]!.steps.map((s) => s.text), ['Читаю a.ts', 'Прогоняю тесты']);
  assert.ok(r.has(live[live.length - 1]!.id));
});

test('turn recaps: a turn that ends in machinery claims no duration', () => {
  const history = [
    msg('u1', 'user', [{ kind: 'text', text: 'go' }], 1000),
    msg('a1', 'assistant', [{ kind: 'text', text: 'смотрю' }, { kind: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/a.ts' } }], 2000),
  ] as HistoryMessage[];
  const r = turnRecaps(groupHistory(history), [], false);
  assert.equal([...r.values()][0]!.ms, undefined);
});

test('turn recaps: a history page that begins mid-turn does not count the tail as a whole turn', () => {
  const history = [
    msg('a0', 'assistant', [{ kind: 'tool_use', id: 't0', name: 'Read', input: { file_path: '/x.ts' } }], 500),
    msg('a1', 'assistant', [{ kind: 'text', text: 'готово' }], 900),
    msg('u1', 'user', [{ kind: 'text', text: 'дальше' }], 1000),
    msg('a2', 'assistant', [{ kind: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/a.ts' } }], 2000),
    msg('a3', 'assistant', [{ kind: 'text', text: 'всё' }], 3000),
  ] as HistoryMessage[];
  const r = turnRecaps(groupHistory(history), [], false);
  assert.equal(r.size, 1);
  assert.deepEqual([...r.values()][0]!.steps.map((s) => s.text), ['Читаю a.ts']);
});
