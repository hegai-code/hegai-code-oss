#!/usr/bin/env node
// Hegai Code release signer: request / approve. Node >= 20 built-ins only.
// See README.md.
//
// The build machine can only ASK for a signature. The authenticator code is
// typed on the signer's own page, next to the request the operator recognises
// (version, full sha256, commit, note), so a code that leaks from the build
// machine cannot sign anything the operator did not look at.
//
//   POST /requests               {version, sha256, commit?, note?}  bearer  -> 201 {id, status}
//   GET  /requests/{id}                                              bearer  -> {status, manifest?, signature?}
//   GET  /pending                                                    -       -> {requests:[...]}  (what the page shows)
//   POST /requests/{id}/approve  {code}                              TOTP    -> {status:'signed'}
//   GET  /                                                           -       -> the approval page
//   GET  /health                                                     -       -> {ok:true}
//
// Binds to 127.0.0.1 only: put TLS and a proxy in front of it.
//
// env: SIGNER_KEY_PATH            PKCS8 PEM Ed25519 private key (mode 0600)
//      SIGNER_TOTP_SECRET_PATH    base32 TOTP secret
//      SIGNER_REQUEST_TOKEN_PATH  bearer token for the build machine (>= 32 bytes)
//      SIGNER_STATE_DIR           directory: state.json (replay + lockout), requests.json
//      SIGNER_LOG_PATH            append-only JSON lines, one per event
//      SIGNER_PORT                default 8787
//      SIGNER_TG_BOT_TOKEN_PATH, SIGNER_TG_CHAT_ID   optional Telegram notices
import { createHash, createPrivateKey, randomBytes, sign, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { base32Decode, verifyCode } from './totp.mjs';
import { manifestText } from './release-format.mjs';

/** 5 wrong codes lock approvals; each further lock doubles, up to a day. */
export const MAX_FAILURES = 5;
export const LOCKOUT_BASE_MS = 15 * 60_000;
export const LOCKOUT_MAX_MS = 24 * 60 * 60_000;
export const REQUEST_TTL_MS = 2 * 60 * 60_000;
export const MAX_PENDING = 10;
/** A signed request stays fetchable this long, then is forgotten. */
const SIGNED_KEEP_MS = 24 * 60 * 60_000;
export const MIN_TOKEN_BYTES = 32;
const MAX_BODY = 4096;
const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/;
const SHA_RE = /^[0-9a-f]{64}$/;
const COMMIT_RE = /^[0-9a-f]{7,40}$/;
const ID_RE = /^[0-9a-f]{32}$/;
const MAX_NOTE = 200;
// C0 and C1 controls, DEL, and the Unicode line/paragraph separators.
const CONTROL_RE = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]');

export const lockoutMs = (lockCount) => Math.min(LOCKOUT_BASE_MS * 2 ** lockCount, LOCKOUT_MAX_MS);

function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
  renameSync(tmp, file);
}

function readState(file) {
  const s = readJson(file, {});
  return {
    lastStep: Number.isInteger(s.lastStep) ? s.lastStep : undefined,
    failures: Number.isInteger(s.failures) ? s.failures : 0,
    lockCount: Number.isInteger(s.lockCount) ? s.lockCount : 0,
    lockedUntil: Number.isFinite(s.lockedUntil) ? s.lockedUntil : 0,
  };
}

