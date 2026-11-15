/**
 * Unit tests for the wire protocol — no live system needed. Run: `npm test`
 * (node's built-in runner via tsx). These lock the contract that the agent, hub,
 * and web all depend on, including the request-id and RPC-schema changes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BrowserToCentral,
  CentralToBrowser,
  CentralToAgent,
  PROTOCOL_VERSION,
  RpcParams,
  RpcResultSchemas,
  decodeAgentToCentral,
  decodeCentralToBrowser,
  encode,
  AgentToCentral,
  AccessRow,
  MemberSummary,
  RUN_CLOSING_MAX_MS,
  CAP_STATS_ON_DEMAND,
  decodeBrowserToCentral,
} from '../src/index.js';

test('agent register round-trips through encode/decode', () => {
  const msg = {
    type: 'register' as const,
    protocol: PROTOCOL_VERSION,
    machine: { machineId: 'm1', name: 'box', os: 'linux' as const, agentVersion: '0.0.0' },
  };
  const decoded = decodeAgentToCentral(encode(msg));
  assert.equal(decoded.type, 'register');
  assert.deepEqual(decoded, msg);
});

test('register_ack preserves the optional Claude monitoring switch', () => {
  const legacy = { type: 'register_ack', adoptedRunIds: [] };
  assert.deepEqual(CentralToAgent.parse(legacy), legacy);
  for (const enabled of [false, true]) {
    const msg = { ...legacy, claudeUsageEnabled: enabled };
    assert.deepEqual(CentralToAgent.parse(msg), msg);
  }
  assert.throws(() => CentralToAgent.parse({ ...legacy, claudeUsageEnabled: null }));
});

test('new_session carries an optional source so the hub can steer employees to codex', () => {
  // Legacy shape (no source) still parses — absence means Claude.
  const claudeRun = CentralToAgent.parse({ type: 'new_session', runId: 'r1', cwd: '/repo' });
  assert.equal(claudeRun.type, 'new_session');
  assert.equal('source' in claudeRun ? claudeRun.source : undefined, undefined);

  // Member sessions are tagged 'codex' by the hub.
  const codexRun = CentralToAgent.parse({
    type: 'new_session',
    runId: 'r2',
    cwd: '/repo',
    source: 'codex',
  });
  assert.equal(codexRun.type === 'new_session' ? codexRun.source : undefined, 'codex');

  // Anything outside the enum is rejected.
  assert.throws(() =>
    CentralToAgent.parse({ type: 'new_session', runId: 'r3', cwd: '/repo', source: 'gpt' }),
  );
});

test('transactional transcript replication validates canonical chunks and cursors', () => {
  const summary = {
    sessionId: 's1',
    source: 'claude' as const,
    title: 'Session',
    cwd: '/repo',
    lastModified: 123,
  };
  assert.doesNotThrow(() =>
    AgentToCentral.parse({
      type: 'session_sync_begin',
      syncId: 'sync-1',
      sessionId: 's1',
      source: 'claude',
      summary,
      mode: 'append',
      baseRevision: 4,
    }),
  );
  assert.doesNotThrow(() =>
    AgentToCentral.parse({
      type: 'session_sync_chunk',
      syncId: 'sync-1',
      start: 10,
      messages: [{ type: 'user', uuid: 'u1', blocks: [{ kind: 'text', text: 'hello' }] }],
    }),
  );
  assert.doesNotThrow(() =>
    CentralToAgent.parse({
      type: 'session_sync_catalog',
      sessions: [
        { sessionId: 's1', source: 'claude', revision: 4, messageCount: 10, tailHash: 'abc', syncedMtime: 123 },
      ],
    }),
  );
  assert.throws(() =>
    AgentToCentral.parse({
      type: 'session_sync_chunk',
      syncId: 'sync-1',
      start: 0,
      messages: Array.from({ length: 201 }, (_, i) => ({ type: 'user', uuid: String(i), blocks: [] })),
    }),
  );
});

test('term_open requires a browser-allocated termId', () => {
  assert.doesNotThrow(() =>
    BrowserToCentral.parse({ type: 'term_open', termId: 't1', machineId: 'm1', cwd: '/tmp' }),
  );
  // Omitting the id breaks the correlation contract — must be rejected.
  assert.throws(() => BrowserToCentral.parse({ type: 'term_open', machineId: 'm1', cwd: '/tmp' }));
});

test('mirror_open requires a browser-allocated mirrorId', () => {
  assert.doesNotThrow(() =>
    BrowserToCentral.parse({ type: 'mirror_open', mirrorId: 'x1', machineId: 'm1', sessionId: 's1', cwd: '/tmp' }),
  );
  assert.throws(() => BrowserToCentral.parse({ type: 'mirror_open', machineId: 'm1', sessionId: 's1', cwd: '/tmp' }));
});

test('mirror_data validates canonical history at both wire boundaries', () => {
  const valid = {
    type: 'mirror_data' as const,
    mirrorId: 'x1',
    replace: true,
    messages: [{ type: 'assistant' as const, uuid: 'm1', blocks: [{ kind: 'text' as const, text: 'hello' }] }],
  };
  assert.doesNotThrow(() => AgentToCentral.parse(valid));
  assert.doesNotThrow(() => CentralToBrowser.parse(valid));

  const invalid = {
    ...valid,
    messages: [{ type: 'assistant', uuid: 'm1', blocks: [{ kind: 'made_up', text: 'hello' }] }],
  };
  assert.throws(() => AgentToCentral.parse(invalid));
  assert.throws(() => CentralToBrowser.parse(invalid));
});

test('RpcParams validates per-method params', () => {
  assert.deepEqual(RpcParams['fs.read'].parse({ cwd: '/a', path: 'b.ts' }), { cwd: '/a', path: 'b.ts' });
  // A missing required field is rejected before the handler ever runs.
  assert.throws(() => RpcParams['fs.read'].parse({ cwd: '/a' }));
  // git.stage needs string[], not a bare string.
  assert.throws(() => RpcParams['git.stage'].parse({ cwd: '/a', paths: 'x' }));
  assert.equal(
    RpcParams['session.messages'].parse({ cwd: '/a', sessionId: 's', limit: 2000 }).limit,
    2000,
  );
  assert.throws(() => RpcParams['session.messages'].parse({ cwd: '/a', sessionId: 's', limit: 2001 }));
});

test('RpcParams enumerates exactly the supported methods', () => {
  const methods = Object.keys(RpcParams);
  assert.ok(methods.includes('fs.read'));
  assert.ok(methods.includes('models.list'));
  assert.equal(methods.includes('does.not.exist'), false);
});

test('RPC methods and results validate at their wire-specific boundary', () => {
  assert.doesNotThrow(() =>
    BrowserToCentral.parse({
      type: 'rpc_request', requestId: 'r1', machineId: 'm1', method: 'session.messages',
      params: { cwd: '/a', sessionId: 's1' },
    }),
  );
  assert.throws(() =>
    BrowserToCentral.parse({
      type: 'rpc_request', requestId: 'r2', machineId: 'm1', method: 'arbitrary.exec', params: {},
    }),
  );
  assert.deepEqual(
    RpcResultSchemas['session.messages'].parse({
      messages: [{ type: 'assistant', uuid: 'u1', blocks: [{ kind: 'text', text: 'ok' }] }],
    }).messages[0]?.uuid,
    'u1',
  );
  assert.throws(() =>
    RpcResultSchemas['session.messages'].parse({ messages: [{ type: 'assistant', uuid: 'u1' }] }),
  );
  assert.throws(() => RpcResultSchemas['proc.list'].parse({ processes: [{ pid: 'not-a-number' }] }));
});

test('snapshot with activeRuns round-trips (central -> browser)', () => {
  const snap = {
    type: 'snapshot' as const,
    machines: [
      {
        machine: { machineId: 'm1', name: 'box', os: 'linux' as const, agentVersion: '0.0.0' },
        online: true,
        lastSeen: 123,
        sessions: [],
      },
    ],
    activeRuns: [{ runId: 'r1', machineId: 'm1', sessionId: 's1', state: 'idle' as const, since: 1 }],
    roadmap: {
      groups: [{ id: 'product', name: 'Product', blurb: 'Core', projects: ['repo'] }],
      unassigned: { name: 'Other', blurb: '' },
    },
  };
  const decoded = CentralToBrowser.parse(JSON.parse(JSON.stringify(snap)));
  assert.equal(decoded.type, 'snapshot');
  if (decoded.type === 'snapshot') assert.equal(decoded.roadmap?.groups[0]?.projects[0], 'repo');
});

test('workspace-scoped snapshot carries viewer capabilities', () => {
  const decoded = decodeCentralToBrowser(JSON.stringify({
    type: 'snapshot',
    viewer: {
      userId: 'u1', email: 'member@example.com', platformAdmin: false,
      workspace: { workspaceId: 'w1', name: 'Team', kind: 'organization', role: 'member' },
      workspaces: [{ workspaceId: 'w1', name: 'Team', kind: 'organization', role: 'member' }],
    },
    machines: [], activeRuns: [],
  }));
  assert.equal(decoded.type, 'snapshot');
  if (decoded.type === 'snapshot') assert.equal(decoded.viewer?.workspace.workspaceId, 'w1');
});

test('plan approval carries the selected permission mode end to end', () => {
  const browser = BrowserToCentral.parse({
    type: 'tool_decision',
    runId: 'r1',
    requestId: 'q1',
    allow: true,
    updatedInput: {},
    permissionMode: 'acceptEdits',
  });
  assert.equal(browser.type, 'tool_decision');
  assert.equal(browser.permissionMode, 'acceptEdits');

  const agent = CentralToAgent.parse({
    type: 'tool_decision',
    requestId: 'q1',
    allow: true,
    permissionMode: 'default',
  });
  assert.equal(agent.type, 'tool_decision');
  assert.equal(agent.permissionMode, 'default');
});

/**
 * `max` is the one effort level that can only ever be REPORTED — the CLI runs
 * at it and nothing can pin it — so it is the one value the browser schema was
 * missing. The two sides declared different domains for the same field, and the
 * consequence was not a missing level: a zod parse is all-or-nothing, so a
 * frame carrying `max` failed entirely and the decoder's `catch` dropped the
 * whole message. A session running at max lost its MODEL updates too, and
 * nothing was logged on any layer.
 */
