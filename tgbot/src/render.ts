/**
 * Turning agent output into something a messenger can show.
 *
 * Telegram's HTML is a short whitelist (`b i u s a code pre blockquote`), and
 * it rejects the WHOLE message on one bad tag — so the order here is: pull code
 * out first, escape everything, apply a small markdown subset, put code back.
 * Doing it the other way round means a stray `<` in a diff kills the message.
 */

import { stripHarnessNoise } from '@cc-remote/shared';

// The one definition lives in shared (also used by the web); re-exported here.
export { stripHarnessNoise };

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** A placeholder marker that cannot occur in agent output, so restoring code
 *  blocks can never collide with prose the model happened to write. */
const SENTINEL = '\u0000';

/**
 * A deliberately small markdown subset: fenced and inline code, bold, links,
 * headings-as-bold, bullets. Italics are NOT converted — `*` and `_` appear
 * unbalanced in paths and code far more often than they mean emphasis, and a
 * half-open `<i>` costs the whole message.
 */
export function mdToHtml(markdown: string): string {
  const blocks: string[] = [];
  let text = markdown;

  // 1. fenced code -> placeholder
  text = text.replace(/```(\w+)?\n?([\s\S]*?)```/g, (_m, lang: string | undefined, body: string) => {
    const code = escapeHtml(body.replace(/\n$/, ''));
    const open = lang ? `<pre><code class="language-${escapeHtml(lang)}">` : '<pre>';
    const close = lang ? '</code></pre>' : '</pre>';
    blocks.push(`${open}${code}${close}`);
    return `${SENTINEL}${blocks.length - 1}${SENTINEL}`;
  });

  // 2. inline code -> placeholder
  text = text.replace(/`([^`\n]+)`/g, (_m, body: string) => {
    blocks.push(`<code>${escapeHtml(body)}</code>`);
    return `${SENTINEL}${blocks.length - 1}${SENTINEL}`;
  });

  // 3. everything that is left is prose
  text = escapeHtml(text);

  // 4. the subset
  text = text.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>');
  text = text.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
  text = text.replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>');
  text = text.replace(/^(\s*)[-*]\s+/gm, '$1• ');

  // 5. code back in
  return text.replace(new RegExp(`${SENTINEL}(\\d+)${SENTINEL}`, 'g'), (_m, index: string) => {
    return blocks[Number(index)] ?? '';
  });
}

/** Agent speech, ready to send. Empty means "nothing worth showing". */
export function speech(text: string): string {
  const clean = stripHarnessNoise(text).trim();
  return clean ? mdToHtml(clean) : '';
}

/** One line, collapsed and clipped — for previews, titles and status. */
export function oneLine(text: string, max = 90): string {
  const flat = stripHarnessNoise(text).replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * A streamed `tool_use` line arrives as `ToolName {json-input}` from Claude and
 * as `$ cmd` / `edit paths` from Codex. Verbose mode shows a compact form of
 * it; the quiet default never calls this.
 */
export function toolLine(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return '';
  const brace = trimmed.indexOf(' {');
  if (brace <= 0) return `▸ ${oneLine(trimmed, 80)}`;
  const name = trimmed.slice(0, brace);
  let detail = '';
  try {
    const input = JSON.parse(trimmed.slice(brace + 1)) as Record<string, unknown>;
    const interesting =
      input['command'] ?? input['file_path'] ?? input['path'] ?? input['pattern'] ?? input['url'] ?? input['description'];
    if (typeof interesting === 'string') detail = ` ${oneLine(interesting, 60)}`;
  } catch {
    /* the input is not always JSON; the name alone is still useful */
  }
  return `▸ ${name}${detail}`;
}

// ---------------------------------------------------------------- history

/** One readable turn: consecutive same-speaker messages already merged. */
export interface HistoryTurn {
  role: 'user' | 'assistant';
  text: string;
  ts: number | undefined;
}

/**
 * Transcript → readable turns.
 *
 * Three rules carried over from the web's reader (`web/src/render/Blocks.tsx`):
 * `system` messages are hook output and CLI caveats, not conversation; a `user`
 * message whose blocks are all `tool_result` is the runtime feeding output
 * back, not a person; and only `text` blocks are prose.
 *
 * The merge matters more than it looks: tool calls sit BETWEEN two halves of
 * one agent answer, and since tools are invisible here, not merging prints
 * "АГЕНТ / АГЕНТ / АГЕНТ" down the screen for what was a single thought.
 */
export function historyTurns(
  messages: ReadonlyArray<{ type: string; blocks: ReadonlyArray<{ kind: string; text?: string }>; ts?: number }>,
): HistoryTurn[] {
  const turns: HistoryTurn[] = [];
  for (const message of messages) {
    if (message.type === 'system') continue;
    const role = message.type === 'user' ? 'user' : 'assistant';
    const text = message.blocks
      .filter((b) => b.kind === 'text' && typeof b.text === 'string')
      .map((b) => stripHarnessNoise(b.text ?? '').trim())
      .filter(Boolean)
      .join('\n\n');
    if (!text) continue;
    const previous = turns.at(-1);
    if (previous && previous.role === role) {
      previous.text = `${previous.text}\n\n${text}`;
      previous.ts = message.ts ?? previous.ts;
      continue;
    }
    turns.push({ role, text, ts: message.ts });
  }
  return turns;
}

/** Above this, a turn is collapsed behind Telegram's "show more". */
const EXPANDABLE_OVER = 380;
/** Above this, a single turn is clipped so one giant answer cannot eat the page. */
const TURN_CLIP = 1200;

/**
 * Render turns as ONE document that fits a single message.
 *
 * Selection walks BACKWARDS from the newest turn under a character budget and
 * then flips the result: what you want when reopening a session is the end of
 * the conversation intact, not its beginning truncated.
 */
export function historyDocument(
  turns: readonly HistoryTurn[],
  budget = 3400,
): { text: string; shown: number; omitted: number } {
  const picked: HistoryTurn[] = [];
  let used = 0;
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i];
    if (!turn) continue;
    const clipped = clipTurn(turn.text, turn.role === 'user' ? 'head' : 'tail');
    const cost = clipped.length + 40; // gutter + tags
    if (used + cost > budget && picked.length) break;
    picked.push({ ...turn, text: clipped });
    used += cost;
  }
  picked.reverse();
  const blocks = picked.map((turn) => {
    const gutter = `<code>${turn.role === 'user' ? 'ТЫ' : 'АГЕНТ'}${turn.ts ? ` · ${ago(turn.ts)}` : ''}</code>`;
    // User text is plain — CLI-injected context is full of `#` and `*` that is
    // not markdown. Assistant text is markdown. Same split as the web reader.
    const body = turn.role === 'user' ? escapeHtml(turn.text) : mdToHtml(turn.text);
    const tag = turn.text.length > EXPANDABLE_OVER ? '<blockquote expandable>' : '<blockquote>';
    return `${gutter}\n${tag}${body}</blockquote>`;
  });
  return { text: blocks.join('\n\n'), shown: picked.length, omitted: turns.length - picked.length };
}

