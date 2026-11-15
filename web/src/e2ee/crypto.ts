import { aadFor, collectOpen, collectOpenSummary, collectSeal, TURN_ECHO_BIND, withMachine, type E2eEnvelope } from '@cc-remote/shared';

/**
 * Private machine, the browser side of the envelope (docs/E2EE.md): AES-256-GCM
 * through WebCrypto, the key id bound as AAD, the nonce 96 random bits. The
 * same bytes the agent's Node `crypto` makes (shared/test/e2e-vectors.json is
 * checked on both sides). The traversal - which fields of which frames are
 * content - is shared/src/e2e.ts; this file only supplies the async cipher.
 *
 * No DOM and no storage here, so it runs under Node's test runner too.
 */

const enc = new TextEncoder();
const dec = new TextDecoder();

export function bytesToB64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export function b64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function b64urlToBytes(b64url: string): Uint8Array<ArrayBuffer> {
  const std = b64url.replace(/-/g, '+').replace(/_/g, '/');
  return b64ToBytes(std + '='.repeat((4 - (std.length % 4)) % 4));
}

/** First 8 bytes of SHA-256(K), hex - the key id sent in clear. */
export async function keyIdOf(raw: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', raw));
  return [...digest.slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Import the raw key ONCE as a non-extractable CryptoKey: from here on the
 *  page can use it but never read it back. */
export function importKey(raw: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

/** Seal a JSON value bound to `bind` (`dir|kind|id`). `nonce` is for test vectors only. */
export async function sealJson(
  key: CryptoKey,
  kid: string,
  value: unknown,
  bind: string,
  nonce: Uint8Array<ArrayBuffer> = crypto.getRandomValues(new Uint8Array(12)),
): Promise<E2eEnvelope> {
  const body = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce, additionalData: enc.encode(aadFor(kid, bind)), tagLength: 128 },
      key,
      enc.encode(JSON.stringify(value)),
    ),
  );
  return { e2e: 1, kid, n: bytesToB64(nonce), c: bytesToB64(body) };
}

/** Open an envelope made for `bind`; throws on a wrong key, binding or tampering. */
export async function openJson(key: CryptoKey, env: E2eEnvelope, bind: string): Promise<unknown> {
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: b64ToBytes(env.n), additionalData: enc.encode(aadFor(env.kid, bind)), tagLength: 128 },
    key,
    b64ToBytes(env.c),
  );
  return JSON.parse(dec.decode(plain)) as unknown;
}

/** What the frame helpers need from a key ring. */
export interface KeySource {
  /** The key a ciphertext with this `kid` needs, if this device holds it. */
  forKid(kid: string): { key: CryptoKey } | undefined;
  /** The newest key paired with this machine, to encrypt with. */
  latestFor(machineId: string): { key: CryptoKey; kid: string } | undefined;
}

type Frame = Record<string, unknown>;

/** Which machine THIS browser attributes a frame to (its own open / rpc / terminal
 *  bookkeeping, never a field of the frame the hub chose). Undefined = unknown:
 *  the envelope stays shut. */
export type MachineOf = (frame: Record<string, unknown>) => string | undefined;

/**
 * A frame from the hub with every envelope this device can open opened. An
 * envelope it cannot open (no key, wrong key, made for another machine) stays
 * where it was, so the UI can say «нужен ключ» / «Зашифровано» instead of
 * showing nothing. Envelopes are bound to a machine id: they open only under the
 * machine this browser itself puts the frame on.
 */
export async function openFrame<T extends object>(frame: T, keys: KeySource, machineOf: MachineOf = () => undefined): Promise<T> {
  const f = frame as unknown as Frame;
  const summaries = summaryLists(f);
  let out: Frame = f;
  if (summaries) {
    if (!summaries.list.some(({ s }) => 'titleE2e' in s || 'cwdE2e' in s)) return frame;
    out = summaries.replace(await Promise.all(summaries.list.map(({ s, machineId }) => openSummary(s, machineId, keys))));
  } else {
    const { frame: opened, jobs } = collectOpen(f, { dir: 'a2c' });
    if (jobs.length === 0) return frame;
    out = opened;
    const machineId = machineOf(f);
    if (machineId === undefined) return frame;
    await Promise.all(
      jobs.map(async (job) => {
        const k = keys.forKid(job.env.kid);
        if (!k) return;
        try {
          job.put(await openJson(k.key, job.env, withMachine(machineId, job.bind)));
        } catch {
          /* wrong key or damaged: the envelope stays, the UI shows the placeholder */
        }
      }),
    );
  }
  return out as unknown as T;
}

async function openSummary(s: Frame, machineId: string | undefined, keys: KeySource): Promise<Frame> {
  if (!('titleE2e' in s) && !('cwdE2e' in s)) return s;
  if (machineId === undefined) return s;
  const { summary, jobs } = collectOpenSummary(s);
  await Promise.all(
    jobs.map(async (job) => {
      const k = keys.forKid(job.env.kid);
      if (!k) return;
      try {
        job.put(await openJson(k.key, job.env, withMachine(machineId, job.bind)));
      } catch {
        /* keep the placeholder */
      }
    }),
  );
  return summary;
}

type SummaryItem = { s: Frame; machineId: string | undefined };

/** Where the session summaries live in the frames that carry them, and which
 *  machine each list belongs to. */
