import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TerminalManager, type IPty, type PtyModule } from '../src/terminal.js';

type FakePty = IPty & { killed: boolean; emitData: (d: string) => void; emitExit: (code: number) => void };

function fakePty(opts: { onDataThrows?: boolean } = {}): FakePty {
  let dataCb: (d: string) => void = () => undefined;
  let exitCb: (e: { exitCode: number }) => void = () => undefined;
  const pty: FakePty = {
    killed: false,
    onData: (cb) => {
      if (opts.onDataThrows) throw new Error('onData refused');
      dataCb = cb;
    },
    onExit: (cb) => {
      exitCb = cb;
    },
    write: () => undefined,
    resize: () => undefined,
    kill: () => {
      pty.killed = true;
    },
    emitData: (d) => dataCb(d),
    emitExit: (exitCode) => exitCb({ exitCode }),
  };
  return pty;
}

const noop = () => undefined;

test('a spawn that throws is a failed open, not a rejected promise or a half-open terminal', async () => {
  const mod: PtyModule = {
    spawn: () => {
      throw new Error('chdir failed: no such directory');
    },
  };
  const terminals = new TerminalManager(mod);
  const res = await terminals.open('t1', '/definitely/not/here', noop, noop);
  assert.equal(res.ok, false);
  assert.match(res.error ?? '', /no such directory/);
  assert.equal(terminals.count, 0);
  // Nothing was registered, so stray frames for the id are inert.
  assert.doesNotThrow(() => terminals.input('t1', 'ls\n'));
  assert.doesNotThrow(() => terminals.resize('t1', 100, 30));
  assert.doesNotThrow(() => terminals.close('t1'));
});

test('after a failed spawn the same termId can open for real', async () => {
  const live = fakePty();
  let attempt = 0;
  const mod: PtyModule = {
    spawn: () => {
      if (++attempt === 1) throw new Error('no pty available');
      return live;
    },
  };
  const terminals = new TerminalManager(mod);
  assert.equal((await terminals.open('t1', undefined, noop, noop)).ok, false);
  assert.equal((await terminals.open('t1', undefined, noop, noop)).ok, true);
  assert.equal(terminals.count, 1);
});

test('a pty that spawns but cannot be wired up is killed and not kept', async () => {
  const half = fakePty({ onDataThrows: true });
  const terminals = new TerminalManager({ spawn: () => half });
  const res = await terminals.open('t1', undefined, noop, noop);
  assert.equal(res.ok, false);
  assert.match(res.error ?? '', /onData refused/);
  assert.equal(half.killed, true);
  assert.equal(terminals.count, 0);
});

test('a healthy open registers the terminal, relays output, and forgets it on exit', async () => {
  const pty = fakePty();
  const terminals = new TerminalManager({ spawn: () => pty });
  const out: string[] = [];
  const exits: Array<number | undefined> = [];
  const res = await terminals.open('t1', undefined, (d) => out.push(d), (c) => exits.push(c));
  assert.deepEqual(res, { ok: true });
  assert.equal(terminals.count, 1);
  pty.emitData('hello');
  assert.deepEqual(out, ['hello']);
  pty.emitExit(3);
  assert.deepEqual(exits, [3]);
  assert.equal(terminals.count, 0);
});
