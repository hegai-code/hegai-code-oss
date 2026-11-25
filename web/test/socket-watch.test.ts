import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSocketWatch, LATE_MS, OPEN_MS, PROBE_MS } from '../src/socketWatch.js';

/** A clock whose timers fire when told to, on time or late. */
function rig() {
  let t = 0;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const state = { pings: 0, dead: 0, buffered: 0, open: true };
  const watch = createSocketWatch({
    ping: () => {
      if (!state.open) return false;
      state.pings += 1;
      return true;
    },
    buffered: () => state.buffered,
    dead: () => {
      state.dead += 1;
    },
    now: () => t,
    setTimer: (fn, ms) => {
      seq += 1;
      timers.set(seq, { at: t + ms, fn });
      return seq;
    },
    clearTimer: (id) => void timers.delete(id as number),
  });
  const pass = (ms: number) => {
    const end = t + ms;
    for (;;) {
      const next = [...timers.entries()].filter(([, x]) => x.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      timers.delete(next[0]);
      t = Math.max(t, next[1].at);
      next[1].fn();
    }
    t = end;
  };
  /** The machine slept: the clock jumps, then whatever was due fires at once. */
  const sleep = (ms: number) => {
    t += ms;
    for (const [id, x] of [...timers.entries()]) {
      if (x.at > t) continue;
      timers.delete(id);
      x.fn();
    }
  };
  return { watch, state, pass, sleep, timers };
}

/** An open socket whose hub is known to answer. */
function answering() {
  const r = rig();
  r.watch.connecting();
  r.watch.opened();
  r.watch.inbound(true);
  return r;
}

test('a socket that stops answering is condemned after two silent windows', () => {
  const r = answering();
  r.watch.probe();
  r.pass(PROBE_MS);
  assert.equal(r.state.dead, 0, 'one silent window is a slow link');
  r.pass(PROBE_MS);
  assert.equal(r.state.dead, 1);
  r.pass(10 * PROBE_MS);
  assert.equal(r.state.dead, 1, 'once per socket');
});

test('any frame is a sign of life, not only pong', () => {
  const r = answering();
  r.watch.probe();
  r.pass(PROBE_MS + 1);
  r.watch.inbound(false);
  r.pass(PROBE_MS * 3);
  assert.equal(r.state.dead, 0);
});

test('a hub that never answered a pong is not judged by silence', () => {
  const r = rig();
  r.watch.connecting();
  r.watch.opened();
  for (let i = 0; i < 10; i += 1) {
    r.watch.probe();
    r.pass(PROBE_MS);
  }
  assert.equal(r.state.dead, 0);
});

test('a socket still draining what we sent is slow, not dead; a stuck one is dead', () => {
  const r = answering();
  r.state.buffered = 1000;
  r.watch.probe();
  for (let left = 900; left > 0; left -= 100) {
    r.state.buffered = left;
    r.pass(PROBE_MS);
  }
  assert.equal(r.state.dead, 0);
  r.pass(PROBE_MS * 2);
  assert.equal(r.state.dead, 1, 'the queue stopped moving');
});

test('a timer that fired after a sleep asks again instead of condemning', () => {
  const r = answering();
  r.watch.probe();
  r.pass(PROBE_MS);
  const before = r.state.pings;
  r.sleep(PROBE_MS + LATE_MS + 3_600_000);
  assert.equal(r.state.dead, 0);
  assert.equal(r.state.pings, before + 1);
  // …and the socket that really died in the sleep is found out right after.
  r.pass(PROBE_MS * 2);
  assert.equal(r.state.dead, 1);
});

test('a handshake that hangs is abandoned, one that opens is not', () => {
  const hung = rig();
  hung.watch.connecting();
  hung.pass(OPEN_MS);
  assert.equal(hung.state.dead, 1);

  const ok = rig();
  ok.watch.connecting();
  ok.pass(OPEN_MS - 1);
  ok.watch.opened();
  ok.watch.inbound(true);
  ok.pass(OPEN_MS * 5);
  assert.equal(ok.state.dead, 0);
});

test('hold and closed leave nothing armed', () => {
  for (const end of ['hold', 'closed'] as const) {
    const r = answering();
    r.watch.probe();
    r.watch[end]();
    assert.equal(r.timers.size, 0);
    r.pass(PROBE_MS * 5);
    assert.equal(r.state.dead, 0);
  }
});

test('asking on a socket that is not open arms nothing', () => {
  const r = answering();
  r.state.open = false;
  r.watch.probe();
  assert.equal(r.timers.size, 0);
});

test('a second question while one is open does not push the verdict back', () => {
  const r = answering();
  r.watch.probe();
  for (let i = 0; i < 6; i += 1) {
    r.pass(PROBE_MS / 3);
    r.watch.probe();
  }
  assert.equal(r.state.dead, 1);
});

test('a socket condemned young buys the next one more patience', () => {
  const r = answering();
  r.watch.probe();
  r.pass(PROBE_MS * 2);
  assert.equal(r.state.dead, 1);
  r.watch.connecting();
  r.watch.opened();
  r.pass(PROBE_MS * 3);
  assert.equal(r.state.dead, 1, 'three silent windows may be one big frame');
  r.pass(PROBE_MS);
  assert.equal(r.state.dead, 2);
});

test('asking: between a question and the first frame after it', () => {
  const r = answering();
  assert.equal(r.watch.asking(), false);
  r.watch.probe();
  assert.equal(r.watch.asking(), true);
  r.watch.inbound(false);
  assert.equal(r.watch.asking(), false);
});
