import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { base32Decode, base32Encode, codeAt, hotp, newSecret, verifyCode } from '../totp.mjs';
import { bundleEdition, manifestText, parseManifest, sha256Hex, verifySignature } from '../release-format.mjs';
import { createSigner, LOCKOUT_BASE_MS, LOCKOUT_MAX_MS, MAX_FAILURES, MAX_PENDING, REQUEST_TTL_MS, lockoutMs } from '../signer.mjs';

// RFC 6238 appendix B, SHA-1, secret "12345678901234567890", 8 digits.
test('TOTP matches the RFC 6238 SHA-1 vectors', () => {
  const secret = Buffer.from('12345678901234567890');
  const vectors = [
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ];
  for (const [t, want] of vectors) assert.equal(hotp(secret, Math.floor(t / 30), 8), want, `t=${t}`);
});

test('base32 round-trips and the replay guard and skew behave', () => {
  const raw = Buffer.from('12345678901234567890');
  assert.equal(base32Encode(raw), 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  assert.deepEqual(base32Decode('gezd gnbv-GY3TQOJQGEZDGNBVGY3TQOJQ'), raw);
  const secret = raw;
  const t = 1_800_000_000;
  const code = codeAt(secret, t);
  assert.equal(verifyCode(secret, code, t), Math.floor(t / 30));
  assert.equal(verifyCode(secret, code, t + 30), Math.floor(t / 30), '+-1 step');
  assert.equal(verifyCode(secret, code, t + 90), undefined, 'two steps late');
  assert.equal(verifyCode(secret, code, t, { afterStep: Math.floor(t / 30) }), undefined, 'replay');
  assert.equal(verifyCode(secret, '12345', t), undefined);
  assert.equal(verifyCode(secret, 'abcdef', t), undefined);
  assert.equal(newSecret().length, 32);
});

const TOKEN = 'a'.repeat(48);
const here = path.dirname(fileURLToPath(import.meta.url));

function rig(extra = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'signer-'));
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const secretB32 = newSecret();
  const cfg = {
    keyPath: path.join(dir, 'key.pem'),
    totpSecretPath: path.join(dir, 'totp'),
    requestTokenPath: path.join(dir, 'request-token'),
    stateDir: path.join(dir, 'state'),
    logPath: path.join(dir, 'log'),
    ...extra,
  };
  writeFileSync(cfg.keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }));
  writeFileSync(cfg.totpSecretPath, `${secretB32}\n`);
  writeFileSync(cfg.requestTokenPath, `${TOKEN}\n`);
  const clock = { t: 1_800_000_000_000 };
  const server = createServer(createSigner({ ...cfg, now: () => clock.t }));
  const secret = base32Decode(secretB32);
  const keys = [publicKey.export({ type: 'spki', format: 'der' }).toString('base64')];
  return { dir, cfg, server, clock, secret, keys, code: () => codeAt(secret, clock.t / 1000) };
}