/**
 * Clip the RAW markdown, never the rendered HTML: cutting HTML mid-tag is what
 * makes Telegram reject a message outright.
 *
 * Which END is kept is a product decision, not a detail. One agent turn spans
 * every tool call it made, so its text is narration first and the CONCLUSION
 * last — keep the tail. A user turn is the opposite: the ask is the first
 * sentence — keep the head.
 */
function clipTurn(text: string, keep: 'head' | 'tail'): string {
  if (text.length <= TURN_CLIP) return text;
  if (keep === 'head') {
    const cut = text.lastIndexOf('\n', TURN_CLIP);
    const at = cut > TURN_CLIP * 0.5 ? cut : TURN_CLIP;
    return `${text.slice(0, at).trimEnd()}\n…`;
  }
  const from = text.length - TURN_CLIP;
  const cut = text.indexOf('\n', from);
  const at = cut >= 0 && cut < text.length - TURN_CLIP * 0.5 ? cut : from;
  return `…\n${text.slice(at).trimStart()}`;
}

/** Russian plural: 1 ход, 2 хода, 5 ходов. "3 ходов" reads as sloppy as it is. */
export function plural(n: number, forms: [string, string, string]): string {
  const mod100 = n % 100;
  const mod10 = n % 10;
  if (mod100 >= 11 && mod100 <= 14) return `${n} ${forms[2]}`;
  if (mod10 === 1) return `${n} ${forms[0]}`;
  if (mod10 >= 2 && mod10 <= 4) return `${n} ${forms[1]}`;
  return `${n} ${forms[2]}`;
}

/** `/abs/path/to/repo` → `repo`, with the parent when the leaf is ambiguous. */
export function projectLabel(cwd: string): string {
  const parts = cwd.replace(/\/+$/, '').split('/').filter(Boolean);
  const leaf = parts.at(-1);
  if (!leaf) return cwd;
  if (/^(src|app|web|server|packages?)$/.test(leaf) && parts.length > 1) {
    return `${parts.at(-2)}/${leaf}`;
  }
  return leaf;
}

const MINUTE = 60_000;

/** "3 мин", "2 ч", "вчера" — a messenger wants relative time, not a timestamp. */
export function ago(ms: number): string {
  const delta = Date.now() - ms;
  if (delta < MINUTE) return 'только что';
  if (delta < 60 * MINUTE) return `${Math.round(delta / MINUTE)} мин`;
  if (delta < 24 * 60 * MINUTE) return `${Math.round(delta / (60 * MINUTE))} ч`;
  const days = Math.round(delta / (24 * 60 * MINUTE));
  return days === 1 ? 'вчера' : `${days} дн`;
}

/**
 * Body of an activity notification.
 *
 * `needs_attention` covers two different things the hub does not tell apart: a
 * question the agent asked, and a permission prompt for a tool it wants to run.
 * The old fallback printed «ждёт ответа» whenever `preview` was missing — and
 * `preview` is missing systematically, because a run re-adopted after a hub
 * restart comes back with none. So the owner got told an agent was waiting on
 * an answer when nothing had been asked, went to look, and found no question.
 *
 * With a preview we show it; without one we say what is actually known — the
 * run stopped and wants a decision — and never invent a question.
 */
export function notifyBody(run: { state: string; preview?: string }): string {
  const preview = run.preview?.trim();
  if (preview) return oneLine(preview, 200);
  if (run.state === 'error') return 'сессия упала — загляните в неё';
  return 'сессия остановилась и ждёт решения: подтверждение инструмента или ответ';
}
