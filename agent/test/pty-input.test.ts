import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PtyInput, chunkEnd, type RawWrite } from '../src/pty-input.js';
import { ptyWriter, type IPty } from '../src/terminal.js';

const eagain = (): NodeJS.ErrnoException => Object.assign(new Error('EAGAIN'), { code: 'EAGAIN' });
const tick = () => new Promise((r) => setImmediate(r));
async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

test('chunkEnd never cuts a UTF-8 sequence in half', () => {
  const buf = Buffer.from('ab' + 'я'.repeat(10), 'utf8'); // 2 + 20 bytes
  assert.equal(chunkEnd(buf, 100), buf.length);
  assert.equal(chunkEnd(buf, 5), 4); // 'ab' + one 'я'; byte 5 is a continuation byte
  assert.equal(chunkEnd(buf, 4), 4);
  assert.doesNotThrow(() => buf.subarray(0, chunkEnd(buf, 5)).toString('utf8'));
});

test('a long paste goes out in chunks of at most 512 bytes, in order, surviving EAGAIN and short writes', async () => {
  const got: Buffer[] = [];
  const sizes: number[] = [];
  let calls = 0;
  const write: RawWrite = (buf, cb) => {
    calls++;
    sizes.push(buf.length);
    setImmediate(() => {
      if (calls % 3 === 0) return cb(eagain(), 0); // the pty is full now and then
      const took = calls % 5 === 0 ? Math.min(7, buf.length) : buf.length; // and sometimes takes a little
      got.push(Buffer.from(buf.subarray(0, took)));
      cb(null, took);
    });
  };
  const input = new PtyInput({ write });
  const text = Array.from({ length: 5000 }, (_, i) => `${i}:ж `).join('');
  input.push(text);
  await until(() => input.pending === 0);
  assert.equal(Buffer.concat(got).toString('utf8'), text);
  assert.ok(Math.max(...sizes) <= 512, `largest write ${Math.max(...sizes)}`);
});

test('input nobody reads is dropped after the stall window, with a notice in the terminal', async () => {
  let now = 0;
  const notices: string[] = [];
  const input = new PtyInput({
    write: (_b, cb) => setImmediate(() => cb(eagain(), 0)),
    notice: (t) => notices.push(t),
    stallMs: 1000,
    now: () => now,
  });
  input.push('x'.repeat(4000));
  await tick();
  assert.equal(input.pending, 4000);
  now = 1000;
  await until(() => input.pending === 0);
  assert.equal(notices.length, 1);
  assert.match(notices[0]!, /4000 байт/);
  input.dispose();
});

test('a queue past its cap refuses new input instead of growing', () => {
  const notices: string[] = [];
  const input = new PtyInput({ write: () => {}, notice: (t) => notices.push(t), maxQueueBytes: 100 });
  input.push('a'.repeat(80));
  input.push('b'.repeat(30));
  assert.equal(input.pending, 80);
  assert.equal(notices.length, 1);
});

test('a dead pty (EIO) drops what is queued and takes nothing more', async () => {
  let calls = 0;
  const input = new PtyInput({
    write: (_b, cb) => {
      calls++;
      setImmediate(() => cb(Object.assign(new Error('EIO'), { code: 'EIO' }), 0));
    },
  });
  input.push('z'.repeat(2000));
  await until(() => input.pending === 0);
  assert.equal(calls, 1);
});

test('a synchronous writer (Windows ConPTY) yields between chunks instead of writing a paste in one tick', async () => {
  const writes: string[] = [];
  const term = { write: (d: string) => void writes.push(d) } as unknown as IPty;
  const input = new PtyInput({ write: ptyWriter(term, 'win32') });
  input.push('é'.repeat(2000)); // 4000 bytes
  assert.equal(writes.length, 1, 'only the first chunk in the calling tick');
  await until(() => input.pending === 0);
  assert.equal(writes.join(''), 'é'.repeat(2000));
  assert.ok(writes.every((w) => Buffer.byteLength(w) <= 512));
});

test(
  'REGRESSION 24.09.2026: a paste into a pty that is not reading never freezes the event loop',
  { skip: process.platform === 'win32', timeout: 20_000 },
  async () => {
    const pty = (await import('@homebridge/node-pty-prebuilt-multiarch')) as unknown as {
      spawn: (f: string, a: string[], o: Record<string, unknown>) => IPty;
    };
    const N = 200_000;
    // For two seconds nothing reads the pty's input — the queue fills after a
    // few KB and every further write is EAGAIN. Through node-pty's own write()
    // that EAGAIN spins inside libuv and the loop stops dead; here it must not.
    const term = pty.spawn('/bin/sh', ['-c', `stty raw -echo; sleep 2; head -c ${N} | wc -c`], { cols: 80, rows: 24 });
    let out = '';
    let exited = false;
    term.onData((d) => (out += d));
    term.onExit(() => (exited = true));
    await new Promise((r) => setTimeout(r, 300)); // let stty run first

    let last = Date.now();
    let maxGap = 0;
    const ticker = setInterval(() => {
      const now = Date.now();
      maxGap = Math.max(maxGap, now - last);
      last = now;
    }, 20);
    try {
      const input = new PtyInput({ write: ptyWriter(term) });
      input.push('a'.repeat(N));
      // Wait for the queue to report empty too: `wc` can print the count a
      // tick before the last write callback lowers `pending` (320 !== 0 on a
      // loaded CI runner, 389e854). A queue that really sticks still fails —
      // at the 15 s bound, on the assertion below.
      await until(() => (out.includes(String(N)) && input.pending === 0) || exited, 15_000);
      assert.match(out, new RegExp(`\\b${N}\\b`), `pty output: ${JSON.stringify(out.slice(-200))}`);
      assert.equal(input.pending, 0);
      assert.ok(maxGap < 500, `event loop stalled for ${maxGap}ms`);
    } finally {
      clearInterval(ticker);
      try {
        term.kill();
      } catch {
        /* gone */
      }
    }
  },
);
