/**
 * Secrets out of what the agent sends the hub about a session.
 *
 * The hub keeps every synced transcript forever (`session_messages`), in
 * plaintext, and shows it to everyone who can see the session. A transcript is
 * mostly tool output: `cat .env`, a `curl -H "Authorization: Bearer …"`, a
 * config file read to debug it. The runtime needed those bytes; the hub's copy
 * does not. So the four things that carry session content leave with
 * secret-shaped values masked (`maskSecrets`):
 *
 *   stream               the live turn (text, data, raw SDK message)
 *   session_sync_chunk   the replica the hub keeps
 *   mirror_data          a live view of a session run elsewhere
 *   session_sync_begin   the summary (its title is often the first prompt)
 *   inventory            the same titles, every tick
 *
 * plus the `session.messages` RPC answer (client.ts, handleRpc).
 *
 * NOT touched, on purpose:
 * - `tool_request`: clients echo its `input` back as `updatedInput`; a masked
 *   command would run with `‹masked›` in it.
 * - terminal output, `fs.read`/`fs.download`: the owner asked for exactly those
 *   bytes, and masking a file on its way to an editor would corrupt it on save.
 * - the transcript on disk: it is the runtime's, and single-writer.
 *
 * Known gap: `partial` events are the model's own text in deltas, so a secret
 * the MODEL types can straddle two of them and pass unmasked to live viewers.
 * Nothing stores partials; the final `assistant` event and the replica are
 * masked whole. Tool output never travels as a partial.
 *
 * Also left verbatim, and not a secret-free zone:
 * - `memory_push` — the content is synced back to other machines by sha, a
 *   mask would be written to their disks;
 * - `tool_request.input` in approval mode — a Bash command with a header in
 *   it reaches the hub (and the Telegram bot) as the person will approve it.
 *
 * This is a net, not a proof — it catches the shapes secrets usually have.
 * `CC_REMOTE_REDACT=0` switches it off on a machine whose owner wants the
 * hub copy verbatim.
 */
import type { AgentToCentral, HistoryMessage } from '@cc-remote/shared';
import { maskSecrets } from './secret-mask.js';

export function redactionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['CC_REMOTE_REDACT'] !== '0';
}

/** Keys whose values are identifiers or structure, never free text. */
const SKIP_KEYS = new Set([
  'id',
  'uuid',
  'parentUuid',
  'sessionId',
  'session_id',
  'runId',
  'requestId',
  'toolUseId',
  'tool_use_id',
  'parent_tool_use_id',
  'type',
  'kind',
  'name',
  'model',
  'role',
  'media_type',
  'ref',
  // Paths come back to the agent as RPC parameters (a click on an Edit opens
  // the file): a masked one would name a file that does not exist.
  'file_path',
  'path',
  'cwd',
  'notebook_path',
]);

/** Past this, a string is masked in newline-aligned slices: one hostile or
 *  merely huge tool result must not hold the event loop in a single call. */
const SLICE = 128 * 1024;

function maskLong(text: string): string {
  if (text.length <= 2 * SLICE) return maskSecrets(text);
  let out = '';
  for (let at = 0; at < text.length; ) {
    let end = Math.min(text.length, at + SLICE);
    const nl = text.lastIndexOf('\n', end);
    if (end < text.length && nl > at) end = nl + 1;
    out += maskSecrets(text.slice(at, end));
    at = end;
  }
  return out;
}

/** A string this long with no whitespace is payload (base64, minified), not text. */
const OPAQUE_BLOB = /^[A-Za-z0-9+/=_-]{4096,}$/;

function isBinarySource(obj: Record<string, unknown>): boolean {
  return obj['type'] === 'base64' || typeof obj['media_type'] === 'string';
}

/**
 * Deep copy with every free-text string masked. Only strings that changed are
 * replaced, and objects are copied only on the way to a change, so the common
 * case (nothing secret) allocates little.
 */
export function redactValue<T>(value: T, key?: string): T {
  if (typeof value === 'string') {
    if (key && SKIP_KEYS.has(key)) return value;
    if (value.length < 8 || OPAQUE_BLOB.test(value)) return value;
    return maskLong(value) as T;
  }
  if (Array.isArray(value)) {
    let out: unknown[] | undefined;
    value.forEach((item, i) => {
      const next = redactValue(item);
      if (next !== item) (out ??= value.slice())[i] = next;
    });
    return (out ?? value) as T;
  }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const binary = isBinarySource(obj);
    let out: Record<string, unknown> | undefined;
    for (const [k, v] of Object.entries(obj)) {
      // Image bytes: a token regex could match inside base64 and corrupt them.
      if (binary && k === 'data') continue;
      const next = redactValue(v, k);
      if (next !== v) (out ??= { ...obj })[k] = next;
    }
    return (out ?? value) as T;
  }
  return value;
}

export function redactMessages(messages: HistoryMessage[]): HistoryMessage[] {
  return redactValue(messages);
}

/** The outgoing frame with session content masked; any other frame as is. */
export function redactOutgoing(msg: AgentToCentral): AgentToCentral {
  switch (msg.type) {
    case 'stream':
      // Partials are the model typing, a few characters each: masking a delta
      // catches nothing (see the gap above) and costs on every keystroke.
      return msg.event.kind === 'partial' ? msg : { ...msg, event: redactValue(msg.event) };
    case 'inventory':
      // The same title as session_sync_begin — often the first prompt — on
      // every inventory tick.
      return { ...msg, sessions: msg.sessions.map((x) => ({ ...x, title: maskSecrets(x.title) })) };
    case 'session_sync_chunk':
    case 'mirror_data':
      return { ...msg, messages: redactMessages(msg.messages) };
    case 'session_sync_begin':
      return { ...msg, summary: { ...msg.summary, title: maskSecrets(msg.summary.title) } };
    default:
      return msg;
  }
}
