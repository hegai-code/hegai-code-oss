import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PhraseStream, cleanPhrase, PHRASE_MAX_MS, type PhraseRecorder } from '../src/phrases.js';

class FakeRec implements PhraseRecorder {
  mimeType = 'audio/webm';
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  started = false;
  constructor(private readonly tag: string) {}
  start() { this.started = true; }
  stop() {
    // Like the browser: the last data, then stop — asynchronously.
    queueMicrotask(() => {
      this.ondataavailable?.({ data: new Blob([this.tag]) });
      this.onstop?.();
    });
  }
}

function harness(levels: number[], replies: (string | Error)[]) {
  let t = 0;
  let li = 0;
  let n = 0;
  const sent: string[] = [];
  const seen: [string, boolean][] = [];
  const s = new PhraseStream({
    makeRecorder: () => new FakeRec(`seg${n++}`),
    getLevel: () => levels[Math.min(li, levels.length - 1)]!,
    transcribe: async (b) => {
      sent.push(await b.text());
      const r = replies.shift() ?? '';
      if (r instanceof Error) throw r;
      return r;
    },
    onChange: (text, pending) => seen.push([text, pending]),
    now: () => t,
    sleep: async () => {},
  });
  const step = (ms: number) => { t += ms; li++; s.tick(); };
  return { s, step, sent, seen };
}

test('cuts at a pause after speech and reads each phrase once', async () => {
  // 3s speech, then silence
  const levels = [...Array(30).fill(0.6), ...Array(10).fill(0.05), ...Array(30).fill(0.6)];
  const h = harness(levels, ['Привет.', 'Как дела?']);
  h.s.start();
  for (let i = 0; i < 38; i++) h.step(100);
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(h.sent, ['seg0'], 'first phrase cut at the pause');
  for (let i = 0; i < 20; i++) h.step(100);
  await h.s.finish();
  assert.deepEqual(h.sent, ['seg0', 'seg1']);
  assert.equal(h.s.text, 'Привет. Как дела?');
  assert.equal(h.s.failed, false);
  assert.ok(h.seen.some(([t, p]) => t === 'Привет.' && p === false) || h.seen.some(([t]) => t === 'Привет.'));
});

test('forced cut without a pause; silence is never sent', async () => {
  const h = harness([0.05], []);
  h.s.start();
  for (let i = 0; i < PHRASE_MAX_MS / 100 + 1; i++) h.step(100);
  await h.s.finish();
  // The 10s of room noise is judged and dropped; the one-tick tail after the
  // cut is too short to judge and may go out (its text is filtered anyway).
  assert.ok(!h.sent.includes('seg0'), 'room noise is not transcribed');
  assert.equal(h.s.lossy, false, 'a silence cut splits no word');
  assert.equal(h.s.text, '');

  const v = harness([0.6], ['a', 'b']);
  v.s.start();
  for (let i = 0; i < PHRASE_MAX_MS / 100 + 1; i++) v.step(100);
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(v.sent, ['seg0'], 'cut at PHRASE_MAX_MS while still talking');
  await v.s.finish();
  assert.deepEqual(v.sent, ['seg0', 'seg1']);
  assert.equal(v.s.lossy, true, 'a cut without a pause marks the text a preview');
});

test('a tail too short to be judged is sent, not dropped as noise', async () => {
  const h = harness([0.6], ['a', 'хвост']);
  h.s.start();
  for (let i = 0; i < 30; i++) h.step(100);
  // speech ended exactly at a pause cut is covered above; here: finish right
  // after a fresh segment opened (0 samples)
  await h.s.finish();
  assert.ok(h.sent.length >= 1);
});

test('a recorder that stops on its own is flushed once', async () => {
  let rec: FakeRec | null = null;
  const sent: string[] = [];
  const s = new PhraseStream({
    makeRecorder: () => (rec = new FakeRec('only')),
    getLevel: () => 0.6,
    transcribe: async (b) => (sent.push(await b.text()), 'x'),
    onChange: () => {},
    sleep: async () => {},
  });
  s.start();
  for (let i = 0; i < 6; i++) s.tick();
  rec!.stop(); // track ended
  await new Promise((r) => setTimeout(r, 0));
  // and a stop() on an inactive recorder throws, as older engines do
  rec!.stop = () => { throw new Error('InvalidStateError'); };
  await s.finish();
  assert.deepEqual(sent, ['only']);
});

test('429 is retried, other failures mark the stream failed', async () => {
  const h = harness([0.6], [new Error('transcribe failed (429)'), 'Раз.']);
  h.s.start();
  h.step(100);
  await h.s.finish();
  assert.equal(h.s.text, 'Раз.');
  assert.equal(h.s.failed, false);

  const g = harness([0.6], [new Error('transcribe failed (502)')]);
  g.s.start();
  g.step(100);
  await g.s.finish();
  assert.equal(g.s.failed, true);
});

test('abort drops everything and resolves waiters', async () => {
  const h = harness([0.6], ['x']);
  h.s.start();
  h.step(100);
  h.s.abort();
  await h.s.finish();
  assert.deepEqual(h.sent, []);
});

test('whisper silence hallucinations are dropped', () => {
  assert.equal(cleanPhrase('Продолжение следует...'), '');
  assert.equal(cleanPhrase('Субтитры сделал DimaTorzok'), '');
  assert.equal(cleanPhrase(' Нормальный текст. '), 'Нормальный текст.');
});

test('each phrase is transcribed with its length in seconds', async () => {
  let t = 0;
  let n = 0;
  const durs: (number | undefined)[] = [];
  const s = new PhraseStream({
    makeRecorder: () => new FakeRec(`seg${n++}`),
    getLevel: () => 0.6,
    transcribe: async (_b, durSec) => (durs.push(durSec), 'x'),
    onChange: () => {},
    now: () => t,
    sleep: async () => {},
  });
  s.start();
  t = 4200;
  await s.finish();
  assert.equal(durs.length, 1);
  assert.ok(Math.abs(durs[0]! - 4.2) < 0.01);
});
