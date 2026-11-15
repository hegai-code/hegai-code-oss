/**
 * The rendering layer is where a bug is invisible until it eats a message:
 * Telegram rejects the WHOLE message on one unbalanced tag, and the fallback
 * only fires for errors it recognises. These cases are the ones agent output
 * actually produces.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  historyDocument,
  historyTurns,
  mdToHtml,
  notifyBody,
  oneLine,
  projectLabel,
  speech,
  stripHarnessNoise,
  toolLine,
} from '../src/render.js';
import { splitText } from '../src/telegram.js';

test('escapes html that agent output is full of', () => {
  assert.equal(mdToHtml('a < b && c > d'), 'a &lt; b &amp;&amp; c &gt; d');
  assert.equal(mdToHtml('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
});

test('code survives escaping without being double-escaped', () => {
  assert.equal(mdToHtml('`a < b`'), '<code>a &lt; b</code>');
  assert.equal(
    mdToHtml('```ts\nconst a = <T,>(x: T) => x;\n```'),
    '<pre><code class="language-ts">const a = &lt;T,&gt;(x: T) =&gt; x;</code></pre>',
  );
});

test('bold and links, but never italics', () => {
  assert.equal(mdToHtml('**важно**'), '<b>важно</b>');
  assert.equal(mdToHtml('[док](https://a.test)'), '<a href="https://a.test">док</a>');
  // A lone asterisk in a path must not open a tag Telegram will reject.
  assert.equal(mdToHtml('rm src/*.ts'), 'rm src/*.ts');
  assert.equal(mdToHtml('snake_case_name and _another_'), 'snake_case_name and _another_');
});

test('headings and bullets become plain structure', () => {
  assert.equal(mdToHtml('## Заголовок'), '<b>Заголовок</b>');
  assert.equal(mdToHtml('- один\n- два'), '• один\n• два');
});

test('harness plumbing never reaches the chat', () => {
  const raw = 'Готово.<system-reminder>секрет</system-reminder>';
  assert.equal(stripHarnessNoise(raw), 'Готово.');
  assert.equal(speech('<task-notification>шум</task-notification>'), '');
  assert.ok(!speech(raw).includes('секрет'));
});

test('a long turn is split on boundaries, not mid-word', () => {
  const text = `${'а'.repeat(100)}\n\n${'б'.repeat(100)}`;
  const parts = splitText(text, 120);
  assert.equal(parts.length, 2);
  assert.ok(parts[0]?.endsWith('а'));
  assert.ok(parts[1]?.startsWith('б'));
  assert.ok(parts.every((p) => p.length <= 120));
});

test('short text is not split at all', () => {
  assert.deepEqual(splitText('коротко', 100), ['коротко']);
});

test('tool lines collapse to name plus the one useful field', () => {
  assert.equal(toolLine('Bash {"command":"npm run build","timeout":1}'), '▸ Bash npm run build');
  assert.equal(toolLine('$ git status'), '▸ $ git status');
});

test('project labels disambiguate generic leaves', () => {
  assert.equal(projectLabel('/Users/x/claudehegai'), 'claudehegai');
  assert.equal(projectLabel('/Users/x/hegainews/web'), 'hegainews/web');
});

test('history keeps one agent thought as one turn', () => {
  // A tool call sits between two halves of a single answer; tools are invisible
  // here, so not merging would print АГЕНТ twice for one thought.
  const turns = historyTurns([
    { type: 'user', blocks: [{ kind: 'text', text: 'почини' }], ts: 1 },
    { type: 'assistant', blocks: [{ kind: 'text', text: 'Смотрю.' }], ts: 2 },
    { type: 'assistant', blocks: [{ kind: 'tool_use' }], ts: 3 },
    { type: 'user', blocks: [{ kind: 'tool_result', text: '' }], ts: 4 },
    { type: 'assistant', blocks: [{ kind: 'text', text: 'Нашёл.' }], ts: 5 },
    { type: 'system', blocks: [{ kind: 'text', text: 'hook output' }], ts: 6 },
  ]);
  assert.deepEqual(
    turns.map((t) => [t.role, t.text]),
    [
      ['user', 'почини'],
      ['assistant', 'Смотрю.\n\nНашёл.'],
    ],
  );
});

test('history renders user as plain and agent as markdown', () => {
  const doc = historyDocument([
    { role: 'user', text: 'смотри **сюда** <b>', ts: undefined },
    { role: 'assistant', text: 'готово **точно**', ts: undefined },
  ]);
  assert.match(doc.text, /смотри \*\*сюда\*\* &lt;b&gt;/);
  assert.match(doc.text, /готово <b>точно<\/b>/);
  assert.match(doc.text, /<code>ТЫ<\/code>/);
  assert.match(doc.text, /<code>АГЕНТ<\/code>/);
});

test('only long turns collapse behind "show more"', () => {
  const short = historyDocument([{ role: 'user', text: 'коротко', ts: undefined }]);
  assert.ok(short.text.includes('<blockquote>'));
  assert.ok(!short.text.includes('expandable'));
  const long = historyDocument([{ role: 'user', text: 'а'.repeat(500), ts: undefined }]);
  assert.ok(long.text.includes('<blockquote expandable>'));
});

test('history keeps the END of a conversation, in order', () => {
  const turns = Array.from({ length: 20 }, (_, i) => ({
    role: (i % 2 ? 'assistant' : 'user') as 'user' | 'assistant',
    text: `ход ${i} ${'x'.repeat(200)}`,
    ts: undefined,
  }));
  const doc = historyDocument(turns, 1000);
  assert.ok(doc.omitted > 0, 'a budget that small must drop something');
  assert.ok(doc.text.includes('ход 19'), 'the newest turn must survive');
  assert.ok(!doc.text.includes('ход 0'), 'the oldest must be the one dropped');
  assert.ok(doc.text.indexOf('ход 18') < doc.text.indexOf('ход 19'), 'order stays chronological');
});

test('a clipped agent turn keeps its conclusion, a user turn keeps its ask', () => {
  // One agent turn spans every tool call it made: narration first, answer last.
  const agent = historyDocument([
    { role: 'assistant', text: `НАЧАЛО\n${'середина\n'.repeat(400)}ВЫВОД`, ts: undefined },
  ]);
  assert.ok(agent.text.includes('ВЫВОД'), 'the conclusion must survive');
  assert.ok(!agent.text.includes('НАЧАЛО'), 'narration is what gets dropped');

  const user = historyDocument([
    { role: 'user', text: `ПРОСЬБА\n${'подробности\n'.repeat(400)}ХВОСТ`, ts: undefined },
  ]);
  assert.ok(user.text.includes('ПРОСЬБА'), 'the ask must survive');
  assert.ok(!user.text.includes('ХВОСТ'));

  assert.ok(agent.text.includes('…') && user.text.includes('…'));
  assert.ok(!/<[a-z]*$/.test(agent.text), 'must not end inside an open tag');
});

test('oneLine collapses whitespace and clips', () => {
  assert.equal(oneLine('a\n\n  b'), 'a b');
  assert.equal(oneLine('абвгде', 4), 'абв…');
});

test('notification body never invents a question', () => {
  // A run re-adopted after a hub restart comes back without a preview. The old
  // fallback said «ждёт ответа» — the owner went looking for a question that
  // was never asked. Now the text claims only what the state actually means.
  assert.equal(
    notifyBody({ state: 'needs_attention' }),
    'сессия остановилась и ждёт решения: подтверждение инструмента или ответ',
  );
  assert.equal(notifyBody({ state: 'error' }), 'сессия упала — загляните в неё');
  assert.equal(notifyBody({ state: 'needs_attention', preview: '  ' }).includes('ждёт решения'), true);
  // With a preview the agent's own words win, trimmed to one line.
  assert.equal(notifyBody({ state: 'needs_attention', preview: 'Готово:\nсобрал витрину' }), 'Готово: собрал витрину');
});
