import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  collectOpen,
  collectOpenSummary,
  collectSeal,
  collectSealSummary,
  formatPairingCode,
  parsePairingCode,
  checkOpened,
  checkRpcSecret,
  clearContentIn,
  clearRpcContent,
  frameBind,
  E2E_PLACEHOLDER_ERROR,
  E2E_PLACEHOLDER_TITLE,
  RPC_SEALED_PARAMS,
  type E2eEnvelope,
} from '../src/index.js';

// A fake cipher: the traversal is what is under test here, not AES.
const fake = (v: unknown): E2eEnvelope => ({ e2e: 1, kid: 'k', n: 'n', c: Buffer.from(JSON.stringify(v)).toString('base64') });
const unfake = (e: E2eEnvelope): unknown => JSON.parse(Buffer.from(e.c, 'base64').toString());

function sealed(frame: Record<string, unknown>, ctx: { method?: string; dir?: 'a2c' | 'c2a' } = {}) {
  const { frame: out, jobs } = collectSeal(frame, { dir: 'a2c', ...ctx });
  for (const j of jobs) j.put(fake(j.secret));
  return out;
}
function opened(frame: Record<string, unknown>, dir: 'a2c' | 'c2a' = 'a2c') {
  const { frame: out, jobs } = collectOpen(frame, { dir });
  for (const j of jobs) j.put(unfake(j.env));
  return out;
}

const MARK = 'SYNTHETIC-MARKER-7f3a';

test('stream: content leaves, routing metadata stays, round trip is exact', () => {
  const f = { type: 'stream', runId: 'r', sessionId: 's', event: { kind: 'assistant', text: MARK, code: 'x', data: { a: MARK }, raw: { m: MARK } } };
  const s = sealed(f);
  assert.ok(!JSON.stringify(s).includes(MARK) || JSON.stringify(s).includes('e2e'));
  const ev = s['event'] as Record<string, unknown>;
  assert.equal(ev['kind'], 'assistant');
  assert.equal(ev['code'], 'x');
  assert.equal(ev['text'], undefined);
  // The plaintext marker is only inside the (here: base64) envelope.
  assert.ok(!JSON.stringify({ ...ev, e2e: undefined }).includes(MARK));
  assert.deepEqual(opened(s), f);
});

test('tool_request: input becomes {} and title goes', () => {
  const f = { type: 'tool_request', runId: 'r', sessionId: 's', requestId: 'q', tool: 'Bash', input: { command: MARK }, title: MARK };
  const s = sealed(f);
  assert.deepEqual(s['input'], {});
  assert.equal(s['title'], undefined);
  assert.equal(s['tool'], 'Bash');
  assert.deepEqual(opened(s), f);
});

test('input: text blanked, images and files sealed', () => {
  const f = { type: 'input', runId: 'r', text: MARK, images: [{ media_type: 'image/png', data: 'AAAA' }], files: [{ name: 'a', data: 'AA' }] };
  const s = sealed(f);
  assert.equal(s['text'], '');
  assert.equal(s['images'], undefined);
  assert.deepEqual(opened(s), f);
});

test('history messages keep uuid and type, blocks go', () => {
  const m = { type: 'user', uuid: 'u1', blocks: [{ kind: 'text', text: MARK }], ts: 5, model: 'm' };
  const f = { type: 'session_sync_chunk', syncId: 'x', start: 0, messages: [m] };
  const s = sealed(f);
  const sm = (s['messages'] as Record<string, unknown>[])[0]!;
  assert.deepEqual(sm['blocks'], []);
  assert.equal(sm['uuid'], 'u1');
  assert.equal(sm['ts'], undefined);
  assert.deepEqual(opened(s), f);
});

