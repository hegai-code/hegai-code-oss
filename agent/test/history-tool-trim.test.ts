import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { HistoryMessage } from '@cc-remote/shared';
import { trimToolPayloads } from '../src/history.js';

// Why this exists: measured across real sessions on this fleet, `tool_use`
// inputs and `tool_result` bodies are 95-99% of a transcript's bytes, and the
// distribution is savagely long-tailed — median ~130 characters, p90 ~1.2k, and
// single blocks up to half a megabyte. Clients fold all of it behind a
// disclosure and clip it on screen anyway, so a phone was paying megabytes to
// render a page of dialogue.

const msg = (blocks: HistoryMessage['blocks']): HistoryMessage => ({
  type: 'assistant',
  uuid: 'u1',
  blocks,
});

test('an oversized tool result is clipped and says how much it is holding back', () => {
  const [out] = trimToolPayloads(
    [msg([{ kind: 'tool_result', toolUseId: 't1', text: 'x'.repeat(50_000) }])],
    1000,
  );
  const block = out!.blocks[0]!;
  assert.equal(block.kind, 'tool_result');
  if (block.kind !== 'tool_result') return;
  assert.ok(block.text.startsWith('x'.repeat(1000)));
  assert.match(block.text, /truncated · 48 KB more/);
  assert.ok(block.text.length < 1100, 'the clipped body stays near the cap');
});

test('the long strings inside a tool input are clipped, its structure is not', () => {
  const [out] = trimToolPayloads(
    [
      msg([
        {
          kind: 'tool_use',
          id: 't1',
          name: 'Write',
          input: { file_path: '/repo/a.ts', content: 'y'.repeat(9000) },
        },
      ]),
    ],
    1000,
  );
  const block = out!.blocks[0]!;
  assert.equal(block.kind, 'tool_use');
  if (block.kind !== 'tool_use') return;
  const input = block.input as Record<string, unknown>;
  // The path is what the collapsed row actually shows — it must survive whole.
  assert.equal(input['file_path'], '/repo/a.ts');
  assert.match(String(input['content']), /^y{1000}\n… truncated · 8 KB more$/);
  assert.equal(block.name, 'Write', 'name and id identify the call — never trimmed');
  assert.equal(block.id, 't1');
});

test('what is already small, and the text you actually read, are left alone', () => {
  const input = [
    msg([
      { kind: 'text', text: 'z'.repeat(40_000) },
      { kind: 'thinking', text: 'w'.repeat(40_000) },
      { kind: 'tool_result', toolUseId: 't1', text: 'short' },
      { kind: 'tool_use', id: 't2', name: 'TodoWrite', input: { todos: [{ status: 'done' }] } },
    ]),
  ];
  const out = trimToolPayloads(input, 1000);
  // Identity, not just equality: nothing was rewritten, so nothing was copied.
  assert.equal(out[0], input[0]);
});

test('a structured input survives when only one of its fields is oversized', () => {
  const [out] = trimToolPayloads(
    [
      msg([
        {
          kind: 'tool_use',
          id: 't1',
          name: 'TodoWrite',
          input: { todos: [{ content: 'ship it', status: 'pending' }], note: 'n'.repeat(5000) },
        },
      ]),
    ],
    1000,
  );
  const block = out!.blocks[0]!;
  if (block.kind !== 'tool_use') throw new Error('expected tool_use');
  const input = block.input as Record<string, unknown>;
  assert.deepEqual(input['todos'], [{ content: 'ship it', status: 'pending' }]);
  assert.match(String(input['note']), /truncated/);
});