async function call(server, method, url, body, { token = TOKEN, headers = {} } = {}) {
  if (!server.listening) await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const h = { ...headers };
  if (body !== undefined) h['content-type'] = 'application/json';
  if (token) h.authorization = `Bearer ${token}`;
  const res = await fetch(`http://127.0.0.1:${server.address().port}${url}`, {
    method,
    headers: h,
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return [res.status, json, res];
}

const SHA = sha256Hex('bundle');
const ask = (r, extra = {}) => call(r.server, 'POST', '/requests', { version: '0.3.4', sha256: SHA, commit: 'abc1234', note: 'release 0.3.4', ...extra });
const approve = (r, id, code = r.code()) => call(r.server, 'POST', `/requests/${id}/approve`, { code }, { token: null });

test('request, approve on the page, fetch: the exact manifest is signed once', async () => {
  const r = rig();
  try {
    const [status, created] = await ask(r);
    assert.equal(status, 201);
    assert.match(created.id, /^[0-9a-f]{32}$/);
    // pending: no signature yet
    const [, pending] = await call(r.server, 'GET', `/requests/${created.id}`);
    assert.equal(pending.status, 'pending');
    assert.equal(pending.signature, undefined);
    // the page lists it with everything the operator compares
    const [, list] = await call(r.server, 'GET', '/pending', undefined, { token: null });
    assert.equal(list.requests.length, 1);
    assert.deepEqual(
      { v: list.requests[0].version, s: list.requests[0].sha256, c: list.requests[0].commit, n: list.requests[0].note },
      { v: '0.3.4', s: SHA, c: 'abc1234', n: 'release 0.3.4' },
    );
    const [ok, signed] = await approve(r, created.id);
    assert.equal(ok, 200);
    assert.equal(signed.status, 'signed');
    const [, got] = await call(r.server, 'GET', `/requests/${created.id}`);
    assert.equal(got.status, 'signed');
    assert.equal(got.manifest, manifestText('0.3.4', SHA));
    assert.equal(got.manifest, `hegai-code-agent-release/1\nedition=external\nversion=0.3.4\nsha256=${SHA}\n`);
    assert.deepEqual(parseManifest(got.manifest), { edition: 'external', version: '0.3.4', sha256: SHA });
    assert.ok(verifySignature(Buffer.from(got.manifest), got.signature, r.keys));
    assert.equal(verifySignature(Buffer.from(`${got.manifest}x`), got.signature, r.keys), false);
    // no longer pending, and approving again is refused
    assert.equal((await call(r.server, 'GET', '/pending', undefined, { token: null }))[1].requests.length, 0);
    r.clock.t += 30_000;
    assert.equal((await approve(r, created.id))[0], 409);
    const log = readFileSync(r.cfg.logPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(log.map((l) => l.event), ['requested', 'signed']);
    assert.ok(!JSON.stringify(log).includes(r.code()), 'codes are never logged');
  } finally {
    r.server.close();
  }
});

test('the audit log is fail-closed for signatures: no `signed` line, no signature', async () => {
  const r = rig();
  try {
    const [, created] = await ask(r);
    // The log becomes unwritable (a directory where the file was).
    rmSync(r.cfg.logPath);
    mkdirSync(r.cfg.logPath);
    const [status, body] = await approve(r, created.id);
    assert.equal(status, 500);
    assert.equal(JSON.stringify(body).includes('signature'), false, 'no signature in the answer');
    const [, got] = await call(r.server, 'GET', `/requests/${created.id}`);
    assert.equal(got.status, 'pending');
    assert.equal(got.signature, undefined);
    assert.equal(got.manifest, undefined);
    // The log works again; the burned step needs the next code.
    rmSync(r.cfg.logPath, { recursive: true });
    r.clock.t += 30_000;
    const [ok] = await approve(r, created.id);
    assert.equal(ok, 200);
    const [, signed] = await call(r.server, 'GET', `/requests/${created.id}`);
    assert.equal(signed.status, 'signed');
    assert.match(readFileSync(r.cfg.logPath, 'utf8'), /"event":"signed"/);
  } finally {
    r.server.close();
  }
});

test('other events are best effort: an unwritable log does not stop requests or crash the server', async () => {
  const r = rig();
  try {
    mkdirSync(r.cfg.logPath); // every append fails
    const [status, created] = await ask(r);
    assert.equal(status, 201);
    const [bad] = await approve(r, created.id, '000000');
    assert.equal(bad, 403);
    const [health] = await call(r.server, 'GET', '/health', undefined, { token: null });
    assert.equal(health, 200);
  } finally {
    r.server.close();
  }
});

test('the request token holder can only ask: no signature without the code', async () => {
  const r = rig();
  try {
    const [, created] = await ask(r);
    assert.equal((await approve(r, created.id, '000000'))[0], 403);
    assert.equal((await approve(r, created.id, ''))[0], 403);
    assert.equal((await call(r.server, 'POST', `/requests/${created.id}/approve`, {}, { token: TOKEN }))[0], 400, 'the bearer token is no substitute for a code');
    assert.equal((await call(r.server, 'GET', `/requests/${created.id}`))[1].signature, undefined);
  } finally {
    r.server.close();
  }
});

test('create and fetch need the bearer token; approval and the page do not', async () => {
  const r = rig();
  try {
    assert.equal((await call(r.server, 'POST', '/requests', { version: '1', sha256: SHA }, { token: null }))[0], 401);
    assert.equal((await call(r.server, 'POST', '/requests', { version: '1', sha256: SHA }, { token: 'b'.repeat(48) }))[0], 401);
    assert.equal((await call(r.server, 'POST', '/requests', { version: '1', sha256: SHA }, { token: TOKEN.slice(1) }))[0], 401);
    const [, created] = await call(r.server, 'POST', '/requests', { version: '1', sha256: SHA });
    assert.equal((await call(r.server, 'GET', `/requests/${created.id}`, undefined, { token: null }))[0], 401);
    const [status, html, res] = await call(r.server, 'GET', '/', undefined, { token: null });
    assert.equal(status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    assert.match(html, /Release signer/);
    assert.doesNotMatch(html, /src=|href=|https?:\/\//, 'no external assets');
    assert.match(res.headers.get('content-security-policy'), /default-src 'none'/);
    assert.match(res.headers.get('content-security-policy'), /script-src 'sha256-/);
  } finally {
    r.server.close();
  }
});

test('a token shorter than 32 bytes is refused at start-up', () => {
  const r = rig();
  writeFileSync(r.cfg.requestTokenPath, 'short\n');
  assert.throws(() => createSigner({ ...r.cfg }), /at least 32 bytes/);
});

test('a used code cannot be replayed, also across a restart; the next step works', async () => {
  const r = rig();
  try {
    const [, one] = await ask(r);
    const [, two] = await ask(r, { version: '0.3.5', sha256: sha256Hex('other') });
    const code = r.code();
    assert.equal((await approve(r, one.id, code))[0], 200);
    assert.equal((await approve(r, two.id, code))[0], 403, 'replay in the same step');
    const second = createServer(createSigner({ ...r.cfg, now: () => r.clock.t }));
    try {
      assert.equal((await call(second, 'POST', `/requests/${two.id}/approve`, { code }, { token: null }))[0], 403, 'replay after a restart');
    } finally {
      second.close();
    }
    r.clock.t += 30_000;
    assert.equal((await approve(r, two.id))[0], 200);
  } finally {
    r.server.close();
  }
});

test('lockout: 5 failures lock for 15 minutes, then 30, 60, ... capped at 24 h, persisted', async () => {
  const r = rig();
  try {
    const [, created] = await ask(r);
    assert.equal(lockoutMs(0), LOCKOUT_BASE_MS);
    assert.equal(lockoutMs(1), 2 * LOCKOUT_BASE_MS);
    assert.equal(lockoutMs(30), LOCKOUT_MAX_MS);
    let expected = LOCKOUT_BASE_MS;
    for (let round = 0; round < 9; round++) {
      for (let i = 0; i < MAX_FAILURES; i++) assert.equal((await approve(r, created.id, '000000'))[0], 403, `round ${round} try ${i}`);
      const [status, out] = await approve(r, created.id);
      assert.equal(status, 429, 'locked even for the right code');
      const want = Math.min(expected, LOCKOUT_MAX_MS) / 1000;
      assert.ok(out.retryAfter > want - 5 && out.retryAfter <= want, `round ${round}: ${out.retryAfter}s vs ${want}s`);
      if (round === 1) {
        // the lock survives a restart
        const again = createServer(createSigner({ ...r.cfg, now: () => r.clock.t }));
        try {
          assert.equal((await call(again, 'POST', `/requests/${created.id}/approve`, { code: r.code() }, { token: null }))[0], 429);
        } finally {
          again.close();
        }
      }
      r.clock.t += Math.min(expected, LOCKOUT_MAX_MS) * 1000 + 1000;
      // keep the request alive across long locks
      const file = path.join(r.cfg.stateDir, 'requests.json');
      const reqs = JSON.parse(readFileSync(file, 'utf8'));
      for (const q of reqs) q.expiresAt = r.clock.t + REQUEST_TTL_MS;
      writeFileSync(file, JSON.stringify(reqs));
      expected *= 2;
    }
    assert.equal(Math.min(expected / 2, LOCKOUT_MAX_MS), LOCKOUT_MAX_MS, 'reached the 24 h cap');
    // a success resets the ladder
    assert.equal((await approve(r, created.id))[0], 200);
    const [, second] = await ask(r, { version: '9', sha256: sha256Hex('z') });
    r.clock.t += 30_000;
    for (let i = 0; i < MAX_FAILURES; i++) await approve(r, second.id, '000000');
    const [, out] = await approve(r, second.id);
    assert.ok(out.retryAfter <= LOCKOUT_BASE_MS / 1000, 'back to 15 minutes');
  } finally {
    r.server.close();
  }
});

test('requests expire after 2 hours and can no longer be approved', async () => {
  const r = rig();
  try {
    const [, created] = await ask(r);
    r.clock.t += REQUEST_TTL_MS - 1000;
    assert.equal((await call(r.server, 'GET', `/requests/${created.id}`))[1].status, 'pending');
    r.clock.t += 2000;
    assert.equal((await call(r.server, 'GET', `/requests/${created.id}`))[1].status, 'expired');
    assert.equal((await call(r.server, 'GET', '/pending', undefined, { token: null }))[1].requests.length, 0);
    assert.equal((await approve(r, created.id))[0], 410);
    // an expired request does not count as a failure
    assert.equal((await approve(r, 'f'.repeat(32)))[0], 404);
  } finally {
    r.server.close();
  }
});

test('at most 10 pending requests; the same build asked twice is one request', async () => {
  const r = rig();
  try {
    const [, first] = await ask(r);
    const [again, same] = await ask(r);
    assert.equal(again, 200);
    assert.equal(same.id, first.id);
    for (let i = 1; i < MAX_PENDING; i++) assert.equal((await ask(r, { version: `1.${i}`, sha256: sha256Hex(`b${i}`) }))[0], 201);
    assert.equal((await ask(r, { version: '2.0', sha256: sha256Hex('over') }))[0], 429);
    // expiry frees the slots
    r.clock.t += REQUEST_TTL_MS + 1000;
    assert.equal((await ask(r, { version: '2.0', sha256: sha256Hex('over') }))[0], 201);
  } finally {
    r.server.close();
  }
});

test('injection in version, sha, commit and note is refused; the page renders notes as text', async () => {
  const r = rig();
  try {
    const bad = [
      { version: '1\nedition=internal' },
      { version: '1\nsha256=' + 'e'.repeat(64) },
      { version: 'a b' },
      { version: '../etc' },
      { version: '' },
      { version: 'x'.repeat(65) },
      { sha256: SHA.toUpperCase() },
      { sha256: `${SHA}\n` },
      { sha256: SHA.slice(1) },
      { commit: 'not-a-hash' },
      { commit: 'abc1234\nx' },
      { note: 'line\nbreak' },
      { note: 'bell\u0007' },
      { note: 'x'.repeat(201) },
      { note: 42 },
    ];
    for (const extra of bad) assert.equal((await ask(r, extra))[0], 400, JSON.stringify(extra));
    assert.equal((await call(r.server, 'POST', '/requests', 'not json'))[0], 400);
    assert.equal((await call(r.server, 'POST', '/requests', '[1]'))[0], 400);
    assert.equal((await call(r.server, 'POST', '/requests', { version: '1' }))[0], 400);
    // a note with markup is allowed as text and handed back verbatim as JSON data
    const evil = '<img src=x onerror=alert(1)>';
    assert.equal((await ask(r, { note: evil }))[0], 201);
    const [, list] = await call(r.server, 'GET', '/pending', undefined, { token: null });
    assert.equal(list.requests[0].note, evil);
    // the page never interpolates request data into HTML
    const html = (await call(r.server, 'GET', '/', undefined, { token: null }))[1];
    assert.ok(!html.includes('innerHTML'));
    assert.ok(!html.includes(evil));
    // wrong content type and unknown routes
    const res = await fetch(`http://127.0.0.1:${r.server.address().port}/requests`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'text/plain' }, body: '{}' });
    assert.equal(res.status, 415);
    assert.equal((await call(r.server, 'POST', '/sign', {}))[0], 404, 'the old /sign endpoint is gone');
    assert.equal((await call(r.server, 'GET', '/nope', undefined, { token: null }))[0], 404);
  } finally {
    r.server.close();
  }
});

test('Telegram is told about every request and every signature, with version and sha', async () => {
  const sent = [];
  const dir = mkdtempSync(path.join(tmpdir(), 'signer-tg-'));
  writeFileSync(path.join(dir, 'bot'), '123:SECRET\n');
  const r = rig({ tg: { botTokenPath: path.join(dir, 'bot'), chatId: '42' } });
  r.server.close();
  const fetchImpl = async (url, init) => {
    sent.push({ url, body: JSON.parse(init.body) });
    return { ok: true };
  };
  const server = createServer(createSigner({ ...r.cfg, now: () => r.clock.t, fetchImpl }));
  try {
    const [, created] = await call(server, 'POST', '/requests', { version: '0.3.4', sha256: SHA });
    assert.equal((await call(server, 'POST', `/requests/${created.id}/approve`, { code: r.code() }, { token: null }))[0], 200);
    await new Promise((x) => setTimeout(x, 50));
    assert.equal(sent.length, 2);
    assert.match(sent[0].url, /bot123:SECRET\/sendMessage$/);
    assert.equal(sent[0].body.chat_id, '42');
    assert.match(sent[0].body.text, /requested/i);
    assert.match(sent[1].body.text, /SIGNED/);
    for (const m of sent) {
      assert.ok(m.body.text.includes('0.3.4') && m.body.text.includes(SHA));
    }
  } finally {
    server.close();
  }
});

test('a failing Telegram never blocks a signature', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'signer-tg-'));
  writeFileSync(path.join(dir, 'bot'), '123:SECRET\n');
  const r = rig({ tg: { botTokenPath: path.join(dir, 'bot'), chatId: '42' } });
  r.server.close();
  const server = createServer(createSigner({ ...r.cfg, now: () => r.clock.t, fetchImpl: async () => { throw new Error('down 123:SECRET'); } }));
  try {
    const [, created] = await call(server, 'POST', '/requests', { version: '1', sha256: SHA });
    assert.equal((await call(server, 'POST', `/requests/${created.id}/approve`, { code: r.code() }, { token: null }))[0], 200);
    await new Promise((x) => setTimeout(x, 50));
    assert.ok(!readFileSync(r.cfg.logPath, 'utf8').includes('123:SECRET'), 'the bot token is never logged');
  } finally {
    server.close();
  }
});

test('health answers without a token', async () => {
  const r = rig();
  try {
    const [status, body] = await call(r.server, 'GET', '/health', undefined, { token: null });
    assert.equal(status, 200);
    assert.deepEqual(body, { ok: true });
  } finally {
    r.server.close();
  }
});

test('the edition marker decides what may be signed', () => {
  assert.equal(bundleEdition(Buffer.from('var a = "HEGAI_AGENT_EDITION=external";')), 'external');
  assert.equal(bundleEdition(Buffer.from('var a = "HEGAI_AGENT_EDITION=internal";')), 'internal');
  assert.equal(bundleEdition(Buffer.from('no marker')), undefined);
  assert.equal(bundleEdition(Buffer.from('"HEGAI_AGENT_EDITION=external" "HEGAI_AGENT_EDITION=internal"')), undefined, 'both: not signable');
  assert.equal(bundleEdition(Buffer.from('HEGAI_AGENT_EDITION=external')), undefined, 'must be a defined string literal');
  assert.equal(parseManifest(`hegai-code-agent-release/1\nversion=1\nsha256=${SHA}\n`), undefined, 'the edition line is part of the format');
});

// ---- the CLI, end to end ------------------------------------------------------

function runCli(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(here, '../sign-release.mjs'), ...args], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (out += c));
    child.on('close', (code) => resolve({ code, out }));
    runCli.last = child;
  });
}