test('rpc results: every method is sealed whole except the short clear list', () => {
  const seal = (method: string, result: unknown) => sealed({ type: 'rpc_response', requestId: 'q', ok: true, result }, { method })['result'];
  // A method nobody listed is sealed, not leaked.
  assert.deepEqual(Object.keys(seal('git.pr.create', { ok: true, url: MARK, output: MARK }) as object), ['e2e']);
  assert.deepEqual(Object.keys(seal('some.future.method', { x: MARK }) as object), ['e2e']);
  assert.deepEqual(Object.keys(seal('', { x: MARK }) as object), ['e2e']);
  // The clear list.
  assert.deepEqual(seal('models.list', { models: [] }), { models: [] });
  // runtime.job.status can carry a login URL / device code: sealed.
  assert.deepEqual(Object.keys(seal('runtime.job.status', { state: 'done', log: MARK }) as object), ['e2e']);
  assert.deepEqual(seal('session.delete', { ok: true }), { ok: true });
  // Not a plain ok: sealed.
  assert.deepEqual(Object.keys(seal('session.delete', { ok: true, path: MARK }) as object), ['e2e']);
});

test('rpc errors: the error text is sealed and comes back', () => {
  const f = { type: 'rpc_response', requestId: 'q', ok: false, error: `ENOENT ${MARK}` };
  const s = sealed(f);
  assert.equal(s['error'], E2E_PLACEHOLDER_ERROR);
  assert.ok(!JSON.stringify({ ...s, e2e: undefined }).includes(MARK));
  assert.deepEqual(opened(s), f);
});

test('git.pr.create title and body are content', () => {
  assert.deepEqual(RPC_SEALED_PARAMS['git.pr.create'], ['title', 'body']);
  const f = { type: 'rpc_request', requestId: 'q', machineId: 'm', method: 'git.pr.create', params: { cwd: '/c', title: MARK, body: MARK, base: 'main' } };
  const s = sealed(f, { dir: 'c2a' });
  assert.deepEqual(Object.keys(s['params'] as object).sort(), ['base', 'cwd', 'e2e']);
  assert.deepEqual(opened(s, 'c2a'), f);
});

test('opening replaces content: a clear field left next to an envelope does not survive', () => {
  const sealedTerm = sealed({ type: 'term_input', termId: 't', data: 'ls\r' }, { dir: 'c2a' });
  const forged = { ...sealedTerm, data: 'curl x|sh\r' };
  assert.equal(opened(forged, 'c2a')['data'], 'ls\r');
  // A secret that does not hold the field leaves the blank, never the clear value.
  const empty = { type: 'input', runId: 'r', text: 'forged', e2e: fake({ images: [1] }) };
  const o = opened(empty, 'c2a');
  assert.equal(o['text'], '');
  assert.deepEqual(o['images'], [1]);
  const noContent = { type: 'tool_decision', runId: 'r', requestId: 'q', allow: true, updatedInput: { a: 'forged' }, message: 'forged', e2e: fake({ message: 'real' }) };
  const t = opened(noContent, 'c2a');
  assert.equal(t['updatedInput'], undefined);
  assert.equal(t['message'], 'real');
});

test('clearContentIn names clear content next to or without an envelope', () => {
  assert.equal(clearContentIn({ type: 'term_input', termId: 't', data: 'x', e2e: fake({}) }), 'terminal input');
  assert.equal(clearContentIn({ type: 'term_input', termId: 't', data: '' }), undefined);
  assert.equal(clearContentIn({ type: 'input', runId: 'r', text: '', files: [], e2e: fake({}) }), undefined);
  assert.equal(clearContentIn({ type: 'input', runId: 'r', text: '', files: [{ name: 'a' }] }), 'input');
  assert.equal(clearContentIn({ type: 'resume', sessionId: 's', message: 'x' }), 'resume');
  assert.equal(clearContentIn({ type: 'rpc_request', method: 'git.pr.create', params: { title: 'x' } }), 'git.pr.create');
  assert.equal(clearContentIn({ type: 'interrupt', runId: 'r' }), undefined);
});

