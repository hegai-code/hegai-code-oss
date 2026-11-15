import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  collectOpen,
  collectOpenSummary,
  collectSeal,
  aadFor,
  clearContentIn,
  withMachine,
  SEALED_COMMANDS,
  collectSealSummary,
  formatPairingCode,
  isE2eEnvelope,
  type E2eEnvelope,
} from '@cc-remote/shared';
import { writeFileAtomicSync } from './atomic-write.js';
import { stateDir } from './config.js';
import { policy } from './policy.js';

/**
 * Private machine: the agent side of end-to-end encryption (docs/E2EE.md).
 *
 * AES-256-GCM, 96-bit random nonce, AAD = `kid|dir|kind|id` (shared `bindTag`). The traversal -
 * which fields of which frames are content - lives in shared/src/e2e.ts and is
 * the same one the web uses; this file brings the Node cipher, the key files
 * and the two doors: `sealOutgoing` (the one place a frame leaves for the hub)
 * and `openIncoming` (the one place a command from the hub is read).
 */

/** Random per process. Every command a client seals for this agent is bound to
 *  it (shared `frameBind`), so what was recorded before a restart is dead. */
export const AGENT_EPOCH = randomBytes(16).toString('hex');

const KEY_BYTES = 32;
const NONCE_BYTES = 12;

export function keyId(key: Buffer): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

export function b64urlEncode(buf: Buffer): string {
  return buf.toString('base64url');
}

export function b64urlDecode(s: string): Buffer {
  return Buffer.from(s, 'base64url');
}

/** Seal a JSON value bound to `bind` (`dir|kind|id`). `nonce` is for test vectors only. */
export function sealJson(key: Buffer, value: unknown, bind: string, nonce: Buffer = randomBytes(NONCE_BYTES)): E2eEnvelope {
  const kid = keyId(key);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(aadFor(kid, bind), 'utf8'));
  const body = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final(), cipher.getAuthTag()]);
  return { e2e: 1, kid, n: nonce.toString('base64'), c: body.toString('base64') };
}

/** Open an envelope with `key` for `bind`; throws on a wrong key, a wrong
 *  binding or tampering. */
export function openJson(key: Buffer, env: E2eEnvelope, bind: string): unknown {
  const raw = Buffer.from(env.c, 'base64');
  if (raw.length < 16) throw new Error('e2e: ciphertext too short');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(env.n, 'base64'));
  decipher.setAAD(Buffer.from(aadFor(env.kid, bind), 'utf8'));
  decipher.setAuthTag(raw.subarray(raw.length - 16));
  const plain = Buffer.concat([decipher.update(raw.subarray(0, raw.length - 16)), decipher.final()]);
  return JSON.parse(plain.toString('utf8')) as unknown;
}

// ---- Key files --------------------------------------------------------------

export function keyFile(dir: string = stateDir()): string {
  return path.join(dir, 'e2ee.key');
}

/** Retired keys (after `--pair --rotate`), one base64url per line. Still read,
 *  so a client that has not re-paired can finish what it was sending. */
function retiredFile(dir: string): string {
  return path.join(dir, 'e2ee.retired');
}

export interface KeyRing {
  current: Buffer;
  currentId: string;
  /** Every key by kid, current included. */
  byId: Map<string, Buffer>;
}

function readKey(file: string): Buffer | undefined {
  if (!existsSync(file)) return undefined;
  const key = b64urlDecode(readFileSync(file, 'utf8').trim());
  if (key.length !== KEY_BYTES) throw new Error(`${file} does not hold a 256-bit key`);
  return key;
}

function writeSecret(file: string, data: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomicSync(file, data, { mode: 0o600, mkdir: true });
  try {
    chmodSync(file, 0o600);
  } catch {
    /* best effort on filesystems without modes */
  }
}

/** Load the machine key, generating it on first use. `rotate` makes a new one
 *  and retires the old (kept for decrypting only). */
