import { z } from 'zod';

/**
 * Private machine: end-to-end encrypted sessions (docs/E2EE.md).
 *
 * This file is the PURE half, shared by every side that handles envelopes: it
 * knows which fields of which frames are content, how to lift them out into a
 * secret and put them back, and nothing about crypto. The agent (Node
 * `crypto`, synchronous) and the web (WebCrypto, asynchronous) each bring their
 * own cipher; the traversal is written once here as `collectSeal` /
 * `collectOpen`, which return the work to do instead of doing it.
 *
 * The hub never imports this to read content — it must treat an envelope as an
 * opaque value and forward it.
 */

/** AES-256-GCM, 96-bit random nonce, AAD = `kid|machineId|dir|kind|id` (see `bindTag`, `withMachine`). */
export const E2eEnvelope = z.object({
  e2e: z.literal(1),
  /** First 8 bytes of SHA-256(K), hex — which key a ciphertext needs. */
  kid: z.string().min(1).max(64),
  /** base64 nonce (12 bytes). */
  n: z.string().min(1).max(64),
  /** base64 ciphertext || tag. */
  c: z.string().min(1),
});
export type E2eEnvelope = z.infer<typeof E2eEnvelope>;

/** The optional carrier field on a frame: absent when the machine is not private. */
export const E2eField = E2eEnvelope.optional();

/** What a client with no key reads in place of a title. */
export const E2E_PLACEHOLDER_TITLE = 'Зашифровано';

/** What stays in an `error` whose text is sealed. */
export const E2E_PLACEHOLDER_ERROR = 'Зашифровано';

/** Direction of a sealed value: agent to client, or client to agent. An
 *  envelope made for one direction does not open in the other. */
export type E2eDir = 'a2c' | 'c2a';

/**
 * What an envelope is bound to, beyond the key: `dir|kind|id` (the cipher adds
 * `kid|` in front and uses the whole string as AAD). A hub that lifts an
 * envelope off one frame and puts it on another - a different terminal, run,
 * request or message, or the other direction - makes the open fail.
 */
export function bindTag(dir: string, kind: string, id: string): string {
  return `${dir}|${kind}|${id}`;
}

/** A binding that also names the machine: `machineId|dir|kind|id`. The cipher's
 *  AAD is then `kid|machineId|dir|kind|id`, so ciphertext of machine A does not
 *  open as machine B's (a hub that mixes machines up gets «Зашифровано»). */
export function withMachine(machineId: string, bind: string): string {
  return `${machineId}|${bind}`;
}

/** The AAD bytes' text for an envelope. */
export function aadFor(kid: string, bind: string): string {
  return `${kid}|${bind}`;
}

export function isE2eEnvelope(v: unknown): v is E2eEnvelope {
  return E2eEnvelope.safeParse(v).success;
}

/** The pairing code: `hcp1.<machineId>.<base64url(K)>`. */
export interface PairingCode {
  machineId: string;
  /** Raw 32 bytes, base64url, as in the code. */
  key: string;
}

const B64URL = /^[A-Za-z0-9_-]+$/;

export function formatPairingCode(machineId: string, keyB64Url: string): string {
  return `hcp1.${machineId}.${keyB64Url}`;
}

/** Undefined for anything that is not a well-formed code. machineId may itself
 *  contain dots, so the key is the LAST segment. */
export function parsePairingCode(code: string): PairingCode | undefined {
  const s = code.trim();
  if (!s.startsWith('hcp1.')) return undefined;
  const rest = s.slice('hcp1.'.length);
  const dot = rest.lastIndexOf('.');
  if (dot <= 0) return undefined;
  const machineId = rest.slice(0, dot);
  const key = rest.slice(dot + 1);
  // 32 bytes -> 43 base64url chars without padding.
  if (!B64URL.test(key) || key.length !== 43) return undefined;
  return { machineId, key };
}

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** One place in a frame where content lives. */
interface Spec {
  /** Object (inside the frame) holding the fields; the frame itself when absent. */
  at?: string;
  /** Fields that are content. */
  take: readonly string[];
  /** What stays in the clear in their place (the field must still satisfy the
   *  clear-side schema). Fields not listed are removed. */
  blank?: Obj;
  /** Subset of `take` that ALSO stays in the clear as a routing hint (the hub
   *  reads it: the folder to start in, whether a decision allows). The sealed
   *  copy is the truth: on opening it replaces the clear one, and a clear
   *  value next to an envelope is never trusted. */
  routing?: readonly string[];
}

