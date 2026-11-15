import type { Enrichment, HistoryMessage } from '@cc-remote/shared';
import type { TranscriptLine } from '../central-reducers.js';
import { parseToolLine, stripCitations, stripHarnessNoise } from './Blocks.js';

/**
 * The INSTANT layer of turn enrichment: pure text heuristics that turn a
 * closing question into one-tap answers before the hub's LLM pass lands (or
 * instead of it, on a hub with no gateway configured). Deliberately narrow: it
 * only ever produces a Да / Нет pair of `answer` buttons. A next step, and an idea worth having,
 * need understanding of what the turn DID — guessing those from sentence shape
 * would put confident nonsense on the screen, so that half belongs to the model.
 */

const clip = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`);

/** A question that opens with one of these is not a yes/no question, and
 *  generic [Да]/[Нет] under it would read as the UI not listening. A set over
 *  the first word rather than a `\b` regex: JS word boundaries only know
 *  `[A-Za-z0-9_]`, so `\b` after a Cyrillic word simply never matches. */
const OPEN_WORDS = new Set([
  'что', 'чем', 'как', 'какой', 'какая', 'какое', 'какие', 'каким', 'какую',
  'где', 'куда', 'откуда', 'почему', 'зачем', 'сколько', 'когда', 'кто', 'кому',
  'which', 'what', 'how', 'where', 'why', 'when', 'who',
]);
const opensWide = (sentence: string): boolean => {
  const first = sentence.split(/\s+/)[0]?.toLowerCase().replace(/[^\p{L}]/gu, '') ?? '';
  return OPEN_WORDS.has(first);
};

/**
 * Quick replies for the question a turn ends with, or null when the turn does
 * not end with one the rules understand. Feed it CLEAN text (stripHarnessNoise
 * + stripCitations) — markers would leak into button labels.
 *
 * Only a plain Да / Нет, label === send. It used to also split «X или Y?» and
 * turn a list above the question into a button per item; both clipped the label
 * to 40 characters and sent the WHOLE item or sentence, so the button said one
 * thing and sent another (owner complaint, 13.10.2026). Whatever a button shows
 * is exactly what it sends.
 */
export function heuristicEnrichment(text: string): Enrichment | null {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (!lines.length) return null;
  // The LAST line must end with the question: one buried mid-turn is one the
  // agent already moved past, and answering it now would answer the wrong thing.
  const last = lines[lines.length - 1]!.replace(/[*_`]/g, '').trim();
  if (!last.endsWith('?') || last.length > 200) return null;
  // The question is the last sentence of that line.
  const sentence = last.split(/(?<=[.!?])\s+/).pop()!.replace(/\?+$/, '').trim();
  if (!sentence) return null;

  // An open question has no guessable answers — better no buttons than wrong
  // ones. Anything else reads as yes/no; the LLM pass upgrades the bare «Да»
  // to a properly conjugated «Да, раскатывай» when it lands.
  if (opensWide(sentence)) return null;
  return {
    quickReplies: [
      { label: 'Да', send: 'Да' },
      { label: 'Нет', send: 'Нет' },
    ],
  };
}

/**
 * Fold the LLM's answer over the heuristic one.
 *
 * The model's answer is FINAL when there is one — including an empty one. It
 * sees the whole turn and says so when the agent stopped mid-work or nothing
 * is worth a tap; putting Да/Нет back under that verdict is the noise this
 * layer used to add. The heuristic stands only where the model could not
 * speak at all: no gateway on this hub (`llm === null`) or a failed call —
 * `undefined` here, passed by the caller as "no answer to fold".
 */
export function mergeEnrichment(heuristic: Enrichment | null, llm: Enrichment | null): Enrichment | null {
  if (!llm) return heuristic;
  return llm.quickReplies?.length
    ? { quickReplies: llm.quickReplies, ...(llm.handoff ? { handoff: llm.handoff } : {}) }
    : null;
}

/** A short stable key for a turn's text (FNV-1a) — the dedup key for asking. */
export function textKey(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `${text.length}:${(h >>> 0).toString(36)}`;
}

// ---- the digest: what the turn DID ------------------------------------------

type DigestEntry =
  | { role: 'user'; text: string }
  | { role: 'assistant'; text: string }
  | { role: 'tool'; text: string }
  | { role: 'error'; text: string };

const oneLine = (s: string, max: number): string => clip(s.replace(/\s+/g, ' ').trim(), max);

/** The tail of a path — enough to name the file without a worktree prefix. */
const shortPath = (p: string): string => {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts.slice(-3).join('/') || p;
};

/**
 * One tool call as a line the model can reason about: «did it deploy?», «did
 * it run the tests?», «is something still in the background?». Fuller than a
 * transcript pill (the whole command, the path's tail) and still one line.
 */
export function describeCall(name: string, input: unknown): string {
  const o = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const str = (k: string) => (typeof o[k] === 'string' ? (o[k] as string) : undefined);
  const bg = o['run_in_background'] === true ? ' [in background]' : '';
  if (name === '$') return `$ ${oneLine(str('command') ?? '', 200)}`;
  const cmd = str('command');
  if (cmd) return `${name}: ${oneLine(cmd, 200)}${bg}`;
  const file = str('file_path') ?? str('notebook_path') ?? str('path');
  if (file) return `${name} ${shortPath(file)}`;
  const desc = str('description');
  if (desc) {
    const who = str('subagent_type');
    return `${name}${who ? `(${who})` : ''}: ${oneLine(desc, 160)}${bg}`;
  }
  const what = str('pattern') ?? str('url') ?? str('query') ?? str('skill') ?? str('prompt');
  if (what) return `${name} ${oneLine(what, 160)}`;
  if (typeof input === 'string') return `${name} ${oneLine(input, 160)}`;
  const json = JSON.stringify(input ?? {});
  return json && json !== '{}' ? `${name} ${oneLine(json, 120)}` : name;
}

