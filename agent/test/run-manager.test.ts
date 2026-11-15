import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import type { PermissionMode } from '@cc-remote/shared';

import type {
  RunOptions,
  SessionRun,
} from '../src/claude-session.js';
import { RunManager, defaultSourceFromEnv } from '../src/run-manager.js';
import { TurnGitSignals, type GitProbe, type UpstreamState } from '../src/git-signals.js';

class FakeRun implements SessionRun {
  readonly completed = new Promise<void>(() => {});
  finishedWith?: 'end' | 'error';
  readonly inputs: Array<{ text: string; images?: unknown[] }> = [];
  closed = false;

  sendInput(text: string, images?: never[]): void {
    this.inputs.push({ text, images });
  }

  async interrupt(): Promise<void> {}
  async setModel(): Promise<void> {}
  async setPermissionMode(_mode: PermissionMode): Promise<void> {}
  async setEffort(): Promise<void> {}

  close(): void {
    this.closed = true;
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('resume queues input until the single-writer liveness check settles', async () => {
  const liveness = deferred<{ pid: number } | undefined>();
  const sent: Array<Record<string, unknown>> = [];
  let run: FakeRun | undefined;
  const manager = new RunManager({
    send: (message) => {
      sent.push(message);
      return true;
    },
    refreshInventory: () => {},
    scheduleInventory: () => {},
    findLiveWriter: () => liveness.promise,
    createRun: (_source, _options) => (run = new FakeRun()),
  });

  const resuming = manager.resume('run-1', 'session-1', '/workspace');
  manager.input('run-1', 'held turn');
  assert.equal(manager.activeCount, 0);

  liveness.resolve(undefined);
  await resuming;

  assert.equal(manager.activeCount, 1);
  assert.deepEqual(run?.inputs, [{ text: 'held turn', images: undefined }]);
  assert.ok(sent.some((message) => message.type === 'run_status' && message.state === 'started'));
});

test('liveRuns reports the runs a reconnecting agent can reclaim', async () => {
  const manager = new RunManager({
    send: () => true,
    refreshInventory: () => {},
    scheduleInventory: () => {},
    findLiveWriter: async () => undefined,
    createRun: () => new FakeRun(),
  });

  assert.deepEqual(manager.liveRuns(), [], 'a clean agent declares nothing');

  await manager.resume('run-a', 'session-a', '/workspace');
  await manager.resume('run-b', 'session-b', '/workspace');

  // The hub matches these against the runs it held through the grace window, so
  // both ids must survive verbatim — a mismatch silently drops live work. The
  // cwd rides along for the harder case: a hub that restarted holds nothing to
  // match against and rebuilds the run from this declaration alone, and without
  // a cwd it cannot, so it closes the run instead.
  assert.deepEqual(
    manager.liveRuns().sort((x, y) => x.runId.localeCompare(y.runId)),
    [
      { runId: 'run-a', sessionId: 'session-a', cwd: '/workspace' },
      { runId: 'run-b', sessionId: 'session-b', cwd: '/workspace' },
    ],
  );

  manager.reset();
  assert.deepEqual(manager.liveRuns(), [], 'torn-down runs must not be reclaimed');
});

test('resume refuses an external writer without constructing a run', async () => {
  const sent: Array<Record<string, unknown>> = [];
  let constructed = false;
  const manager = new RunManager({
    send: (message) => {
      sent.push(message);
      return true;
    },
    refreshInventory: () => {},
    scheduleInventory: () => {},
    findLiveWriter: async () => ({ pid: 42, entrypoint: 'claude-vscode' }),
    createRun: () => {
      constructed = true;
      return new FakeRun();
    },
  });

  await manager.resume('run-2', 'session-2', '/workspace');

  assert.equal(constructed, false);
  assert.equal(manager.activeCount, 0);
  assert.ok(sent.some((message) => message.type === 'run_status' && message.state === 'yielded'));
});

/**
 * A liveness check that THREW used to be indistinguishable from one that came
 * back clean: both paths went through `.catch(() => undefined)`. So an
 * unreadable `~/.claude/sessions` — a permission change, a descriptor ceiling,
 * a mount gone — read as «no writer here» and the resume launched a second one
 * into the same transcript. The invariant must not rest on a filesystem read
 * never failing. Refusing costs the person a retry, and they get their message
 * back; the other way costs the transcript.
 */
test('a liveness check that fails is not a clean bill', async () => {
  const sent: Array<Record<string, unknown>> = [];
  let constructed = false;
  const manager = new RunManager({
    send: (message) => {
      sent.push(message);
      return true;
    },
    refreshInventory: () => {},
    scheduleInventory: () => {},
    findLiveWriter: async () => {
      throw new Error('EACCES: permission denied');
    },
    createRun: () => {
      constructed = true;
      return new FakeRun();
    },
  });

  await manager.resume('run-x', 'session-x', '/workspace');

  assert.equal(constructed, false, 'nothing may be launched on an unproven session');
  assert.equal(manager.activeCount, 0);
  const refusal = sent.find((m) => m.type === 'run_status' && m.state === 'yielded');
  assert.ok(refusal, 'the client is told, and told why');
  assert.equal(refusal!['code'], 'resume_refused', 'so the message goes back in the composer');
});

/** The same, where it matters more: a takeover exists to CONFIRM death, and a
 *  failed lookup used to end its kill loop and launch — calling the field clear
 *  because it could not look at it. */
test('a takeover aborts when it cannot see whether anyone is still writing', async () => {
  const sent: Array<Record<string, unknown>> = [];
  let constructed = false;
  const manager = new RunManager({
    send: (message) => {
      sent.push(message);
      return true;
    },
    refreshInventory: () => {},
    scheduleInventory: () => {},
    findLiveWriter: async () => {
      throw new Error('EMFILE: too many open files');
    },
    createRun: () => {
      constructed = true;
      return new FakeRun();
    },
  });

  await manager.takeover('run-y', 'session-y', '/workspace', 'первое сообщение');

  assert.equal(constructed, false, 'a takeover that cannot confirm death must not resume');
  assert.equal(manager.activeCount, 0);
  const refusal = sent.find((m) => m.type === 'run_status' && m.state === 'error');
  assert.ok(refusal, 'and it says so instead of failing silently');
  assert.equal(refusal!['code'], 'resume_refused');
});

test('reset closes runs and settles outstanding tool approvals immediately', async () => {
  const sent: Array<Record<string, unknown>> = [];
  let options: RunOptions | undefined;
  let run: FakeRun | undefined;
  const manager = new RunManager({
    send: (message) => {
      sent.push(message);
      return true;
    },
    refreshInventory: () => {},
    scheduleInventory: () => {},
    approvalTimeoutMs: 60_000,
    createRun: (_source, runOptions) => {
      options = runOptions;
      return (run = new FakeRun());
    },
  });
  manager.startNew('run-3', '/workspace');

  // A QUESTION, not a permission: ordinary tool approvals are answered on the
  // spot now (`autoApproves`), so they never become an outstanding card there
  // is anything to settle. What still waits for a person is what this test is
  // about.
  const approval = options?.handlers.approveTool?.({
    tool: 'AskUserQuestion',
    input: { questions: [] },
    toolUseID: 'tool-1',
  });
  assert.ok(approval);
  assert.ok(sent.some((message) => message.type === 'tool_request'));

  manager.reset('connection lost');

  assert.equal(run?.closed, true);
  assert.equal(manager.activeCount, 0);
  assert.deepEqual(await approval, { allow: false, message: 'connection lost' });
});

test('yield closes a run that becomes externally live', async () => {
  const sent: Array<Record<string, unknown>> = [];
  let run: FakeRun | undefined;
  const manager = new RunManager({
    send: (message) => {
      sent.push(message);
      return true;
    },
    refreshInventory: () => {},
    scheduleInventory: () => {},
    readLiveWriters: async () => new Map([
      ['session-4', { pid: 99, entrypoint: 'terminal' }],
    ]),
    createRun: (_source, _options) => (run = new FakeRun()),
  });
  manager.startNew('run-4', '/workspace');
  // A fresh run learns its durable id from the runtime before the yield check.
  // Drive that callback exactly as the SDK would.
  const started = sent.find((message) => message.type === 'run_status');
  assert.equal(started?.sessionId, '');

  // Recreate with an existing id, since that is the collision the guard checks.
  manager.end('run-4', 'ended');
  await manager.resume('run-5', 'session-4', '/workspace', 'codex');
  await manager.checkYields();

  assert.equal(run?.closed, true);
  assert.equal(manager.activeCount, 0);
  assert.ok(sent.some((message) => message.type === 'run_status' && message.state === 'yielded'));
});

test('CC_REMOTE_DEFAULT_SOURCE is honoured only when it names a CLI', () => {
  assert.equal(defaultSourceFromEnv(undefined), undefined);
  assert.equal(defaultSourceFromEnv(''), undefined);
  assert.equal(defaultSourceFromEnv('codex'), 'codex');
  assert.equal(defaultSourceFromEnv(' Codex '), 'codex');
  assert.equal(defaultSourceFromEnv('claude'), 'claude');
  assert.equal(defaultSourceFromEnv('gpt'), undefined);
});

test('a new session with no source starts on the machine default; a resume never does', async () => {
  const seen: Array<string | undefined> = [];
  const manager = new RunManager({
    send: () => true,
    refreshInventory: () => {},
    scheduleInventory: () => {},
    findLiveWriter: async () => undefined,
    defaultSource: 'codex',
    createRun: (source) => {
      seen.push(source);
      return new FakeRun();
    },
  });

  manager.startNew('run-d1', '/workspace');
  manager.startNew('run-d2', '/workspace', undefined, undefined, 'claude');
  await manager.resume('run-d3', 'session-d3', '/workspace');
  assert.deepEqual(seen, ['codex', 'claude', undefined]);
  assert.deepEqual(manager.activeCwds().sort(), ['/workspace', '/workspace', '/workspace']);

  const untouched: Array<string | undefined> = [];
  const plain = new RunManager({
    send: () => true,
    refreshInventory: () => {},
    scheduleInventory: () => {},
    createRun: (source) => {
      untouched.push(source);
      return new FakeRun();
    },
  });
  plain.startNew('run-d4', '/workspace');
  assert.deepEqual(untouched, [undefined], 'without the env the default is unchanged');
});

test('a run whose turn moved HEAD reports the commit and the push on idle', async () => {
  const sent: Array<Record<string, unknown>> = [];
  const send = (message: Record<string, unknown>) => {
    sent.push(message);
    return true;
  };
  const git: { head?: string; upstream?: UpstreamState; url?: string } = { head: 'aaa' };
  const probe: GitProbe = {
    head: async () => git.head,
    upstream: async () => git.upstream,
    remoteUrl: async () => git.url,
  };
  let options: RunOptions | undefined;
  const manager = new RunManager({
    send: send as never,
    refreshInventory: () => {},
    scheduleInventory: () => {},
    gitSignals: new TurnGitSignals(send as never, probe),
    createRun: (_source, runOptions) => {
      options = runOptions;
      return new FakeRun();
    },
  });

  manager.startNew('run-g', '/workspace');
  options?.handlers.onSessionId?.('session-g');
  await new Promise((resolve) => setImmediate(resolve));

  // The turn committed and pushed to a remote that did not exist at launch.
  git.head = 'bbb';
  git.upstream = { remote: 'origin', ahead: 0 };
  git.url = 'https://x-access-token:secret@github.com/org/repo.git';
  options?.handlers.onEvent({ kind: 'result', text: 'done' });

  const deadline = Date.now() + 2000;
  while (!sent.some((message) => message.type === 'project_pushed')) {
    if (Date.now() > deadline) throw new Error('project_pushed never arrived');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(sent.some((message) => message.type === 'run_status' && message.state === 'idle'));
  assert.deepEqual(
    sent.filter((message) => message.type === 'session_committed'),
    [{ type: 'session_committed', sessionId: 'session-g', cwd: '/workspace' }],
  );
  assert.deepEqual(
    sent.filter((message) => message.type === 'project_pushed'),
    [{ type: 'project_pushed', sessionId: 'session-g', cwd: '/workspace', remoteHost: 'github.com' }],
  );

  // A second idle with nothing new stays quiet.
  options?.handlers.onEvent({ kind: 'result', text: 'done' });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(sent.filter((m) => m.type === 'session_committed' || m.type === 'project_pushed').length, 2);
});

test('a stream error carries its code to the wire', () => {
  const sent: Array<Record<string, unknown>> = [];
  let options: RunOptions | undefined;
  const manager = new RunManager({
    send: (message) => {
      sent.push(message);
      return true;
    },
    refreshInventory: () => {},
    scheduleInventory: () => {},
    createRun: (_source, runOptions) => {
      options = runOptions;
      return new FakeRun();
    },
  });
  manager.startNew('run-e', '/workspace');
  options?.handlers.onEvent({ kind: 'error', text: 'used up', code: 'budget_exhausted' });

  const stream = sent.find((message) => message.type === 'stream');
  assert.deepEqual(stream?.event, { kind: 'error', text: 'used up', code: 'budget_exhausted' });
  // A failed TURN leaves the runtime alive and waiting, so the run stays open
  // and goes idle — the next message goes straight in instead of resuming.
  assert.equal(manager.activeCount, 1, 'a failed turn does not close the run');
  const idle = sent.find((message) => message.type === 'run_status' && message.state === 'idle');
  assert.ok(idle, 'the hub is told the turn is over');
});

test('only a fatal error closes the run', () => {
  const sent: Array<Record<string, unknown>> = [];
  let options: RunOptions | undefined;
  let run: FakeRun | undefined;
  const manager = new RunManager({
    send: (message) => {
      sent.push(message);
      return true;
    },
    refreshInventory: () => {},
    scheduleInventory: () => {},
    createRun: (_source, runOptions) => {
      options = runOptions;
      return (run = new FakeRun());
    },
  });
  manager.startNew('run-f', '/workspace');
  options?.handlers.onEvent({ kind: 'error', text: 'process exited', code: 'run_failed', fatal: true });
  assert.equal(manager.activeCount, 0);
  assert.equal(run?.closed, true);
  const status = sent.find((message) => message.type === 'run_status' && message.state === 'error');
  assert.equal(status?.code, 'run_failed');
});

test('a refused resume names itself so the client can return the message', async () => {
  const sent: Array<Record<string, unknown>> = [];
  const manager = new RunManager({
    send: (message) => {
      sent.push(message);
      return true;
    },
    refreshInventory: () => {},
    scheduleInventory: () => {},
    findLiveWriter: async () => ({ pid: 42, entrypoint: 'claude-vscode' }),
    createRun: () => new FakeRun(),
  });
  const resuming = manager.resume('run-g', 'session-g', '/workspace');
  manager.input('run-g', 'the message that rode on the open');
  await resuming;
  const status = sent.find((message) => message.type === 'run_status');
  assert.equal(status?.state, 'yielded');
  assert.equal(status?.code, 'resume_refused');
});

test('announceState re-tells the hub each run\'s state and re-issues a pending approval', async () => {
  const sent: Array<Record<string, unknown>> = [];
  let options: RunOptions | undefined;
  const manager = new RunManager({
    send: (message) => {
      sent.push(message);
      return true;
    },
    refreshInventory: () => {},
    scheduleInventory: () => {},
    approvalTimeoutMs: 60_000,
    createRun: (_source, runOptions) => {
      options = runOptions;
      return new FakeRun();
    },
  });
  manager.startNew('run-h', '/workspace');
  // The turn finished while the socket was down: the idle was dropped.
  options?.handlers.onEvent({ kind: 'result', text: 'done' });
  sent.length = 0;
  manager.announceState();
  assert.deepEqual(
    sent.map((m) => [m.type, m.state]),
    [['run_status', 'idle']],
  );

  // Now the runtime asks a QUESTION, and the hub reconnects before anyone
  // answered: it must be asked again. (A `Bash` permission would not get this
  // far — `autoApproves` answers it before a card exists.)
  const decided = options!.handlers.approveTool!({
    tool: 'AskUserQuestion',
    input: { questions: [] },
    toolUseID: 't1',
  });
  sent.length = 0;
  manager.announceState();
  assert.deepEqual(
    sent.map((m) => [m.type, m.state ?? m.tool]),
    [
      ['run_status', 'started'],
      ['tool_request', 'AskUserQuestion'],
    ],
  );
  const requestId = String(sent[1]!['requestId']);
  manager.decideTool(requestId, { allow: true });
  assert.equal((await decided).allow, true);
  sent.length = 0;
  manager.announceState();
  assert.deepEqual(sent.map((m) => m.type), ['run_status'], 'answered — nothing to re-issue');
});

test('task clock dates user input and survives runtime events and reconnect', async t => {
  const sent: Array<Record<string, unknown>> = [];
  let options!: RunOptions;
  const manager = new RunManager({
    send: message => { sent.push(message); return true; },
    refreshInventory: () => {}, scheduleInventory: () => {},
    findLiveWriter: async () => undefined,
    createRun: (_source, opts) => { options = opts; return new FakeRun(); },
  });
  t.after(() => manager.reset());
  t.mock.timers.enable({ apis: ['Date'], now: 1_000 });
  await manager.resume('clock', 'session', '/workspace');
  manager.input('clock', 'first');
  const stamp = () => sent.filter(m => m.type === 'run_status').at(-1)?.taskStartedAt;
  assert.equal(stamp(), 1_000);
  t.mock.timers.tick(60_000);
  options.handlers.onEvent({ kind: 'assistant', text: 'Waiting for a child' });
  options.handlers.onEvent({ kind: 'status', code: 'session_state', data: { state: 'idle' } });
  manager.announceState();
  assert.equal(stamp(), 1_000);
  assert.equal(sent.filter(m => m.type === 'run_status').at(-1)?.state, 'started');
  manager.input('clock', 'latest instruction');
  assert.equal(stamp(), 61_000);
  t.mock.timers.tick(60_000);
  manager.announceState();
  assert.equal(stamp(), 61_000);
});

test('a live background task keeps the agent from restarting and is re-told first after a reconnect', () => {
  const sent: Array<Record<string, unknown>> = [];
  let options: RunOptions | undefined;
  const manager = new RunManager({
    send: (message) => {
      sent.push(message);
      return true;
    },
    refreshInventory: () => {},
    scheduleInventory: () => {},
    createRun: (_source, runOptions) => {
      options = runOptions;
      return new FakeRun();
    },
  });
  manager.startNew('run-bg', '/workspace');
  const tasks = [{ id: 'b1', type: 'local_bash', description: 'Score all batches', since: 1 }];
  options?.handlers.onEvent({ kind: 'status', text: '', code: 'background_tasks', data: { tasks } });
  options?.handlers.onEvent({ kind: 'result', text: 'жду' });
  assert.equal(manager.isQuiet(), false, 'self-update would kill the task');

  sent.length = 0;
  manager.announceState();
  const kinds = sent.map((m) => (m.type === 'stream' ? `stream:${(m.event as { code?: string }).code}` : `${m.type}:${m.state}`));
  assert.deepEqual(kinds.slice(0, 2), ['stream:background_tasks', 'run_status:idle'], 'the list goes before the state');

  options?.handlers.onEvent({ kind: 'status', text: '', code: 'background_tasks', data: { tasks: [] } });
  assert.equal(manager.isQuiet(), true, 'nothing in the background, nothing mid-turn');
  sent.length = 0;
  manager.announceState();
  assert.ok(!sent.some((m) => m.type === 'stream'), 'an empty list is not re-told');
});

test('releaseForDelete ends our own run and waits for its process to exit', async () => {
  const sent: Array<Record<string, unknown>> = [];
  let run: FakeRun | undefined;
  const manager = new RunManager({
    send: (message) => {
      sent.push(message);
      return true;
    },
    refreshInventory: () => {},
    scheduleInventory: () => {},
    // After the resume, the session is OURS: finding "a writer" now would be
    // finding our own CLI and refusing the delete because of it.
    findLiveWriter: async () => (resumed ? { pid: 7, entrypoint: 'sdk-ts' } : undefined),
    createRun: () => (run = new FakeRun()),
  });
  let resumed = false;
  await manager.resume('run-del', 'session-del', '/workspace');
  resumed = true;

  // FakeRun.completed never settles here: a CLI that will not go fails the
  // delete rather than having its file removed from under it.
  await assert.rejects(manager.releaseForDelete('session-del', 10), /не завершился/);

  assert.equal(run?.closed, true, 'the CLI was told to stop before the file goes');
  assert.equal(manager.activeCount, 0);
  assert.ok(sent.some((m) => m.type === 'run_status' && m.runId === 'run-del' && m.state === 'ended'));
});

test('releaseForDelete refuses while a writer we do not drive holds the session', async () => {
  const manager = new RunManager({
    send: () => true,
    refreshInventory: () => {},
    scheduleInventory: () => {},
    findLiveWriter: async () => ({ pid: 42, entrypoint: 'claude-vscode' }),
    createRun: () => new FakeRun(),
  });
  await assert.rejects(manager.releaseForDelete('session-ext', 10), /claude-vscode/);
});

test('releaseForDelete lets an idle session through', async () => {
  const manager = new RunManager({
    send: () => true,
    refreshInventory: () => {},
    scheduleInventory: () => {},
    findLiveWriter: async () => undefined,
    createRun: () => new FakeRun(),
  });
  await manager.releaseForDelete('session-idle', 10);
});

test('a run cannot start on a session while its delete is in flight', async () => {
  const sent: Array<Record<string, unknown>> = [];
  let created = 0;
  const manager = new RunManager({
    send: (message) => {
      sent.push(message);
      return true;
    },
    refreshInventory: () => {},
    scheduleInventory: () => {},
    findLiveWriter: async () => undefined,
    createRun: () => {
      created += 1;
      return new FakeRun();
    },
  });
  await manager.releaseForDelete('session-going', 10);
  await manager.resume('run-late', 'session-going', '/workspace');
  assert.equal(created, 0, 'no writer on a file that is about to be removed');
  assert.ok(sent.some((m) => m.runId === 'run-late' && m.code === 'resume_refused'));

  // A double-pressed «Удалить»: two deletes in flight; the first to finish
  // must not lift the refusal the second still needs.
  await manager.releaseForDelete('session-going', 10);
  manager.finishDelete('session-going');
  await manager.resume('run-between', 'session-going', '/workspace');
  assert.equal(created, 0, 'still refused while the second delete runs');

  manager.finishDelete('session-going');
  await manager.resume('run-after', 'session-going', '/workspace');
  assert.equal(created, 1, 'the mark does not outlive the deletes');
});

test('an after-turn plan card keeps the run idle, returns it to idle on refusal, and yields to a new message', async () => {
  const sent: Array<Record<string, unknown>> = [];
  let options!: RunOptions;
  const manager = new RunManager({
    send: (message) => { sent.push(message); return true; },
    refreshInventory: () => {},
    scheduleInventory: () => {},
    approvalTimeoutMs: 60_000,
    createRun: (_source, runOptions) => { options = runOptions; return new FakeRun(); },
  });
  manager.startNew('run-p', '/workspace');
  options.handlers.onEvent({ kind: 'result', text: 'done' });
  const card = () => options.handlers.approveTool!({ tool: 'ExitPlanMode', input: { plan: 'p' }, toolUseID: 'x', afterTurn: true });

  // Refused: back to idle, said to the hub, since no turn will say it.
  const first = card();
  sent.length = 0;
  manager.announceState();
  assert.deepEqual(sent.map((m) => [m.type, m.state ?? m.tool]), [['run_status', 'idle'], ['tool_request', 'ExitPlanMode']]);
  sent.length = 0;
  manager.decideTool(String((await (async () => {
    manager.announceState();
    return sent.find((m) => m.type === 'tool_request')!;
  })())['requestId']), { allow: false });
  assert.equal((await first).allow, false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(sent.filter((m) => m.type === 'run_status').at(-1)?.state, 'idle');

  // Waiting on a card is still quiet: self-update may close the run.
  const pending = card();
  assert.equal(manager.isQuiet(), true);
  // Accepted and acted on: the runtime says so, the hub hears «started».
  sent.length = 0;
  manager.announceState();
  manager.decideTool(String(sent.find((m) => m.type === 'tool_request')!['requestId']), { allow: true });
  await pending;
  options.handlers.onEvent({ kind: 'status', code: 'plan_accepted', text: 'accepted' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent.filter((m) => m.type === 'run_status').at(-1)?.state, 'started');
  options.handlers.onEvent({ kind: 'result', text: 'done' });

  // Walked past: a message settles the card as refused and stays working.
  const second = card();
  sent.length = 0;
  manager.input('run-p', 'something else');
  assert.equal((await second).allow, false);
  assert.equal(sent.filter((m) => m.type === 'run_status').at(-1)?.state, 'started');
  sent.length = 0;
  manager.announceState();
  assert.deepEqual(sent.map((m) => m.type), ['run_status'], 'nothing left to re-issue');
});


test('runBy from the start frame reaches RunOptions, and is absent when not given', () => {
  const launched: Array<{ source: string; options: RunOptions }> = [];
  const manager = new RunManager({
    send: () => true,
    refreshInventory: () => {}, scheduleInventory: () => {},
    createRun: (source, options) => { launched.push({ source, options }); return new FakeRun(); },
  });
  manager.startNew('a', '/workspace', 'x', undefined, 'codex', { runBy: { userId: 'u1', email: 'a@b.c' } });
  assert.deepEqual(launched[0]!.options.runBy, { userId: 'u1', email: 'a@b.c' });
  manager.startNew('b', '/workspace', 'x', undefined, 'codex', {});
  assert.equal('runBy' in launched[1]!.options, false);
  manager.end('a', 'ended');
  manager.end('b', 'ended');
});

test('the run state file tracks who authored the latest turn and goes away with the run', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const prev = process.env['CC_REMOTE_STATE_DIR'];
  process.env['CC_REMOTE_STATE_DIR'] = fs.mkdtempSync(path.join(os.tmpdir(), 'ccr-runstate-'));
  try {
    const launched: Array<{ options: RunOptions }> = [];
    const manager = new RunManager({
      send: () => true,
      refreshInventory: () => {}, scheduleInventory: () => {},
      createRun: (_source, options) => { launched.push({ options }); return new FakeRun(); },
    });
    const starter = { userId: 'u1', email: 'a@b.c' };
    manager.startNew('r1', '/workspace', 'first', undefined, 'codex', { runBy: starter });
    const file = launched[0]!.options.runStateFile!;
    assert.ok(file.endsWith('r1.json'));
    const read = () => JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(read().startedBy, starter);
    assert.deepEqual(read().lastInputBy, starter, 'the first turn is the starter\'s');
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
    // The first turn ends, so the colleague's input starts a turn from idle.
    launched[0]!.options.handlers.onEvent({ kind: 'result', text: 'done' } as never);
    manager.input('r1', 'from a colleague', undefined, undefined, { userId: 'u2' });
    assert.deepEqual(read().lastInputBy, { userId: 'u2' });
    assert.deepEqual(read().startedBy, starter);
    launched[0]!.options.handlers.onEvent({ kind: 'result', text: 'done' } as never);
    manager.input('r1', 'from a bot');
    assert.equal(read().lastInputBy, null);
    manager.end('r1', 'ended');
    assert.equal(fs.existsSync(file), false);
    // A run nobody signed in for still has a file; startedBy is null.
    manager.startNew('r2', '/workspace', 'x', undefined, 'codex', {});
    const f2 = launched[1]!.options.runStateFile!;
    assert.equal(JSON.parse(fs.readFileSync(f2, 'utf8')).startedBy, null);
    manager.end('r2', 'ended');
  } finally {
    if (prev === undefined) delete process.env['CC_REMOTE_STATE_DIR'];
    else process.env['CC_REMOTE_STATE_DIR'] = prev;
  }
});

test('while a turn is running a different author makes lastInputBy null; an idle start restores one author', async () => {
  const fs = await import('node:fs');
  const launched: Array<{ options: RunOptions }> = [];
  const manager = new RunManager({
    send: () => true,
    refreshInventory: () => {}, scheduleInventory: () => {},
    createRun: (_source, options) => { launched.push({ options }); return new FakeRun(); },
  });
  const u1 = { userId: 'u1' };
  const u2 = { userId: 'u2' };
  manager.startNew('busy', '/workspace', 'first', undefined, 'codex', { runBy: u1 });
  const opts = launched[0]!.options;
  const read = () => JSON.parse(fs.readFileSync(opts.runStateFile!, 'utf8')).lastInputBy;
  assert.deepEqual(read(), u1);
  // Busy, same author: keeps the name.
  manager.input('busy', 'more', undefined, undefined, u1);
  assert.deepEqual(read(), u1);
  // Busy, someone else: mixed.
  manager.input('busy', 'colleague', undefined, undefined, u2);
  assert.equal(read(), null);
  // Still busy, the first author again: still mixed (u2's turn may be running).
  manager.input('busy', 'again', undefined, undefined, u1);
  assert.equal(read(), null);
  // All four outstanding turns end; a new turn from idle has a single author.
  for (let i = 0; i < 4; i += 1) opts.handlers.onEvent({ kind: 'result', text: 'done' } as never);
  manager.input('busy', 'fresh', undefined, undefined, u1);
  assert.deepEqual(read(), u1);
  // Busy with an unattributed message (bot): mixed.
  manager.input('busy', 'bot');
  assert.equal(read(), null);
  manager.end('busy', 'ended');
});

test('an error result with another author\'s turn still queued does not restore an author', () => {
  const launched: Array<{ options: RunOptions }> = [];
  const manager = new RunManager({
    send: () => true,
    refreshInventory: () => {}, scheduleInventory: () => {},
    createRun: (_source, options) => { launched.push({ options }); return new FakeRun(); },
  });
  const u1 = { userId: 'u1' };
  const u2 = { userId: 'u2' };
  manager.startNew('q', '/workspace', 'first', undefined, 'codex', { runBy: u1 });
  const opts = launched[0]!.options;
  const read = () => JSON.parse(fs.readFileSync(opts.runStateFile!, 'utf8')).lastInputBy;
  manager.input('q', 'colleague', undefined, undefined, u2);
  assert.equal(read(), null);
  // The first turn fails (non-fatal): the run reads idle, but u2's turn is queued.
  opts.handlers.onEvent({ kind: 'error', text: 'boom', fatal: false } as never);
  manager.input('q', 'u1 again', undefined, undefined, u1);
  assert.equal(read(), null, 'u2\'s turn may still be running');
  // Both outstanding results arrive; the next turn from a quiet run is u1's.
  opts.handlers.onEvent({ kind: 'result', text: 'a' } as never);
  opts.handlers.onEvent({ kind: 'result', text: 'b' } as never);
  manager.input('q', 'quiet', undefined, undefined, u1);
  assert.deepEqual(read(), u1);
  manager.end('q', 'ended');
});

test('one person driving their own run never turns the author into null', () => {
  const launched: Array<{ options: RunOptions }> = [];
  const manager = new RunManager({
    send: () => true,
    refreshInventory: () => {}, scheduleInventory: () => {},
    createRun: (_source, options) => { launched.push({ options }); return new FakeRun(); },
  });
  const u1 = { userId: 'u1' };
  manager.startNew('solo', '/workspace', 'first', undefined, 'codex', { runBy: u1 });
  const opts = launched[0]!.options;
  const read = () => JSON.parse(fs.readFileSync(opts.runStateFile!, 'utf8')).lastInputBy;
  for (let i = 0; i < 5; i += 1) {
    manager.input('solo', `queued ${i}`, undefined, undefined, u1); // while busy
    assert.deepEqual(read(), u1);
  }
  for (let i = 0; i < 8; i += 1) opts.handlers.onEvent({ kind: 'result', text: 'r' } as never); // extra results floor at 0
  manager.input('solo', 'after idle', undefined, undefined, { userId: 'u1' });
  assert.deepEqual(read(), u1);
  manager.end('solo', 'ended');
});

test('accepting a plan counts for authorship: a colleague makes it mixed, the author keeps it', async () => {
  const u1 = { userId: 'u1' };
  const u2 = { userId: 'u2' };
  for (const [acceptor, expected] of [[u2, null], [u1, u1], [undefined, null]] as const) {
    const sent: Array<Record<string, unknown>> = [];
    let options!: RunOptions;
    const manager = new RunManager({
      send: (message) => { sent.push(message); return true; },
      refreshInventory: () => {}, scheduleInventory: () => {},
      approvalTimeoutMs: 60_000,
      createRun: (_source, runOptions) => { options = runOptions; return new FakeRun(); },
    });
    manager.startNew('plan', '/workspace', 'make a plan', undefined, 'codex', { runBy: u1 });
    options.handlers.onEvent({ kind: 'result', text: 'done' } as never);
    const read = () => JSON.parse(fs.readFileSync(options.runStateFile!, 'utf8')).lastInputBy;
    assert.deepEqual(read(), u1);
    const card = options.handlers.approveTool!({ tool: 'ExitPlanMode', input: { plan: 'p' }, toolUseID: 'x', afterTurn: true });
    manager.announceState();
    const requestId = String(sent.find((m) => m.type === 'tool_request')!['requestId']);
    manager.decideTool(requestId, { allow: true }, acceptor);
    await card;
    assert.deepEqual(read(), expected);
    manager.end('plan', 'ended');
  }
});

test('a failed state-file write removes the old file so scripts are refused', async () => {
  const fs = await import('node:fs');
  const { createRunState, recordRunInput, runStatePath } = await import('../src/run-state.js');
  const file = createRunState('failclosed', { userId: 'u1' })!;
  assert.ok(fs.existsSync(file));
  // Make the next atomic write fail: a directory squats on the tmp name.
  fs.mkdirSync(`${file}.${process.pid}.tmp`);
  recordRunInput('failclosed', { userId: 'u1' }, { userId: 'u2' });
  assert.equal(fs.existsSync(file), false, 'stale author must not survive a failed write');
  assert.equal(runStatePath('failclosed'), file);
  fs.rmSync(`${file}.${process.pid}.tmp`, { recursive: true, force: true });
});

test('internal gateway jobs reject Claude before launching and forward the guard to Codex', () => {
  const sent: Array<Record<string, unknown>> = [];
  const launched: Array<{ source: string; options: RunOptions }> = [];
  const manager = new RunManager({
    send: message => { sent.push(message); return true; },
    refreshInventory: () => {}, scheduleInventory: () => {},
    createRun: (source, options) => { launched.push({ source, options }); return new FakeRun(); },
  });
  manager.startNew('refused', '/workspace', 'spec', undefined, 'claude', { requireGateway: true });
  assert.equal(launched.length, 0);
  assert.equal(manager.activeCount, 0);
  assert.ok(sent.some(m => m.code === 'session_not_created'));
  manager.startNew('accepted', '/workspace', 'spec', undefined, 'codex', { requireGateway: true, permissionMode: 'plan' });
  assert.equal(launched.length, 1);
  assert.equal(launched[0]!.source, 'codex');
  assert.equal(launched[0]!.options.requireGateway, true);
  assert.equal(launched[0]!.options.permissionMode, 'plan');
  manager.end('accepted', 'ended');
});

test('an ended turn — result or a failed turn — is reported for its session', async () => {
  // The client turns this into an immediate inventory mtime bump
  // (`publishTurnEnd`): without it the hub learned of the final answer ~9 s
  // after the phone's idle re-read had already given up (07.10.2026).
  const ended: string[] = [];
  let options: RunOptions | undefined;
  const manager = new RunManager({
    send: () => true,
    refreshInventory: () => {},
    scheduleInventory: () => {},
    findLiveWriter: async () => undefined,
    turnEnded: (sessionId) => ended.push(sessionId),
    createRun: (_source, runOptions) => {
      options = runOptions;
      return new FakeRun();
    },
  });

  await manager.resume('run-t', 'session-t', '/workspace');
  options?.handlers.onEvent({ kind: 'assistant', text: 'working' });
  assert.deepEqual(ended, [], 'streaming text is not the end of a turn');
  options?.handlers.onEvent({ kind: 'result', text: 'done' });
  assert.deepEqual(ended, ['session-t']);
  options?.handlers.onEvent({ kind: 'error', text: '529 overloaded' });
  assert.deepEqual(ended, ['session-t', 'session-t'], 'a failed turn ends the turn too');
});

test('announceSettings re-tells the hub each run\'s permission mode', () => {
  // The hub keeps `run_mode` only in memory: after a hub restart every live
  // run showed «Сначала спросить» until the mode changed again (10.10.2026).
  const sent: Array<Record<string, unknown>> = [];
  let options: RunOptions | undefined;
  const manager = new RunManager({
    send: (message) => {
      sent.push(message);
      return true;
    },
    refreshInventory: () => {},
    scheduleInventory: () => {},
    createRun: (_source, runOptions) => {
      options = runOptions;
      return new FakeRun();
    },
  });
  manager.startNew('run-m', '/workspace');
  sent.length = 0;
  manager.announceSettings();
  assert.equal(sent.filter((m) => m.type === 'run_mode').length, 0, 'nothing reported yet, nothing re-told');

  options?.handlers.onModeChange?.('bypassPermissions');
  sent.length = 0;
  manager.announceSettings();
  assert.deepEqual(
    sent.filter((m) => m.type === 'run_mode').map((m) => [m.runId, m.mode]),
    [['run-m', 'bypassPermissions']],
  );

  // The runtime's later readback wins: the re-told mode is the latest one.
  options?.handlers.onModeChange?.('plan');
  sent.length = 0;
  manager.announceSettings();
  assert.deepEqual(sent.filter((m) => m.type === 'run_mode').map((m) => m.mode), ['plan']);
});

test('a late model answer is pending, then applied — never failed (16.10.2026)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const answer = deferred<void>();
  const sent: Array<Record<string, unknown>> = [];
  class SlowRun extends FakeRun {
    override setModel(): Promise<void> {
      return answer.promise;
    }
  }
  const manager = new RunManager({
    send: (message) => {
      sent.push(message);
      return true;
    },
    refreshInventory: () => {},
    scheduleInventory: () => {},
    findLiveWriter: async () => undefined,
    createRun: () => new SlowRun(),
  });
  await manager.resume('run-1', 'session-1', '/workspace');

  manager.setModel('run-1', 'opus');
  const codes = () =>
    sent.flatMap((m) => (m.type === 'stream' ? [(m.event as { code?: string }).code] : []));
  t.mock.timers.tick(10_000);
  assert.deepEqual(codes(), ['control_pending'], 'a slow CLI gets a «will apply» line');

  answer.resolve();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(codes(), ['control_pending', 'control_applied']);
  const settings = sent.filter((m) => m.type === 'run_settings').at(-1);
  assert.equal(settings?.model, 'opus', 'the picker learns the model the run is now on');
});

// Codex has no pid file for `findLiveWriter` to read, and `end()` reports
// `ended` to the hub before the app-server has actually died (SIGTERM, then
// SIGKILL after a grace). A resume of the same session on this machine must
// wait for that process's confirmed exit, or two writers hold one rollout.
test('resume of a session whose Codex writer is still exiting waits for it', async () => {
  const exited = deferred<void>();
  class DyingRun extends FakeRun {
    readonly exited = exited.promise;
  }
  const created: SessionRun[] = [];
  const manager = new RunManager({
    send: () => true,
    refreshInventory: () => {},
    scheduleInventory: () => {},
    findLiveWriter: async () => undefined,
    createRun: () => {
      const run = created.length === 0 ? new DyingRun() : new FakeRun();
      created.push(run);
      return run;
    },
  });

  await manager.resume('run-1', 'session-1', '/workspace', 'codex');
  assert.equal(created.length, 1);
  manager.end('run-1', 'ended');
  assert.equal(manager.activeCount, 0, 'ended at once — the hub releases its lock on this');

  const resuming = manager.resume('run-2', 'session-1', '/workspace', 'codex');
  manager.input('run-2', 'typed while the old app-server is still dying');
  await new Promise((done) => setTimeout(done, 25));
  assert.equal(created.length, 1, 'no second writer while the first is still exiting');

  exited.resolve();
  await resuming;
  assert.equal(created.length, 2);
  assert.deepEqual((created[1] as FakeRun).inputs.map((i) => i.text), [
    'typed while the old app-server is still dying',
  ]);

  // A different session never waits on it.
  const other = manager.resume('run-3', 'session-2', '/workspace', 'codex');
  await other;
  assert.equal(created.length, 3);
});

test('a run without `exited` (Claude) does not hold the next resume', async () => {
  const created: SessionRun[] = [];
  const manager = new RunManager({
    send: () => true,
    refreshInventory: () => {},
    scheduleInventory: () => {},
    findLiveWriter: async () => undefined,
    createRun: () => {
      const run = new FakeRun();
      created.push(run);
      return run;
    },
  });
  await manager.resume('run-1', 'session-1', '/workspace');
  manager.end('run-1', 'ended');
  await manager.resume('run-2', 'session-1', '/workspace');
  assert.equal(created.length, 2);
});

// The wait for a dying process is bounded, and the bound does NOT mean «go
// ahead»: a process that outlived SIGKILL is a writer nobody can vouch for, so
// the resume is refused (the message goes back to the composer via
// `resume_refused`) and the session stays marked until the process really goes.
test('a Codex writer that never confirms its exit makes the next resume refuse, not proceed', async () => {
  const never = new Promise<void>(() => {});
  class StuckRun extends FakeRun {
    readonly exited = never;
  }
  const sent: Array<Record<string, unknown>> = [];
  const created: SessionRun[] = [];
  const manager = new RunManager({
    send: (message) => {
      sent.push(message);
      return true;
    },
    refreshInventory: () => {},
    scheduleInventory: () => {},
    findLiveWriter: async () => undefined,
    // The bound elapses at once: this is the wait, not the clock, under test.
    sleep: async () => {},
    createRun: () => {
      const run = created.length === 0 ? new StuckRun() : new FakeRun();
      created.push(run);
      return run;
    },
  });
  await manager.resume('run-1', 'session-1', '/workspace', 'codex');
  manager.end('run-1', 'ended');

  await manager.resume('run-2', 'session-1', '/workspace', 'codex');
  assert.equal(created.length, 1, 'no second writer next to a process that may still write');
  const refusal = sent.find((m) => m.type === 'run_status' && m.runId === 'run-2');
  assert.equal(refusal?.state, 'yielded');
  assert.equal(refusal?.code, 'resume_refused');
  assert.equal(manager.activeCount, 0);

  // Still refused on the next try — the entry is kept, not consumed.
  await manager.resume('run-3', 'session-1', '/workspace', 'codex');
  assert.equal(created.length, 1);
  // …and a takeover is held to the same rule.
  await manager.takeover('run-4', 'session-1', '/workspace', 'hello', undefined, 'codex');
  assert.equal(created.length, 1);
  const aborted = sent.find((m) => m.type === 'run_status' && m.runId === 'run-4');
  assert.equal(aborted?.code, 'resume_refused');
});

// The hub releases a session's writer lock on a terminal `run_status`, but the
// app-server behind a Codex run outlives the close by up to the kill grace and
// leaves no pid file. The frame says so (`closing`), and `writer_released`
// follows when the process is confirmed gone — otherwise the hub would hand the
// session to a second writer while the first may still be writing.
test('a run with `exited` reports closing, then writer_released once the process is gone', async () => {
  const exited = deferred<void>();
  class DyingRun extends FakeRun {
    readonly exited = exited.promise;
  }
  const sent: Array<Record<string, unknown>> = [];
  const manager = new RunManager({
    send: (message) => {
      sent.push(message);
      return true;
    },
    refreshInventory: () => {},
    scheduleInventory: () => {},
    findLiveWriter: async () => undefined,
    createRun: () => new DyingRun(),
  });
  await manager.resume('run-1', 'session-1', '/workspace', 'codex');
  manager.end('run-1', 'ended');

  const ended = sent.find((m) => m.type === 'run_status' && m.state === 'ended');
  assert.deepEqual(ended, { type: 'run_status', sessionId: 'session-1', runId: 'run-1', state: 'ended', closing: true });
  await new Promise((done) => setTimeout(done, 10));
  assert.equal(sent.some((m) => m.type === 'writer_released'), false, 'not while the process lives');

  exited.resolve();
  await new Promise((done) => setTimeout(done, 10));
  const released = sent.filter((m) => m.type === 'writer_released');
  assert.deepEqual(released, [{ type: 'writer_released', sessionId: 'session-1', runId: 'run-1' }]);
  const order = sent.map((m) => m.type);
  assert.ok(order.indexOf('run_status') < order.indexOf('writer_released'), 'the status goes first');
});

test('a run without `exited` (Claude) sends the terminal status unchanged and no writer_released', async () => {
  const sent: Array<Record<string, unknown>> = [];
  const manager = new RunManager({
    send: (message) => {
      sent.push(message);
      return true;
    },
    refreshInventory: () => {},
    scheduleInventory: () => {},
    findLiveWriter: async () => undefined,
    createRun: () => new FakeRun(),
  });
  await manager.resume('run-1', 'session-1', '/workspace');
  manager.end('run-1', 'ended');
  await new Promise((done) => setTimeout(done, 10));

  const ended = sent.find((m) => m.type === 'run_status' && m.state === 'ended');
  // Byte for byte what an agent without this feature sends: no `closing` key
  // at all — absent, not `false` — so an old hub sees the same frame.
  assert.equal(JSON.stringify(ended), '{"type":"run_status","sessionId":"session-1","runId":"run-1","state":"ended"}');
  assert.equal('closing' in (ended ?? {}), false);
  assert.equal(sent.some((m) => m.type === 'writer_released'), false);
});

test('yield and fatal-error closes of a run with `exited` report closing too; reset reports nothing', async () => {
  const exitedA = deferred<void>();
  const exitedB = deferred<void>();
  const exitedC = deferred<void>();
  const exits = [exitedA, exitedB, exitedC];
  class DyingRun extends FakeRun {
    readonly exited: Promise<void>;
    constructor(done: Promise<void>) {
      super();
      this.exited = done;
    }
  }
  const sent: Array<Record<string, unknown>> = [];
  const options: RunOptions[] = [];
  let made = 0;
  const manager = new RunManager({
    send: (message) => {
      sent.push(message);
      return true;
    },
    refreshInventory: () => {},
    scheduleInventory: () => {},
    findLiveWriter: async () => undefined,
    readLiveWriters: async () => new Map([['session-y', { pid: 99, entrypoint: 'terminal' }]]),
    createRun: (_source, runOptions) => {
      options.push(runOptions);
      return new DyingRun(exits[made++].promise);
    },
  });

  // yielded
  await manager.resume('run-y', 'session-y', '/workspace', 'codex');
  await manager.checkYields();
  const yielded = sent.find((m) => m.type === 'run_status' && m.state === 'yielded');
  assert.equal(yielded?.closing, true);
  assert.equal(yielded?.runId, 'run-y');
  exitedA.resolve();

  // fatal error
  manager.startNew('run-f', '/workspace', undefined, undefined, 'codex');
  options[1].handlers.onEvent({ kind: 'error', text: 'app-server died', code: 'run_failed', fatal: true });
  const failed = sent.find((m) => m.type === 'run_status' && m.state === 'error');
  assert.equal(failed?.closing, true);
  assert.equal(failed?.code, 'run_failed');
  assert.equal(failed?.error, 'app-server died');
  exitedB.resolve();
  await new Promise((done) => setTimeout(done, 10));
  assert.deepEqual(
    sent.filter((m) => m.type === 'writer_released').map((m) => m.runId).sort(),
    ['run-f', 'run-y'],
  );

  // reset: no status, no writer_released — the socket is going away
  manager.startNew('run-r', '/workspace', undefined, undefined, 'codex');
  sent.length = 0;
  manager.reset('stopped');
  exitedC.resolve();
  await new Promise((done) => setTimeout(done, 10));
  assert.deepEqual(sent, []);
});

// An editor that opens the session between the last liveness check and the
// launch is not seen by the pre-check and may not produce an fs event the agent
// catches. The launch is followed by a burst of yield checks; the first one
// runs at once, so the collision is judged without anybody else's help.
test('a writer that appeared during the launch is yielded by the post-launch burst', async () => {
  const sent: Array<Record<string, unknown>> = [];
  let run: FakeRun | undefined;
  const manager = new RunManager({
    send: (message) => {
      sent.push(message);
      return true;
    },
    refreshInventory: () => {},
    scheduleInventory: () => {},
    // The pre-check saw nobody…
    findLiveWriter: async () => undefined,
    // …but by the time the run exists an editor holds the session.
    readLiveWriters: async () => new Map([['session-b', { pid: 4242, entrypoint: 'terminal' }]]),
    createRun: () => (run = new FakeRun()),
  });
  const resumed = manager.resume('run-b', 'session-b', '/workspace', 'codex');
  manager.input('run-b', 'typed before the answer'); // queued: the start is reserved
  await resumed;
  // Judged right after the launch, before the queued input was delivered: the
  // run is gone, nothing was written, the text goes back to the composer.
  assert.equal(run?.closed, true);
  assert.equal(run?.inputs.length, 0, 'no word reached a transcript somebody else holds');
  assert.equal(manager.activeCount, 0);
  const yielded = sent.find((m) => m.type === 'run_status' && m.runId === 'run-b' && m.state === 'yielded');
  assert.equal(yielded?.code, 'resume_refused');
});

// While the agent drains its processes before a self-update exit, a resume or
// a new session must be refused with the text going back to the composer —
// not started and then killed by the exit a few seconds later.
test('resume and new sessions are refused while the agent drains for an update', async () => {
  const exited = deferred<void>();
  class DyingRun extends FakeRun {
    readonly exited = exited.promise;
  }
  const sent: Array<Record<string, unknown>> = [];
  let created = 0;
  const manager = new RunManager({
    send: (message) => {
      sent.push(message);
      return true;
    },
    refreshInventory: () => {},
    scheduleInventory: () => {},
    findLiveWriter: async () => undefined,
    sleep: async () => {},
    createRun: () => {
      created += 1;
      return created === 1 ? new DyingRun() : new FakeRun();
    },
  });
  await manager.resume('run-1', 'session-1', '/workspace', 'codex');
  const drain = manager.endAllAndAwaitExit();
  await manager.resume('run-2', 'session-2', '/workspace', 'codex');
  manager.startNew('run-3', '/workspace', 'hello', undefined, 'codex');
  assert.equal(created, 1, 'nothing launched while draining');
  const refused = sent.filter((m) => m.type === 'run_status' && m.state === 'error' && (m.runId === 'run-2' || m.runId === 'run-3'));
  assert.deepEqual(refused.map((m) => m.code).sort(), ['resume_refused', 'session_not_created']);
  exited.resolve();
  await drain;
});