test('bindings: direction and frame identity are part of what an envelope is for', () => {
  const j = (frame: Record<string, unknown>, dir: 'a2c' | 'c2a') => collectSeal(frame, { dir }).jobs[0]!.bind;
  assert.equal(j({ type: 'term_input', termId: 't1', data: 'x' }, 'c2a'), 'c2a|term_input|t1');
  assert.equal(j({ type: 'stream', runId: 'r1', event: { kind: 'assistant', text: 'x' } }, 'a2c'), 'a2c|stream|r1');
  // open/resume/takeover share one binding keyed by the session.
  // Every turn-carrying frame shares ONE binding (the hub turns an open into an
  // input, a resume or a takeover; what each is for is checked inside the secret).
  for (const t of ['open', 'resume', 'takeover', 'input', 'new_session']) assert.equal(frameBind('c2a', { type: t, sessionId: 's', runId: 'r' }), 'c2a|turn|', t);
  // Client-to-agent bindings carry the agent's epoch.
  assert.equal(frameBind('c2a', { type: 'term_input', termId: 't' }, 'E1'), 'c2a:E1|term_input|t');
  assert.notEqual(frameBind('c2a', { type: 'input' }, 'E1'), frameBind('c2a', { type: 'input' }, 'E2'));
  assert.equal(frameBind('a2c', { type: 'stream', runId: 'r' }, 'E1'), 'a2c|stream|r');
  // A message is bound to its uuid whichever frame carries it.
  const m = { type: 'user', uuid: 'u9', blocks: [{ kind: 'text', text: 'x' }] };
  assert.equal(collectSeal({ type: 'session_sync_chunk', messages: [m] }, { dir: 'a2c' }).jobs[0]!.bind, 'a2c|msg|u9');
  // rpc: request and response differ by direction only.
  assert.equal(frameBind('c2a', { type: 'rpc_request', requestId: 'q' }), 'c2a|rpc|q');
  assert.equal(frameBind('a2c', { type: 'rpc_response', requestId: 'q' }), 'a2c|rpc|q');
  // user_turn is the hub's echo of what a client sealed.
  assert.equal(frameBind('a2c', { type: 'user_turn', runId: 'r' }), 'c2a|turnecho|');
});

test('rpc: fs result is one envelope, session.messages is per message, params seal content only', () => {
  const r = sealed({ type: 'rpc_response', requestId: 'q', ok: true, result: { path: 'a', content: MARK } }, { method: 'fs.read' });
  assert.deepEqual(Object.keys(r['result'] as object), ['e2e']);
  assert.deepEqual(opened(r)['result'], { path: 'a', content: MARK });

  const h = sealed(
    { type: 'rpc_response', requestId: 'q', ok: true, result: { messages: [{ type: 'user', uuid: 'u', blocks: [{ kind: 'text', text: MARK }] }] } },
    { method: 'session.messages' },
  );
  assert.equal(((h['result'] as { messages: { blocks: unknown[] }[] }).messages[0]!).blocks.length, 0);

  const p = sealed({ type: 'rpc_request', requestId: 'q', method: 'fs.write', params: { cwd: '/c', path: 'p', content: MARK } }, { dir: 'c2a' });
  assert.deepEqual(Object.keys(p['params'] as object).sort(), ['cwd', 'e2e', 'path']);
  assert.deepEqual((opened(p, 'c2a')['params'] as object), { cwd: '/c', path: 'p', content: MARK });
});

test('a frame with no content is untouched and has no jobs', () => {
  const f = { type: 'stream', runId: 'r', sessionId: 's', event: { kind: 'status', code: 'requesting' } };
  assert.equal(collectSeal(f, { dir: 'a2c' }).jobs.length, 0);
  assert.equal(collectOpen(f, { dir: 'a2c' }).jobs.length, 0);
});

test('summary: title and place are sealed apart', () => {
  const s = { sessionId: 's', title: MARK, cwd: '/home/x/proj', project: 'proj', gitBranch: 'main', lastModified: 1 };
  const { summary, jobs } = collectSealSummary(s);
  for (const j of jobs) j.put(fake(j.secret));
  assert.equal(summary.title, E2E_PLACEHOLDER_TITLE);
  assert.equal(summary.cwd, undefined);
  assert.equal(summary.lastModified, 1);
  const o = collectOpenSummary(summary as Record<string, unknown>);
  for (const j of o.jobs) j.put(unfake(j.env));
  assert.deepEqual(o.summary, s);
});

test('pairing code round trip; garbage is refused', () => {
  // Bytes 0..31 — a fixture, built here so it does not read as a secret.
  const key = Buffer.from(Array.from({ length: 32 }, (_, i) => i)).toString('base64url');
  const code = formatPairingCode('mach.with.dots', key);
  assert.deepEqual(parsePairingCode(`  ${code} \n`), { machineId: 'mach.with.dots', key });
  assert.equal(parsePairingCode('hcp1.x.short'), undefined);
  assert.equal(parsePairingCode('nope'), undefined);
});

