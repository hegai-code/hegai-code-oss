import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { bindTag, collectSeal, parsePairingCode, TURN_ECHO_BIND, withMachine } from '@cc-remote/shared';
import {
  b64urlToBytes,
  importKey,
  isContentFrame,
  hasRealContent,
  needsSeal,
  keyIdOf,
  openFrame,
  openJson,
  sealFrame,
  sealJson,
  type KeySource,
} from '../src/e2ee/crypto.js';

// The SAME vectors the agent's Node crypto is held to (agent/test/e2ee.test.ts).
const vec = JSON.parse(readFileSync(new URL('../../shared/test/e2e-vectors.json', import.meta.url), 'utf8')) as {
  keyHex: string;
  nonceHex: string;
  kid: string;
  value: unknown;
  envelope: { e2e: 1; kid: string; n: string; c: string };
  pairingCode: string;
  bind: string;
};
const hex = (h: string) => Uint8Array.from(h.match(/../g)!.map((b) => parseInt(b, 16)));
const MARK = 'SYNTHETIC-MARKER-7f3a';
const EPOCH = 'epoch-1';
const M = () => 'm-1';
const mb = (bind: string) => withMachine('m-1', bind);

async function ring(): Promise<KeySource & { kid: string }> {
  const key = await importKey(hex(vec.keyHex));
  return {
    kid: vec.kid,
    forKid: (kid) => (kid === vec.kid ? { key } : undefined),
    latestFor: () => ({ key, kid: vec.kid }),
  };
}

test('shared test vector: WebCrypto produces and opens exactly the pinned envelope', async () => {
  const raw = hex(vec.keyHex);
  assert.equal(await keyIdOf(raw), vec.kid);
  const key = await importKey(raw);
  assert.deepEqual(await sealJson(key, vec.kid, vec.value, vec.bind, hex(vec.nonceHex)), vec.envelope);
  assert.deepEqual(await openJson(key, vec.envelope, vec.bind), vec.value);
});

test('the pairing code of the vectors parses to the vector key', async () => {
  const p = parsePairingCode(vec.pairingCode)!;
  assert.equal(p.machineId, 'm-1');
  assert.equal(await keyIdOf(b64urlToBytes(p.key)), vec.kid);
});

test('a wrong key and a tampered kid are refused', async () => {
  const key = await importKey(hex(vec.keyHex));
  const other = await importKey(new Uint8Array(32).fill(9));
  await assert.rejects(openJson(other, vec.envelope, vec.bind));
  await assert.rejects(openJson(key, { ...vec.envelope, kid: 'ffffffffffffffff' }, vec.bind));
  // Right key, wrong frame or wrong direction.
  await assert.rejects(openJson(key, vec.envelope, 'm-1|a2c|stream|run-2'));
  await assert.rejects(openJson(key, vec.envelope, 'm-1|c2a|stream|run-1'));
});

test('a sealed stream frame opens to the plain frame the transcript folds', async () => {
  const keys = await ring();
  const key = keys.forKid(vec.kid)!.key;
  const plain = { type: 'stream', runId: 'r', sessionId: 's', event: { kind: 'assistant', text: MARK, data: { a: 1 } } };
  // What the agent sends (agent to client).
  const { frame: wire, jobs } = collectSeal({ ...plain, event: { ...plain.event } }, { dir: 'a2c' });
  for (const j of jobs) j.put(await sealJson(key, vec.kid, j.secret, mb(j.bind)));
  assert.ok(!JSON.stringify(wire).includes(MARK));
  assert.deepEqual(await openFrame(wire, keys, M), plain);
  // Lifted onto another run, or sent by the client side, it stays sealed.
  const lifted = { ...wire, runId: 'other' };
  assert.deepEqual(await openFrame(lifted, keys, M), lifted);
});

test('what a device seals is a client-to-agent envelope: it does not open as agent output', async () => {
  const keys = await ring();
  const sealedByDevice = await sealFrame({ type: 'term_input', termId: 't', data: MARK }, 'm-1', keys, EPOCH);
  assert.ok(!JSON.stringify(sealedByDevice).includes(MARK));
  const asAgentOutput = { type: 'term_data', termId: 't', data: '', e2e: (sealedByDevice as { e2e: never }).e2e };
  assert.deepEqual(await openFrame(asAgentOutput, keys, M), asAgentOutput);
});

