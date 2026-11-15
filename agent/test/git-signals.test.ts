import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentToCentral } from '@cc-remote/shared';
import {
  TurnGitSignals,
  baselineMemory,
  decideGitSignals,
  parseRemoteHost,
  type GitProbe,
  type UpstreamState,
} from '../src/git-signals.js';

interface FakeGit {
  head?: string;
  upstream?: UpstreamState;
  url?: string;
}

function fakeProbe(state: FakeGit): GitProbe {
  return {
    head: async () => state.head,
    upstream: async () => state.upstream,
    remoteUrl: async () => state.url,
  };
}

function collector() {
  const sent: AgentToCentral[] = [];
  return { sent, send: (message: AgentToCentral) => (sent.push(message), true) };
}

test('parseRemoteHost keeps the host and nothing else', () => {
  const cases: Array<[string, string | undefined]> = [
    ['https://github.com/org/repo.git', 'github.com'],
    ['https://x-access-token:ghp_secret@github.com/org/repo.git', 'github.com'],
    ['https://GitLab.example.com:8443/group/repo', 'gitlab.example.com'],
    ['http://[::1]:3000/repo.git', '[::1]'],
    ['git@github.com:org/repo.git', 'github.com'],
    ['deploy@git.a.test:apps/site.git', 'git.a.test'],
    ['git.a.test:apps/site.git', 'git.a.test'],
    ['ssh://git@github.com/org/repo.git', 'github.com'],
    ['ssh://git@github.com:2222/org/repo.git', 'github.com'],
    ['git://kernel.org/linux.git', 'kernel.org'],
    ['/srv/git/repo.git', undefined],
    ['../sibling', undefined],
    ['file:///srv/git/repo.git', undefined],
    ['C:\\repos\\thing', undefined],
    ['', undefined],
  ];
  for (const [url, host] of cases) {
    assert.equal(parseRemoteHost(url), host, url);
  }
});

test('the decision: a moved HEAD is a commit, an un-ahead branch is a push, each once', () => {
  const start = baselineMemory({ head: 'a', upstream: { remote: 'origin', ahead: 0 } });
  assert.deepEqual(start, { lastHead: 'a', pushedHead: 'a' }, 'a fresh clone is already pushed');

  const quiet = decideGitSignals(start, { head: 'a', upstream: { remote: 'origin', ahead: 0 } });
  assert.deepEqual([quiet.committed, quiet.pushed], [false, false], 'nothing happened');

  const committed = decideGitSignals(quiet.next, { head: 'b', upstream: { remote: 'origin', ahead: 1 } });
  assert.deepEqual([committed.committed, committed.pushed], [true, false]);

  const pushed = decideGitSignals(committed.next, { head: 'b', upstream: { remote: 'origin', ahead: 0 } });
  assert.deepEqual([pushed.committed, pushed.pushed], [false, true], 'a push-only turn still counts');

  const again = decideGitSignals(pushed.next, { head: 'b', upstream: { remote: 'origin', ahead: 0 } });
  assert.deepEqual([again.committed, again.pushed], [false, false], 'the same push is not repeated');

  const hooked = decideGitSignals(again.next, { head: 'c' }, 'c');
  assert.equal(hooked.committed, false, 'a sha the hook already announced is not announced again');

  const gone = decideGitSignals(hooked.next, {});
  assert.deepEqual([gone.committed, gone.pushed], [false, false], 'not a repo any more: silence');
  assert.equal(gone.next.lastHead, 'c', 'memory survives a failed probe');
});

test('a turn that moved HEAD sends session_committed once', async () => {
  const state: FakeGit = { head: 'a' };
  const { sent, send } = collector();
  const signals = new TurnGitSignals(send, fakeProbe(state));

  signals.observe('run-1', '/p');
  await signals.turnEnded('run-1', 'session-1', '/p');
  assert.deepEqual(sent, [], 'an idle with no change is silent');

  state.head = 'b';
  await signals.turnEnded('run-1', 'session-1', '/p');
  await signals.turnEnded('run-1', 'session-1', '/p');
  assert.deepEqual(sent, [{ type: 'session_committed', sessionId: 'session-1', cwd: '/p' }]);
});