test('a run reported at max still delivers the rest of its settings', () => {
  const frame = {
    type: 'run_settings',
    runId: 'r1',
    sessionId: 's1',
    activeModel: 'claude-opus-5',
    activeEffort: 'max',
  };

  // The agent-facing schema always allowed it.
  const agent = decodeAgentToCentral(JSON.stringify(frame));
  assert.equal(agent?.type, 'run_settings');

  // The browser-facing one has to agree, or the frame never arrives at all.
  const browser = decodeCentralToBrowser(JSON.stringify(frame));
  assert.equal(browser?.type, 'run_settings', 'the frame must survive the parse');
  if (browser?.type === 'run_settings') {
    assert.equal(browser.activeEffort, 'max');
    assert.equal(browser.activeModel, 'claude-opus-5', 'and the model rides on the same frame');
  }
});

test('run_settings reports model and effort back, and absent is not null', () => {
  const agent = decodeAgentToCentral(JSON.stringify({
    type: 'run_settings',
    sessionId: 's1',
    runId: 'r1',
    model: 'opus',
    activeModel: 'claude-opus-5',
    effort: 'xhigh',
  }));
  assert.equal(agent?.type, 'run_settings');
  if (agent?.type === 'run_settings') {
    assert.equal(agent.model, 'opus');
    assert.equal(agent.activeModel, 'claude-opus-5');
    // No explicit ultracode stays absent — clean()'s contract, not `null`.
    assert.ok(!('ultracode' in agent) || agent.ultracode === undefined);
  }

  // Cleared back to the account default: both fields simply go away.
  const cleared = CentralToBrowser.parse({
    type: 'run_settings',
    runId: 'r1',
    sessionId: 's1',
  });
  assert.equal(cleared.type, 'run_settings');
  if (cleared.type === 'run_settings') {
    assert.equal(cleared.model, undefined);
    assert.equal(cleared.effort, undefined);
  }

  // The model list carries the alias mapping the picker matches on, and the
  // runtime's own effort names — 'max' included, which EffortLevel excludes.
  const models = RpcResultSchemas['models.list'].parse({
    models: [{ id: 'opus', name: 'Opus', resolved: 'claude-opus-5', efforts: ['high', 'max'] }],
  });
  assert.equal(models.models[0]?.resolved, 'claude-opus-5');
  assert.deepEqual(models.models[0]?.efforts, ['high', 'max']);
});