test('history messages in an rpc_response open message by message', async () => {
  const keys = await ring();
  const key = keys.forKid(vec.kid)!.key;
  const msg = { type: 'user', uuid: 'u', blocks: [{ kind: 'text', text: MARK }], ts: 7 };
  const env = await sealJson(key, vec.kid, { blocks: msg.blocks, ts: msg.ts }, mb(bindTag('a2c', 'msg', 'u')));
  const wire = { type: 'rpc_response', requestId: 'q', ok: true, result: { messages: [{ type: 'user', uuid: 'u', blocks: [], e2e: env }] } };
  assert.deepEqual(await openFrame(wire, keys, M), { ...wire, result: { messages: [msg] } });
});

test('an rpc result that is one envelope opens to the typed result', async () => {
  const keys = await ring();
  const key = keys.forKid(vec.kid)!.key;
  const result = { path: 'a.txt', content: MARK, truncated: false };
  const wire = { type: 'rpc_response', requestId: 'q', ok: true, result: { e2e: await sealJson(key, vec.kid, result, mb(bindTag('a2c', 'rpc', 'q'))) } };
  assert.deepEqual((await openFrame(wire, keys, M)).result, result);
  // The same bytes on another request's response stay sealed.
  const lifted = { ...wire, requestId: 'other' };
  assert.deepEqual(await openFrame(lifted, keys, M), lifted);
});

test('an envelope this device cannot open stays put (the UI shows the placeholder)', async () => {
  const keys = await ring();
  const stranger: KeySource = { forKid: () => undefined, latestFor: () => undefined };
  const wire = { type: 'stream', runId: 'r', sessionId: 's', event: { kind: 'assistant', e2e: vec.envelope } };
  assert.deepEqual(await openFrame(wire, stranger, M), wire);
  void keys;
});

test('outgoing input is sealed with a turn envelope for the other screens; no key means no send', async () => {
  const keys = await ring();
  const out = (await sealFrame({ type: 'input', runId: 'r', text: MARK, images: [{ media_type: 'image/png', data: 'AAAA' }], files: [{ name: 'a.txt', data: 'AA' }] }, 'm-1', keys, EPOCH)) as Record<string, unknown>;
  assert.equal(out['text'], '');
  assert.equal(out['images'], undefined);
  assert.ok(!JSON.stringify(out).includes(MARK));
  const turn = (await openJson(keys.forKid(vec.kid)!.key, out['turnE2e'] as never, mb(TURN_ECHO_BIND))) as Record<string, unknown>;
  assert.deepEqual(turn, { text: MARK, images: 1, files: ['a.txt'] });
  await assert.rejects(sealFrame({ type: 'input', runId: 'r', text: 'x' }, 'm-1', { forKid: () => undefined, latestFor: () => undefined }, EPOCH));
});

test('terminal input, fs.write and tool answers are sealed; plain rpc params are not touched', async () => {
  const keys = await ring();
  const term = (await sealFrame({ type: 'term_input', termId: 't', data: MARK }, 'm-1', keys, EPOCH)) as Record<string, unknown>;
  assert.equal(term['data'], '');
  const write = (await sealFrame({ type: 'rpc_request', requestId: 'q', machineId: 'm-1', method: 'fs.write', params: { cwd: '/c', path: 'p', content: MARK } }, 'm-1', keys, EPOCH)) as { params: Record<string, unknown> };
  assert.deepEqual(Object.keys(write.params).sort(), ['cwd', 'e2e', 'path']);
  const decision = (await sealFrame({ type: 'tool_decision', runId: 'r', requestId: 'q', allow: true, updatedInput: { a: MARK } }, 'm-1', keys, EPOCH)) as Record<string, unknown>;
  assert.equal(decision['updatedInput'], undefined);
  assert.equal(decision['allow'], true);
  const list = (await sealFrame({ type: 'rpc_request', requestId: 'q', machineId: 'm-1', method: 'models.list', params: {} }, 'm-1', keys, EPOCH)) as { params: object };
  assert.deepEqual(list.params, {});
});