function sameSecret(a, b) {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

// The approval page: no external assets, no data in the markup. Everything a
// requester wrote reaches the DOM through textContent, never as HTML.
const PAGE_SCRIPT = `
const list = document.getElementById('list');
const note = document.getElementById('note');
function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }
function say(text, bad) { note.textContent = text; note.className = bad ? 'bad' : 'ok'; }
async function approve(id, input, button) {
  button.disabled = true;
  try {
    const res = await fetch('/requests/' + id + '/approve', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: input.value.replace(/\\s/g, '') }) });
    const body = await res.json().catch(() => ({}));
    if (res.ok) say('Signed. The build machine will pick it up.', false);
    else if (res.status === 429) say('Locked after wrong codes. Try again in ' + Math.ceil((body.retryAfter || 0) / 60) + ' min.', true);
    else say(body.error || ('Refused (' + res.status + ')'), true);
  } catch (e) { say('No answer from the signer.', true); }
  input.value = '';
  button.disabled = false;
  load();
}
async function load() {
  let data;
  try { data = await (await fetch('/pending', { cache: 'no-store' })).json(); } catch (e) { return; }
  list.replaceChildren();
  if (!data.requests.length) list.append(el('p', 'muted', 'No pending requests.'));
  for (const r of data.requests) {
    const card = el('section', 'card');
    card.append(el('h2', '', 'Version ' + r.version));
    card.append(el('div', 'label', 'sha256 - compare with what your trusted build printed'));
    card.append(el('code', 'sha', r.sha256));
    if (r.commit) { card.append(el('div', 'label', 'commit')); card.append(el('code', '', r.commit)); }
    if (r.note) { card.append(el('div', 'label', 'note')); card.append(el('div', '', r.note)); }
    card.append(el('div', 'muted', 'requested ' + new Date(r.createdAt).toLocaleString() + ', expires ' + new Date(r.expiresAt).toLocaleString()));
    const form = el('form', 'row');
    const input = el('input'); input.inputMode = 'numeric'; input.autocomplete = 'one-time-code'; input.maxLength = 7; input.placeholder = '6-digit code'; input.setAttribute('aria-label', 'Authenticator code');
    const button = el('button', '', 'Sign this exact build'); button.type = 'submit';
    form.append(input, button);
    form.addEventListener('submit', (ev) => { ev.preventDefault(); approve(r.id, input, button); });
    card.append(form);
    list.append(card);
  }
}
load();
setInterval(load, 15000);
`;

const PAGE_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Release signer</title>
<style>
:root { color-scheme: light dark; --bg:#fff; --fg:#14181f; --muted:#5d6675; --line:#d5dae3; --accent:#1d4ed8; --bad:#b42318; --ok:#067647; }
@media (prefers-color-scheme: dark) { :root { --bg:#0e1116; --fg:#e8ebf1; --muted:#9aa4b5; --line:#2a313d; --accent:#6b9bff; --bad:#ff8a80; --ok:#5fd39a; } }
body { margin:0; padding:16px; background:var(--bg); color:var(--fg); font:16px/1.45 system-ui,sans-serif; max-width:640px; margin-inline:auto; }
h1 { font-size:1.2rem; } h2 { font-size:1.05rem; margin:0 0 8px; }
.card { border:1px solid var(--line); border-radius:10px; padding:14px; margin:12px 0; }
.label { color:var(--muted); font-size:.8rem; margin-top:10px; }
.sha { display:block; font:14px/1.4 ui-monospace,monospace; word-break:break-all; margin-top:2px; }
code { font-family: ui-monospace,monospace; word-break:break-all; }
.muted { color:var(--muted); font-size:.85rem; margin-top:10px; }
.row { display:flex; gap:8px; margin-top:12px; }
input { flex:1; min-width:0; font-size:1.1rem; padding:10px; border:1px solid var(--line); border-radius:8px; background:var(--bg); color:var(--fg); }
button { font-size:1rem; padding:10px 14px; border:0; border-radius:8px; background:var(--accent); color:#fff; }
button:disabled { opacity:.5; }
#note.bad { color:var(--bad); } #note.ok { color:var(--ok); }
</style></head><body>
<h1>Release signer</h1>
<p class="muted">Sign only a build whose version and sha256 you recognise: compare the sha256 below with the one printed by the build on a machine you trust.</p>
<div id="note" role="status"></div>
<div id="list"></div>
<script>${PAGE_SCRIPT}</script>
</body></html>`;

const PAGE_CSP = `default-src 'none'; style-src 'unsafe-inline'; script-src 'sha256-${createHash('sha256').update(PAGE_SCRIPT).digest('base64')}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;

/** Build the request handler. `now` (ms) and `fetchImpl` are injectable for tests. */
export function createSigner({ keyPath, totpSecretPath, requestTokenPath, stateDir, logPath, tg, now = Date.now, fetchImpl = globalThis.fetch }) {
  const key = createPrivateKey(readFileSync(keyPath));
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('SIGNER_KEY_PATH must be an Ed25519 key');
  const secret = base32Decode(readFileSync(totpSecretPath, 'utf8'));
  const token = readFileSync(requestTokenPath, 'utf8').trim();
  if (Buffer.byteLength(token) < MIN_TOKEN_BYTES) throw new Error(`SIGNER_REQUEST_TOKEN_PATH must hold at least ${MIN_TOKEN_BYTES} bytes`);
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const statePath = path.join(stateDir, 'state.json');
  const requestsPath = path.join(stateDir, 'requests.json');
  const tgToken = tg?.botTokenPath ? readFileSync(tg.botTokenPath, 'utf8').trim() : undefined;
  const tgChat = tg?.chatId;
  let chain = Promise.resolve();

  /** Append to the audit log. THROWS when the line did not land: a signature must never exist without its record. */
  const appendLog = (event, extra) => {
    appendFileSync(logPath, `${JSON.stringify({ t: new Date(now()).toISOString(), event, ...extra })}\n`, { mode: 0o600 });
  };
  /** Best effort, for every event that is not a released signature: a full disk never takes the server down. */
  const log = (event, extra) => {
    try {
      appendLog(event, extra);
    } catch (err) {
      console.error(`log write failed: ${err.message}`);
    }
  };

  /** Fire and forget: a Telegram outage never blocks or fails a signature. */
  const notify = (text) => {
    if (!tgToken || !tgChat) return;
    Promise.resolve()
      .then(() =>
        fetchImpl(`https://api.telegram.org/bot${tgToken}/sendMessage`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chat_id: tgChat, text, disable_web_page_preview: true }),
          signal: AbortSignal.timeout(10_000),
        }),
      )
      .catch((err) => log('notify_failed', { error: String(err?.message ?? err).replace(tgToken, '***') }));
  };

  /** Requests, with expiry applied: a pending request past its time is `expired`, a signed one past its keep time is gone. */
  function loadRequests() {
    const t = now();
    const all = readJson(requestsPath, []);
    const kept = [];
    for (const r of Array.isArray(all) ? all : []) {
      if (r.status === 'pending' && r.expiresAt <= t) r.status = 'expired';
      if (r.status === 'signed' && t - r.signedAt > SIGNED_KEEP_MS) continue;
      if (r.status === 'expired' && t - r.expiresAt > SIGNED_KEEP_MS) continue;
      kept.push(r);
    }
    return kept;
  }

  const pendingOf = (requests) => requests.filter((r) => r.status === 'pending');
  const publicView = (r) => ({ id: r.id, version: r.version, sha256: r.sha256, commit: r.commit, note: r.note, createdAt: r.createdAt, expiresAt: r.expiresAt });

  function authorized(req) {
    const h = String(req.headers.authorization ?? '');
    const m = /^Bearer (.+)$/.exec(h);
    return Boolean(m) && sameSecret(m[1], token);
  }

  function handleCreate(body, remote) {
    const { version, sha256, commit, note } = body ?? {};
    if (typeof version !== 'string' || !VERSION_RE.test(version)) return [400, { error: 'bad version' }];
    if (typeof sha256 !== 'string' || !SHA_RE.test(sha256)) return [400, { error: 'bad sha256' }];
    if (commit !== undefined && (typeof commit !== 'string' || !COMMIT_RE.test(commit))) return [400, { error: 'bad commit' }];
    if (note !== undefined && (typeof note !== 'string' || note.length > MAX_NOTE || CONTROL_RE.test(note))) return [400, { error: 'bad note' }];
    const requests = loadRequests();
    const same = requests.find((r) => r.status === 'pending' && r.version === version && r.sha256 === sha256);
    if (same) {
      writeJson(requestsPath, requests);
      return [200, { id: same.id, status: 'pending', createdAt: same.createdAt, expiresAt: same.expiresAt }];
    }
    if (pendingOf(requests).length >= MAX_PENDING) return [429, { error: 'too many pending requests' }];
    const t = now();
    const r = { id: randomBytes(16).toString('hex'), status: 'pending', version, sha256, createdAt: t, expiresAt: t + REQUEST_TTL_MS };
    if (commit) r.commit = commit;
    if (note) r.note = note;
    requests.push(r);
    writeJson(requestsPath, requests);
    log('requested', { remote, id: r.id, version, sha256, commit });
    notify(`Release signing requested\nversion ${version}\nsha256 ${sha256}${commit ? `\ncommit ${commit}` : ''}${note ? `\nnote ${note}` : ''}\nOpen the signer page and compare the sha256 before approving.`);
    return [201, { id: r.id, status: 'pending', createdAt: r.createdAt, expiresAt: r.expiresAt }];
  }

  function handleGet(id) {
    const r = loadRequests().find((x) => x.id === id);
    if (!r) return [404, { error: 'unknown request' }];
    if (r.status === 'signed') return [200, { id, status: 'signed', version: r.version, sha256: r.sha256, manifest: r.manifest, signature: r.signature }];
    return [200, { id, status: r.status, version: r.version, sha256: r.sha256, expiresAt: r.expiresAt }];
  }

  /** One request at a time: state is a read-modify-write on files. */
  function handleApprove(id, body, remote) {
    const code = body?.code;
    if (typeof code !== 'string') return [400, { error: 'bad code' }];
    const state = readState(statePath);
    const t = now();
    if (state.lockedUntil > t) {
      log('locked', { remote, retryAfterS: Math.ceil((state.lockedUntil - t) / 1000) });
      return [429, { error: 'locked', retryAfter: Math.ceil((state.lockedUntil - t) / 1000) }];
    }
    const requests = loadRequests();
    const r = requests.find((x) => x.id === id);
    if (!r) return [404, { error: 'unknown request' }];
    if (r.status === 'expired') return [410, { error: 'request expired' }];
    if (r.status !== 'pending') return [409, { error: `request is ${r.status}` }];
    const step = verifyCode(secret, code, Math.floor(t / 1000), { afterStep: state.lastStep });
    if (step === undefined) {
      state.failures += 1;
      let lockedMs = 0;
      if (state.failures >= MAX_FAILURES) {
        lockedMs = lockoutMs(state.lockCount);
        state.failures = 0;
        state.lockCount += 1;
        state.lockedUntil = t + lockedMs;
      }
      writeJson(statePath, state);
      log('bad_code', { remote, id, version: r.version, sha256: r.sha256, lockedForS: lockedMs / 1000 });
      return [403, { error: 'invalid code' }];
    }
    // The step is burned BEFORE the signature leaves: a crash after this line
    // costs the operator a fresh code, never a replayable one.
    writeJson(statePath, { lastStep: step, failures: 0, lockCount: 0, lockedUntil: 0 });
    const manifest = manifestText(r.version, r.sha256);
    const signature = sign(null, Buffer.from(manifest), key).toString('base64');
    // Fail closed: the `signed` line is on disk BEFORE the signature is stored for the requester. If it cannot
    // be written the request stays pending (the burned code costs the operator a fresh one) and nothing leaves.
    try {
      appendLog('signed', { remote, id, version: r.version, sha256: r.sha256 });
    } catch (err) {
      console.error(`signature withheld, audit log write failed: ${err.message}`);
      return [500, { error: 'audit log unavailable, nothing was signed' }];
    }
    r.status = 'signed';
    r.signedAt = t;
    r.manifest = manifest;
    r.signature = signature;
    writeJson(requestsPath, requests);
    notify(`Release SIGNED\nversion ${r.version}\nsha256 ${r.sha256}`);
    return [200, { id, status: 'signed' }];
  }

  return function handler(req, res) {
    const reply = (status, obj) => {
      const text = JSON.stringify(obj);
      res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      res.end(text);
    };
    const url = (req.url ?? '').split('?')[0];
    if (req.method === 'GET' && url === '/health') return reply(200, { ok: true });
    if (req.method === 'GET' && url === '/') {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'content-security-policy': PAGE_CSP,
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
        'x-frame-options': 'DENY',
      });
      return res.end(PAGE_HTML);
    }
    const remote = String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '').slice(0, 100);
    const serialized = (fn) => {
      chain = chain.then(() => {
        try {
          const [status, obj] = fn();
          reply(status, obj);
        } catch (err) {
          console.error(`signer request failed: ${err.message}`);
          reply(500, { error: 'internal error' });
        }
      });
    };
    if (req.method === 'GET' && url === '/pending') {
      return serialized(() => [200, { requests: pendingOf(loadRequests()).map(publicView) }]);
    }
    const idMatch = /^\/requests\/([0-9a-f]{32})(\/approve)?$/.exec(url);
    const isCreate = req.method === 'POST' && url === '/requests';
    const isGet = req.method === 'GET' && idMatch && !idMatch[2];
    const isApprove = req.method === 'POST' && idMatch && idMatch[2];
    if (!isCreate && !isGet && !isApprove) return reply(404, { error: 'not found' });
    // The build machine's token opens create/get; approval needs the code only.
    if (!isApprove && !authorized(req)) {
      log('unauthorized', { remote, url });
      return reply(401, { error: 'bearer token required' });
    }
    if (isGet) return serialized(() => handleGet(idMatch[1]));
    if (String(req.headers['content-type'] ?? '').split(';')[0].trim() !== 'application/json') return reply(415, { error: 'application/json required' });
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('error', () => {});
    req.on('end', () => {
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return reply(400, { error: 'bad json' });
      }
      if (body === null || typeof body !== 'object' || Array.isArray(body)) return reply(400, { error: 'bad json' });
      if (isCreate) serialized(() => handleCreate(body, remote));
      else serialized(() => handleApprove(idMatch[1], body, remote));
    });
  };
}

function main() {
  const need = (name) => {
    const v = process.env[name];
    if (!v) {
      console.error(`${name} is required`);
      process.exit(2);
    }
    return v;
  };
  const cfg = {
    keyPath: need('SIGNER_KEY_PATH'),
    totpSecretPath: need('SIGNER_TOTP_SECRET_PATH'),
    requestTokenPath: need('SIGNER_REQUEST_TOKEN_PATH'),
    stateDir: need('SIGNER_STATE_DIR'),
    logPath: need('SIGNER_LOG_PATH'),
  };
  if (process.env.SIGNER_TG_BOT_TOKEN_PATH && process.env.SIGNER_TG_CHAT_ID) {
    cfg.tg = { botTokenPath: process.env.SIGNER_TG_BOT_TOKEN_PATH, chatId: process.env.SIGNER_TG_CHAT_ID };
  }
  const port = Number(process.env.SIGNER_PORT ?? 8787);
  const server = createServer(createSigner(cfg));
  server.requestTimeout = 10_000;
  server.listen(port, '127.0.0.1', () => console.log(`release signer listening on 127.0.0.1:${port}`));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