test('a commit the hook already announced is not announced again', async () => {
  const state: FakeGit = { head: 'a' };
  const { sent, send } = collector();
  const signals = new TurnGitSignals(send, fakeProbe(state));

  signals.observe('run-1', '/p');
  state.head = 'b';
  signals.noteExternalCommit('session-1', '/p');
  await new Promise((resolve) => setImmediate(resolve));
  await signals.turnEnded('run-1', 'session-1', '/p');
  assert.deepEqual(sent, []);

  state.head = 'c';
  await signals.turnEnded('run-1', 'session-1', '/p');
  assert.equal(sent.length, 1, 'the next commit is still seen');
});

test('a fresh clone is not a push; a commit then a push across turns is', async () => {
  const state: FakeGit = { head: 'a', upstream: { remote: 'origin', ahead: 0 }, url: 'git@github.com:org/repo.git' };
  const { sent, send } = collector();
  const signals = new TurnGitSignals(send, fakeProbe(state));

  signals.observe('run-1', '/p');
  await signals.turnEnded('run-1', 'session-1', '/p');
  assert.deepEqual(sent, []);

  state.head = 'b';
  state.upstream = { remote: 'origin', ahead: 1 };
  await signals.turnEnded('run-1', 'session-1', '/p');
  assert.deepEqual(sent.map((m) => m.type), ['session_committed']);

  state.upstream = { remote: 'origin', ahead: 0 };
  await signals.turnEnded('run-1', 'session-1', '/p');
  assert.deepEqual(sent.at(-1), {
    type: 'project_pushed',
    sessionId: 'session-1',
    cwd: '/p',
    remoteHost: 'github.com',
  });

  await signals.turnEnded('run-1', 'session-1', '/p');
  assert.equal(sent.length, 2, 'the same push is not repeated');
});

test('a remote with no host (a local path) sends no push signal', async () => {
  const state: FakeGit = { head: 'a', url: '/srv/git/repo.git' };
  const { sent, send } = collector();
  const signals = new TurnGitSignals(send, fakeProbe(state));

  signals.observe('run-1', '/p');
  state.head = 'b';
  state.upstream = { remote: 'origin', ahead: 0 };
  await signals.turnEnded('run-1', 'session-1', '/p');
  assert.deepEqual(sent.map((m) => m.type), ['session_committed']);
});

test('a directory that is not a repo is silent, and a forgotten run stays quiet', async () => {
  const state: FakeGit = {};
  const { sent, send } = collector();
  const signals = new TurnGitSignals(send, fakeProbe(state));

  signals.observe('run-1', '/p');
  await signals.turnEnded('run-1', 'session-1', '/p');
  assert.deepEqual(sent, []);

  state.head = 'a';
  signals.forget('run-1');
  await signals.turnEnded('run-1', 'session-1', '/p');
  assert.deepEqual(sent, [], 'no memory, no verdict');
});

test('an idle that lands before the launch baseline resolved waits for it', async () => {
  let releaseBaseline!: (head: string) => void;
  const baseline = new Promise<string>((resolve) => {
    releaseBaseline = resolve;
  });
  let calls = 0;
  const probe: GitProbe = {
    head: () => (calls++ === 0 ? baseline : Promise.resolve('a')),
    upstream: async () => undefined,
    remoteUrl: async () => undefined,
  };
  const { sent, send } = collector();
  const signals = new TurnGitSignals(send, probe);

  signals.observe('run-1', '/p');
  const idle = signals.turnEnded('run-1', 'session-1', '/p');
  releaseBaseline('a');
  await idle;
  assert.deepEqual(sent, [], 'the baseline itself is not a commit');
});