test('session summaries in a snapshot get their title and place back', async () => {
  const keys = await ring();
  const key = keys.forKid(vec.kid)!.key;
  const wire = {
    type: 'snapshot',
    machines: [
      {
        machine: { machineId: 'm-1', private: true },
        sessions: [
          {
            sessionId: 's',
            title: 'Зашифровано',
            lastModified: 1,
            titleE2e: await sealJson(key, vec.kid, MARK, mb(bindTag('a2c', 'title', 's'))),
            cwdE2e: await sealJson(key, vec.kid, { cwd: '/w/p', project: 'p' }, mb(bindTag('a2c', 'cwd', 's'))),
          },
          { sessionId: 'plain', title: 'T', lastModified: 2 },
        ],
      },
    ],
  };
  const opened = (await openFrame(wire, keys, M)) as typeof wire;
  assert.deepEqual(opened.machines[0]!.sessions[0], { sessionId: 's', title: MARK, lastModified: 1, cwd: '/w/p', project: 'p' });
  assert.deepEqual(opened.machines[0]!.sessions[1], { sessionId: 'plain', title: 'T', lastModified: 2 });
});

test('which outgoing frames carry content', () => {
  for (const t of ['input', 'open', 'new_session', 'takeover', 'tool_decision', 'term_input', 'rpc_request']) {
    assert.equal(isContentFrame(t), true, t);
  }
  for (const t of ['interrupt', 'subscribe', 'ping', 'close']) assert.equal(isContentFrame(t), false, t);
});

test('an rpc error and a git.pr.create body round trip through the same bindings', async () => {
  const keys = await ring();
  const key = keys.forKid(vec.kid)!.key;
  const wire = { type: 'rpc_response', requestId: 'q', ok: false, error: 'Зашифровано', e2e: await sealJson(key, vec.kid, { error: `ENOENT ${MARK}` }, mb(bindTag('a2c', 'rpc', 'q'))) };
  const opened = await openFrame(wire, keys, M);
  assert.equal(opened.error, `ENOENT ${MARK}`);
  assert.equal('e2e' in opened, false);
  const pr = (await sealFrame({ type: 'rpc_request', requestId: 'q', machineId: 'm-1', method: 'git.pr.create', params: { cwd: '/c', title: MARK, body: MARK } }, 'm-1', keys, EPOCH)) as { params: Record<string, unknown> };
  assert.deepEqual(Object.keys(pr.params).sort(), ['cwd', 'e2e']);
  assert.ok(!JSON.stringify(pr).includes(MARK));
});

test('a user_turn the hub forged next to a real envelope shows only what the envelope holds', async () => {
  const keys = await ring();
  const key = keys.forKid(vec.kid)!.key;
  const wire = {
    type: 'user_turn', runId: 'r', sessionId: 's', turnId: 't', text: 'FORGED', ts: 1,
    e2e: await sealJson(key, vec.kid, { text: MARK }, mb(TURN_ECHO_BIND)),
  };
  const opened = await openFrame(wire, keys, M);
  assert.equal(opened.text, MARK);
});

test('needsSeal: content frames; a bare open or a no-content rpc goes as is', () => {
  assert.equal(needsSeal({ type: 'term_input', termId: 't', data: 'x' }), true);
  assert.equal(needsSeal({ type: 'input', runId: 'r', text: 'x' }), true);
  assert.equal(needsSeal({ type: 'open', machineId: 'm', sessionId: 's' }), false);
  assert.equal(needsSeal({ type: 'rpc_request', requestId: 'q', method: 'models.list', params: {} }), false);
  assert.equal(needsSeal({ type: 'rpc_request', requestId: 'q', method: 'git.pr.create', params: { title: 't' } }), true);
});

test('sealing needs the agent epoch, and what is sealed is good for that epoch only', async () => {
  const keys = await ring();
  await assert.rejects(sealFrame({ type: 'term_input', termId: 't', data: MARK }, 'm-1', keys, undefined), /epoch/);
  const a = (await sealFrame({ type: 'term_input', termId: 't', data: 'ls' }, 'm-1', keys, 'E1')) as { e2e: never };
  const key = keys.forKid(vec.kid)!.key;
  assert.deepEqual(await openJson(key, a.e2e, 'm-1|c2a:E1|term_input|t'), { data: 'ls' });
  await assert.rejects(openJson(key, a.e2e, 'm-1|c2a:E2|term_input|t'));
});