test('run_status: the error text (the CLI\'s own words) is sealed, state and code stay', () => {
  const f = { type: 'run_status', sessionId: 's', runId: 'r', state: 'error', code: 'turn_failed', error: `fatal: ${MARK}` };
  const s = sealed(f);
  assert.equal(s['error'], undefined);
  assert.equal(s['state'], 'error');
  assert.equal(s['code'], 'turn_failed');
  assert.ok(!JSON.stringify({ ...s, e2e: undefined }).includes(MARK));
  assert.deepEqual(opened(s), f);
  // No error, nothing to seal.
  assert.equal(collectSeal({ type: 'run_status', sessionId: 's', runId: 'r', state: 'idle' }, { dir: 'a2c' }).jobs.length, 0);
});

test('turn secrets say what they are for, and checkOpened holds the frame to it', () => {
  const sealTurn = (f: Record<string, unknown>) => collectSeal(f, { dir: 'c2a', epoch: 'E' }).jobs[0]!.secret as Record<string, unknown>;
  const open = sealTurn({ type: 'open', machineId: 'm', sessionId: 'S', message: MARK });
  assert.equal(open['_k'], 'open');
  assert.equal(open['_s'], 'S');
  // An open arrives at the agent as an input (the run exists), a resume or a takeover.
  assert.equal(checkOpened({ type: 'input', runId: 'r' }, open, { sessionOfRun: () => 'S' }), undefined);
  assert.equal(checkOpened({ type: 'takeover', sessionId: 'S' }, open), undefined);
  // ...but not as a new_session, and not into a run of another session.
  assert.match(checkOpened({ type: 'new_session' }, open) ?? '', /another kind/);
  assert.match(checkOpened({ type: 'input', runId: 'r' }, open, { sessionOfRun: () => 'OTHER' }) ?? '', /another session/);
  assert.match(checkOpened({ type: 'takeover', sessionId: 'OTHER' }, open) ?? '', /another session/);
  // An input is for its run.
  const input = sealTurn({ type: 'input', runId: 'r1', text: MARK });
  assert.match(checkOpened({ type: 'input', runId: 'r2' }, input) ?? '', /another run/);
  assert.match(checkOpened({ type: 'resume', sessionId: 'S' }, input) ?? '', /another kind/);
  // The choices that must come from the person are inside the secret.
  const ns = sealTurn({ type: 'new_session', machineId: 'm', cwd: '/proj', model: 'x', message: MARK });
  assert.equal(ns['cwd'], '/proj');
  assert.equal(ns['model'], 'x');
  assert.equal(checkOpened({ type: 'new_session' }, ns), undefined);
  assert.match(checkOpened({ type: 'new_session' }, { _k: 'new_session' }) ?? '', /no sealed folder/);
  const td = sealTurn({ type: 'tool_decision', runId: 'r', requestId: 'q', allow: false, updatedInput: { a: 1 } });
  assert.equal(td['allow'], false);
  assert.match(checkOpened({ type: 'tool_decision' }, { _k: 'tool_decision' }) ?? '', /no sealed answer/);
  const pm = sealTurn({ type: 'set_permission_mode', runId: 'r', mode: 'plan' });
  assert.equal(pm['mode'], 'plan');
  assert.match(checkOpened({ type: 'set_permission_mode' }, { _k: 'set_permission_mode' }) ?? '', /no sealed mode/);
});

test('routing hints stay clear next to the envelope, but the sealed copy wins on opening', () => {
  const f = { type: 'new_session', machineId: 'm', cwd: '/proj', model: 'sonnet', message: MARK };
  const s = collectSeal(f, { dir: 'c2a', epoch: 'E' });
  for (const j of s.jobs) j.put(fake(j.secret));
  assert.equal(s.frame['cwd'], '/proj', 'the hub still sees the folder it routes by');
  assert.equal(s.frame['message'], undefined);
  const forged = { ...s.frame, cwd: '/etc', model: 'evil' };
  const o = collectOpen(forged, { dir: 'c2a', epoch: 'E' });
  for (const j of o.jobs) j.put(unfake(j.env));
  assert.equal(o.frame['cwd'], '/proj');
  assert.equal(o.frame['model'], 'sonnet');
  const td = collectSeal({ type: 'tool_decision', runId: 'r', requestId: 'q', allow: true }, { dir: 'c2a', epoch: 'E' });
  assert.equal(td.frame['allow'], true);
  // Routing keys are not "content in the clear".
  assert.equal(clearContentIn({ type: 'new_session', cwd: '/x', model: 'm' }), undefined);
  assert.equal(clearContentIn({ type: 'tool_decision', allow: true }), undefined);
  assert.equal(clearContentIn({ type: 'tool_decision', allow: true, message: 'x' }), 'tool_decision');
});