export function loadKeyRing(opts: { rotate?: boolean; dir?: string } = {}): KeyRing {
  const dir = opts.dir ?? stateDir();
  const file = keyFile(dir);
  let current = readKey(file);
  const retired: Buffer[] = [];
  if (existsSync(retiredFile(dir))) {
    for (const line of readFileSync(retiredFile(dir), 'utf8').split('\n')) {
      const t = line.trim();
      if (t) retired.push(b64urlDecode(t));
    }
  }
  if (current && opts.rotate) {
    retired.push(current);
    writeSecret(retiredFile(dir), `${retired.map(b64urlEncode).join('\n')}\n`);
    current = undefined;
  }
  if (!current) {
    current = randomBytes(KEY_BYTES);
    writeSecret(file, `${b64urlEncode(current)}\n`);
  }
  const byId = new Map<string, Buffer>();
  for (const k of [...retired, current]) byId.set(keyId(k), k);
  return { current, currentId: keyId(current), byId };
}

export function pairingCodeFor(machineId: string, ring: KeyRing): string {
  return formatPairingCode(machineId, b64urlEncode(ring.current));
}

// ---- The doors ---------------------------------------------------------------

type Frame = Record<string, unknown>;

/** Frames a private machine does not send at all: they would carry paths,
 *  prompts or usage patterns to a hub that must not see content. */
const NEVER_SENT = new Set(['memory_push', 'memory_fetch', 'builder_profile', 'project_pushed']);

/** Requests in flight that a sealed answer is waiting for. */
const MAX_RPC_IN_FLIGHT = 4096;
/** Inbound nonces remembered for the life of the process. Evicting one would
 *  let its envelope be replayed, so past the cap new sealed commands are
 *  refused instead (200k commands in one process run - practically unreachable). */
export const MAX_SEEN_NONCES = 200_000;

let globalMachineId = '';

/** The id this agent registers under: every envelope is bound to it. */
export function setE2eeMachineId(id: string): void {
  globalMachineId = id;
}

export class E2ee {
  /** requestId -> method, so a response is clear only for the few methods that
   *  are not content. Dropped when the response goes out. */
  private readonly rpcMethods = new Map<string, string>();
  /** Every inbound nonce already opened: an envelope a hub replays is refused. */
  private readonly seenNonces = new Set<string>();

  /** Changes when `--pair --rotate` (another process) replaces the key file. */
  private keySignature: string | undefined;
  private lastKeyCheck = 0;

  constructor(
    public ring: KeyRing,
    private readonly dir?: string,
    private readonly machineId?: string,
  ) {
    this.keySignature = this.signature();
  }

  private signature(): string | undefined {
    try {
      const st = statSync(keyFile(this.dir ?? stateDir()));
      return `${st.ino}:${st.mtimeMs}:${st.size}`;
    } catch {
      return undefined;
    }
  }

  /** Pick up a key rotated by another process (the owner ran `--pair --rotate`
   *  while the daemon runs). Throttled unless `force`; a failed reload keeps the
   *  ring in use. Returns whether the ring changed. */
  refreshRing(force = false, now: number = Date.now()): boolean {
    if (!force && now - this.lastKeyCheck < 2000) return false;
    this.lastKeyCheck = now;
    const sig = this.signature();
    if (sig === this.keySignature) return false;
    try {
      this.ring = loadKeyRing({ dir: this.dir });
      this.keySignature = sig;
      console.log(`[agent] e2ee: key ring reloaded (current key ${this.ring.currentId})`);
      return true;
    } catch (err) {
      console.error(`[agent] e2ee: could not reload the key ring: ${(err as Error).message}`);
      return false;
    }
  }

  /** `duplicate`: that requestId is already in flight (an id is the client's
   *  choice; a second request under it must not rewrite what the first answers
   *  as) - drop it. `full`: too many in flight - refuse it. */
  noteRpc(requestId: string, method: string): 'ok' | 'duplicate' | 'full' {
    if (this.rpcMethods.has(requestId)) return 'duplicate';
    if (this.rpcMethods.size >= MAX_RPC_IN_FLIGHT) return 'full';
    this.rpcMethods.set(requestId, method);
    return 'ok';
  }

  /** `machineId|dir|kind|id`: what every envelope of this agent is bound to. */
  private bound(bind: string): string {
    return withMachine(this.machineId ?? globalMachineId, bind);
  }

  private seal(value: unknown, bind: string): E2eEnvelope {
    return sealJson(this.ring.current, value, this.bound(bind));
  }

