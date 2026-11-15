/**
 * Dictation clean-up on the web side — what goes to `POST /polish` and how the
 * answer is put back (server-rs/src/polish.rs does the rewrite).
 *
 * Whisper writes down sounds: «юз рекордер», «деплой хаб эс эйч», «кодекс».
 * The rewrite turns that into what the person meant to type, and the thing
 * that makes it right for THIS person is context — the project and the words
 * the conversation has been using. So the composer sends the end of the
 * transcript it is showing, as vocabulary.
 */
import { POLISH_MAX_RECENT, type HistoryMessage, type PolishRequest } from '@cc-remote/shared';

/** Last few turns, oldest first, `role: text`. Tool output is not what anyone
 *  says out loud, and the assistant's prose already names the files it touched. */
const RECENT_TURNS = 6;
/** One very long turn must not crowd the others out. */
const PER_TURN = 1_200;

/** A UTF-16 slice can split a surrogate pair (an emoji at the cut), and a lone
 *  half serialises as `"\udc…"`, which serde_json refuses — the whole request
 *  would 4xx and polish would quietly stop for as long as that turn is in the
 *  tail. Drop the orphan at either edge. */
const dropLoneSurrogates = (s: string) => s.replace(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/g, '');

export function recentForPolish(history: readonly HistoryMessage[]): string | undefined {
  const lines: string[] = [];
  for (let i = history.length - 1; i >= 0 && lines.length < RECENT_TURNS; i--) {
    const m = history[i]!;
    if (m.type === 'system') continue;
    const text = m.blocks
      .map((b) => (b.kind === 'text' ? b.text : ''))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!text) continue;
    // The END of a long turn: that is where the agent says what it did and asks.
    const cut = text.length > PER_TURN ? `…${dropLoneSurrogates(text.slice(-PER_TURN))}` : text;
    lines.push(`${m.type}: ${cut}`);
  }
  const out = lines.reverse().join('\n');
  if (!out) return undefined;
  return out.length > POLISH_MAX_RECENT ? dropLoneSurrogates(out.slice(-POLISH_MAX_RECENT)) : out;
}

/** Cap for the project label sent to `/transcribe` (recognition prompt). */
const TRANSCRIBE_PROJECT_MAX = 80;

/** The project label for `/transcribe?project=` — trimmed, ≤80, no lone surrogates. */
export function transcribeProject(project: string | undefined): string | undefined {
  const p = project && dropLoneSurrogates(project.trim().slice(0, TRANSCRIBE_PROJECT_MAX));
  return p || undefined;
}

/** How many recent turns `transcribeHints` reads. */
const HINT_TURNS = 10;
/** Whisper-prompt budget for session terms; the hub re-checks (≤25 terms, ≤40 each, ≤300 total). */
const HINT_MAX_TERMS = 20;
const HINT_MAX_CHARS = 300;
const HINT_TERM_MAX = 40;
const HINT_TERM_MIN = 3;
/** Words that are everywhere and say nothing about THIS session. */
const HINT_STOP = new Set(
  (
    'the and for with this that from not are you was have will can all but use set get new out run add ' +
    'has had its into also your what when then than they them been were which where there here just only ' +
    'e.g i.e'
  ).split(' '),
);
/** A Latin/identifier token: starts at a boundary (so `2fa` and `x.y` tails are not re-cut) with a letter. */
const HINT_LATIN = /(?<![A-Za-z0-9_])[A-Za-z][A-Za-z0-9_.\-/]*/g;
/** A capitalised Cyrillic word that follows a word (not a sentence/line start). */
const HINT_CYRILLIC = /(?<=[\p{L}\p{N}_,;] )[А-ЯЁ][а-яё]{2,}(?!\p{L})/gu;
/** Looks like an identifier or file name rather than a plain word. */
const HINT_SPECIAL = /[A-Z0-9._\-/]/;

/**
 * Session vocabulary for the recognition prompt (`/transcribe?hints=`): names,
 * identifiers and file names from the last few turns, so whisper spells
 * `useRecorder` and «Владелец» the way this conversation does. Comma-separated,
 * ≤20 terms and ≤300 chars; `undefined` when nothing qualifies.
 *
 * Ranked by how often a term occurs, +1 for identifier-like tokens (camelCase,
 * digits, `._-/`), ties to the more recent. Case-insensitive dedupe keeps the
 * spelling used most recently.
 */
