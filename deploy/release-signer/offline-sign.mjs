#!/usr/bin/env node
// Offline release signing on a laptop that is NOT in the fleet (Owner's MacBook,
// 31.10.2026): no Hegai Code agent, no fleet SSH key, so root on the hub cannot
// reach the key. One file, Node built-ins only — read it before you run it.
//
//   node offline-sign.mjs setup                 # once: new Ed25519 key, passphrase-encrypted
//   node offline-sign.mjs pubkey                # print the line for deploy/release-keys.txt
//   node offline-sign.mjs sign <bundle | https URL> [--version <v>] [--keys release-keys.txt]
//
// `sign` downloads (or reads) the external agent bundle, refuses anything that
// is not an external build, shows version and sha256 — compare the sha256 with
// the one the build printed — asks the passphrase and writes, next to the
// bundle, `<bundle>.release` (the manifest) and `<bundle>.sig` (the signature).
// It also prints both: they are public, paste them back to whoever publishes.
//
// The key file never leaves ~/.hegai-release-signing (0700/0600). The PKCS#8
// private key is encrypted with AES-256-GCM under a key derived from the
// passphrase by scrypt (N=2^17). Two factors: this laptop and the passphrase.
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  scryptSync,
  sign,
  verify,
} from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = process.env.HEGAI_SIGNING_DIR || path.join(os.homedir(), '.hegai-release-signing');
const KEY = path.join(DIR, 'release-ed25519.key.json');
// scrypt cost: N=2^17, r=8, p=1 (~128 MiB, about a second) — an offline guess
// at the passphrase costs that much each time.
const SCRYPT = { N: 2 ** 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };
const MAX_BUNDLE = 32 * 1024 * 1024;
const MAGIC = 'hegai-code-agent-release/1';

// Same bytes as deploy/release-signer/release-format.mjs (copied so this file stands alone).
const manifestText = (version, sha256) => `${MAGIC}\nedition=external\nversion=${version}\nsha256=${sha256}\n`;
const sha256Hex = (data) => createHash('sha256').update(data).digest('hex');
function bundleEdition(bytes) {
  const text = Buffer.from(bytes).toString('latin1');
  const ext = text.includes('"HEGAI_AGENT_EDITION=external"');
  const int = text.includes('"HEGAI_AGENT_EDITION=internal"');
  return ext === int ? undefined : ext ? 'external' : 'internal';
}

function die(msg) {
  console.error(`offline-sign: ${msg}`);
  process.exit(1);
}

/** Read a line from the terminal without echoing it. */
function askHidden(prompt) {
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    if (!input.isTTY) return reject(new Error('needs a terminal for the passphrase'));
    process.stderr.write(prompt);
    let buf = '';
    input.setRawMode(true);
    input.resume();
    input.setEncoding('utf8');
    const onData = (ch) => {
      for (const c of ch) {
        if (c === '\r' || c === '\n') {
          input.setRawMode(false);
          input.pause();
          input.removeListener('data', onData);
          process.stderr.write('\n');
          return resolve(buf);
        }
        if (c === '\u0003') {
          input.setRawMode(false);
          process.exit(130);
        }
        if (c === '\u007f' || c === '\b') buf = buf.slice(0, -1);
        else buf += c;
      }
    };
    input.on('data', onData);
  });
}

function pubkeyLine() {
  if (!existsSync(KEY)) die(`no key at ${KEY} — run: node offline-sign.mjs setup`);
  // The public half is derivable without the passphrase only from the private
  // key, so it is stored next to it at setup.
  const pub = path.join(DIR, 'release-ed25519.pub');
  if (!existsSync(pub)) die(`missing ${pub}`);
  return readFileSync(pub, 'utf8').trim();
}

async function setup() {
  if (existsSync(KEY)) die(`a key already exists at ${KEY} — rotating is a new key: move it away first`);
  const p1 = await askHidden('New passphrase (at least 12 characters): ');
  if (p1.length < 12) die('passphrase too short');
  const p2 = await askHidden('Repeat: ');
  if (p1 !== p2) die('passphrases differ');
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  mkdirSync(DIR, { recursive: true, mode: 0o700 });
  chmodSync(DIR, 0o700);
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const kek = scryptSync(p1, salt, 32, SCRYPT);
  const cipher = createCipheriv('aes-256-gcm', kek, iv);
  const ct = Buffer.concat([cipher.update(privateKey.export({ type: 'pkcs8', format: 'der' })), cipher.final()]);
  const sealed = { v: 1, kdf: 'scrypt', ...SCRYPT, salt: salt.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ct: ct.toString('base64') };
  writeFileSync(KEY, `${JSON.stringify(sealed)}\n`, { mode: 0o600 });
  const line = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  writeFileSync(path.join(DIR, 'release-ed25519.pub'), `${line}\n`, { mode: 0o644 });
  console.log(`Key written to ${KEY} (encrypted).`);
  console.log('Public key — this line goes into deploy/release-keys.txt (it is public):');
  console.log(line);
}