test('enrichment round-trips, and absent is not null', () => {
  const req = BrowserToCentral.parse({
    type: 'enrich_request',
    requestId: 'e1',
    machineId: 'm1',
    sessionId: 's1',
    source: 'claude',
    uuid: 'a1-p0',
    text: 'Изменение в одном файле. Раскатывать?',
  });
  assert.equal(req.type, 'enrich_request');
  // userText omitted stays omitted — the hub's clean() contract.
  assert.ok(!('userText' in req) || req.userText === undefined);

  const ok = decodeCentralToBrowser(JSON.stringify({
    type: 'enrich_result',
    requestId: 'e1',
    ok: true,
    enrichment: { quickReplies: [{ label: 'Да, раскатывай', send: 'Да, раскатывай' }] },
  }));
  assert.equal(ok.type, 'enrich_result');
  if (ok.type === 'enrich_result') assert.equal(ok.enrichment?.quickReplies?.[0]?.label, 'Да, раскатывай');

  const off = decodeCentralToBrowser(JSON.stringify({
    type: 'enrich_result', requestId: 'e2', ok: false, error: 'enrichment not configured',
  }));
  assert.equal(off.type, 'enrich_result');
  if (off.type === 'enrich_result') assert.equal(off.enrichment, undefined);

  // null is a protocol violation, not a value — zod must refuse it.
  assert.throws(() => decodeCentralToBrowser(JSON.stringify({
    type: 'enrich_result', requestId: 'e3', ok: true, enrichment: null,
  })));
});