/** Frames whose content fields travel as one envelope in `e2e` (same table both
 *  directions: agent->hub, hub->browser, browser->hub, hub->agent). */
export const FRAME_SPECS: Readonly<Record<string, Spec>> = {
  stream: { at: 'event', take: ['text', 'raw', 'data'] },
  tool_request: { take: ['input', 'title'], blank: { input: {} } },
  tool_decision: { take: ['allow', 'permissionMode', 'updatedInput', 'message'], routing: ['allow'] },
  input: { take: ['text', 'images', 'files'], blank: { text: '' } },
  open: { take: ['message', 'images', 'files'] },
  new_session: {
    take: ['message', 'images', 'files', 'cwd', 'model', 'effort', 'permissionMode'],
    routing: ['cwd', 'model', 'effort', 'permissionMode'],
  },
  set_permission_mode: { take: ['mode'], routing: ['mode'] },
  takeover: { take: ['message', 'images', 'files'] },
  resume: { take: ['message', 'images', 'files'] },
  user_turn: { take: ['text', 'images', 'files'], blank: { text: '' } },
  /** A fatal run error carries event text (the CLI's own words). */
  run_status: { take: ['error'] },
  term_data: { take: ['data'], blank: { data: '' } },
  term_input: { take: ['data'], blank: { data: '' } },
};

/** Each history message: blocks + the turn's time + model. `type` and `uuid`
 *  stay clear — the hub keys the replica by uuid. */
const MESSAGE_SPEC: Spec = { take: ['blocks', 'ts', 'model'], blank: { blocks: [] } };

/** RPC methods whose result is NOT content and stays in the clear (the hub or
 *  the picker reads it). Every other method's result is sealed whole - an
 *  allow-list of what is secret would leak every method nobody remembered. A
 *  plain `{ok:true}` is clear too (see `isClearRpcResult`). */
export const RPC_CLEAR_RESULT: ReadonlySet<string> = new Set(['models.list']);

/** True when an ok result carries nothing worth sealing. */
export function isClearRpcResult(method: string, result: unknown): boolean {
  if (RPC_CLEAR_RESULT.has(method)) return true;
  if (!isObj(result)) return false;
  const keys = Object.keys(result);
  return keys.length === 1 && keys[0] === 'ok' && result['ok'] === true;
}

/** RPC methods whose result is `{messages}` sealed message by message. */
export const RPC_MESSAGE_RESULT: ReadonlySet<string> = new Set(['session.messages', 'session.subagent']);

/** True when an `ok` rpc_response carries content in the clear that the agent
 *  of a keyed machine would have sealed (mirror of the `rpc_response` branch of
 *  `collectSeal`): such a result is the hub's own invention and must not be
 *  shown. Clear errors are not judged here — the hub answers some itself. */
export function clearRpcContent(method: string, frame: Record<string, unknown>): boolean {
  if (frame['ok'] !== true || frame['result'] === undefined) return false;
  const result = frame['result'];
  if (isClearRpcResult(method, result)) return false;
  if (RPC_MESSAGE_RESULT.has(method) && isObj(result) && Array.isArray(result['messages'])) {
    // A sealed message keeps only its routing next to the envelope (`blocks`
    // blanked to []); an unsealed one carries none of the sealed fields at
    // all. Anything else beside an envelope is clear text the hub added, which
    // would survive an envelope that does not open.
    return result['messages'].some((m) => {
      if (!isObj(m)) return false;
      if (!isObj(m['e2e'])) return MESSAGE_SPEC.take.some((k) => m[k] !== undefined);
      const blocks = m['blocks'];
      return (
        m['ts'] !== undefined || m['model'] !== undefined || (blocks !== undefined && !(Array.isArray(blocks) && blocks.length === 0))
      );
    });
  }
  return !(isObj(result) && isE2eEnvelope(result['e2e']) && Object.keys(result).length === 1);
}

/** Params of these methods that are content (everything else - cwd, path,
 *  ids, offsets - stays in the clear: the hub gates on them). */