  /** The frame as it may leave the machine; `null` = do not send it. */
  sealOutgoing(msg: Frame): Frame | null {
    this.refreshRing();
    const type = String(msg['type']);
    if (NEVER_SENT.has(type)) return null;
    let out = msg;
    if (type === 'inventory' && Array.isArray(msg['sessions'])) {
      out = { ...msg, sessions: msg['sessions'].map((s) => this.sealSummary(s as Frame)) };
      return out;
    }
    if (type === 'session_sync_begin' && msg['summary']) {
      return { ...msg, summary: this.sealSummary(msg['summary'] as Frame) };
    }
    if (type === 'machine_stats' && msg['stats'] && typeof msg['stats'] === 'object') {
      // The busiest processes are command lines: names of what the person runs.
      return { ...msg, stats: { ...(msg['stats'] as Frame), top: [] } };
    }
    if (type === 'session_committed') {
      const { cwd: _cwd, ...rest } = msg;
      return rest;
    }
    let method: string | undefined;
    if (type === 'rpc_response') {
      const id = String(msg['requestId']);
      method = this.rpcMethods.get(id);
      this.rpcMethods.delete(id);
    }
    const { frame, jobs } = collectSeal(out, { dir: 'a2c', method });
    for (const j of jobs) j.put(this.seal(j.secret, j.bind));
    return frame;
  }

  /** Envelopes already made for a summary field, by what they hold. An
   *  inventory is re-sent every few seconds and the hub skips rows that did not
   *  change byte for byte; a fresh nonce each time would make every row look
   *  changed (a database write and a broadcast per session per inventory).
   *  Reusing the envelope of IDENTICAL plaintext under the same key reveals
   *  only that it is unchanged - it can never pair two different plaintexts
   *  with one keystream. */
  private readonly summaryEnvelopes = new Map<string, E2eEnvelope>();

  private sealSummary(s: Frame): Frame {
    const { summary, jobs } = collectSealSummary(s);
    for (const j of jobs) {
      const k = `${this.ring.currentId}:${j.bind}:${JSON.stringify(j.secret)}`;
      let env = this.summaryEnvelopes.get(k);
      if (!env) {
        if (this.summaryEnvelopes.size > 50_000) this.summaryEnvelopes.clear();
        env = this.seal(j.secret, j.bind);
        this.summaryEnvelopes.set(k, env);
      }
      j.put(env);
    }
    return summary;
  }

  /**
   * A command from the hub with its envelopes opened. `refusal` is set when a
   * private machine got content in the clear (a client that holds no key, or a
   * hub that tried to type into the session itself) or an envelope it cannot
   * accept (unknown key, damaged, made for another frame, already seen): the
   * caller must not act.
   *
   * The clear-content check runs on the frame as received, envelope or not:
   * a hub that replays a genuine envelope next to its own `data: "curl x|sh"`
   * must not get the clear field acted on.
   */
  openIncoming(
    msg: Frame,
    opts: { acceptPlaintext?: boolean; sessionOfRun?: (runId: string) => string | undefined } = {},
  ): { msg: Frame; refusal?: string } {
    if (!opts.acceptPlaintext) {
      const clear = plaintextContent(msg);
      if (clear) return { msg, refusal: `${clear} must be encrypted on a private machine` };
    }
    const { frame, jobs } = collectOpen(msg, { dir: 'c2a', epoch: AGENT_EPOCH });
    // The person's own choices (folder, answer, mode) are taken only from a
    // sealed envelope: a hub could otherwise set them in the clear.
    if (!opts.acceptPlaintext && jobs.length === 0 && SEALED_COMMANDS.has(String(msg['type']))) {
      return { msg, refusal: `${String(msg['type'])} must be encrypted on a private machine` };
    }
    const nonces: string[] = [];
    for (const j of jobs) {
      const key = this.ring.byId.get(j.env.kid);
      let found = key;
      if (!found && this.refreshRing(true)) found = this.ring.byId.get(j.env.kid);
      if (!found) return { msg, refusal: `unknown key ${j.env.kid} - pair this device again` };
      // One nonce, one spelling: base64 has several for the same 12 bytes, and
      // a hub that re-spells a seen nonce must not slip past the replay set.
      const raw = Buffer.from(j.env.n, 'base64');
      if (raw.length !== NONCE_BYTES || raw.toString('base64') !== j.env.n) {
        return { msg, refusal: 'the encrypted command has a malformed nonce' };
      }
      const nonce = raw.toString('hex');
      if (this.seenNonces.has(nonce) || nonces.includes(nonce)) {
        return { msg, refusal: 'this encrypted command was already received (replay)' };
      }
      nonces.push(nonce);
      let secret: unknown;
      try {
        secret = openJson(found, j.env, this.bound(j.bind));
      } catch {
        return { msg, refusal: 'could not decrypt the command (wrong key, wrong frame or damaged)' };
      }
      const why = j.check?.(secret, { sessionOfRun: opts.sessionOfRun });
      if (why) return { msg, refusal: why };
      j.put(secret);
    }
    if (this.seenNonces.size + nonces.length > MAX_SEEN_NONCES) {
      console.error('[agent] e2ee: inbound nonce memory is full - refusing sealed commands until the agent restarts');
      return { msg, refusal: 'too many encrypted commands since the agent started - restart the agent' };
    }
    for (const n of nonces) this.seenNonces.add(n);
    return { msg: { ...frame } };
  }

