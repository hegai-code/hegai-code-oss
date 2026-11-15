import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { LiveRunRow } from '../src/render/Blocks.js';

test('a history run folded in front of a live one is ONE mark with the summed count', () => {
  const before = Array.from({ length: 5 }, (_, i) => ({ kind: 'tool_use' as const, name: 'Read', input: { file_path: `/a/${i}.ts` } }));
  const lines = Array.from({ length: 11 }, (_, i) => ({ id: i + 1, kind: 'tool_use' as const, text: `Bash ${JSON.stringify({ command: `echo ${i}` })}` }));
  const html = renderToStaticMarkup(createElement(LiveRunRow, { lines, current: false, before: before as never }));
  assert.equal((html.match(/class="toolrun"/g) ?? []).length, 1);
  assert.match(html, /<span class="toolrun-count">16<\/span>/);
});

// 04.10.2026: «Bash не выполнен — запрещено правилом в настройках» stood in
// the reading as its own mono line, and the run after it — with no prose to
// ride behind — opened the next paragraph as «⚙ 4 Нули на месте…». The
// transcript is prose only: the refusal is machinery, and a gear never heads
// a paragraph.
test('a refused tool folds into the run, and no gear opens a paragraph', async () => {
  const { groupLive, LiveLine } = await import('../src/render/Blocks.js');
  const tool = (id: number) => ({ id, kind: 'tool_use' as const, text: `Read ${JSON.stringify({ file_path: `/a/${id}.ts` })}` });
  const items = groupLive([
    { id: 1, kind: 'assistant', text: 'Смотрю.', ts: 1 },
    tool(2),
    { id: 3, kind: 'status', code: 'permission_denied', text: 'Bash не выполнен — запрещено правилом в настройках' },
    tool(4),
    { id: 5, kind: 'status', code: 'notification', text: 'Claude Code needs your attention' },
    { id: 6, kind: 'status', text: '💭 думаю' },
    { id: 7, kind: 'assistant', text: 'Нули на месте.', ts: 2 },
  ]);
  // Two items, both prose: the refusal, the CLI notice and the thought are
  // inside the first paragraph's run, not lines of their own.
  assert.deepEqual(items.map((it) => (it.kind === 'line' ? it.line.kind : it.kind)), ['assistant', 'assistant']);
  const html = items
    .map((it) => (it.kind === 'line' ? renderToStaticMarkup(createElement(LiveLine, { line: it.line, runBefore: it.runBefore, runAfter: it.runAfter?.lines })) : ''))
    .join('');
  assert.doesNotMatch(html, /chip-inline lead/);
  // The refusal is still there for whoever opens the capsule.
  assert.match(html, /toolrun-body">(?:(?!<\/details><time).)*Bash не выполнен/s);

  // A run with nothing behind it to ride (it follows the human turn) goes to
  // the END of the paragraph it precedes, not its head.
  const [, line] = groupLive([{ id: 1, kind: 'user', text: 'го' }, tool(2), { id: 3, kind: 'assistant', text: 'Готово.', ts: 3 }]);
  assert.ok(line?.kind === 'line' && line.runBefore);
  const one = renderToStaticMarkup(createElement(LiveLine, { line: line.line, runBefore: line.runBefore }));
  assert.ok(one.indexOf('Готово.') < one.indexOf('toolrun'), one);
});