test('sign-release.mjs: refuses a non-external bundle, asks, waits for the page, verifies, writes the files', async () => {
  const r = rig();
  const dir = mkdtempSync(path.join(tmpdir(), 'cli-'));
  const tokenFile = path.join(dir, 'token');
  writeFileSync(tokenFile, TOKEN);
  const keysFile = path.join(dir, 'keys.txt');
  writeFileSync(keysFile, `# test\n${r.keys[0]}\n`);
  try {
    await new Promise((x) => r.server.listen(0, '127.0.0.1', x));
    const url = `http://127.0.0.1:${r.server.address().port}`;
    // an internal (or unmarked) bundle never reaches the signer
    const internal = path.join(dir, 'agent-internal.mjs');
    writeFileSync(internal, 'console.log("HEGAI_AGENT_EDITION=internal")');
    const refused = await runCli(['--signer', url, '--bundle', internal, '--version', '1.0.0', '--token-file', tokenFile, '--keys', keysFile]);
    assert.equal(refused.code, 1);
    assert.match(refused.out, /not an external-edition build/);
    assert.equal((await call(r.server, 'GET', '/pending', undefined, { token: null }))[1].requests.length, 0, 'nothing was requested');
    // the external build: the CLI waits until somebody approves
    const bundle = path.join(dir, 'agent-external.mjs');
    writeFileSync(bundle, 'console.log("HEGAI_AGENT_EDITION=external")');
    const sha = sha256Hex(readFileSync(bundle));
    const cli = runCli(['--signer', url, '--bundle', bundle, '--version', '1.0.0', '--commit', 'deadbeef', '--note', 'rc', '--token-file', tokenFile, '--keys', keysFile, '--poll-ms', '50', '--timeout-s', '20']);
    let pending;
    for (let i = 0; i < 100 && !pending; i++) {
      await new Promise((x) => setTimeout(x, 50));
      pending = (await call(r.server, 'GET', '/pending', undefined, { token: null }))[1].requests[0];
    }
    assert.ok(pending, 'the CLI created a request');
    assert.equal(pending.sha256, sha);
    assert.equal(pending.commit, 'deadbeef');
    assert.equal(existsSync(`${bundle}.sig`), false, 'not signed before the operator approves');
    assert.equal((await approve(r, pending.id))[0], 200);
    const done = await cli;
    assert.equal(done.code, 0, done.out);
    assert.match(done.out, new RegExp(sha));
    assert.match(done.out, /on your phone/);
    assert.equal(readFileSync(`${bundle}.release`, 'utf8'), manifestText('1.0.0', sha));
    assert.ok(verifySignature(readFileSync(`${bundle}.release`), readFileSync(`${bundle}.sig`, 'utf8'), r.keys));
    // SIGN_RELEASE_CODE no longer exists anywhere in the CLI
    assert.ok(!readFileSync(path.join(here, '../sign-release.mjs'), 'utf8').includes('SIGN_RELEASE_CODE'));
  } finally {
    r.server.close();
  }
});

