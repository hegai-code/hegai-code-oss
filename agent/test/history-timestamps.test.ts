import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRecord, parseTimestamp } from '../src/history.js';
import { parseCodexRecord } from '../src/codex.js';

// Both transcript formats carry an ISO `timestamp` on the record, not inside the
// message. The rule this file pins: a turn either gets the REAL time or none —
// there is no fallback to "now", because a wrong time reads as a true one.

const claude = (timestamp?: unknown) =>
  ({ type: 'user', uuid: 'u1', message: { content: 'привет' }, ...(timestamp === undefined ? {} : { timestamp }) }) as unknown;

test('an ISO timestamp becomes ms since epoch', () => {
  assert.equal(parseTimestamp('2026-08-14T09:41:12.000Z'), Date.parse('2026-08-14T09:41:12.000Z'));
});

test('a numeric timestamp passes through; junk and absence yield undefined', () => {
  assert.equal(parseTimestamp(1_755_160_872_000), 1_755_160_872_000);
  assert.equal(parseTimestamp('not a date'), undefined);
  assert.equal(parseTimestamp(Number.NaN), undefined);
  assert.equal(parseTimestamp(undefined), undefined);
  assert.equal(parseTimestamp(null), undefined);
});

test('parseRecord stamps a Claude turn, and OMITS the field when it cannot', () => {
  const iso = '2026-08-14T09:41:12.000Z';
  assert.equal(parseRecord(claude(iso))?.ts, Date.parse(iso));
  // Omitted, never null: `ts` is a zod `optional`, so an absent field is the
  // only shape the schema accepts for "unknown".
  const bare = parseRecord(claude());
  assert.equal(bare?.ts, undefined);
  assert.equal('ts' in bare!, false);
  assert.equal('ts' in parseRecord(claude('nonsense'))!, false);
});

test('parseCodexRecord stamps from the rollout line, not the payload', () => {
  const iso = '2026-08-14T09:41:12.000Z';
  const line = (timestamp?: string) =>
    JSON.stringify({
      ...(timestamp === undefined ? {} : { timestamp }),
      type: 'response_item',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hello' }] },
    });
  const stamped = line(iso);
  assert.equal(parseCodexRecord(JSON.parse(stamped), stamped)?.ts, Date.parse(iso));
  const bare = line();
  assert.equal('ts' in parseCodexRecord(JSON.parse(bare), bare)!, false);
});

test('a record with no blocks stays null even when it has a timestamp', () => {
  // The stamp is applied AFTER the payload parse, so it must not resurrect a
  // record the parser already rejected.
  assert.equal(parseRecord({ type: 'user', uuid: 'u1', message: { content: '' }, timestamp: '2026-08-14T09:41:12.000Z' }), null);
});