const clean = (t: string) => stripCitations(stripHarnessNoise(t)).trim();

function historyEntries(history: HistoryMessage[]): DigestEntry[] {
  const out: DigestEntry[] = [];
  for (const m of history) {
    for (const b of m.blocks) {
      if (b.kind === 'text') {
        // A `<task-notification>` arrives as a USER row and is machinery;
        // stripped, it is empty and must not read as the person speaking.
        const text = clean(b.text);
        if (!text) continue;
        if (m.type === 'user') out.push({ role: 'user', text });
        else if (m.type === 'assistant') out.push({ role: 'assistant', text });
      } else if (b.kind === 'tool_use') {
        out.push({ role: 'tool', text: describeCall(b.name, b.input) });
      } else if (b.kind === 'tool_result' && b.isError) {
        out.push({ role: 'error', text: oneLine(b.text, 240) });
      }
    }
  }
  return out;
}

function liveEntries(lines: TranscriptLine[]): DigestEntry[] {
  const out: DigestEntry[] = [];
  for (const l of lines) {
    if (l.kind === 'user') {
      const text = clean(l.text);
      if (text) out.push({ role: 'user', text });
    } else if (l.kind === 'assistant') {
      const text = clean(l.text);
      if (text) out.push({ role: 'assistant', text });
    } else if (l.kind === 'tool_use') {
      const { name, input } = parseToolLine(l.text);
      out.push({ role: 'tool', text: describeCall(name, input) });
    } else if (l.kind === 'error') {
      out.push({ role: 'error', text: oneLine(l.text, 240) });
    }
  }
  return out;
}

const DIGEST_BUDGET = 12_000;
const MAX_ACTIONS = 60;

/**
 * What the suggestion model reads besides the final message: who asked for
 * what, every action the agent took since, every error it hit, and a little of
 * the conversation before. The final assistant message is NOT in here — it
 * travels as `text`, and the hub puts it last, where the handoff is judged.
 *
 * `history` is the file's messages, `live` the stream lines ahead of it (the
 * run just went idle and the refetch has not landed). Returns undefined when
 * there is nothing beyond the final message to say.
 */
export function buildTurnDigest(
  history: HistoryMessage[],
  live: TranscriptLine[],
  opts: { cwd?: string } = {},
): string | undefined {
  const all = [...historyEntries(history), ...liveEntries(live)];
  // The final assistant message is the tail itself — it goes separately.
  let end = all.length;
  while (end > 0 && all[end - 1]!.role === 'assistant') end--;
  const lastUser = all.slice(0, end).map((e) => e.role).lastIndexOf('user');
  const turn = all.slice(lastUser + 1, end);
  const ask = lastUser >= 0 ? all[lastUser]!.text : undefined;
  const before = lastUser >= 0 ? all.slice(0, lastUser) : [];
  if (!ask && !turn.length) return undefined;

  // Actions, with runs of the same line collapsed («Read ×4») and the middle of
  // a very long turn elided — its start says what it set out to do, its end
  // what state it left things in.
  const acts: string[] = [];
  for (const e of turn) {
    const line =
      e.role === 'tool' ? e.text : e.role === 'error' ? `✗ ERROR: ${e.text}` : `(said) ${oneLine(e.text, 300)}`;
    const prev = acts[acts.length - 1];
    const m = prev?.match(/^(.*) ×(\d+)$/);
    if (prev === line) acts[acts.length - 1] = `${line} ×2`;
    else if (m && m[1] === line) acts[acts.length - 1] = `${line} ×${Number(m[2]) + 1}`;
    else acts.push(line);
  }
  const shown =
    acts.length > MAX_ACTIONS
      ? [...acts.slice(0, 12), `… ${acts.length - MAX_ACTIONS} more actions …`, ...acts.slice(-(MAX_ACTIONS - 12))]
      : acts;

  // The two exchanges before this one: what the person said, what the agent
  // answered last — for «проверь оба фикса» to know which fixes.
  const earlier: string[] = [];
  let exchanges = 0;
  for (let i = before.length - 1; i >= 0 && exchanges < 2; i--) {
    const e = before[i]!;
    if (e.role !== 'user') continue;
    const reply = before.slice(i + 1).filter((x) => x.role === 'assistant').pop();
    earlier.unshift(
      `USER: ${oneLine(e.text, 600)}${reply ? `\nASSISTANT (last words): ${oneLine(reply.text.slice(-900), 900)}` : ''}`,
    );
    exchanges++;
  }

  const head = opts.cwd ? `PROJECT: ${opts.cwd}\n\n` : '';
  const askPart = ask ? `USER TURN (what the person asked):\n${clip(ask, 3000)}\n\n` : '';
  const actPart = `WHAT THE AGENT DID THIS TURN (in order):\n${shown.length ? shown.map((a) => `- ${a}`).join('\n') : '- (no tool calls — it only answered)'}`;
  let earlierPart = earlier.length ? `EARLIER IN THE SESSION:\n${earlier.join('\n\n')}\n\n` : '';
  const fixed = head.length + askPart.length + actPart.length;
  if (fixed + earlierPart.length > DIGEST_BUDGET) {
    earlierPart = fixed < DIGEST_BUDGET - 200 ? `${earlierPart.slice(0, DIGEST_BUDGET - fixed - 2)}\n\n` : '';
  }
  return clip(`${head}${earlierPart}${askPart}${actPart}`, DIGEST_BUDGET + 500);
}