test('viewer access and sandbox markers are optional, never null', () => {
  // A pre-rollout hub omits `access` — the client treats that as active.
  const legacy = decodeCentralToBrowser(JSON.stringify({
    type: 'snapshot',
    viewer: {
      userId: 'u1', email: 'a@b', platformAdmin: false,
      workspace: { workspaceId: 'personal:u1', name: 'Моя работа', kind: 'personal', role: 'owner' },
      workspaces: [],
    },
    machines: [],
  }));
  assert.equal(legacy.type, 'snapshot');
  if (legacy.type === 'snapshot') assert.equal(legacy.viewer?.access, undefined);

  const waitlisted = decodeCentralToBrowser(JSON.stringify({
    type: 'snapshot',
    viewer: {
      userId: 'u2', email: 'c@d', platformAdmin: false,
      workspace: { workspaceId: 'personal:u2', name: 'Моя работа', kind: 'personal', role: 'owner' },
      workspaces: [],
      access: { state: 'waitlist', plan: 'community', requestedAt: 1 },
    },
    machines: [{
      machine: { machineId: 'm1', name: 'sb-c', os: 'linux', agentVersion: '0' },
      kind: 'sandbox', online: true, lastSeen: 1, sessions: [],
    }],
  }));
  if (waitlisted.type === 'snapshot') {
    assert.equal(waitlisted.viewer?.access?.state, 'waitlist');
    assert.equal(waitlisted.machines[0]?.kind, 'sandbox');
  }

  assert.throws(() => decodeCentralToBrowser(JSON.stringify({
    type: 'snapshot',
    viewer: {
      userId: 'u3', email: 'e@f', platformAdmin: false,
      workspace: { workspaceId: 'personal:u3', name: 'x', kind: 'personal', role: 'owner' },
      workspaces: [], access: null,
    },
    machines: [],
  })));
});