test('the person\'s own choices are sealed: new_session folder and options, tool answer, mode', async () => {
  const keys = await ring();
  const key = keys.forKid(vec.kid)!.key;
  assert.equal(needsSeal({ type: 'new_session', machineId: 'm-1', cwd: '/p' }), true);
  assert.equal(needsSeal({ type: 'tool_decision', runId: 'r', requestId: 'q', allow: true }), true);
  assert.equal(needsSeal({ type: 'set_permission_mode', runId: 'r', mode: 'plan' }), true);
  const ns = (await sealFrame({ type: 'new_session', machineId: 'm-1', cwd: '/proj', model: 'x', message: MARK }, 'm-1', keys, 'E1')) as Record<string, unknown>;
  assert.equal(ns['cwd'], '/proj', 'the hub still routes by the clear folder');
  assert.ok(!JSON.stringify(ns).includes(MARK));
  const secret = (await openJson(key, ns['e2e'] as never, 'm-1|c2a:E1|turn|')) as Record<string, unknown>;
  assert.equal(secret['cwd'], '/proj');
  assert.equal(secret['_k'], 'new_session');
  const pm = (await sealFrame({ type: 'set_permission_mode', runId: 'r', mode: 'plan' }, 'm-1', keys, 'E1')) as Record<string, unknown>;
  assert.equal(((await openJson(key, pm['e2e'] as never, 'm-1|c2a:E1|set_permission_mode|r')) as { mode: string }).mode, 'plan');
});

test('an envelope is bound to its machine: attributed to another machine it stays shut', async () => {
  const keys = await ring();
  const key = keys.forKid(vec.kid)!.key;
  const wire = { type: 'rpc_response', requestId: 'q', ok: true, result: { e2e: await sealJson(key, vec.kid, { a: 1 }, mb(bindTag('a2c', 'rpc', 'q'))) } };
  assert.deepEqual((await openFrame(wire, keys, M)).result, { a: 1 });
  assert.deepEqual(await openFrame(wire, keys, () => 'm-2'), wire);
  assert.deepEqual(await openFrame(wire, keys, () => undefined), wire);
  // Sealing for machine A does not open as B's.
  const sealed = (await sealFrame({ type: 'term_input', termId: 't', data: 'ls' }, 'm-1', keys, 'E1')) as { e2e: never };
  await assert.rejects(openJson(key, sealed.e2e, 'm-2|c2a:E1|term_input|t'));
});

test('summaries open only under the machine of the list they came in', async () => {
  const keys = await ring();
  const key = keys.forKid(vec.kid)!.key;
  const entry = (id: string) => ({
    machine: { machineId: id },
    sessions: [{ sessionId: 's', title: 'Зашифровано', lastModified: 1, titleE2e: null as unknown }],
  });
  const env = await sealJson(key, vec.kid, MARK, mb(bindTag('a2c', 'title', 's')));
  const a = entry('m-1');
  const b = entry('m-2');
  a.sessions[0]!.titleE2e = env;
  b.sessions[0]!.titleE2e = env; // the hub moved m-1's title into m-2's list
  const out = (await openFrame({ type: 'snapshot', machines: [a, b] }, keys, M)) as { machines: { sessions: { title: string }[] }[] };
  assert.equal(out.machines[0]!.sessions[0]!.title, MARK);
  assert.equal(out.machines[1]!.sessions[0]!.title, 'Зашифровано');
});

test('hasRealContent: words and files count, a mode switch or bare approval does not', () => {
  assert.equal(hasRealContent({ type: 'input', runId: 'r', text: 'hi' }), true);
  assert.equal(hasRealContent({ type: 'term_input', termId: 't', data: 'ls' }), true);
  assert.equal(hasRealContent({ type: 'set_permission_mode', runId: 'r', mode: 'plan' }), false);
  assert.equal(hasRealContent({ type: 'tool_decision', runId: 'r', requestId: 'q', allow: true }), false);
  assert.equal(hasRealContent({ type: 'tool_decision', runId: 'r', requestId: 'q', allow: true, message: 'why' }), true);
  assert.equal(hasRealContent({ type: 'new_session', machineId: 'm', cwd: '/p' }), false);
  assert.equal(hasRealContent({ type: 'new_session', machineId: 'm', cwd: '/p', message: 'go' }), true);
});