test('runtime.login.input code is content', () => {
  assert.deepEqual(RPC_SEALED_PARAMS['runtime.login.input'], ['code']);
});

test('rpc requests are bound to their method and clear params', () => {
  const f = { type: 'rpc_request', requestId: 'q', machineId: 'm', method: 'fs.write', params: { cwd: '/c', path: 'p', content: MARK } };
  const s = collectSeal(f, { dir: 'c2a', epoch: 'E' });
  const secret = s.jobs[0]!.secret as Record<string, unknown>;
  assert.equal(secret['_m'], 'fs.write');
  assert.deepEqual(secret['_p'], { cwd: '/c', path: 'p' });
  const frame = s.frame as { method: string; params: Record<string, unknown> };
  assert.equal(checkRpcSecret(frame, secret), undefined);
  // The hub rewrites the path, the folder, or the method.
  assert.match(checkRpcSecret({ ...frame, params: { ...frame.params, path: '../../etc/passwd' } }, secret) ?? '', /another path/);
  assert.match(checkRpcSecret({ ...frame, params: { ...frame.params, cwd: '/' } }, secret) ?? '', /another cwd/);
  assert.match(checkRpcSecret({ ...frame, params: { ...frame.params, name: 'x' } }, secret) ?? '', /another name/);
  assert.match(checkRpcSecret({ ...frame, method: 'git.commit' }, secret) ?? '', /another method/);
  // And the open job carries the check.
  const o = collectOpen({ ...frame, method: 'git.commit' } as never, { dir: 'c2a', epoch: 'E' });
  assert.equal(o.jobs.length, 0, 'git.commit has a sealed field of its own; fs.write params are not opened under it');
});

test('clearRpcContent: what a keyed agent would have sealed, arriving clear, is forged', () => {
  const ok = (method: string, result: unknown) => ({ type: 'rpc_response', requestId: 'q', ok: true, result });
  // Exactly what the agent sends is never flagged.
  for (const [method, result] of [
    ['fs.read', { content: MARK }],
    ['git.status', { files: [MARK] }],
    ['models.list', { models: [] }],
    ['session.delete', { ok: true }],
    ['session.messages', { messages: [{ uuid: 'u', type: 'user', blocks: [{ text: MARK }], ts: 1 }, { uuid: 'v' }] }],
  ] as const) {
    assert.equal(clearRpcContent(method, sealed(ok(method, result), { method })), false, method);
  }
  // The same results in the clear are the hub's.
  assert.equal(clearRpcContent('fs.read', ok('fs.read', { content: MARK })), true);
  assert.equal(clearRpcContent('', ok('', { x: MARK })), true);
  assert.equal(clearRpcContent('session.delete', ok('session.delete', { ok: true, path: MARK })), true);
  assert.equal(clearRpcContent('session.messages', ok('session.messages', { messages: [{ uuid: 'u', blocks: [{ text: MARK }] }] })), true);
  // A message envelope with clear content beside it: the hub's.
  assert.equal(
    clearRpcContent('session.messages', ok('session.messages', { messages: [{ uuid: 'u', e2e: fake({}), blocks: [{ text: MARK }] }] })),
    true,
  );
  assert.equal(clearRpcContent('session.messages', ok('session.messages', { messages: [{ uuid: 'u', e2e: fake({}), model: MARK }] })), true);
  // An envelope plus clear extras is not what the agent sends.
  assert.equal(clearRpcContent('fs.read', ok('fs.read', { e2e: fake({}), content: MARK })), true);
  // Errors are not judged here (the hub answers some itself).
  assert.equal(clearRpcContent('fs.read', { type: 'rpc_response', requestId: 'q', ok: false, error: MARK }), false);
});
