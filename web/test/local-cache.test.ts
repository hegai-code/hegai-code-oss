import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { HistoryMessage } from '@cc-remote/shared';
import { LocalCache } from '../src/localCache.js';

/**
 * The device cache that makes a session open at once. Under node there is no
 * IndexedDB, which is itself a case worth pinning: every call must degrade to
 * a no-op rather than throw, and the in-tab memory must still work.
 */
const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() { return store.size; },
  };
  LocalCache.clear();
});

const msg = (type: 'user' | 'assistant', text: string): HistoryMessage =>
  ({ type, uuid: text, blocks: [{ kind: 'text', text }] }) as unknown as HistoryMessage;

test('a page seen in this tab is there synchronously for the next pane', async () => {
  LocalCache.saveTranscript('m::s', [msg('user', 'вопрос'), msg('assistant', 'ответ')]);
  assert.equal(LocalCache.peekTranscript('m::s').length, 2);
  assert.equal((await LocalCache.transcript('m::s')).length, 2, 'the async read answers from memory too');
});

test('without IndexedDB nothing throws and an unseen session is simply empty', async () => {
  assert.deepEqual(LocalCache.peekTranscript('m::none'), []);
  assert.deepEqual(await LocalCache.transcript('m::none'), []);
  assert.equal(await LocalCache.snapshot('u', 'w'), undefined);
  LocalCache.saveSnapshot('u', 'w', []);
});

test('one runaway transcript is not kept', () => {
  LocalCache.saveTranscript('m::big', [msg('assistant', 'x'.repeat(3_100_000))]);
  assert.deepEqual(LocalCache.peekTranscript('m::big'), []);
});

test('another person signing in on this browser gets an empty cache', () => {
  LocalCache.claimFor('alice');
  LocalCache.saveTranscript('m::s', [msg('assistant', 'секрет Алисы')]);
  LocalCache.claimFor('alice');
  assert.equal(LocalCache.peekTranscript('m::s').length, 1, 'the same person keeps it');
  LocalCache.claimFor('bob');
  assert.deepEqual(LocalCache.peekTranscript('m::s'), []);
  assert.equal(store.get('cc-cache-owner'), 'bob');
});

test('the old speech-only preview is swept out of localStorage', () => {
  store.set('cc-tx2:m::s', '{"m":1,"t":[]}');
  store.set('cc-other', 'kept');
  LocalCache.clear();
  assert.equal(store.has('cc-tx2:m::s'), false);
  assert.equal(store.get('cc-other'), 'kept');
});