test('a viewer, an access row and a member without an email decode; email is never null', () => {
  // A Telegram-only account has no address: the hub omits the key.
  const snap = decodeCentralToBrowser(JSON.stringify({
    type: 'snapshot',
    viewer: {
      userId: 'tg-1', fullName: 'Данис', platformAdmin: false,
      workspace: { workspaceId: 'personal:tg-1', name: 'Моя работа', kind: 'personal', role: 'owner' },
      workspaces: [],
      access: { state: 'waitlist', plan: 'community', requestedAt: 1 },
    },
    machines: [],
  }));
  assert.equal(snap.type, 'snapshot');
  if (snap.type === 'snapshot') {
    assert.equal(snap.viewer?.userId, 'tg-1', 'the whole snapshot survives, viewer included');
    assert.equal(snap.viewer?.email, undefined);
  }
  assert.ok(AccessRow.safeParse({
    userId: 'tg-1', fullName: 'Данис', state: 'waitlist', plan: 'community', requestedAt: 1,
    seat: { status: 'none' }, sandbox: { status: 'none' },
  }).success);
  assert.ok(MemberSummary.safeParse({ userId: 'tg-1', role: 'member', joinedAt: 1 }).success);
  // Optional means absent: the hub must never send null.
  assert.equal(MemberSummary.safeParse({ userId: 'tg-1', email: null, role: 'member', joinedAt: 1 }).success, false);
});

test('projects.create validates its name and https-only clone url', () => {
  assert.ok(RpcParams['projects.create'].safeParse({ name: 'my-app' }).success);
  assert.ok(RpcParams['projects.create'].safeParse({ name: 'my-app', gitUrl: 'https://github.com/x/y.git' }).success);
  assert.ok(!RpcParams['projects.create'].safeParse({ name: '../x' }).success);
  assert.ok(!RpcParams['projects.create'].safeParse({ name: 'App' }).success);
  assert.ok(!RpcParams['projects.create'].safeParse({ name: 'ok', gitUrl: 'git@github.com:x/y.git' }).success);
  const res = RpcResultSchemas['projects.create'].parse({ cwd: '/home/sb-c/work/my-app', label: 'my-app', created: true, git: 'init' });
  assert.equal(res.git, 'init');
  const listed = RpcResultSchemas['projects.list'].parse({ projects: [{ cwd: '/w/a', label: 'a', lastModified: 1, count: 0, origin: 'root' }] });
  assert.equal(listed.projects[0]?.origin, 'root');
});

test('a stream error may carry a machine-readable code, and a push is host-only', () => {
  const err = decodeAgentToCentral(encode({
    type: 'stream', sessionId: 's', runId: 'r',
    event: { kind: 'error', text: 'quota', code: 'budget_exhausted' },
  }));
  if (err.type === 'stream') assert.equal(err.event.code, 'budget_exhausted');
  const pushed = decodeAgentToCentral(encode({ type: 'project_pushed', cwd: '/w/a', remoteHost: 'github.com' }));
  assert.equal(pushed.type, 'project_pushed');
});


test('runBy survives the wire on new_session, resume and takeover', () => {
  const runBy = { userId: 'u1', email: 'a@b.c' };
  const msgs = [
    { type: 'new_session', runId: 'r', cwd: '/w', runBy },
    { type: 'resume', sessionId: 's', cwd: '/w', runId: 'r', runBy: { userId: 'u1' } },
    { type: 'takeover', sessionId: 's', cwd: '/w', runId: 'r', runBy },
  ];
  for (const m of msgs) {
    assert.deepEqual(CentralToAgent.parse(m), m);
    assert.throws(() => CentralToAgent.parse({ ...m, runBy: 'u1' }));
    assert.throws(() => CentralToAgent.parse({ ...m, runBy: { userId: '' } }));
    assert.throws(() => CentralToAgent.parse({ ...m, runBy: { userId: 'u', email: 5 } }));
  }
});

test('input carries the typist as an optional RunBy', () => {
  const msg = { type: 'input', runId: 'r', text: 'hi', by: { userId: 'u2', email: 'b@c.d' } };
  assert.deepEqual(CentralToAgent.parse(msg), msg);
  assert.deepEqual(CentralToAgent.parse({ type: 'input', runId: 'r', text: 'hi' }), { type: 'input', runId: 'r', text: 'hi' });
  assert.throws(() => CentralToAgent.parse({ ...msg, by: 'u2' }));
  assert.throws(() => CentralToAgent.parse({ ...msg, by: { userId: '' } }));
});

