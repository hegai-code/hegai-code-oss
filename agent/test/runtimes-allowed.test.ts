import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PermissionMode } from '@cc-remote/shared';

import type { SessionRun } from '../src/claude-session.js';
import { RunManager } from '../src/run-manager.js';
import { claudeDisabledFromEnv } from '../src/runtimes-allowed.js';

class FakeRun implements SessionRun {
  readonly completed = new Promise<void>(() => {});
  sendInput(): void {}
  async interrupt(): Promise<void> {}
  async setModel(): Promise<void> {}
  async setPermissionMode(_mode: PermissionMode): Promise<void> {}
  async setEffort(): Promise<void> {}
  close(): void {}
}

test('CC_REMOTE_DISABLE_CLAUDE: unset or a clear no keeps Claude; anything else turns it off', () => {
  for (const v of [undefined, '', '  ', '0', 'false', 'No', 'off']) assert.equal(claudeDisabledFromEnv(v), false, String(v));
  for (const v of ['1', 'true', 'YES', 'on']) assert.equal(claudeDisabledFromEnv(v), true, v);
  // A typo must never quietly re-enable Claude.
  assert.equal(claudeDisabledFromEnv('ture'), true);
});

function manager(
  created: string[],
  sent: Array<Record<string, unknown>>,
  extra: Partial<ConstructorParameters<typeof RunManager>[0]> = {},
) {
  return new RunManager({
    send: (m) => {
      sent.push(m);
      return true;
    },
    refreshInventory: () => {},
    scheduleInventory: () => {},
    findLiveWriter: async () => undefined,
    claudeDisabled: true,
    createRun: (source) => {
      created.push(source ?? 'claude');
      return new FakeRun();
    },
    ...extra,
  });
}

test('Claude off: a session that names no CLI goes to Codex', () => {
  const created: string[] = [];
  const m = manager(created, []);
  m.startNew('run-1', '/w', 'hi');
  assert.deepEqual(created, ['codex']);
});

test('Claude off: an explicit Claude start or resume is refused, nothing constructed', async () => {
  const created: string[] = [];
  const sent: Array<Record<string, unknown>> = [];
  const m = manager(created, sent);
  m.startNew('run-1', '/w', 'hi', undefined, 'claude');
  await m.resume('run-2', 'session-2', '/w', 'claude');
  assert.deepEqual(created, []);
  const errors = sent.filter((x) => x.type === 'run_status' && x.state === 'error');
  assert.equal(errors.length, 2);
  assert.match(String(errors[0]!.error), /Claude на этой машине выключен/);
  // Codex is untouched.
  m.startNew('run-3', '/w', 'hi', undefined, 'codex');
  assert.deepEqual(created, ['codex']);
});

test('Claude off beats an older Claude default (Telegram never names a CLI)', () => {
  const created: string[] = [];
  const m = manager(created, [], { defaultSource: 'claude' });
  m.startNew('run-1', '/w', 'hi');
  assert.deepEqual(created, ['codex']);
});

test('Claude off: a takeover is refused before any writer is looked up or killed', async () => {
  const created: string[] = [];
  const sent: Array<Record<string, unknown>> = [];
  let looked = 0;
  const killed: number[] = [];
  const m = manager(created, sent, {
    findLiveWriter: async () => {
      looked++;
      return { pid: 4242 };
    },
    readLiveWriters: async () => {
      looked++;
      return new Map([['session-1', { pid: 4242 }]]) as never;
    },
    pidIsAlive: () => true,
    killProcess: (pid) => {
      killed.push(pid);
    },
    sleep: async () => {},
  });
  await m.takeover('run-1', 'session-1', '/w', 'held', undefined, 'claude');
  assert.equal(looked, 0);
  assert.deepEqual(killed, []);
  assert.deepEqual(created, []);
  const refusal = sent.find((x) => x.type === 'run_status' && x.state === 'error');
  assert.equal(refusal?.code, 'resume_refused', 'the composer gets the message back');
});
