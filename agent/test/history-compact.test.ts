import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRecord } from '../src/history.js';

/**
 * Compaction in a transcript: the seam and the summary. Shapes are copied from
 * a real ~/.claude/projects/**\/*.jsonl (2026-08-20).
 */

test('a compact_boundary system record becomes a boundary block', () => {
  const msg = parseRecord({
    type: 'system',
    subtype: 'compact_boundary',
    content: 'Conversation compacted',
    timestamp: '2026-08-20T12:55:36.544Z',
    uuid: '7990ff84',
    compactMetadata: { trigger: 'manual', preTokens: 621244, durationMs: 133514 },
  });
  assert.deepEqual(msg, {
    type: 'system',
    uuid: '7990ff84',
    blocks: [{ kind: 'compact_boundary', trigger: 'manual', preTokens: 621244 }],
    ts: Date.parse('2026-08-20T12:55:36.544Z'),
  });
});

test('other system records are still dropped', () => {
  assert.equal(parseRecord({ type: 'system', subtype: 'informational', content: 'x', uuid: 'u' }), null);
  assert.equal(parseRecord({ type: 'system', content: 'hook output', uuid: 'u' }), null);
});

test('the compact summary is a folded system block, not a user turn', () => {
  const msg = parseRecord({
    type: 'user',
    isCompactSummary: true,
    isVisibleInTranscriptOnly: true,
    uuid: 'sum1',
    message: { role: 'user', content: 'This session is being continued from a previous conversation…\n\nSummary:\n1. …' },
  });
  assert.equal(msg?.type, 'system');
  assert.equal(msg?.blocks[0]?.kind, 'compact_summary');
  assert.match((msg?.blocks[0] as { text: string }).text, /^This session is being continued/);
});

test('an ordinary user turn is unchanged', () => {
  const msg = parseRecord({ type: 'user', uuid: 'u2', message: { content: [{ type: 'text', text: 'привет' }] } });
  assert.deepEqual(msg, { type: 'user', uuid: 'u2', blocks: [{ kind: 'text', text: 'привет' }] });
});