test('tool_decision carries the answering user as an optional RunBy', () => {
  const msg = { type: 'tool_decision', requestId: 'q', allow: true, by: { userId: 'u2' } };
  assert.deepEqual(CentralToAgent.parse(msg), msg);
  assert.throws(() => CentralToAgent.parse({ ...msg, by: 7 }));
  assert.throws(() => CentralToAgent.parse({ ...msg, by: { email: 'x@y.z' } }));
});

test('internal gateway requirement and enforcement capability survive the wire', () => {
  const msg = { type: 'new_session', runId: 'internal', cwd: '/repo', source: 'codex', requireGateway: true };
  assert.deepEqual(CentralToAgent.parse(msg), msg);
  assert.throws(() => CentralToAgent.parse({ ...msg, requireGateway: 'true' }));
  assert.throws(() => CentralToAgent.parse({ ...msg, requireGateway: null }));
  const register = { type: 'register', protocol: PROTOCOL_VERSION,
    machine: { machineId: 'm', name: 'box', os: 'linux', agentVersion: 'test', gatewaySessions: true } };
  assert.deepEqual(AgentToCentral.parse(register), register);
  assert.throws(() => AgentToCentral.parse({ ...register, machine: { ...register.machine, gatewaySessions: null } }));
});

test('run_status may say the runtime is still closing; absent otherwise, never null', () => {
  const plain = { type: 'run_status', sessionId: 's1', runId: 'r1', state: 'ended' };
  // An old agent's frame, and every Claude run: no `closing` key, byte for byte.
  const parsed = AgentToCentral.parse(plain);
  assert.deepEqual(parsed, plain);
  assert.equal('closing' in parsed, false);
  assert.equal(JSON.stringify(parsed), JSON.stringify(plain));

  for (const state of ['ended', 'error', 'yielded'] as const) {
    const closing = { ...plain, state, closing: true };
    assert.deepEqual(decodeAgentToCentral(encode(closing)), closing);
  }
  assert.throws(() => AgentToCentral.parse({ ...plain, closing: null }));
  assert.throws(() => AgentToCentral.parse({ ...plain, closing: 'yes' }));

  // The hub rebuilds the browser frame field by field; the browser schema
  // must not grow the key, or a client would start to depend on it.
  const fed = CentralToBrowser.parse({
    type: 'run_status',
    ref: 'k',
    sessionId: 's1',
    runId: 'r1',
    state: 'ended',
    closing: true,
  } as unknown);
  assert.equal('closing' in fed, false);
});

test('writer_released names the session and run, and nothing else is required', () => {
  const msg = { type: 'writer_released', sessionId: 's1', runId: 'r1' };
  const decoded = decodeAgentToCentral(encode(msg));
  assert.deepEqual(decoded, msg);
  assert.throws(() => AgentToCentral.parse({ type: 'writer_released', runId: 'r1' }));
  assert.throws(() => AgentToCentral.parse({ type: 'writer_released', sessionId: 's1' }));
});

test('the closing bound covers the runtime kill grace with margin', () => {
  // codex-run.ts KILL_GRACE_MS is 5 s, plus the 1 s the agent waits after
  // SIGKILL; the hub's deadline must outlast both or it frees a live writer.
  assert.equal(RUN_CLOSING_MAX_MS, 8_000);
  assert.ok(RUN_CLOSING_MAX_MS >= 5_000 + 1_000);
});

test('stats_interest is a browser frame with a required boolean, and the cap name is fixed', () => {
  // The hub (server-rs `CAP_STATS_ON_DEMAND`) and the clients agree on this
  // string; a rename here without the Rust constant silences hardware for good.
  assert.equal(CAP_STATS_ON_DEMAND, 'statsOnDemand');
  assert.deepEqual(decodeBrowserToCentral('{"type":"stats_interest","on":true}'), {
    type: 'stats_interest',
    on: true,
  });
  assert.throws(() => decodeBrowserToCentral('{"type":"stats_interest"}'));
  const hello = decodeBrowserToCentral(
    JSON.stringify({ type: 'hello', client: 'app', caps: ['sessionPatch', CAP_STATS_ON_DEMAND] }),
  );
  assert.equal(hello.type, 'hello');
  if (hello.type === 'hello') assert.deepEqual(hello.caps, ['sessionPatch', 'statsOnDemand']);
});