  openSummary(s: Frame): Frame {
    const { summary, jobs } = collectOpenSummary(s);
    for (const j of jobs) {
      const key = typeof (j.env as E2eEnvelope).kid === 'string' ? this.ring.byId.get(j.env.kid) : undefined;
      if (key) j.put(openJson(key, j.env, this.bound(j.bind)));
    }
    return summary;
  }
}

/** Name of the content a command carries in the clear, or undefined. */
export function plaintextContent(msg: Frame): string | undefined {
  return clearContentIn(msg);
}

export { isE2eEnvelope };

let instance: E2ee | null | undefined;

/** The process's encryption, or null when this machine is not private. Read
 *  once - the policy needs a restart to change, and so does this. */
export function e2ee(): E2ee | null {
  if (instance === undefined) {
    if (!policy().private) {
      instance = null;
    } else {
      try {
        instance = new E2ee(loadKeyRing(), stateDir());
      } catch (err) {
        // A corrupt key file must not stop the machine registering (it may be the
        // only remote hand there is). Fail closed instead: seal under a key that
        // exists nowhere else, so nothing leaves in the clear and every sealed
        // command is refused as «unknown key» until the owner fixes the file.
        console.error(`[agent] e2ee: the key file is unusable (${(err as Error).message}) - sealing with a throwaway key; fix ${keyFile()} and restart`);
        const current = randomBytes(KEY_BYTES);
        const ring: KeyRing = { current, currentId: keyId(current), byId: new Map([[keyId(current), current]]) };
        instance = new E2ee(ring, stateDir());
      }
    }
  }
  return instance;
}

let opener: E2ee | null | undefined;

/**
 * What opens a sealed command: the private machine's encryption, or - on a
 * machine that is no longer private but still holds its key - an opener over
 * the same key file, so a browser paired earlier (whose key wins) is still
 * understood while the machine answers in the clear. Never creates a key.
 */
export function e2eeOpener(): E2ee | null {
  const priv = e2ee();
  if (priv) return priv;
  if (opener === undefined) {
    try {
      opener = existsSync(keyFile()) ? new E2ee(loadKeyRing(), stateDir()) : null;
    } catch (err) {
      // An ordinary machine with a damaged leftover key keeps working; it just
      // cannot open sealed commands.
      console.error(`[agent] e2ee: ignoring an unusable key file (${(err as Error).message})`);
      opener = null;
    }
  }
  return opener;
}

/** Tests only. */
export function setE2eeForTests(e: E2ee | null | undefined): void {
  instance = e;
  opener = undefined;
}

/** The `--pair` command: print the code (and a QR when `qrencode` exists). */
export function runPairCli(args: string[], machineId: string): number {
  const rotate = args.includes('--rotate');
  if (!policy().private) {
    console.error('This machine is not private. Set "private": true in policy.json (or `policy private on`), then run --pair.');
    return 1;
  }
  const ring = loadKeyRing({ rotate });
  const code = pairingCodeFor(machineId, ring);
  console.log(code);
  // A QR for the phone apps (phase 2), when the tool is on the machine.
  const qr = spawnSync('qrencode', ['-t', 'ANSIUTF8', code], { encoding: 'utf8' });
  if (qr.status === 0 && qr.stdout) console.log(qr.stdout);
  console.log(`key id: ${ring.currentId}${rotate ? ' (rotated - older sessions stay readable only with the old key)' : ''}`);
  console.log('Whoever sees this code can read this machine\'s sessions. Enter it in the Hegai Code web "Ввести код пары".');
  return 0;
}