export const RPC_SEALED_PARAMS: Readonly<Record<string, readonly string[]>> = {
  'fs.write': ['content'],
  'fs.upload.chunk': ['data'],
  'git.commit': ['message'],
  'git.pr.create': ['title', 'body'],
  'session.rename': ['title'],
  'runtime.login.input': ['code'],
  // The gateway key goes into the machine's config: a private machine's hub must not see it,
  // nor flip gateway/own or the model behind the person's back - every param is sealed.
  'runtime.codex.provider': ['mode', 'apiKey', 'model', 'effort'],
};

/** Clear rpc params that tell WHAT a sealed request does to WHERE. They stay in
 *  the clear (the hub gates on them) and are also repeated inside the secret, so
 *  a hub that rewrites them, or turns the method into another, is caught. */
export const RPC_BOUND_PARAMS: readonly string[] = ['cwd', 'path', 'dir', 'name', 'uploadId', 'from', 'to', 'sessionId'];

/** A unit of crypto work found in a frame. */
export interface SealJob {
  secret: unknown;
  /** `dir|kind|id` - what the envelope is bound to (see `bindTag`). */
  bind: string;
  put: (env: E2eEnvelope) => void;
}
export interface OpenJob {
  env: E2eEnvelope;
  /** `dir|kind|id` the envelope must have been sealed for. */
  bind: string;
  /** Refuse an opened secret that was made for something else (see `checkOpened`). */
  check?: (secret: unknown, ctx?: CheckContext) => string | undefined;
  put: (secret: unknown) => void;
}

function present(o: Obj, k: string): boolean {
  return o[k] !== undefined;
}

/** Lift `spec.take` out of `holder` into a secret; leave `spec.blank` behind. */
function takeFrom(holder: Obj, spec: Spec): { secret: Obj; holder: Obj } | undefined {
  const secret: Obj = {};
  let any = false;
  for (const k of spec.take) {
    if (present(holder, k)) {
      secret[k] = holder[k];
      any = true;
    }
  }
  if (!any) return undefined;
  const next: Obj = { ...holder };
  for (const k of spec.take) if (!spec.routing?.includes(k)) delete next[k];
  if (spec.blank) {
    for (const [k, v] of Object.entries(spec.blank)) {
      if (k in secret) next[k] = v;
    }
  }
  return { secret, holder: next };
}

/** Put an opened secret back. EVERY content field is first dropped from the
 *  holder: whatever a hub left in the clear next to an envelope must not
 *  survive into the opened frame (the envelope's content replaces it, and a
 *  field the secret does not hold goes back to its clear-side blank). */