async function load(src) {
  if (/^https:\/\//.test(src)) {
    // No redirects (an https link must not quietly become http), a deadline,
    // and a size cap before anything is buffered.
    const res = await fetch(src, { redirect: 'error', signal: AbortSignal.timeout(60_000) });
    if (!res.ok) die(`GET ${src} → ${res.status}`);
    const len = Number(res.headers.get('content-length') ?? 0);
    if (len > MAX_BUNDLE) die(`bundle too large (${len} bytes)`);
    // Read with the cap applied while streaming, not after buffering it all.
    const chunks = [];
    let total = 0;
    for await (const chunk of res.body) {
      total += chunk.length;
      if (total > MAX_BUNDLE) die('bundle too large');
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks);
    // A fresh name next to nothing: never overwrite an existing file.
    const file = path.resolve(`agent-external-${sha256Hex(bytes).slice(0, 12)}.mjs`);
    if (existsSync(file)) die(`${file} already exists — move it away first`);
    writeFileSync(file, bytes, { flag: 'wx' });
    return { bytes, file };
  }
  if (/^http:/.test(src)) die('only https downloads');
  return { bytes: readFileSync(src), file: path.resolve(src) };
}

/** The version the build compiled into the bundle (deploy/build-agent.sh). */
function bundleVersion(bytes) {
  const m = /AGENT_VERSION = true \? "([0-9A-Za-z._+-]{1,64})"/.exec(Buffer.from(bytes).toString('latin1'));
  return m?.[1];
}

/** Unlock the sealed private key with the passphrase. */
function unlock(pass) {
  const sealed = JSON.parse(readFileSync(KEY, 'utf8'));
  const kek = scryptSync(pass, Buffer.from(sealed.salt, 'base64'), 32, {
    N: sealed.N,
    r: sealed.r,
    p: sealed.p,
    maxmem: SCRYPT.maxmem,
  });
  const d = createDecipheriv('aes-256-gcm', kek, Buffer.from(sealed.iv, 'base64'));
  d.setAuthTag(Buffer.from(sealed.tag, 'base64'));
  const der = Buffer.concat([d.update(Buffer.from(sealed.ct, 'base64')), d.final()]);
  return createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
}

async function signCmd(src, version, keysFile) {
  if (!src) die('usage: sign <bundle | https URL> [--version <v>] [--keys release-keys.txt]');
  if (!existsSync(KEY)) die(`no key at ${KEY} — run setup first`);
  const { bytes, file } = await load(src);
  const edition = bundleEdition(bytes);
  if (edition !== 'external') die(`this is not an external agent build (edition: ${edition ?? 'unknown'}) — refusing to sign`);
  const built = bundleVersion(bytes);
  if (!built) die('cannot read the version compiled into the bundle');
  if (version && version !== built) die(`--version ${version} but the bundle was built as ${built}`);
  const sha = sha256Hex(bytes);
  console.error(`bundle  ${file}\nversion ${built}\nsha256  ${sha}\n`);
  console.error('Compare the sha256 above with the one the build printed. Sign only if they match.');
  const pass = await askHidden('Passphrase: ');
  let key;
  try {
    key = unlock(pass);
  } catch {
    die('wrong passphrase');
  }
  const manifest = Buffer.from(manifestText(built, sha));
  const sig = sign(null, manifest, key).toString('base64');
  // Self-check: against our own public key, and — when given — against the keys
  // the consumers actually trust, so a missing or mistyped key line is caught here.
  const keys = [pubkeyLine()];
  const trusted = keysFile
    ? readFileSync(keysFile, 'utf8')
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#'))
    : undefined;
  const ok = (k) => verify(null, manifest, createPublicKey({ key: Buffer.from(k, 'base64'), format: 'der', type: 'spki' }), Buffer.from(sig, 'base64'));
  if (!keys.some(ok)) die('self-check failed');
  if (trusted && !trusted.some((k) => { try { return ok(k); } catch { return false; } })) {
    die(`signed, but no key in ${keysFile} verifies it — add the public key line there first`);
  }
  if (!trusted) console.error('note: no --keys given; not checked against deploy/release-keys.txt');
  if (existsSync(`${file}.release`) || existsSync(`${file}.sig`)) die(`${file}.release or .sig already exists — move them away first`);
  writeFileSync(`${file}.release`, manifest, { flag: 'wx' });
  writeFileSync(`${file}.sig`, `${sig}\n`, { flag: 'wx' });
  console.log(`Wrote ${file}.release and ${file}.sig\n`);
  console.log('--- agent-external.mjs.release ---');
  process.stdout.write(manifest);
  console.log('--- agent-external.mjs.sig ---');
  console.log(sig);
}

const [cmd, ...rest] = process.argv.slice(2);
const flag = (name) => {
  const i = rest.indexOf(name);
  if (i < 0) return undefined;
  const v = rest[i + 1];
  if (!v || v.startsWith('--')) die(`${name} needs a value`);
  return v;
};
const positional = rest.filter((a, i) => !a.startsWith('--') && rest[i - 1] !== '--version' && rest[i - 1] !== '--keys')[0];

if (cmd === 'setup') await setup();
else if (cmd === 'pubkey') console.log(pubkeyLine());
else if (cmd === 'sign') await signCmd(positional, flag('--version'), flag('--keys'));
else {
  console.error('usage: node offline-sign.mjs setup | pubkey | sign <bundle | https URL> [--version <v>] [--keys release-keys.txt]');
  process.exit(2);
}