function summaryLists(f: Frame): { list: SummaryItem[]; replace: (next: Frame[]) => Frame } | undefined {
  switch (f['type']) {
    case 'snapshot': {
      const machines = f['machines'];
      if (!Array.isArray(machines)) return undefined;
      const flat: SummaryItem[] = [];
      for (const m of machines as Frame[]) {
        const id = (m['machine'] as Frame | undefined)?.['machineId'];
        for (const s of (m['sessions'] as Frame[] | undefined) ?? []) {
          flat.push({ s, machineId: typeof id === 'string' ? id : undefined });
        }
      }
      return {
        list: flat,
        replace: (next) => {
          let i = 0;
          return {
            ...f,
            machines: (machines as Frame[]).map((m) => ({
              ...m,
              sessions: ((m['sessions'] as Frame[] | undefined) ?? []).map(() => next[i++]),
            })),
          };
        },
      };
    }
    case 'machine_sessions': {
      const machine = f['machine'] as Frame | undefined;
      const id = (machine?.['machine'] as Frame | undefined)?.['machineId'];
      const list = ((machine?.['sessions'] as Frame[] | undefined) ?? []).map((s) => ({
        s,
        machineId: typeof id === 'string' ? id : undefined,
      }));
      return { list, replace: (next) => ({ ...f, machine: { ...machine, sessions: next } }) };
    }
    case 'session_updates': {
      const id = f['machineId'];
      const list = ((f['sessions'] as Frame[] | undefined) ?? []).map((s) => ({
        s,
        machineId: typeof id === 'string' ? id : undefined,
      }));
      return { list, replace: (next) => ({ ...f, sessions: next }) };
    }
    default:
      return undefined;
  }
}

function turnSecret(frame: Frame): Frame | undefined {
  const text = typeof frame['text'] === 'string' ? frame['text'] : typeof frame['message'] === 'string' ? frame['message'] : '';
  const images = Array.isArray(frame['images']) ? frame['images'].length : 0;
  const files = Array.isArray(frame['files'])
    ? (frame['files'] as Frame[]).map((f) => String(f['name'] ?? '')).filter(Boolean)
    : [];
  if (!text && !images && files.length === 0) return undefined;
  return { text, ...(images ? { images } : {}), ...(files.length ? { files } : {}) };
}

const TURN_TYPES = new Set(['input', 'open', 'new_session', 'takeover']);

/** Frames a private machine's content leaves in; the sealing needs a key. */
export async function sealFrame<T extends object>(
  frame: T,
  machineId: string,
  keys: KeySource,
  /** The agent's epoch from the machine's info: what is sealed is good for that one process. */
  epoch: string | undefined,
): Promise<T> {
  const k = keys.latestFor(machineId);
  if (!k) throw new Error('no key for this machine');
  if (!epoch) throw new Error('the machine has not announced its epoch yet');
  const f = frame as unknown as Frame;
  const { frame: sealed, jobs } = collectSeal(f, { dir: 'c2a', epoch });
  const turn = TURN_TYPES.has(String(f['type'])) ? turnSecret(f) : undefined;
  await Promise.all(jobs.map(async (job) => job.put(await sealJson(k.key, k.kid, job.secret, withMachine(machineId, job.bind)))));
  if (turn) sealed['turnE2e'] = await sealJson(k.key, k.kid, turn, withMachine(machineId, TURN_ECHO_BIND));
  return sealed as unknown as T;
}

/** Whether this outgoing frame actually carries something to seal. A bare
 *  `open`, `projects.list` or a history page has nothing secret in it: it goes
 *  as is, so a device without the key still subscribes and shows placeholders. */
export function needsSeal(frame: object): boolean {
  const f = frame as Frame;
  if (!isContentFrame(f['type'])) return false;
  if (f['type'] === 'term_input') return true;
  if (TURN_TYPES.has(String(f['type'])) && turnSecret(f)) return true;
  return collectSeal(f, { dir: 'c2a' }).jobs.length > 0;
}

/** The outgoing frames that carry content and so must be sealed for a private
 *  machine. (`rpc_request` is sealed only for the methods that carry content;
 *  `collectSeal` leaves the rest untouched.) */
export function isContentFrame(type: unknown): boolean {
  return (
    type === 'input' ||
    type === 'open' ||
    type === 'new_session' ||
    type === 'takeover' ||
    type === 'tool_decision' ||
    type === 'set_permission_mode' ||
    type === 'term_input' ||
    type === 'rpc_request'
  );
}

const ROUTING_ONLY = new Set(['cwd', 'model', 'effort', 'permissionMode', 'allow', 'mode', '_k', '_r', '_s', '_m', '_p']);

/** Whether sealing this frame hides something the person wrote or chose to
 *  keep (text, files, a command, an answer's text) - as opposed to a frame that
 *  is only sealed because it is addressed to a keyed machine (a mode switch, a
 *  bare approval, a folder choice). Decides what is held back when the machine
 *  cannot be determined at all. */
export function hasRealContent(frame: object): boolean {
  const f = frame as Frame;
  if (!isContentFrame(f['type'])) return false;
  if (f['type'] === 'term_input') return true;
  return collectSeal(f, { dir: 'c2a' }).jobs.some((j) => isRecord(j.secret) && Object.keys(j.secret).some((k) => !ROUTING_ONLY.has(k)));
}

function isRecord(v: unknown): v is Frame {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