function putInto(holder: Obj, secret: unknown, spec: Spec): Obj {
  const next: Obj = { ...holder };
  delete next['e2e'];
  for (const k of spec.take) delete next[k];
  const s = isObj(secret) ? secret : {};
  for (const k of spec.take) if (k in s) next[k] = s[k];
  if (spec.blank) {
    for (const [k, v] of Object.entries(spec.blank)) if (!(k in s)) next[k] = v;
  }
  return next;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** Frames that start or carry a person's turn. The hub turns `open` into an
 *  `input` (a run already exists) or a `resume`/`takeover`, and `new_session`
 *  has no id yet, so they share ONE binding (`turn`, no id); what each envelope
 *  is for is carried inside it (`_k`, `_r`, `_s`, see `checkOpened`). */
const TURN_TYPES = new Set(['input', 'open', 'new_session', 'takeover', 'resume']);

/** Frames whose secret carries `_k`/`_r`/`_s` and is checked on opening. */
const META_TYPES = new Set([...TURN_TYPES, 'tool_decision', 'set_permission_mode']);

/** Commands that carry the person's choice itself (which folder, which answer,
 *  which mode): on a private machine the agent takes them only from a sealed
 *  envelope. */
export const SEALED_COMMANDS: ReadonlySet<string> = new Set(['new_session', 'tool_decision', 'set_permission_mode']);

/** The binding of `turnE2e` / `user_turn`: the echo of a turn for other
 *  screens. No epoch (screens do not know it per run); display only. */
export const TURN_ECHO_BIND = bindTag('c2a', 'turnecho', '');

/** The `dir|kind|id` binding of a frame's envelope. The same function runs on
 *  the agent and the web, so both compute the same string. `epoch` is the
 *  agent's per-process random id: a client-to-agent envelope is good for ONE
 *  agent process, so nothing recorded before a restart can be replayed after it. */
export function frameBind(dir: E2eDir, frame: Obj, epoch?: string): string {
  const type = str(frame['type']);
  if (type === 'user_turn') return TURN_ECHO_BIND;
  const d = dir === 'c2a' && epoch ? `c2a:${epoch}` : dir;
  if (TURN_TYPES.has(type)) return bindTag(d, 'turn', '');
  switch (type) {
    case 'stream':
    case 'run_status':
    case 'set_permission_mode':
      return bindTag(d, type, str(frame['runId']));
    case 'tool_request':
    case 'tool_decision':
      return bindTag(d, type, str(frame['requestId']));
    case 'term_data':
    case 'term_input':
      return bindTag(d, type, str(frame['termId']));
    case 'rpc_request':
    case 'rpc_response':
      return bindTag(d, 'rpc', str(frame['requestId']));
    default:
      return bindTag(d, type, '');
  }
}

/** Frame types an opened `_k` may say, per the frame it arrives as. */
const KINDS_FOR: Readonly<Record<string, readonly string[]>> = {
  input: ['input', 'open'],
  resume: ['open', 'takeover'],
  takeover: ['open', 'takeover'],
  new_session: ['new_session'],
  tool_decision: ['tool_decision'],
  set_permission_mode: ['set_permission_mode'],
};

/** An rpc_request's sealed secret must say the method and the clear params the
 *  agent received. */
export function checkRpcSecret(frame: Obj, secret: unknown): string | undefined {
  if (!isObj(secret)) return 'the sealed request is malformed';
  if (secret['_m'] !== frame['method']) return 'the sealed request was made for another method';
  const sealed = secret['_p'];
  const params = isObj(frame['params']) ? frame['params'] : {};
  if (!isObj(sealed)) return 'the sealed request does not say where it applies';
  for (const k of RPC_BOUND_PARAMS) {
    if (JSON.stringify(sealed[k]) !== JSON.stringify(params[k])) return `the sealed request was made for another ${k}`;
  }
  return undefined;
}

export interface CheckContext {
  /** The session a live run belongs to, if the agent knows it. */
  sessionOfRun?: (runId: string) => string | undefined;
}

/**
 * What the opened secret says it is FOR must match the frame it arrived in:
 * a hub can reroute a genuine, unused envelope (it is the one carrying it), so
 * the sealed `_k` (frame kind), `_r` (run) and `_s` (session) are compared with
 * what the agent got, and the choices that must come from the person (folder,
 * answer, mode) must be IN the secret. Returns a refusal reason, or undefined.
 */
export function checkOpened(frame: Obj, secret: unknown, ctx: CheckContext = {}): string | undefined {
  const type = str(frame['type']);
  if (!META_TYPES.has(type)) return undefined;
  if (!isObj(secret)) return 'the sealed command is malformed';
  const kinds = KINDS_FOR[type] ?? [type];
  if (typeof secret['_k'] !== 'string' || !kinds.includes(secret['_k'])) {
    return `the sealed command was made for another kind of frame, not ${type}`;
  }
  const r = secret['_r'];
  if (typeof r === 'string' && typeof frame['runId'] === 'string' && r !== frame['runId']) {
    return 'the sealed command was made for another run';
  }
  const sid = secret['_s'];
  if (typeof sid === 'string') {
    if (typeof frame['sessionId'] === 'string' && sid !== frame['sessionId']) return 'the sealed command was made for another session';
    const run = typeof frame['runId'] === 'string' ? ctx.sessionOfRun?.(frame['runId']) : undefined;
    if (run !== undefined && run !== '' && run !== sid) return 'the sealed command was made for another session';
  }
  if (type === 'new_session' && typeof secret['cwd'] !== 'string') return 'new_session carries no sealed folder';
  if (type === 'tool_decision' && typeof secret['allow'] !== 'boolean') return 'tool_decision carries no sealed answer';
  if (type === 'set_permission_mode' && typeof secret['mode'] !== 'string') return 'set_permission_mode carries no sealed mode';
  return undefined;
}

/** A history message is bound to its uuid, whichever frame carries it (a sync
 *  chunk, a mirror, an rpc page): the replica serves the same bytes in all. */
function messageBind(m: Obj): string {
  return bindTag('a2c', 'msg', str(m['uuid']));
}

/** A clear-side check for the receiving agent: the name of the first content
 *  field `frame` carries in the clear (a content field that is not its blank).
 *  Run on the frame AS RECEIVED, before any envelope is opened: next to an
 *  envelope, clear content is a hub trying to add to what the person sealed. */
export function clearContentIn(frame: Obj): string | undefined {
  const type = str(frame['type']);
  if (type === 'rpc_request') {
    const fields = RPC_SEALED_PARAMS[str(frame['method'])];
    const params = frame['params'];
    if (fields && isObj(params) && fields.some((f) => params[f] !== undefined)) return str(frame['method']);
    return undefined;
  }
  const spec = FRAME_SPECS[type];
  if (!spec || spec.at) return undefined;
  for (const k of spec.take) {
    if (spec.routing?.includes(k)) continue;
    const v = frame[k];
    if (v === undefined || v === null) continue;
    const blank = spec.blank && k in spec.blank ? spec.blank[k] : undefined;
    if (blank !== undefined && JSON.stringify(v) === JSON.stringify(blank)) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    if (v === '') continue;
    return type === 'term_input' ? 'terminal input' : type;
  }
  return undefined;
}

function frameSpec(type: unknown): Spec | undefined {
  return typeof type === 'string' ? FRAME_SPECS[type] : undefined;
}

export interface SealContext {
  /** Which way the frame travels: decides the binding. */
  dir: E2eDir;
  /** The agent's epoch (client-to-agent frames only). */
  epoch?: string;
  /** For `rpc_response`: the method this answers. */
  method?: string;
}

/**
 * Plan the sealing of an outgoing frame. Returns the frame with content
 * replaced by its clear-side blanks plus the jobs that must each be sealed and
 * `put` back (`put` mutates the returned frame, so run every job before
 * sending). `undefined` frame result = nothing to seal.
 */
export function collectSeal(frame: Obj, ctx: SealContext): { frame: Obj; jobs: SealJob[] } {
  const jobs: SealJob[] = [];
  let out: Obj = { ...frame };
  const type = frame['type'];
  const bind = frameBind(ctx.dir, frame, ctx.epoch);

  const sealHolder = (holder: Obj, spec: Spec, store: (next: Obj) => void) => {
    const taken = takeFrom(holder, spec);
    if (!taken) return;
    store(taken.holder);
    if (typeof type === 'string' && META_TYPES.has(type)) {
      taken.secret['_k'] = type;
      if (typeof frame['runId'] === 'string') taken.secret['_r'] = frame['runId'];
      if (typeof frame['sessionId'] === 'string') taken.secret['_s'] = frame['sessionId'];
    }
    jobs.push({
      secret: taken.secret,
      bind,
      put: (env) => {
        taken.holder['e2e'] = env;
      },
    });
  };

  if (type === 'rpc_response') {
    const m = ctx.method ?? '';
    if (frame['ok'] === true && frame['result'] !== undefined) {
      const result = frame['result'];
      if (isClearRpcResult(m, result)) {
        // not content: the hub or the picker reads it
      } else if (RPC_MESSAGE_RESULT.has(m) && isObj(result) && Array.isArray(result['messages'])) {
        const r2: Obj = { ...result };
        r2['messages'] = sealMessages(result['messages'], jobs);
        out['result'] = r2;
      } else {
        // Every other method, known or not: the whole result is the secret.
        const holder: Obj = {};
        out['result'] = holder;
        jobs.push({
          secret: result,
          bind,
          put: (env) => {
            holder['e2e'] = env;
          },
        });
      }
    } else if (frame['ok'] === false && typeof frame['error'] === 'string' && frame['error'] !== '') {
      // An error says what was asked ("no such file: ...", a command's output).
      const error = frame['error'];
      out['error'] = E2E_PLACEHOLDER_ERROR;
      jobs.push({
        secret: { error },
        bind,
        put: (env) => {
          out['e2e'] = env;
        },
      });
    }
    return { frame: out, jobs };
  }

  if (type === 'rpc_request') {
    const fields = RPC_SEALED_PARAMS[String(frame['method'])];
    if (fields && isObj(frame['params'])) {
      const params = frame['params'];
      sealHolder(params, { take: fields }, (next) => {
        out['params'] = next;
      });
      const job = jobs[jobs.length - 1];
      if (job && isObj(job.secret)) {
        job.secret['_m'] = String(frame['method']);
        const bound: Obj = {};
        for (const k of RPC_BOUND_PARAMS) if (params[k] !== undefined) bound[k] = params[k];
        job.secret['_p'] = bound;
      }
    }
    return { frame: out, jobs };
  }

  if (type === 'session_sync_chunk' || type === 'mirror_data') {
    if (Array.isArray(frame['messages'])) out['messages'] = sealMessages(frame['messages'], jobs);
    return { frame: out, jobs };
  }

  const spec = frameSpec(type);
  if (!spec) return { frame: out, jobs };
  if (spec.at) {
    const inner = frame[spec.at];
    if (isObj(inner)) {
      sealHolder(inner, spec, (next) => {
        out[spec.at as string] = next;
      });
    }
  } else {
    sealHolder(frame, spec, (next) => {
      out = next;
    });
  }
  return { frame: out, jobs };
}

function sealMessages(messages: unknown[], jobs: SealJob[]): unknown[] {
  return messages.map((m) => {
    if (!isObj(m) || isObj(m['e2e'])) return m;
    const taken = takeFrom(m, MESSAGE_SPEC);
    if (!taken) return m;
    jobs.push({
      secret: taken.secret,
      bind: messageBind(m),
      put: (env) => {
        taken.holder['e2e'] = env;
      },
    });
    return taken.holder;
  });
}

/**
 * Plan the opening of an incoming frame: every envelope found, and where its
 * content goes back. The returned frame is a copy; run every job (each `put`
 * mutates it) before using it. A frame with no envelopes has no jobs. `dir` is
 * the direction the frame was SEALED for (the agent opens `c2a`, the web `a2c`).
 */
export function collectOpen(frame: Obj, ctx: { dir: E2eDir; epoch?: string }): { frame: Obj; jobs: OpenJob[] } {
  const jobs: OpenJob[] = [];
  let out: Obj = { ...frame };
  const type = frame['type'];
  const bind = frameBind(ctx.dir, frame, ctx.epoch);

  const openHolder = (
    holder: Obj,
    spec: Spec,
    store: (next: Obj) => void,
    rpcCheck?: (secret: unknown) => string | undefined,
  ) => {
    const env = holder['e2e'];
    if (!isE2eEnvelope(env)) return;
    const next: Obj = { ...holder };
    store(next);
    jobs.push({
      env,
      bind,
      check: rpcCheck ?? (typeof type === 'string' && META_TYPES.has(type) ? (secret, c) => checkOpened(frame, secret, c) : undefined),
      put: (secretIn) => {
        let secret = secretIn;
        // A browser's `open` with a first message reaches the agent as an
        // `input` when the session already has a run: its `message` is the text.
        if (type === 'input' && isObj(secret) && secret['_k'] === 'open' && typeof secret['message'] === 'string') {
          secret = { ...secret, text: secret['message'] };
        }
        // Replace, not merge: see putInto.
        const merged = putInto(next, secret, spec);
        for (const k of Object.keys(next)) delete next[k];
        Object.assign(next, merged);
      },
    });
  };

  if (type === 'rpc_response') {
    const result = frame['result'];
    if (isObj(result)) {
      if (isE2eEnvelope(result['e2e'])) {
        jobs.push({
          env: result['e2e'] as E2eEnvelope,
          bind,
          put: (secret) => {
            out['result'] = secret;
          },
        });
      } else if (Array.isArray(result['messages'])) {
        const r2: Obj = { ...result };
        r2['messages'] = openMessages(result['messages'], jobs);
        out['result'] = r2;
      }
    }
    if (isE2eEnvelope(frame['e2e'])) {
      jobs.push({
        env: frame['e2e'] as E2eEnvelope,
        bind,
        put: (secret) => {
          if (isObj(secret) && typeof secret['error'] === 'string') out['error'] = secret['error'];
          delete out['e2e'];
        },
      });
    }
    return { frame: out, jobs };
  }

  if (type === 'rpc_request') {
    if (isObj(frame['params'])) {
      const fields = RPC_SEALED_PARAMS[String(frame['method'])] ?? [];
      openHolder(
        frame['params'],
        { take: fields },
        (next) => {
          out['params'] = next;
        },
        (secret) => checkRpcSecret(frame, secret),
      );
    }
    return { frame: out, jobs };
  }

  if (type === 'session_sync_chunk' || type === 'mirror_data') {
    if (Array.isArray(frame['messages'])) out['messages'] = openMessages(frame['messages'], jobs);
    return { frame: out, jobs };
  }

  const spec = frameSpec(type);
  if (!spec) return { frame: out, jobs };
  if (spec.at) {
    const inner = frame[spec.at];
    if (isObj(inner)) {
      openHolder(inner, spec, (next) => {
        out[spec.at as string] = next;
      });
    }
  } else {
    openHolder(frame, spec, (next) => {
      out = next;
    });
  }
  return { frame: out, jobs };
}

function openMessages(messages: unknown[], jobs: OpenJob[]): unknown[] {
  return messages.map((m) => {
    if (!isObj(m) || !isE2eEnvelope(m['e2e'])) return m;
    const next: Obj = { ...m };
    jobs.push({
      env: m['e2e'] as E2eEnvelope,
      bind: messageBind(m),
      put: (secret) => {
        const merged = putInto(next, secret, MESSAGE_SPEC);
        for (const k of Object.keys(next)) delete next[k];
        Object.assign(next, merged);
      },
    });
    return next;
  });
}

/** True when a frame (or the sessions it lists) carries something to open - a
 *  cheap pre-check so the common case skips the traversal. */
export function mayCarryE2e(raw: string): boolean {
  return raw.includes('"e2e"') || raw.includes('"titleE2e"') || raw.includes('"cwdE2e"');
}

// ---- Session summaries -----------------------------------------------------

/** The part of a summary that is content, sealed in two envelopes. */
export interface SummaryLike extends Obj {
  title?: string;
  cwd?: string;
  project?: string;
  gitBranch?: string;
}

/** Plan sealing a summary: title -> titleE2e, cwd/project/gitBranch -> cwdE2e. */
export function collectSealSummary<T extends SummaryLike>(s: T): { summary: T; jobs: SealJob[] } {
  const out: Obj = { ...s };
  const jobs: SealJob[] = [];
  if (typeof s.title === 'string' && s.title !== E2E_PLACEHOLDER_TITLE) {
    jobs.push({
      secret: s.title,
      bind: bindTag('a2c', 'title', str(s['sessionId'])),
      put: (env) => {
        out['titleE2e'] = env;
      },
    });
    out['title'] = E2E_PLACEHOLDER_TITLE;
  }
  const where: Obj = {};
  for (const k of ['cwd', 'project', 'gitBranch'] as const) {
    if (s[k] !== undefined) where[k] = s[k];
  }
  if (Object.keys(where).length > 0) {
    jobs.push({
      secret: where,
      bind: bindTag('a2c', 'cwd', str(s['sessionId'])),
      put: (env) => {
        out['cwdE2e'] = env;
      },
    });
    delete out['cwd'];
    delete out['project'];
    delete out['gitBranch'];
  }
  return { summary: out as T, jobs };
}

/** Plan opening a summary's envelopes. */
export function collectOpenSummary<T extends Obj>(s: T): { summary: T; jobs: OpenJob[] } {
  const out: Obj = { ...s };
  const jobs: OpenJob[] = [];
  if (isE2eEnvelope(s['titleE2e'])) {
    jobs.push({
      env: s['titleE2e'] as E2eEnvelope,
      bind: bindTag('a2c', 'title', str(s['sessionId'])),
      put: (secret) => {
        if (typeof secret === 'string') out['title'] = secret;
        delete out['titleE2e'];
      },
    });
  }
  if (isE2eEnvelope(s['cwdE2e'])) {
    jobs.push({
      env: s['cwdE2e'] as E2eEnvelope,
      bind: bindTag('a2c', 'cwd', str(s['sessionId'])),
      put: (secret) => {
        if (isObj(secret)) {
          for (const k of ['cwd', 'project', 'gitBranch']) if (typeof secret[k] === 'string') out[k] = secret[k];
        }
        delete out['cwdE2e'];
      },
    });
  }
  return { summary: out as T, jobs };
}