test('sign-release.mjs: times out when nobody approves, and needs a token file', async () => {
  const r = rig();
  const dir = mkdtempSync(path.join(tmpdir(), 'cli-'));
  const tokenFile = path.join(dir, 'token');
  writeFileSync(tokenFile, TOKEN);
  const bundle = path.join(dir, 'agent-external.mjs');
  writeFileSync(bundle, 'console.log("HEGAI_AGENT_EDITION=external")');
  try {
    await new Promise((x) => r.server.listen(0, '127.0.0.1', x));
    const url = `http://127.0.0.1:${r.server.address().port}`;
    const noToken = await runCli(['--signer', url, '--bundle', bundle], { SIGN_RELEASE_TOKEN_FILE: '' });
    assert.equal(noToken.code, 1);
    assert.match(noToken.out, /token file is required/);
    const wrong = path.join(dir, 'wrong');
    writeFileSync(wrong, 'x'.repeat(48));
    const denied = await runCli(['--signer', url, '--bundle', bundle, '--version', '1', '--token-file', wrong]);
    assert.equal(denied.code, 1);
    assert.match(denied.out, /401/);
    const slow = await runCli(['--signer', url, '--bundle', bundle, '--version', '1', '--token-file', tokenFile, '--poll-ms', '20', '--timeout-s', '1']);
    assert.equal(slow.code, 1);
    assert.match(slow.out, /timed out/);
    assert.equal(existsSync(`${bundle}.sig`), false);
  } finally {
    r.server.close();
  }
});