export function transcribeHints(history: readonly HistoryMessage[]): string | undefined {
  const found = new Map<string, { term: string; score: number; seq: number }>();
  let seq = 0;
  let turns = 0;
  const note = (raw: string, special: boolean) => {
    const key = raw.toLowerCase();
    const hit = found.get(key);
    const bonus = special ? 1 : 0;
    if (hit) hit.score++;
    else found.set(key, { term: raw, score: 1 + bonus, seq: seq });
    seq++;
  };
  for (let i = history.length - 1; i >= 0 && turns < HINT_TURNS; i--) {
    const m = history[i]!;
    if (m.type === 'system') continue;
    const text = m.blocks
      .map((b) => (b.kind === 'text' ? b.text : ''))
      .join('\n')
      .replace(/[ \t]+/g, ' ');
    if (!text.trim()) continue;
    turns++;
    const noUrls = text.replace(/\S*:\/\/\S*/g, ' ');
    const terms: { t: string; special: boolean }[] = [];
    for (const m1 of noUrls.matchAll(HINT_LATIN)) {
      const t = m1[0].replace(/[.\-/]+$/, '');
      if (t.length < HINT_TERM_MIN || t.length > HINT_TERM_MAX) continue;
      if (HINT_STOP.has(t.toLowerCase())) continue;
      if (/^[0-9a-f]{7,}$/i.test(t) || /^\d+$/.test(t)) continue;
      terms.push({ t, special: HINT_SPECIAL.test(t) });
    }
    for (const m2 of noUrls.matchAll(HINT_CYRILLIC)) terms.push({ t: m2[0], special: false });
    // Newest first, like the walk over turns: a lower `seq` is more recent.
    for (let k = terms.length - 1; k >= 0; k--) note(terms[k]!.t, terms[k]!.special);
  }
  const ranked = [...found.values()].sort((a, b) => b.score - a.score || a.seq - b.seq);
  const out: string[] = [];
  let len = 0;
  for (const r of ranked) {
    if (out.length >= HINT_MAX_TERMS) break;
    const next = len + (out.length ? 2 : 0) + r.term.length;
    if (next > HINT_MAX_CHARS) break;
    out.push(r.term);
    len = next;
  }
  const joined = dropLoneSurrogates(out.join(', '));
  return joined || undefined;
}

/** What `/polish` came to. `off`: no polisher on the hub (503, latched) — not a
 *  failure, nothing to say. `failed`: it was asked and did not deliver (refusal,
 *  timeout, 429, the hub handing the text back untouched). `ok` with the same
 *  text is «nothing to fix», also not a failure. */
export type PolishResult = { kind: 'ok'; text: string } | { kind: 'failed' } | { kind: 'off' };

/** The polisher as the recorder sees it. `safe` = the dictation goes out
 *  unseen (sent from the recording), so only context that cannot carry
 *  conversation text may be used. */
export type DictationPolisher = (text: string, safe: boolean) => Promise<PolishResult>;

export const POLISH_FAILED_NOTE = 'Вычитка не удалась — текст как распознан';

/**
 * Run the rewrite for one dictation. Never throws, never loses the text.
 *
 * On the `immediate` path (sent straight from the recording, nobody reads the
 * text first) the polisher is called with `safe = true`: the callers then send
 * ONLY the dictation and the project label. No `recent` (the conversation
 * tail — the agent's own words can carry an injection into the rewrite) and no
 * `title` (LLM-written from the conversation). With nothing conversation-derived
 * in the prompt, the rewrite can only be a function of what the person said, so
 * sending it unseen is no worse than sending the raw recognition. The normal
 * stop keeps the full context: the person reads the result before it is sent.
 */
export async function polishDictationText(
  text: string,
  clean: DictationPolisher | undefined,
  immediate: boolean,
): Promise<{ text: string; raw?: string; failed: boolean }> {
  if (!text || !clean) return { text, failed: false };
  try {
    const r = await clean(text, immediate);
    if (r.kind === 'failed') return { text, failed: true };
    if (r.kind === 'ok') {
      const polished = r.text.trim();
      if (polished && polished !== text) return { text: polished, raw: text, failed: false };
    }
    return { text, failed: false };
  } catch (err) {
    console.warn('[recorder] polish failed', err);
    return { text, failed: true };
  }
}

/** The context half of a `/polish` request, with empty fields left out (zod
 *  `optional` is absent, never `''`). */
export function polishContext(opts: {
  project?: string;
  title?: string;
  history?: readonly HistoryMessage[];
}): Omit<PolishRequest, 'text'> {
  const ctx: Omit<PolishRequest, 'text'> = {};
  const project = opts.project && dropLoneSurrogates(opts.project.trim().slice(0, 200));
  const title = opts.title && dropLoneSurrogates(opts.title.trim().slice(0, 200));
  if (project) ctx.project = project;
  if (title) ctx.title = title;
  const recent = opts.history ? recentForPolish(opts.history) : undefined;
  if (recent) ctx.recent = recent;
  return ctx;
}

/**
 * The «как сказал» switch: one dictation, two spellings, and the composer shows
 * one of them. `swapDictation` puts the other in its place — the LAST
 * occurrence, because dictation is appended to the draft. `null` means the
 * text is no longer in the draft (edited or sent) and the switch should go.
 */
export interface DictationPair {
  raw: string;
  polished: string;
  showing: 'raw' | 'polished';
}

export function swapDictation(draft: string, pair: DictationPair): { draft: string; pair: DictationPair } | null {
  const [from, to] = pair.showing === 'polished' ? [pair.polished, pair.raw] : [pair.raw, pair.polished];
  const at = draft.lastIndexOf(from);
  if (at < 0) return null;
  return {
    draft: draft.slice(0, at) + to + draft.slice(at + from.length),
    pair: { ...pair, showing: pair.showing === 'polished' ? 'raw' : 'polished' },
  };
}

/** Is the switch still about text that is in the box? */
export function dictationVisible(draft: string, pair: DictationPair | null): boolean {
  if (!pair) return false;
  return draft.includes(pair.showing === 'polished' ? pair.polished : pair.raw);
}
