import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { withCodexAppServer } from '../src/codex-rpc.js';

/** A stand-in `codex app-server`: logs every frame, answers by method name. */
const SERVER = `
import { createInterface } from 'node:readline';
import { appendFileSync, writeFileSync } from 'node:fs';
writeFileSync(process.env.CCR_RPC_PID, String(process.pid));
createInterface({ input: process.stdin }).on('line', (line) => {
  appendFileSync(process.env.CCR_RPC_LOG, line + '\\n');
  let m;
  try { m = JSON.parse(line); } catch { return; }
  if (m.id === undefined) return;
  if (m.method === 'slow') return;
  if (m.method === 'die') process.exit(3);
  const reply = m.method === 'bad'
    ? { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'no such method' } }
    : { jsonrpc: '2.0', id: m.id, result: { echo: m.method } };
  process.stdout.write('not json\\n' + JSON.stringify(reply) + '\\n');
});
`;

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'ccr-rpc-test-'));
  const bin = join(root, 'codex');
  writeFileSync(bin, `#!${process.execPath}\n${SERVER}`, { mode: 0o755 });
  const log = join(root, 'frames.jsonl');
  const pidFile = join(root, 'pid');
  const keys = ['CODEX_BIN', 'CCR_RPC_LOG', 'CCR_RPC_PID'] as const;
  const before = keys.map((key) => process.env[key]);
  Object.assign(process.env, { CODEX_BIN: bin, CCR_RPC_LOG: log, CCR_RPC_PID: pidFile });
  t.after(() => {
    keys.forEach((key, i) => {
      if (before[i] === undefined) delete process.env[key];
      else process.env[key] = before[i];
    });
    rmSync(root, { recursive: true, force: true });
  });
  const frames = () =>
    (existsSync(log) ? readFileSync(log, 'utf8') : '').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
  return { frames, pidFile };
}

test('handshake first, then requests resolve with the raw response frame', async (t) => {
  const { frames } = fixture(t);
  const answer = await withCodexAppServer({ timeoutMs: 5000 }, async (rpc) => {
    const first = await rpc.request('model/list', { limit: 1 });
    const second = await rpc.request('bad', {});
    return { first, second };
  });
  assert.deepEqual(answer.first['result'], { echo: 'model/list' });
  // an error frame is an answer, not a rejection: the caller decides what it means
  assert.equal((answer.second['error'] as { message: string }).message, 'no such method');
  assert.deepEqual(
    frames().map((f) => f['method']),
    ['initialize', 'initialized', 'model/list', 'bad'],
  );
});

test('a request nobody answers rejects with the method named', async (t) => {
  fixture(t);
  // The budget covers the spawn and the `initialize` handshake too; on a box
  // under load 1.5 s was not always enough for a fixture to come up, and the
  // timeout then named `initialize` instead of `slow`.
  await assert.rejects(
    withCodexAppServer({ timeoutMs: 4000 }, (rpc) => rpc.request('slow', {})),
    /codex slow timed out/,
  );
});

test('the process dying mid-request rejects at once, not at the deadline', async (t) => {
  fixture(t);
  const started = Date.now();
  await assert.rejects(
    withCodexAppServer({ timeoutMs: 10_000 }, (rpc) => rpc.request('die', {})),
    /codex app-server exited \(3\)/,
  );
  assert.ok(Date.now() - started < 5000);
});

test('the app-server is killed when the work is done, and when it throws', async (t) => {
  const { pidFile } = fixture(t);
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  for (const failing of [false, true]) {
    const run = withCodexAppServer({ timeoutMs: 5000 }, async (rpc) => {
      await rpc.request('ping', {});
      if (failing) throw new Error('caller failed');
    });
    if (failing) await assert.rejects(run, /caller failed/);
    else await run;
    const pid = Number(readFileSync(pidFile, 'utf8'));
    const end = Date.now() + 5000;
    while (alive(pid) && Date.now() < end) await delay(20);
    assert.equal(alive(pid), false, 'app-server should be gone');
  }
});
