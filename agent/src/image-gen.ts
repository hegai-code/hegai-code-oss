import os from 'node:os';
import path from 'node:path';
import type { HistoryMessage, ImageGenEventData, RenderBlock } from '@cc-remote/shared';

/**
 * Generated pictures in a Claude session: the CLI `hegai-image "prompt" out.png`
 * run through the Bash tool. There is no tool of its own — a picture exists only
 * as a command and a line of its output — so the live stream, the history parser
 * and the byte loader all recognise it from those two texts, and this module is
 * the one place that knows what they look like.
 *
 * Refs: `gen:<toolUseId>#<n>`, n = 0-based index of the output line.
 */

/** One output line per image: `out.png 1122x1402 1834 KB 47s`. The name is
 *  exactly what the person passed, so spaces are possible; lazy match keeps the
 *  size columns from being swallowed into it. */
const OUTPUT_LINE_RE = /^(.+?\.(?:png|jpe?g|webp))\s+\d+x\d+\s+\d+\s*KB\b/gim;

/** Does this Bash command run `hegai-image` as a generation (not `health`, not a mention)? */
export function isImageGenCommand(command: unknown): command is string {
  return typeof command === 'string' && parseImageGenCall(command) !== undefined;
}

/** A Bash tool_use input that runs in the background: its output never reaches a
 *  tool_result of its own, so it is never tracked as a generation. */
export function isBackgroundBash(input: unknown): boolean {
  return (input as { run_in_background?: unknown } | null)?.run_in_background === true;
}

/** Split a shell command line into words, keeping `;`, `&&`, `||`, `|`, `&`,
 *  `(`, `)` and newlines as their own operator tokens. Quotes and backslashes
 *  are honoured; variable and command substitution are NOT expanded — a word
 *  that is `$p` stays `$p`. Best effort: this feeds a caption, not an exec. */
export function shellWords(command: string): string[] {
  const out: string[] = [];
  let cur = '';
  let has = false;
  let quote: '"' | "'" | undefined;
  const flush = () => {
    if (has) out.push(cur);
    cur = '';
    has = false;
  };
  // Here-documents opened on the current line: their bodies start after the
  // next unquoted newline and are DATA (`cat > gen.sh <<'EOF' … EOF`), not
  // commands — a `hegai-image` line written into a script is not a call, and
  // its card could never resolve (11.11.2026: two eternal placeholders).
  // The body is kept as one HEREDOC word at the `<<` position: a shell that
  // reads it (`bash <<'EOF'`) runs it, and `parseImageGenCalls` looks inside.
  const heredocs: Array<{ delim: string; stripTabs: boolean; at: number }> = [];
  let arith = 0; // inside $(( … )) / (( … )): `<<` is a shift, not a heredoc
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (quote === undefined && c === '(' && command[i + 1] === '(') arith++;
    else if (quote === undefined && c === ')' && command[i + 1] === ')' && arith > 0) arith--;
    // A comment runs to the end of the line; a `<<` in it opens nothing.
    if (quote === undefined && c === '#' && !has) {
      const nl = command.indexOf('\n', i);
      i = (nl === -1 ? command.length : nl) - 1;
      continue;
    }
    if (quote === undefined && c === '<' && command.startsWith('<<<', i)) {
      // here-string: its word is an argument like any other
      cur += '<<<';
      has = true;
      i += 2;
      continue;
    }
    if (quote === undefined && arith === 0 && c === '<' && command[i + 1] === '<') {
      flush();
      let k = i + 2;
      const stripTabs = command[k] === '-';
      if (stripTabs) k++;
      while (command[k] === ' ' || command[k] === '\t') k++;
      let delim = '';
      let quoted = false; // `<<''` is a valid, empty delimiter
      let q: '"' | "'" | undefined;
      for (; k < command.length; k++) {
        const d = command[k]!;
        if (q) {
          if (d === q) q = undefined;
          else delim += d;
        } else if (d === '$' && (command[k + 1] === "'" || command[k + 1] === '"')) {
          // `$'EOF'` / `$"EOF"`: the `$` is quoting, not part of the word
        } else if (d === "'" || d === '"') {
          q = d;
          quoted = true;
        }
        else if (d === '\\' && k + 1 < command.length) delim += command[++k]!;
        else if (/[\s;&|()<>`]/.test(d)) break;
        else delim += d;
      }
      if (delim || quoted) {
        out.push(HEREDOC);
        heredocs.push({ delim, stripTabs, at: out.length - 1 });
      }
      i = k - 1;
      continue;
    }
    if (quote === undefined && c === '\n' && heredocs.length) {
      flush();
      out.push('\n');
      let pos = i + 1;
      for (const h of heredocs.splice(0)) {
        const body: string[] = [];
        for (;;) {
          if (pos >= command.length) break;
          const nl = command.indexOf('\n', pos);
          const end = nl === -1 ? command.length : nl;
          let line = command.slice(pos, end);
          if (h.stripTabs) line = line.replace(/^\t+/, '');
          pos = end + 1;
          if (line === h.delim) break;
          body.push(line);
        }
        out[h.at] = HEREDOC + body.join('\n');
      }
      i = pos - 1;
      continue;
    }
    if (quote === "'") {
      if (c === "'") quote = undefined;
      else cur += c;
      continue;
    }
    if (quote === '"') {
      if (c === '"') quote = undefined;
      else if (c === '\\' && i + 1 < command.length && '"\\$`'.includes(command[i + 1]!)) cur += command[++i]!;
      else cur += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      has = true;
    } else if (c === '\\' && i + 1 < command.length) {
      if (command[i + 1] === '\n') i++;
      else {
        cur += command[++i]!;
        has = true;
      }
    } else if (/\s/.test(c) && c !== '\n') {
      flush();
    } else if (c === '\n' || c === ';' || c === '|' || c === '&' || c === '(' || c === ')' || c === '`') {
      flush();
      // `&&` / `||` as one token.
      if ((c === '&' || c === '|') && command[i + 1] === c) {
        out.push(c + c);
        i++;
      } else out.push(c);
    } else {
      cur += c;
      has = true;
    }
  }
  flush();
  return out;
}

/** Prefix of the word that stands for a here-document body (see `shellWords`). */
export const HEREDOC = '\0heredoc\0';
const isHeredoc = (w: string) => w.startsWith(HEREDOC);

const OPS = new Set([';', '&&', '||', '|', '&', '(', ')', '\n', '`']);
/** The real CLI (argparse): `hegai-image [generate] PROMPT OUT [--size WxH]
 *  [--quality q] [--ref FILE]... [--force]`. These options take a value. */
const VALUE_OPTIONS = new Set(['--size', '--quality', '--ref']);
/** Words that may sit between a separator and the command itself. */
const PREFIX_WORDS = new Set(['do', 'then', 'else', 'elif', 'if', 'while', 'until', '{', '!', 'time', 'exec', 'nohup', 'command', 'sudo', 'env']);
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash']);

export interface ImageGenCall {
  /** First positional argument. Absent when it is a bare `$var` we cannot know. */
  prompt?: string;
  /** Second positional argument: the output path as typed. */
  out?: string;
  /** Argument of the last `cd` before the call in the same command (`~` expanded). */
  dir?: string;
  /** A `cd` whose target we cannot know (`cd "$X"`, `cd -`): a relative `out` cannot be resolved. */
  dirUnknown?: true;
}

const baseName = (w: string) => w.slice(w.lastIndexOf('/') + 1);

/** Where a `cd` argument leads, given where the previous `cd` left us. */
function nextDir(prev: { dir?: string; unknown?: true }, arg: string | undefined): { dir?: string; unknown?: true } {
  if (arg === undefined || arg === '~') return { dir: os.homedir() };
  if (arg.startsWith('~/')) return { dir: path.join(os.homedir(), arg.slice(2)) };
  if (arg.startsWith('$') || arg.startsWith('~') || arg === '-') return { unknown: true };
  if (path.isAbsolute(arg)) return { dir: arg };
  if (prev.unknown) return { unknown: true };
  return { dir: prev.dir === undefined ? arg : path.join(prev.dir, arg) };
}

/** Shell variables a command set for itself before the call: `S=/abs/dir; cd $S`
 *  is how models usually write it, and treating every `$S` as unknowable lost
 *  the picture (07.11.2026: a third of all calls). Only plain assignments that
 *  stand as their own command count (`FOO=1 cmd` scopes FOO to cmd); a value
 *  we cannot know (`$(…)`, an unknown `$X`) forgets the name. Best effort — a
 *  wrong guess still has to pass the loader's folder, mtime and magic checks. */
type ShellVars = Map<string, string>;

const ASSIGN_RE = /^([A-Za-z_]\w*)=(.*)$/s;

/** `$NAME` / `${NAME}` replaced from `vars` (HOME is seeded there); a leading `~/` or bare
 *  `~` as in an assignment. `undefined` when anything is left we cannot know. */
function expandWord(word: string, vars: ShellVars): string | undefined {
  let unknown = false;
  let out = word.replace(/\$(?:\{([A-Za-z_]\w*)\}|([A-Za-z_]\w*))/g, (_m, braced: string | undefined, bare: string | undefined) => {
    const name = (braced ?? bare)!;
    const value = vars.get(name);
    if (value === undefined) unknown = true;
    return value ?? '';
  });
  if (unknown || out.includes('$')) return undefined;
  if (out === '~') out = os.homedir();
  else if (out.startsWith('~/')) out = path.join(os.homedir(), out.slice(2));
  return out;
}

/** Record `NAME=value` words from `words[from..to)`. A value we cannot know —
 *  `$(…)`, backticks (shellWords splits both off, leaving `S=$` or `S=`), an
 *  unknown `$X` — forgets the name instead of keeping a wrong one. */
function assign(vars: ShellVars, words: string[], from: number, to: number, expandFrom: ShellVars = vars): void {
  for (let k = from; k < to; k++) {
    const append = /^([A-Za-z_]\w*)\+=/.exec(words[k]!);
    if (append) {
      vars.delete(append[1]!); // `S+=/sub`: not followed
      continue;
    }
    const m = ASSIGN_RE.exec(words[k]!);
    if (!m) continue;
    const next = words[k + 1];
    const value = next === '`' || next === '(' ? undefined : expandWord(m[2]!, expandFrom);
    if (value === undefined) vars.delete(m[1]!);
    else vars.set(m[1]!, value);
  }
}

/** Commands that change a variable in ways we do not follow: forget the names. */
const VAR_CHANGERS = new Set(['for', 'read', 'unset', 'local', 'declare', 'typeset', 'readonly', 'select', 'mapfile', 'readarray', 'getopts', 'printf']);

/** Parse the words after `hegai-image` up to the next operator. `undefined` unless
 *  it is a real generation: not `health`/`-h`/`--help`, with a prompt and an output. */
function parseArgs(words: string[], from: number): { prompt?: string; out: string } | undefined {
  const args: string[] = [];
  for (let j = from; j < words.length && !OPS.has(words[j]!); j++) if (!isHeredoc(words[j]!)) args.push(words[j]!);
  if (args[0] === 'health') return undefined;
  const positional: string[] = [];
  let rest = false;
  for (let j = 0; j < args.length; j++) {
    const a = args[j]!;
    if (!rest && a === '--') rest = true;
    else if (!rest && (a === '-h' || a === '--help')) return undefined;
    else if (!rest && VALUE_OPTIONS.has(a)) j++;
    else if (!rest && a.startsWith('-') && a.length > 1) continue; // --force, --opt=value
    else positional.push(a);
  }
  if (positional[0] === 'generate' && args[0] === 'generate') positional.shift();
  if (positional.length < 2 || positional[1] === undefined || positional[1] === '') return undefined;
  const prompt = positional[0]!.trim();
  return { ...(prompt && !/^\$[\w{(]/.test(prompt) ? { prompt } : {}), out: positional[1] };
}

/** The first `hegai-image` generation in a command, parsed best effort; `undefined`
 *  when there is none. Only an invocation in command position counts — a mention
 *  (`grep hegai-image notes.md`, `echo hegai-image …`, `which hegai-image`) does
 *  not. Looks one level into a quoted `bash -c '…'` argument. */
export function parseImageGenCall(command: string, depth = 0): ImageGenCall | undefined {
  return parseImageGenCalls(command, depth)[0];
}

/** Every generation in the command, in order — `cd a && hegai-image … a.png;
 *  cd ../b && hegai-image … b.png` is two calls with two folders and prompts. */
export function parseImageGenCalls(command: string, depth = 0): ImageGenCall[] {
  const found: ImageGenCall[] = [];
  const words = shellWords(command);
  const vars: ShellVars = new Map([['HOME', os.homedir()]]);
  let cwd: { dir?: string; unknown?: true } = {};
  // `( … )` and `$( … )` are subshells: what they assign or cd stays inside.
  const scopes: Array<{ vars: ShellVars; cwd: { dir?: string; unknown?: true } }> = [];
  let atCmd = true;
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    if (OPS.has(w)) {
      if (w === '(') scopes.push({ vars: new Map(vars), cwd });
      else if (w === ')') {
        const outer = scopes.pop();
        if (outer) {
          vars.clear();
          for (const [k, v] of outer.vars) vars.set(k, v);
          cwd = outer.cwd;
        }
      }
      atCmd = true;
      continue;
    }
    if (!atCmd) continue;
    // skip `do`, `FOO=bar`, `timeout 300`, … in front of the command itself
    let j = i;
    while (j < words.length && !OPS.has(words[j]!)) {
      const x = words[j]!;
      if (PREFIX_WORDS.has(x) || /^[A-Za-z_]\w*=/.test(x)) j++;
      else if (baseName(x) === 'timeout') {
        j++;
        while (j < words.length && !OPS.has(words[j]!) && (words[j]!.startsWith('-') || /^\d+(\.\d+)?[smhd]?$/.test(words[j]!))) j++;
      } else break;
    }
    const cmd = words[j];
    if (cmd === undefined || OPS.has(cmd)) {
      // Nothing but assignments: they set shell variables for what follows.
      assign(vars, words, i, j);
      i = j - 1;
      continue;
    }
    atCmd = false;
    i = j;
    const base = baseName(cmd);
    if (/^[A-Za-z_]\w*\+=/.test(cmd)) {
      vars.delete(cmd.slice(0, cmd.indexOf('+'))); // `P+=/sub`
    } else if (VAR_CHANGERS.has(base)) {
      for (let k = j + 1; k < words.length && !OPS.has(words[k]!); k++) {
        const name = /^([A-Za-z_]\w*)/.exec(words[k]!)?.[1];
        if (name) vars.delete(name);
      }
    } else if (base === 'cd') {
      let k = j + 1;
      while (k < words.length && !OPS.has(words[k]!) && (words[k] === '-P' || words[k] === '-L' || words[k] === '--')) k++;
      const raw = k < words.length && !OPS.has(words[k]!) ? words[k] : undefined;
      // An empty expansion is no folder we can name (bash would go to $HOME).
      const arg = raw?.includes('$') ? expandWord(raw, vars) || undefined : raw;
      cwd = raw !== undefined && arg === undefined ? { unknown: true } : nextDir(cwd, arg);
    } else if (base === 'export') {
      let k = j + 1;
      while (k < words.length && !OPS.has(words[k]!)) k++;
      // Every right-hand side is expanded before export assigns any of them.
      assign(vars, words, j + 1, k, new Map(vars));
    } else if (base === 'hegai-image') {
      const parsed = parseArgs(words, j + 1);
      if (parsed) {
        // `"$S/mock/a.png"` prints as the expanded path; expand it the same way so
        // the output line still finds its call (prompt, folder).
        const out = parsed.out.includes('$') ? (expandWord(parsed.out, vars) ?? parsed.out) : parsed.out;
        found.push({
          ...(parsed.prompt !== undefined ? { prompt: parsed.prompt } : {}),
          out,
          ...(cwd.dir !== undefined ? { dir: cwd.dir } : {}),
          ...(cwd.unknown ? { dirUnknown: true as const } : {}),
        });
        if (found.length >= MAX_IMAGES_PER_CALL) return found;
      }
    } else if (depth === 0 && SHELLS.has(base)) {
      // The script is the `-c` argument, or — with no script file named — a
      // here-document on stdin (`bash <<'EOF'`), which the shell runs.
      let script: string | undefined;
      let file = false;
      for (let k = j + 1; k < words.length && !OPS.has(words[k]!); k++) {
        const x = words[k]!;
        if (/^-[a-z]*c[a-z]*$/.test(x) && words[k + 1] !== undefined && !isHeredoc(words[k + 1]!)) {
          script = words[k + 1];
          break;
        }
        if (isHeredoc(x)) {
          if (!file && script === undefined) script = x.slice(HEREDOC.length);
        } else if (!x.startsWith('-')) file = true;
      }
      for (const nested of script === undefined ? [] : parseImageGenCalls(script, 1)) {
        found.push({
          ...nested,
          ...(nested.dir === undefined && !nested.dirUnknown && cwd.dir !== undefined ? { dir: cwd.dir } : {}),
          ...(nested.dir === undefined && !nested.dirUnknown && cwd.unknown ? { dirUnknown: true as const } : {}),
        });
        if (found.length >= MAX_IMAGES_PER_CALL) return found;
      }
    }
  }
  return found;
}

/**
 * Which call printed output line `typed`: the one whose output argument is that
 * exact string; else, with a single call (a loop runs it many times), that one.
 * Several calls and no exact match → unknown: no prompt, and a relative path
 * cannot be resolved — better than another call's prompt or folder.
 */
export function callForOutput(calls: ImageGenCall[], typed: string): ImageGenCall | undefined {
  return calls.find((c) => c.out === typed) ?? (calls.length === 1 ? calls[0] : undefined);
}

/** Paths of the images a `hegai-image` run reports, in output order. */
/** Pictures one Bash call may yield. Output is untrusted: a command printing
 *  thousands of image-shaped lines must not fan out into thousands of events,
 *  blocks and refs. Live events, history and the loader share this bound. */
export const MAX_IMAGES_PER_CALL = 16;

export function parseImageOutputs(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(OUTPUT_LINE_RE)) {
    out.push(m[1]!);
    if (out.length >= MAX_IMAGES_PER_CALL) break;
  }
  return out;
}

/** The last line of a failed run worth showing: not empty, not a bare prompt
 *  symbol. Truncated to `max`. */
export function lastMeaningfulLine(text: string, max = 300): string {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^[$>#]+$/.test(l));
  const last = lines[lines.length - 1] ?? '';
  return last.length > max ? `${last.slice(0, max - 1)}…` : last;
}

export function genRef(toolUseId: string, n: number): string {
  return `gen:${toolUseId}#${n}`;
}

/** `gen:<toolUseId>#<n>` → its halves, or null for anything else. */
export function parseGenRef(ref: string): { toolUseId: string; n: number } | null {
  const m = /^gen:([A-Za-z0-9_-]{1,120})#(\d{1,3})$/.exec(ref);
  return m ? { toolUseId: m[1]!, n: Number(m[2]) } : null;
}

const clip = (text: string | undefined, max: number): string | undefined =>
  text === undefined ? undefined : text.length > max ? text.slice(0, max) : text;

/** A live `status` stream event carrying `ImageGenEventData`. `text` is for old
 *  clients, which print it as a plain status line. */
export function imageGenEvent(data: ImageGenEventData): {
  kind: 'status';
  code: 'image_gen';
  text: string;
  data: ImageGenEventData;
} {
  const text =
    data.state === 'started'
      ? '🎨 Рисую картинку…'
      : data.state === 'done'
        ? '🎨 Картинка готова'
        : `🎨 Не удалось нарисовать${data.error ? `: ${data.error}` : ''}`;
  return { kind: 'status', code: 'image_gen', text, data };
}

interface Pending {
  calls: ImageGenCall[];
  startedAt: number;
}

function promptOf(call: ImageGenCall | undefined): { prompt?: string } {
  const prompt = clip(call?.prompt, 4000);
  return prompt ? { prompt } : {};
}

const MAX_PENDING = 100;

/**
 * Live side of the Claude path: feed it every `Bash` tool_use and every
 * tool_result of the main thread; it answers with the `image_gen` events to emit.
 * The first picture of a call reuses the `started` card (`<toolUseId>#0`), later
 * pictures of the same command arrive as `done` with the same `startedAt`.
 */
export class ImageGenLiveTracker {
  private readonly pending = new Map<string, Pending>();

  toolUse(id: string, name: unknown, input: unknown, now = Date.now()): ReturnType<typeof imageGenEvent>[] {
    if (name !== 'Bash' || !id) return [];
    if (isBackgroundBash(input)) return [];
    const command = (input as { command?: unknown } | null)?.command;
    const calls = typeof command === 'string' ? parseImageGenCalls(command) : [];
    if (!calls.length) return [];
    this.pending.set(id, { calls, startedAt: now });
    if (this.pending.size > MAX_PENDING) this.pending.delete(this.pending.keys().next().value!);
    return [imageGenEvent({ id: `${id}#0`, state: 'started', startedAt: now, ...promptOf(calls[0]) })];
  }

  /** The turn ended with calls still open (stopped, crashed): close their cards,
   *  or a client keeps a «Рисую…» bar crawling under a finished turn. */
  abandon(): ReturnType<typeof imageGenEvent>[] {
    const events = [...this.pending].map(([id, p]) =>
      imageGenEvent({
        id: `${id}#0`,
        state: 'failed',
        startedAt: p.startedAt,
        ...promptOf(p.calls[0]),
        error: 'генерация прервана',
      }),
    );
    this.pending.clear();
    return events;
  }

  toolResult(toolUseId: string, text: string, isError: boolean): ReturnType<typeof imageGenEvent>[] {
    const p = this.pending.get(toolUseId);
    if (!p) return [];
    this.pending.delete(toolUseId);
    const outputs = isError ? [] : parseImageOutputs(text);
    if (outputs.length === 0) {
      const error = clip(lastMeaningfulLine(text), 300);
      return [
        imageGenEvent({
          id: `${toolUseId}#0`,
          state: 'failed',
          startedAt: p.startedAt,
          ...promptOf(p.calls[0]),
          ...(error ? { error } : {}),
        }),
      ];
    }
    return outputs.map((typed, n) =>
      imageGenEvent({
        id: `${toolUseId}#${n}`,
        state: 'done',
        ref: genRef(toolUseId, n),
        startedAt: p.startedAt,
        ...promptOf(callForOutput(p.calls, typed)),
      }),
    );
  }
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((c) => {
      const b = c as { type?: unknown; text?: unknown };
      return b.type === 'text' && typeof b.text === 'string' ? b.text : '';
    })
    .filter(Boolean)
    .join('\n');
}

/**
 * History side. Feed transcript records in FILE order; for a user record that
 * carries the result of a remembered `hegai-image` call it returns the synthetic
 * assistant message(s) to place right after that record's own message.
 *
 * The tool_use is remembered between records, so a ledger must see the whole
 * transcript from the start: every full-parse path (`scanClaudeHistory`,
 * `pushClaudeLine`) does, and the incremental replica keeps the ledger with its
 * kept parse. A result whose call this ledger never saw (a mirror chunk that
 * starts mid-session) yields nothing — it is NOT recognised from its text
 * alone, because `cat build.log` can print the same line shape and a card that
 * cannot resolve is worse than no card.
 *
 * Synthetic uuid: `${record.uuid}:gen:${toolUseId}` — derived from two ids that
 * are already stable in the file, so the message is identical on every parse and
 * the replica's append check (which hashes messages) never sees it change.
 */
export class ImageGenLedger {
  private readonly uses = new Map<string, ImageGenCall[]>();

  observe(record: unknown, ts?: number): HistoryMessage[] {
    const r = record as { type?: unknown; uuid?: unknown; isSidechain?: unknown; message?: { content?: unknown } } | null;
    if (!r || r.isSidechain === true || typeof r.uuid !== 'string') return [];
    const content = r.message?.content;
    if (!Array.isArray(content)) return [];
    const out: HistoryMessage[] = [];
    for (const raw of content as Array<Record<string, unknown>>) {
      if (r.type === 'assistant' && raw['type'] === 'tool_use' && raw['name'] === 'Bash') {
        if (isBackgroundBash(raw['input'])) continue;
        const command = (raw['input'] as { command?: unknown } | null)?.command;
        const calls = typeof command === 'string' ? parseImageGenCalls(command) : [];
        if (typeof raw['id'] !== 'string' || !calls.length) continue;
        this.uses.set(raw['id'], calls);
        if (this.uses.size > MAX_PENDING * 5) this.uses.delete(this.uses.keys().next().value!);
      } else if (r.type === 'user' && raw['type'] === 'tool_result' && typeof raw['tool_use_id'] === 'string') {
        const toolUseId = raw['tool_use_id'];
        const use = this.uses.get(toolUseId);
        if (!use) continue;
        this.uses.delete(toolUseId);
        if (raw['is_error'] === true) continue;
        const outputs = parseImageOutputs(resultText(raw['content']));
        if (outputs.length === 0) continue;
        const blocks: RenderBlock[] = outputs.map((typed, n) => ({
          kind: 'image',
          ref: genRef(toolUseId, n),
          generated: true,
          ...promptOf(callForOutput(use, typed)),
        }));
        out.push({
          type: 'assistant',
          uuid: `${r.uuid}:gen:${toolUseId}`,
          blocks,
          ...(ts === undefined ? {} : { ts }),
        });
      }
    }
    return out;
  }
}
