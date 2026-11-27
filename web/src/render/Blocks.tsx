import { useMarkdownLib } from './markdown-lib.js';
import { SubagentCards, agentCallsFromBlocks, agentCallsFromLines } from './Subagents.js';
import { Fragment, memo, useEffect, useRef, useState, type ReactNode } from 'react';
import { isPlanTool, PLAN_TOOL, stripHarnessNoise, type HistoryMessage, type ImageGenEventData, type RenderBlock } from '@cc-remote/shared';
import type { TranscriptLine } from '../central-reducers.js';
import { CopyIcon, Check, ImageIcon, GearIcon } from '../icons.js';
import { dayKey, pluralRu, stamp } from '../lib.js';
import { Avatar } from '../components/Avatar.js';
import { linkProps } from '../router.js';
import { notLoggedInRuntime } from '../components/runtimeChips.js';
import { BudgetCard, isBudgetLine } from '../components/BudgetCard.js';
import { Attachment, ImageLightbox } from './Attachment.js';
import { FileHref, FilePreviews } from './FilePreviews.js';
import { fileLinkTarget } from './filePaths.js';
import { GeneratedImage, ImageGenCard } from './GeneratedImage.js';
import { BROWSER_FLAG, OWN_WINDOW_FLAG } from '../router.js';
import { linksToBrowser, ownWindowsSafe } from '../shell/useSessionMenu.js';

/** A <pre> with a hover copy button in the corner. Reads innerText on click so
 *  it works for both markdown fences and raw tool bodies. */
export function CodeBlock({ className, children }: { className?: string; children: ReactNode }) {
  const ref = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  const timerRef = useRef(0);
  useEffect(() => () => window.clearTimeout(timerRef.current), []);
  const copy = () => {
    const t = ref.current?.innerText ?? '';
    if (!t || !navigator.clipboard) return;
    navigator.clipboard.writeText(t).then(() => {
      setCopied(true);
      window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => setCopied(false), 1200);
    });
  };
  return (
    <div className="codeblock">
      <button className="code-copy" onClick={copy} title="Копировать" aria-label="Копировать код">
        {copied ? <Check size={13} /> : <CopyIcon size={13} />}
      </button>
      <pre ref={ref} className={className}>
        {children}
      </pre>
    </div>
  );
}

/** Whether markdown may load this image by itself. Agent prose is shown to
 *  everyone a session is shared with, so a remote `![](https://x/?…)` would
 *  tell its host each viewer's IP and the moment they opened it. Inline bytes
 *  and this site's own paths are fine; anything else becomes a link. */
export function inlineImageAllowed(src: string | undefined): boolean {
  if (!src) return false;
  if (/^(data:image\/|blob:)/i.test(src)) return true;
  try {
    return new URL(src, window.location.href).origin === window.location.origin;
  } catch {
    return false;
  }
}

function MdImage({ src, alt }: { src?: string; alt?: string }) {
  if (inlineImageAllowed(src)) return <img src={src} alt={alt ?? ''} />;
  let host = '';
  try {
    host = new URL(src ?? '').host;
  } catch {
    return null;
  }
  return (
    <a href={src} target="_blank" rel="noreferrer noopener">
      {alt ? `${alt} (${host})` : `картинка: ${host}`}
    </a>
  );
}

/** How the desktop shell should open a link to this site from agent prose:
 *  `browser` — hand it to the system browser (shell 0.1.24+); `window` — a
 *  second app window (shells that build one safely); `none` — leave it alone. */
export type SameSiteLinks = 'browser' | 'window' | 'none';

/** A link in agent prose opens beside the app, never in place of it. A plain
 *  `<a>` loaded its target into the app's own tab: a report link
 *  (`/w/reports/<id>`) replaced `/w/sessions/columns?s=…`, and since the split
 *  lives in that URL every column was gone (08.10.2026). Inside the desktop
 *  shell a link to this site goes to the person's browser (10.10.2026, «чтобы
 *  открывалась в браузере, а не в самом аппе») where the shell understands
 *  the flag, and to a second app window in older shells that build one safely;
 *  in a browser the flags are stripped on arrival and the link is simply a new
 *  tab. In-page anchors stay as they are. */
export function mdLinkHref(href: string, here: string, sameSite: SameSiteLinks): string {
  if (href.startsWith('#')) return href;
  try {
    const u = new URL(href, here);
    if (sameSite !== 'none' && u.origin === new URL(here).origin && /^https?:$/.test(u.protocol)) {
      u.searchParams.set(sameSite === 'browser' ? BROWSER_FLAG : OWN_WINDOW_FLAG, '1');
      return u.toString();
    }
  } catch {
    // not a URL we can parse — leave it to the browser as written
  }
  return href;
}

function sameSiteLinks(): SameSiteLinks {
  if (linksToBrowser()) return 'browser';
  return ownWindowsSafe() ? 'window' : 'none';
}

/** react-markdown blanks an href with a colon before its first `/` (`C:\\a.docx`,
 *  `m-glossary.mjs:28`, `file:///…`). A file link is drawn as a button, never as
 *  `<a href>`, so it passes through untouched. */
export function mdUrlTransform(url: string, key: string, fallback: (u: string) => string): string {
  return key === 'href' && fileLinkTarget(url) ? url : fallback(url);
}

function MdLink({ href, children }: { href?: string; children?: ReactNode }) {
  if (!href) return <>{children}</>;
  if (href.startsWith('#')) return <a href={href}>{children}</a>;
  const file = fileLinkTarget(href);
  if (file) return <FileHref path={file}>{children}</FileHref>;
  // `~/…` is a path on the machine the app cannot resolve: text, not a dead link.
  if (href.startsWith('~')) return <span title={href}>{children}</span>;
  return (
    <a href={mdLinkHref(href, window.location.href, sameSiteLinks())} target="_blank" rel="noreferrer noopener">
      {children}
    </a>
  );
}

const MD_COMPONENTS = {
  a: MdLink,
  pre: ({ children }: { children?: ReactNode }) => <CodeBlock>{children}</CodeBlock>,
  img: MdImage,
  // Wide tables scroll inside their own box instead of widening the pane —
  // see `.md-table-wrap`. `pre` already carried its own `overflow: auto`;
  // a table had nothing, and it is the one element `overflow-wrap` cannot help.
  table: ({ children }: { children?: ReactNode }) => (
    <div className="md-table-wrap">
      <table>{children}</table>
    </div>
  ),
};

/** Codex embeds `:codex-file-citation{path="…" …}` markers in its prose —
 *  collapse them to the file's basename as inline code. Exported for the
 *  enrichment layer, which must not feed citation markup to a model. */
export function stripCitations(text: string): string {
  return text.replace(/:?:codex-file-citation\{[^{}]*?path="([^"]+)"[^{}]*\}\.?/g, (_, p: string) => {
    const base = p.split('/').pop() ?? p;
    return '`' + base + '`';
  });
}

/** Memoized: react-markdown parses synchronously on every render, and the chat
 *  re-renders per streamed token — without memo the WHOLE transcript re-parses
 *  markdown on each chunk.
 *
 *  `tail` carries the folded machinery chip (and the agent's clock) on the
 *  last line of the prose: that paragraph goes inline and the chip continues
 *  it. There is no head chip any more — a gear opening a paragraph read as a
 *  bullet (04.10.2026). A row of its own (27.09) doubled every short status line;
 *  back on the line since 28.09.2026 — «Metadata rides the line again» in
 *  styles.css. */
export const Md = memo(function Md({
  text,
  tail,
}: {
  text: string;
  tail?: ReactNode;
}) {
  const cls = `md${tail ? ' chip-tail' : ''}`;
  const lib = useMarkdownLib();
  const Markdown = lib?.Markdown;
  return (
    <div className={cls}>
      {Markdown ? (
        <Markdown
          remarkPlugins={[lib!.gfm]}
          components={MD_COMPONENTS}
          urlTransform={(u: string, key: string) => mdUrlTransform(u, key, lib!.defaultUrlTransform)}
        >
          {stripCitations(text)}
        </Markdown>
      ) : (
        // Until the chunk lands: the same words, unstyled. Never a spinner —
        // this sits inside a streaming transcript.
        <p className="md-plain">{stripCitations(text)}</p>
      )}
      {/* A real space, not a margin: at a wrap it collapses, so the chip
          starts the next line flush instead of indented by 5px. */}
      {tail && ' '}
      {tail && <div className="chip-inline tail">{tail}</div>}
    </div>
  );
});

/** URLs in a human turn (plain text, not markdown) become links that open
 *  beside the app, same as in agent prose. Trailing sentence punctuation stays
 *  outside the link. */
export function linkifyPlain(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(/https?:\/\/[^\s<>"']+/g)) {
    const raw = m[0];
    const url = raw.replace(/[.,;:!?)\]}»”]+$/, '');
    const at = m.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    out.push(<MdLink key={at} href={url}>{url}</MdLink>);
    last = at + url.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** User prompt text rendered PLAIN (no markdown), with `<image …>` pseudo-tags
 *  folded into attachment chips. */
function userSegments(text: string): ReactNode[] {
  return text
    .split(/(<image\b[^>\n]*>|<\/image>)/g)
    .map((p, i) => {
      if (/^<\/image>$/.test(p)) return null;
      const m = /^<image\b([^>\n]*)>$/.exec(p);
      if (m) {
        const name = /name=\[?([^\]">]*?)\]?(?:\s|$)/.exec(m[1] ?? '')?.[1]?.trim() || 'image';
        return (
          <span key={i} className="att-chip">
            <ImageIcon size={12} /> {name}
          </span>
        );
      }
      return p ? <span key={i}>{linkifyPlain(p)}</span> : null;
    })
    .filter(Boolean);
}

const LONG_CHARS = 450;
const LONG_LINES = 6;

/** A user turn. Long pasted prompts collapse to a faded preview with a
 *  Show more toggle (the Claude VSCode extension's pattern) so a wall of
 *  injected context doesn't drown the dialog. */
/**
 * `stamp` is the turn's clock, and it renders INSIDE the plate on purpose.
 *
 * As a sibling of the plate it was a grid item of its own, which means a row of
 * its own: a blank band under every human turn holding one 11px time, aligned
 * to the message's right edge rather than the plate's — so it hung off the
 * corner, level with nothing. Floated into the end of the text it lands on the
 * last line when there is room and drops only when there is not, which is the
 * messenger convention and costs no row at all.
 */
/** What the sticky plate repeats of a human turn: its first few hundred
 *  characters on one line — it shows two lines at most. */
function askText(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 400);
}

function UserText({ text, stamp, attachments }: { text: string; stamp?: ReactNode; attachments?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const long = text.length > LONG_CHARS || text.split('\n').length > LONG_LINES;
  return (
    <div className={`usertext ${long && !open ? 'clamped' : ''}`}>
      <div className="usertext-body">
        {userSegments(text)}
        {attachments}
        {stamp}
      </div>
      {long && (
        <button className="usertext-more" onClick={() => setOpen((o) => !o)}>
          {open ? 'Свернуть' : 'Показать полностью'}
        </button>
      )}
    </div>
  );
}

export function TodoList({ todos }: { todos: Array<Record<string, unknown>> }) {
  return (
    <ul className="todos">
      {todos.map((t, i) => {
        const status = String(t['status'] ?? 'pending');
        const mark = status === 'completed' ? '✓' : status === 'in_progress' ? '▸' : '○';
        return (
          <li key={i} className={`todo ${status}`}>
            <span className="mark">{mark}</span>
            {String(t['content'] ?? '')}
          </li>
        );
      })}
    </ul>
  );
}

function Diff({ oldStr, newStr }: { oldStr: string; newStr: string }) {
  return (
    <div className="diff">
      {oldStr.split('\n').map((l, i) => (
        <div key={`o${i}`} className="del">
          - {l}
        </div>
      ))}
      {newStr.split('\n').map((l, i) => (
        <div key={`n${i}`} className="add">
          + {l}
        </div>
      ))}
    </div>
  );
}

/**
 * What a tool DID, in three kinds — not six decorative hues.
 *
 * The old cycle (gold / ember-deep / green / plum / info-blue / cocoa) was an
 * identity palette: it told you which tool ran, which the label beside it
 * already says. Colour is better spent on what the label does not carry —
 * whether the call touched anything. `read` inspects and is safe; `act` writes
 * or executes and has consequences; `err` failed.
 */
function toolFamily(name: string): string {
  const n = name.toLowerCase();
  if (/read|glob|grep|^ls$|search|web|fetch|todo|plan|question/.test(n)) return 'read';
  if (n === '$' || /edit|write|notebook|bash|terminal|kill|monitor|exec|shell|agent|task|workflow|skill/.test(n)) return 'act';
  return '';
}

export function ToolUse({ name, input }: { name: string; input: unknown }) {
  const obj = (input ?? {}) as Record<string, unknown>;
  const shell = name === '$' && typeof obj['command'] === 'string';
  let body: JSX.Element;
  if (shell) {
    body = <CodeBlock className="code">{String(obj['command'])}</CodeBlock>;
  } else if (isPlanTool(name) && Array.isArray(obj['todos'])) {
    body = <TodoList todos={obj['todos'] as Array<Record<string, unknown>>} />;
  } else if (name === 'Edit' && typeof obj['old_string'] === 'string') {
    body = <Diff oldStr={String(obj['old_string'])} newStr={String(obj['new_string'] ?? '')} />;
  } else if ((name === 'Write' || name === 'NotebookEdit') && typeof obj['content'] === 'string') {
    body = <CodeBlock className="code">{String(obj['content'])}</CodeBlock>;
  } else if (name === 'Bash' && typeof obj['command'] === 'string') {
    body = <CodeBlock className="code">{String(obj['command'])}</CodeBlock>;
  } else {
    body = <CodeBlock className="code">{JSON.stringify(input, null, 2)}</CodeBlock>;
  }
  const subtitle =
    typeof obj['file_path'] === 'string'
      ? String(obj['file_path'])
      : typeof obj['description'] === 'string'
        ? String(obj['description'])
        : '';
  return (
    <details className="tool" open={isPlanTool(name)}>
      <summary>
        <span className={`tool-sq ${toolFamily(name)}`} aria-hidden>
          {callName(name, input).charAt(0).toUpperCase()}
        </span>
        <span className="tool-line">
          {shell ? `$ ${String(obj['command'])}` : `${callName(name, input)}${subtitle ? ` · ${subtitle}` : ''}`}
        </span>
      </summary>
      {body}
    </details>
  );
}

/** Label for a folded run of tool calls: how many, then the names in order of
 *  first appearance ("14 действий · Read×6 · Bash×4 · Grep"). Results are not
 *  counted — a result is the echo of a call, not a second action. Ported from
 *  the iOS `toolRunSummary`, which is what mobile shows in the same place. */
export function toolRunSummary(names: string[], current?: string): string {
  const order: string[] = [];
  const counts = new Map<string, number>();
  for (const n of names) {
    if (!counts.has(n)) order.push(n);
    counts.set(n, (counts.get(n) ?? 0) + 1);
  }
  const head = `${names.length} ${pluralRu(names.length, ['действие', 'действия', 'действий'])}`;
  if (current) return `${head} · сейчас: ${current}`;
  const parts = order.slice(0, 4).map((n) => (counts.get(n)! > 1 ? `${n}×${counts.get(n)}` : n));
  if (order.length > 4) parts.push('…');
  return `${head} · ${parts.join(' · ')}`;
}

/** The colorless mark of a folded run — service machinery, deliberately
 *  quieter than any single tool pill. Closed, CSS strips its plate down to the
 *  bare glyph so the chip cannot widen the prose line it rides. */
export function ToolRunIcon() {
  return (
    <span className="tool-sq run" aria-hidden>
      <GearIcon size={10} />
    </span>
  );
}

/**
 * Everything mechanical between two pieces of prose, folded into ONE service
 * capsule — however many messages it spanned. A reader came for the answer, not
 * for forty Read calls; opening the capsule unfolds the original pills, each
 * still its own toggle.
 */
export const ToolRunRow = memo(function ToolRunRow({ blocks }: { blocks: RenderBlock[] }) {
  // EVERY run folds, a one-call run included. The old passthrough rendered a
  // lone call as its own full-width `Read · queries-sales.sql` row, so a
  // transcript that had folded forty calls into one mark still spent whole
  // lines announcing single ones — the reader saw the machinery come back for
  // no reason it could name. One call is one mark, same as forty.
  const uses = blocks.flatMap((b) =>
    b.kind === 'tool_use' ? [{ name: callName(b.name, b.input), subtitle: subtitleOf(b.input) }] : [],
  );
  // A result-only run (its call sits in the prose turn above) folds to a quiet
  // "results" rather than a nonsense "0 actions".
  const label = !uses.length
    ? 'results'
    : uses.length === 1
      ? `${uses[0]!.name}${uses[0]!.subtitle ? ` · ${uses[0]!.subtitle}` : ''}`
      : toolRunSummary(uses.map((u) => u.name));
  return (
    // Closed, a run is a mark and a number in the gutter and nothing else — the
    // reader came for the answer and skims straight past forty Read calls. The
    // names appear when you open it, which is the moment you asked what it did.
    // The full label stays in `title` so hovering still answers without a click.
    <details className="toolrun" title={label}>
      <summary>
        <ToolRunIcon />
        {uses.length > 0 && <span className="toolrun-count">{uses.length}</span>}
        <span className="tool-line">{label}</span>
      </summary>
      <div className="toolrun-body">
        {blocks.map((b, i) => (
          <BlockView key={i} block={b} />
        ))}
      </div>
    </details>
  );
});

/**
 * The one line that says WHICH thing a call touched.
 *
 * It used to be the raw argument, so an edit deep inside a worktree spent the
 * whole row on `/srv/acme/.claude/worktrees/posthog-analytics/.gitignore` — the
 * part that identifies the file is the last segment, and every character before
 * it is the same prefix as the line above. Keep the basename, and keep a command
 * short enough that it stays one line. The full argument is still there when the
 * call is opened.
 */
function subtitleOf(input: unknown): string {
  const obj = (input ?? {}) as Record<string, unknown>;
  if (typeof obj['description'] === 'string') return clip(obj['description']);
  if (typeof obj['file_path'] === 'string') return baseName(obj['file_path']);
  if (typeof obj['command'] === 'string') return clip(obj['command']);
  return '';
}

function baseName(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

function clip(s: string, max = 48): string {
  const line = s.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** What a call is called in a folded run's label. A Codex shell call carries no
 *  tool name at all, so its first word ("grep", "deploy-prod") stands in for
 *  one — otherwise a run of ten commands reads "10 actions · $×10". */
function callName(name: string, input: unknown): string {
  // Our own plan tool is "План" to a person, never `mcp__hegai__plan`.
  if (name === PLAN_TOOL) return 'План';
  if (name !== '$') return name;
  const cmd = (input as Record<string, unknown> | null)?.['command'];
  return (typeof cmd === 'string' ? cmd.trim().split(/\s+/)[0] : '') || '$';
}

const STATUS_CHARS = 200;
const STATUS_LINES = 3;

/**
 * A live `status` line is usually one word ("done"), but Codex echoes a whole
 * command's stdout through the same channel — that is the wall of grep output a
 * chat used to turn into. Long ones fold into the service pill everything else
 * mechanical already uses; short ones stay the quiet centered line they were.
 * Plans (`✓ / ○` steps) never fold: they are the useful signal, not machinery.
 */
export function statusFolds(text: string): boolean {
  const lines = text.split('\n');
  // Plans (`✓ / ○` steps) never fold: they are the signal, not the machinery.
  if (lines.every((l) => !l.trim() || /^[✓○]/.test(l.trim()))) return false;
  return text.length > STATUS_CHARS || lines.length > STATUS_LINES;
}

export function StatusLine({ text, code }: { text: string; code?: string }) {
  // The compaction seam, live: the same rule the history draws from a
  // `compact_boundary` block, so a reload shows what the stream showed.
  if (code === 'compact_done') return <CompactSeam text={text} />;
  if (!statusFolds(text)) {
    return <div className={`line status${code && ATTENTION_CODES.has(code) ? ' attn' : ''}`}>{text}</div>;
  }
  const lines = text.split('\n');
  const thought = text.startsWith('💭');
  // Codex closes a command echo with "→ completed" — that verdict is the one
  // part worth keeping in the collapsed label.
  const tail = lines[lines.length - 1]!.trim();
  const verdict = tail.startsWith('→') ? ` ${tail}` : '';
  const count = lines.length - (verdict ? 1 : 0);
  const n10 = count % 10, n100 = count % 100;
  const lineWord = n10 === 1 && n100 !== 11 ? 'строка' : n10 >= 2 && n10 <= 4 && (n100 < 12 || n100 > 14) ? 'строки' : 'строк';
  const label = thought ? 'размышления' : `вывод · ${count} ${lineWord}${verdict}`;
  return (
    <details className={thought ? 'thinking' : 'tool-result out'}>
      <summary>
        {!thought && (
          <span className="tool-sq run" aria-hidden>
            ›
          </span>
        )}
        <span className="tool-line">{label}</span>
      </summary>
      {thought ? <div className="thinking-body">{text.replace(/^💭\s*/, '')}</div> : <CodeBlock className="code">{text}</CodeBlock>}
    </details>
  );
}

export function BlockView({ block }: { block: RenderBlock }) {
  switch (block.kind) {
    case 'text':
      return <Md text={block.text} />;
    case 'thinking':
      return (
        <details className="thinking">
          <summary>размышления</summary>
          <div className="thinking-body">{block.text}</div>
        </details>
      );
    case 'tool_use':
      return <ToolUse name={block.name} input={block.input} />;
    case 'tool_result':
      return (
        <details className={`tool-result ${block.isError ? 'err' : ''}`}>
          <summary>
            <span className={`tool-sq ${block.isError ? 'err' : ''}`} aria-hidden>
              {block.isError ? '!' : '✓'}
            </span>
            <span className="tool-line">{block.isError ? 'ошибка инструмента' : 'результат инструмента'}</span>
          </summary>
          <CodeBlock className="code">{block.text.slice(0, 4000)}</CodeBlock>
        </details>
      );
    // History carries an image as a marker — the bytes deliberately stay out of
    // the transcript payload (see RenderBlockSchema in shared), or every reload
    // of a session full of screenshots would pay for all of them. The marker
    // now carries a `ref`, and `Attachment` trades it for the picture when the
    // picture is about to be on screen. Without a ref, or outside a session
    // that can fetch, it is the placeholder chip this used to be.
    case 'image':
      // A picture the runtime made (Codex `image_gen`, `hegai-image`) is the
      // agent's answer — large, with its prompt — not a small attachment.
      if (block.generated) return <GeneratedImage blockRef={block.ref} prompt={block.prompt} />;
      return <Attachment blockRef={block.ref} />;
    case 'compact_boundary':
      return <CompactSeam trigger={block.trigger} pre={block.preTokens} post={block.postTokens} />;
    case 'compact_summary':
      return (
        <details className="compact-summary">
          <summary>
            <span className="tool-sq run" aria-hidden>
              ›
            </span>
            <span className="tool-line">пересказ предыдущего контекста</span>
          </summary>
          <Md text={block.text} />
        </details>
      );
  }
}

/**
 * The seam where the runtime replaced the earlier turns with a summary. One
 * rule with a mono-caps label, the way the design marks a section rather than
 * a field: history on one side of it is what the model no longer carries.
 * Rendered from a `compact_boundary` block on reload and from the live
 * `compact_done` line, so the two paths look the same.
 */
export function CompactSeam({
  trigger,
  pre,
  post,
  text,
}: {
  trigger?: 'manual' | 'auto';
  pre?: number;
  post?: number;
  text?: string;
}) {
  const k = (n?: number) => (typeof n === 'number' ? `${Math.round(n / 1000)}k` : undefined);
  const nums = k(pre) && k(post) ? ` · ${k(pre)} → ${k(post)}` : k(pre) ? ` · ${k(pre)} →` : '';
  const label = text ?? `контекст сжат${trigger === 'auto' ? ' автоматически' : ''}${nums}`;
  return (
    <div className="compact-seam" role="separator" aria-label={label}>
      <span className="compact-seam-label">{label}</span>
    </div>
  );
}

// One definition, shared with the Telegram bot; re-exported for the readers
// (Chat, Mirror, enrich) that import it from here.
export { stripHarnessNoise };

/** Drop what renders as an empty box, and clean what renders as noise. */
function cleanBlocks(blocks: RenderBlock[]): RenderBlock[] {
  const out: RenderBlock[] = [];
  for (const b of blocks) {
    if (b.kind === 'text') {
      const text = stripHarnessNoise(b.text);
      if (text) out.push({ ...b, text });
    } else if (b.kind === 'thinking') {
      if (b.text.trim()) out.push(b);
    } else if (b.kind === 'tool_result') {
      // An empty result that failed still matters — the error is the signal.
      if (b.text.trim() || b.isError) out.push(b);
    } else {
      out.push(b);
    }
  }
  return out;
}

/** A streamed `tool_use` line arrives as "ToolName {json}" (see the agent's
 *  claude-session emit). Split it back into name + input so it renders through
 *  the same quiet, collapsed <ToolUse> as the history/mirror view instead of a
 *  loud green JSON dump. */
export function parseToolLine(text: string): { name: string; input: unknown } {
  // Codex streams a shell call as "$ <command>" — splitting that on the first
  // space named every pill "$" and threw the command away, which is why a Codex
  // session used to be a column of identical "$" pills.
  if (text.startsWith('$ ')) return { name: '$', input: { command: text.slice(2) } };
  const sp = text.indexOf(' ');
  if (sp === -1) return { name: text, input: {} };
  const rest = text.slice(sp + 1);
  try {
    return { name: text.slice(0, sp), input: JSON.parse(rest) };
  } catch {
    return { name: text.slice(0, sp), input: rest };
  }
}

/** A live line is machinery when it is a tool call, or the long stdout echo
 *  Codex writes through the `status` channel after every command, or a line
 *  the CLI wrote to its stderr (`stderr` — a log, folded with the rest of the
 *  run's machinery). Short status notices that carry actual information stay
 *  visible; the synthetic "session resumed" line is no longer emitted. */
function isMachineryLine(l: TranscriptLine): boolean {
  // A picture card is the turn's result, never backstage — even a long failure.
  if (isImageGenLine(l)) return false;
  if (l.kind === 'tool_use') return true;
  if (l.kind === 'status' && l.code && BACKSTAGE_CODES.has(l.code)) return true;
  // A Codex reasoning summary, short or long: the agent thinking aloud is
  // backstage too — what it concluded comes as prose.
  if (l.kind === 'status' && l.text.startsWith('💭')) return true;
  return (l.kind === 'status' || l.kind === 'result') && statusFolds(l.text);
}

/** The live card of a picture being drawn, drawn or failed: user-visible output, never
 *  folded into the machinery chip. */
function isImageGenLine(l: TranscriptLine): boolean {
  return l.kind === 'status' && l.code === 'image_gen';
}

/** Status codes that are the run's backstage, not the reading: a tool the CLI
 *  refused («Bash не выполнен — запрещено правилом в настройках»), the CLI's
 *  own notices, its stderr and command echoes. The transcript is the agent's
 *  prose and nothing else (Владелец, 04.10.2026); these fold into the machinery
 *  chip, where the open capsule still lists them. History never had them in
 *  the reading either — a refusal there is a tool_result inside the run. */
const BACKSTAGE_CODES = new Set(['stderr', 'command_output', 'permission_denied', 'notification']);

/** Status codes a person must notice: the run is waiting on something outside
 *  itself, and «working…» alone would read as a hang. */
const ATTENTION_CODES = new Set(['api_retry', 'rate_limit', 'model_error', 'turn_failed', 'compact_failed', 'stopped', 'control_failed', 'tool_error']);

export type LiveItem =
  | {
      kind: 'line';
      id: string;
      line: TranscriptLine;
      cont: boolean;
      /** Whether this line PRINTS its stamp — same rule as history's. */
      showStamp: boolean;
      /** Finished machinery this line reports on — inline chip at its head. */
      runBefore?: TranscriptLine[];
      /** Machinery this line announced — inline chip at its end. `tail` marks
       *  the transcript's last run, the one that may still be streaming. */
      runAfter?: { lines: TranscriptLine[]; tail: boolean };
    }
  | { kind: 'run'; id: string; lines: TranscriptLine[]; tail: boolean };

/** The live twin of `groupHistory`: consecutive machinery folds into one
 *  capsule. `system` lines are init/model noise and drop outright.
 *  Continuation mirrors history too: an assistant line straight after another
 *  assistant line (machinery in between never breaks it, any other spoken
 *  line does) merges into the same flowing turn, and runs fold onto their
 *  neighbouring assistant line the same way attachRuns does for history. */
export function groupLive(lines: TranscriptLine[]): LiveItem[] {
  const out: LiveItem[] = [];
  let run: TranscriptLine[] = [];
  let lastSpeech: TranscriptLine['kind'] | null = null;
  const seen = stampedOnce();
  const flush = (tail: boolean) => {
    if (!run.length) return;
    // A LONE call folds too. It used to keep its own row on the theory that one
    // pill is quieter than a capsule around it; live, that is what put a
    // full-width `Edit · product-standards.md` back into the transcript between
    // two paragraphs. Folded, it is the same mark as any other run.
    out.push({ kind: 'run', id: `r-${run[0]!.id}`, lines: run, tail });
    run = [];
  };
  for (const l of lines) {
    if (l.kind === 'system') continue;
    if (isMachineryLine(l)) run.push(l);
    else {
      flush(false);
      // A finished-or-drawing picture speaks as the agent (history carries it on
      // an assistant message of its own), so prose after it continues the turn.
      const speaks = l.kind === 'assistant' || isImageGenLine(l);
      const cont = speaks && lastSpeech === 'assistant';
      out.push({
        kind: 'line',
        id: `l-${l.id}`,
        line: l,
        cont,
        showStamp: seen(l.ts, cont),
      });
      lastSpeech = speaks ? 'assistant' : l.kind;
    }
  }
  flush(true);
  stampAgentAtEnd(
    out,
    (it) => (it.kind === 'line' ? { ts: it.line.ts, agent: it.line.kind === 'assistant', cont: it.cont } : undefined),
    (it, show) => {
      if (it.kind === 'line') it.showStamp = show;
    },
  );
  return attachLiveRuns(out);
}

/** The live mirror of `attachRuns`: a run rides the assistant line that
 *  announced it, or the one that reports on it. */
function attachLiveRuns(items: LiveItem[]): LiveItem[] {
  const speaks = (it: LiveItem | undefined): it is Extract<LiveItem, { kind: 'line' }> =>
    it?.kind === 'line' && it.line.kind === 'assistant';
  const out: LiveItem[] = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i]!;
    if (it.kind === 'run') {
      const prev = out[out.length - 1];
      if (speaks(prev) && !prev.runAfter) {
        prev.runAfter = { lines: it.lines, tail: it.tail };
        continue;
      }
      const next = items[i + 1];
      if (speaks(next) && !next.runBefore) {
        next.runBefore = it.lines;
        continue;
      }
    }
    out.push(it);
  }
  return out;
}

/** One streamed line, rendered in the same language as history. */
/**
 * Who is talking, in the 76px gutter: the warm mark this app uses for identity
 * everywhere else, plus a name you can actually read.
 *
 * Deliberately NOT a chat bubble. Bubbles encode two people saying comparable
 * things; here a person writes a short instruction and the agent returns a
 * structured document, so the transcript is set as one — a shared measure under
 * a gutter that names the speaker (DESIGN.md, «Транскрипт»).
 *
 * Shared by both renderers on purpose: this markup existed only in `MessageView`
 * and the live stream never got it.
 */
function SpeakerGutter({ name }: { name: string }) {
  return (
    <span className="who">
      <Avatar tone={name} label={name} size="xs" />
      <span className="who-name">{name}</span>
    </span>
  );
}

/** The gutter stamp on a LIVE turn. Same element and same rule as history's —
 *  the two renderers drifting is how the live half lost its speaker gutter
 *  once already. Nothing renders when the line predates stamping. */
function LineStamp({ ts }: { ts?: number }) {
  if (ts === undefined) return null;
  return (
    <time className="when" dateTime={new Date(ts).toISOString()}>
      {stamp(ts)}
    </time>
  );
}

/**
 * What you attached to the turn you just sent.
 *
 * Only on the LIVE line, and only for the person who sent it — the bytes are
 * the ones that went on the wire a moment ago. History cannot show this: the
 * agent strips image data out of `session.messages` deliberately, so a reload
 * replaces these with the grey «image» chip the block renderer draws. That is
 * the honest limit, and it is still better than the old behaviour, where a
 * message carrying both text and pictures showed no sign of the pictures at
 * all and you could not tell whether they had gone.
 *
 * The thumbnail opens the shared full-size lightbox — an attachment you cannot
 * look at is a receipt, not a picture.
 */
function Attached({ images, files }: { images?: string[]; files?: string[] }) {
  const [open, setOpen] = useState<string | null>(null);
  if (!images?.length && !files?.length) return null;
  return (
    <>
      <div className="msg-attached">
        {images?.map((src, i) => (
          <button
            key={i}
            type="button"
            className="ma-shot"
            onClick={() => setOpen(src)}
            title="Открыть картинку"
          >
            <img src={src} alt={`Вложение ${i + 1}`} />
          </button>
        ))}
        {files?.map((name) => (
          <span className="ma-file" key={name}>
            {name}
          </span>
        ))}
      </div>
      {open && <ImageLightbox url={open} onClose={() => setOpen(null)} />}
    </>
  );
}

export function LiveLine({
  line,
  cont = false,
  showStamp = true,
  agent = 'Claude',
  you = 'Вы',
  runBefore,
  runBeforeHistory,
  runAfter,
  runCurrent = false,
}: {
  /** The history's trailing run, folded into this line's leading chip. */
  runBeforeHistory?: RenderBlock[];
  line: TranscriptLine;
  cont?: boolean;
  /** Print the gutter stamp — silenced by `groupLive` when it would repeat. */
  showStamp?: boolean;
  /** Which runtime answers here — same value `MessageView` gets. */
  agent?: string;
  /** What to call the reader on their own turns (`viewerName`). */
  you?: string;
  /** Attached machinery (see LiveItem) — folded into the line's own prose. */
  runBefore?: TranscriptLine[];
  runAfter?: TranscriptLine[];
  /** The attached runAfter is the transcript tail of a busy run. */
  runCurrent?: boolean;
}) {
  // The live stream and loaded history are two renderers of the same thing, and
  // they had drifted: history grew the mark-plus-name gutter while this side was
  // left with a bare lowercase "you" on human turns and NOTHING at all on the
  // agent's. Mid-conversation that reads as one anonymous column of text. Same
  // gutter both sides now — see `SpeakerGutter`.
  const notLoggedIn = line.kind === 'assistant' || line.kind === 'error' ? notLoggedInRuntime(line.text) : undefined;
  if (notLoggedIn) return <NotLoggedIn runtime={notLoggedIn} />;
  if (line.kind === 'assistant')
    return (
      <div className={cont ? 'msg assistant cont' : 'msg assistant'}>
        {!cont && <SpeakerGutter name={agent} />}
        {/* The clock rides the end of the text, beside the machinery chip —
            same as history (`stampInline` in MessageView). */}
        <Md
          text={line.text}
          tail={
            runBefore || runBeforeHistory || runAfter || (showStamp && line.ts !== undefined) ? (
              <>
                {/* ONE gear per paragraph, at its END: the machinery it reports
                    on and the machinery it announced share the chip. A chip at
                    the head of the prose read as a bullet (04.10.2026). */}
                {(runBefore || runBeforeHistory || runAfter) && (
                  <LiveRunRow
                    lines={[...(runBefore ?? []), ...(runAfter ?? [])]}
                    current={!!runAfter && runCurrent}
                    before={runBeforeHistory}
                  />
                )}
                {showStamp && <LineStamp ts={line.ts} />}
              </>
            ) : undefined
          }
        />
        {/* Not while the line is still being typed: a half-written path would
            ask the agent for a file that does not exist yet. */}
        {!line.streaming && <FilePreviews text={line.text} />}
        <SubagentCards
          calls={[...agentCallsFromBlocks(runBeforeHistory), ...agentCallsFromLines([...(runBefore ?? []), ...(runAfter ?? [])])]}
        />
      </div>
    );
  if (line.kind === 'user')
    return (
      // `data-ask`: the question the sticky plate over the transcript repeats
      // while its answer scrolls by (Chat.tsx, StickyAsk).
      <div className={cont ? 'msg user cont' : 'msg user'} data-ask={askText(line.text)}>
        {!cont && <SpeakerGutter name={you} />}
        <UserText
          text={line.text}
          attachments={<Attached images={line.images} files={line.files} />}
          stamp={showStamp ? <LineStamp ts={line.ts} /> : undefined}
        />
      </div>
    );
  if (line.kind === 'tool_use') {
    const { name, input } = parseToolLine(line.text);
    return <ToolUse name={name} input={input} />;
  }
  if (isImageGenLine(line) && line.data) {
    return (
      <div className={cont ? 'msg assistant cont' : 'msg assistant'}>
        {!cont && <SpeakerGutter name={agent} />}
        <ImageGenCard data={line.data as unknown as ImageGenEventData} />
      </div>
    );
  }
  if (line.kind === 'status' || line.kind === 'result') return <StatusLine text={line.text} code={line.code} />;
  // The gateway refusing for quota is not a failure of the run — the session
  // is kept and waits for the reset — so it gets a card that says so, not a
  // red mono line that reads as "it broke".
  if (isBudgetLine(line)) return <BudgetCard />;
  // A failed TURN: the run is alive and takes the next message. Say so in the
  // line, or «error» alone reads as the session having died.
  if (line.kind === 'error' && line.code === 'turn_failed') {
    return (
      <div className="line error">
        ход не удался: {line.text}
        <span className="line-hint"> · сессия жива, можно писать дальше</span>
      </div>
    );
  }
  return <div className={`line ${line.kind}`}>{line.text}</div>;
}

/** The CLI's raw «Not logged in · Please run /login» says nothing a person
 *  can act on from the web. Say what it means and where the button is. */
export function NotLoggedIn({ runtime }: { runtime: 'claude' | 'codex' }) {
  return (
    <div className="rt-notice">
      <b>{runtime === 'claude' ? 'Claude' : 'Codex'} на этой машине не вошёл в аккаунт</b> — сессия не может ответить.{' '}
      Откройте <a {...linkProps({ kind: 'settings', tab: 'hardware' })}>Настройки → Машины</a>, нажмите «Войти» у{' '}
      {runtime === 'claude' ? 'Claude Code' : 'Codex'} и повторите сообщение.
    </div>
  );
}

/** A folded run of live machinery. While the run is still working, the label
 *  says what is executing right now instead of a stale count. */
export function LiveRunRow({
  lines,
  current,
  before,
}: {
  lines: TranscriptLine[];
  current: boolean;
  /** A run the loaded HISTORY ended on, with nothing between it and this one.
   *  Folded in front: the same stretch of machinery is one mark, not «⚙ 5»
   *  over «⚙ 11» just because the first part was already on disk (29.09.2026). */
  before?: RenderBlock[];
}) {
  const past = (before ?? []).flatMap((b) => (b.kind === 'tool_use' ? [{ name: b.name, input: b.input }] : []));
  const uses = [...past, ...lines.filter((l) => l.kind === 'tool_use').map((l) => parseToolLine(l.text))];
  const named = (u: { name: string; input: unknown }) => {
    const sub = subtitleOf(u.input);
    return sub ? `${callName(u.name, u.input)} · ${sub}` : callName(u.name, u.input);
  };
  const last = uses[uses.length - 1];
  const label = !uses.length
    ? 'вывод'
    : uses.length === 1
      ? named(uses[0]!)
      : toolRunSummary(
          uses.map((u) => callName(u.name, u.input)),
          current && last ? named(last) : undefined,
        );
  return (
    <details className="toolrun" title={label}>
      <summary>
        <ToolRunIcon />
        {/* While the run is live the count keeps climbing, which is the one
            thing worth watching from the outside of a closed capsule. */}
        {uses.length > 0 && <span className="toolrun-count">{uses.length}</span>}
        <span className="tool-line">{label}</span>
      </summary>
      <div className="toolrun-body">
        {before?.map((b, i) => (
          <BlockView key={`h${i}`} block={b} />
        ))}
        {lines.map((l) => (
          <LiveLine key={l.id} line={l} />
        ))}
      </div>
    </details>
  );
}

function isMechanical(b: RenderBlock): boolean {
  return b.kind === 'tool_use' || b.kind === 'tool_result' || b.kind === 'thinking';
}

export type TranscriptItem =
  | {
      kind: 'msg';
      id: string;
      msg: HistoryMessage;
      cont: boolean;
      /** Whether this turn PRINTS its stamp. False when the turn before it
       *  already shows the same one — see `stampedOnce`. */
      showStamp: boolean;
      /** Machinery that ran BEFORE this prose (the turn opened with tools and
       *  the text reports their result) — rendered as an inline chip at the
       *  head of the first line. */
      runBefore?: RenderBlock[];
      /** Machinery that ran AFTER this prose (the text announced it — «Теперь
       *  роут:») — an inline chip at the end of the last line. */
      runAfter?: RenderBlock[];
    }
  | { kind: 'run'; id: string; blocks: RenderBlock[] }
  /** The compaction seam and the summary behind it — a `system` message that
   *  IS conversation, unlike the hook output the others carry. */
  | { kind: 'seam'; id: string; blocks: RenderBlock[] };

/**
 * The stamp gate both renderers share: answers "does THIS turn print its time",
 * and remembers the last one it said yes to.
 *
 * A stamp on every turn was the point — "when was this one" has a different
 * answer per turn — but only while the answers differ. They routinely do not: a
 * single turn that interleaves prose and tools splits into several items which
 * all carry the SAME `ts`, and a burst of turns lands inside one minute. Printed
 * literally that is the same four characters ten rows down the gutter, which
 * answers nothing and turns the mono column into wallpaper — the failure
 * DESIGN.md names for the eyebrow, arrived at from the other side.
 *
 * So a CONTINUATION prints its stamp only when the stamp changed. A turn that
 * introduces itself always prints one: the gutter is a unit — mark, name, time —
 * and the stamp sits under the name it belongs to. Silencing it there detaches
 * the stamp above from its own turn and floats it between two speakers, which a
 * screenshot of the first version of this rule showed plainly. A repeat one row
 * below a different name is not wallpaper; it re-anchors a new block.
 *
 * Note this is NOT the old "stamp the first of a group" rule: that was the
 * run-level dateline this replaced, and it left the turn you were reading
 * unstamped three screens below its own date. A continuation still prints the
 * moment its minute — or its day, which `stamp` spells differently — moves.
 */
function stampedOnce(): (ts: number | undefined, cont: boolean) => boolean {
  let shown: string | undefined;
  return (ts, cont) => {
    if (ts === undefined) return false;
    const s = stamp(ts);
    if (cont && s === shown) return false;
    shown = s;
    return true;
  };
}

/**
 * The transcript regrouped at BLOCK level, the way the iOS ChatView already
 * reads: between any two pieces of prose, everything mechanical — tool calls
 * embedded in a mixed turn, whole tool-result messages, thinking — folds into
 * exactly ONE service row, however many messages it spans. Grouping per MESSAGE
 * instead fragments the moment a turn carries text *and* tools: every turn draws
 * its own capsule and nothing is actually folded.
 */
export function groupHistory(history: HistoryMessage[]): TranscriptItem[] {
  const out: TranscriptItem[] = [];
  let run: RenderBlock[] = [];
  let runId = '';
  let runSeq = 0;
  // Consecutive same-speaker turns CONTINUE each other: the second one drops
  // its header and top rule and reads as the next paragraph, not a new entry.
  // Runs never break a merge (machinery between two paragraphs is still the
  // same person talking); a change of speaker or of calendar day does. Absent
  // timestamps degrade to speaker-only merging — exactly where the day marks
  // themselves degrade to nothing.
  let lastSpeaker: 'user' | 'assistant' | null = null;
  let lastTs: number | undefined;
  const sameDay = (a?: number, b?: number) =>
    a === undefined || b === undefined || dayKey(a) === dayKey(b);
  const seen = stampedOnce();
  const pushMsg = (id: string, msg: HistoryMessage, speaker: 'user' | 'assistant') => {
    const cont = speaker === lastSpeaker && sameDay(lastTs, msg.ts);
    out.push({ kind: 'msg', id, msg, cont, showStamp: seen(msg.ts, cont) });
    lastSpeaker = speaker;
    if (msg.ts !== undefined) lastTs = msg.ts;
  };
  const flushRun = () => {
    if (!run.length) return;
    out.push({ kind: 'run', id: `r-${runId}`, blocks: run });
    run = [];
  };
  for (const msg of history) {
    // `system` turns are hook output and CLI caveats, not conversation — with
    // one exception: the compaction seam (and the summary the runtime wrote
    // behind it), which is the only way a reload can show where the history
    // the model carries actually begins.
    if (msg.type === 'system') {
      const seam = msg.blocks.filter((b) => b.kind === 'compact_boundary' || b.kind === 'compact_summary');
      if (seam.length) {
        flushRun();
        out.push({ kind: 'seam', id: `s-${msg.uuid}`, blocks: seam });
        lastSpeaker = null;
      }
      continue;
    }
    const blocks = cleanBlocks(msg.blocks);
    if (!blocks.length) continue;
    // A human turn renders whole (bubble + attachments) and hard-flushes; a user
    // message carrying only tool results is the runtime talking, not a person.
    if (msg.type === 'user' && !blocks.every(isMechanical)) {
      flushRun();
      pushMsg(`m-${msg.uuid}`, { ...msg, blocks }, 'user');
      continue;
    }
    let prose: RenderBlock[] = [];
    let proseIdx = 0;
    const flushProse = () => {
      if (!prose.length) return;
      const uuid = `${msg.uuid}-p${proseIdx}`;
      // Prose reaching this loop is always assistant-authored: a user message
      // with a text block took the bubble branch above.
      pushMsg(`m-${uuid}`, { ...msg, uuid, blocks: prose }, 'assistant');
      proseIdx += 1;
      prose = [];
    };
    for (const b of blocks) {
      // A generated picture is the agent's answer, not machinery: it breaks the
      // run and stands as its own turn, like prose.
      if (b.kind === 'text' || (b.kind === 'image' && b.generated)) {
        flushRun();
        prose.push(b);
      } else {
        flushProse();
        // A run id stays unique even when one message opens two runs
        // (tools → text → tools), so it carries a sequence.
        if (!run.length) runId = `${msg.uuid}-${runSeq++}`;
        run.push(b);
      }
    }
    flushProse();
  }
  flushRun();
  stampAgentAtEnd(
    out,
    (it) => (it.kind === 'msg' ? { ts: it.msg.ts, agent: it.msg.type === 'assistant', cont: it.cont } : undefined),
    (it, show) => {
      if (it.kind === 'msg') it.showStamp = show;
    },
  );
  return attachRuns(out);
}

/**
 * The agent's stamp goes at the END of a minute, not the start.
 *
 * `stampedOnce` prints the first turn of a minute and silences the rest, which
 * is right for YOUR turns (the time you asked) but wrong for the agent's: a
 * reply of three paragraphs landing inside 21:08 printed its clock under the
 * first one and left the last — the one you are looking at when you wonder
 * «when did it last say anything» — bare. So within a chain of agent turns
 * (same speaker, `cont`), a turn prints only when the NEXT one in the chain
 * would print something different, or when there is no next one. The same
 * minute is still never said twice in a row.
 */
function stampAgentAtEnd<T>(
  items: T[],
  read: (it: T) => { ts?: number; agent: boolean; cont: boolean } | undefined,
  write: (it: T, show: boolean) => void,
): void {
  const spoken = items.filter((it) => read(it) !== undefined);
  for (let i = 0; i < spoken.length; i++) {
    const cur = read(spoken[i]!)!;
    if (!cur.agent) continue;
    if (cur.ts === undefined) {
      write(spoken[i]!, false);
      continue;
    }
    // The next agent turn in this chain that carries a time. An untimed one in
    // between is not a break — it prints nothing either way.
    let nx: { ts?: number; agent: boolean; cont: boolean } | undefined;
    for (let j = i + 1; j < spoken.length; j++) {
      const r = read(spoken[j]!)!;
      if (!r.agent || !r.cont) break;
      if (r.ts !== undefined) {
        nx = r;
        break;
      }
    }
    write(spoken[i]!, !(nx?.ts !== undefined && stamp(nx.ts) === stamp(cur.ts)));
  }
}

/**
 * A run belongs to the prose that frames it, not to the space between turns:
 * «Теперь роут:» ANNOUNCES the machinery that follows, and a turn that opens
 * with tools reports their result in the text after. So a run folds onto its
 * neighbouring assistant prose — the preceding one first (the announce pattern
 * dominates), the following one when the run opened the exchange — and only a
 * run with no assistant prose on either side stays a row of its own.
 */
function attachRuns(items: TranscriptItem[]): TranscriptItem[] {
  // A run rides the END of a paragraph; a picture-only turn (a generated
  // image) has none, so it would swallow the chip unseen.
  const hasProse = (m: HistoryMessage) => m.blocks.some((b) => b.kind === 'text');
  const out: TranscriptItem[] = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i]!;
    if (it.kind === 'run') {
      const prev = out[out.length - 1];
      if (prev?.kind === 'msg' && prev.msg.type === 'assistant' && hasProse(prev.msg) && !prev.runAfter) {
        prev.runAfter = it.blocks;
        continue;
      }
      const next = items[i + 1];
      if (next?.kind === 'msg' && next.msg.type === 'assistant' && hasProse(next.msg) && !next.runBefore) {
        next.runBefore = it.blocks;
        continue;
      }
    }
    out.push(it);
  }
  return out;
}

/** Memoized: history messages are immutable once parsed, so appending one
 *  message (or streaming into the live tail) must not re-render the rest. */
export const MessageView = memo(function MessageView({
  msg,
  agent = 'Claude',
  you = 'Вы',
  cont = false,
  showStamp = true,
  runBefore,
  runAfter,
}: {
  msg: HistoryMessage;
  /** Which runtime is answering — the name shown on its turns. */
  agent?: string;
  /** What to call the reader on their own turns (`viewerName`). */
  you?: string;
  /** Continuation of the previous turn (same speaker, same day): no header, no
   *  dateline, and CSS collapses the seam — the turn reads as the next
   *  paragraph rather than a new entry. Computed by groupHistory. */
  cont?: boolean;
  /** Print the gutter stamp. Computed by groupHistory, which silences a stamp
   *  identical to the one above it (see `stampedOnce`). */
  showStamp?: boolean;
  /** Machinery folded into this turn's own prose (see TranscriptItem). Raw
   *  block arrays, not JSX: their identity is stable across the parent's
   *  streaming re-renders, which is what keeps this memo effective. */
  runBefore?: RenderBlock[];
  runAfter?: RenderBlock[];
}) {
  // `system` turns are hook output and CLI caveats, not conversation — the live
  // stream already drops them, so history should read the same.
  if (msg.type === 'system') return null;
  const cleaned = cleanBlocks(msg.blocks);
  if (!cleaned.length) return null;
  const isUser = msg.type === 'user';
  const blocks = cleaned;
  // A user message that only carries tool_result blocks is the runtime's
  // tool output, not a human turn — render it without the "you" bubble.
  //
  // Judged on the CLEANED blocks, because those are the ones that will be on
  // screen. Read from `msg.blocks` it judged a turn by content it was about to
  // throw away: the runtime wraps a tool result together with a line of harness
  // noise, `cleanBlocks` drops the noise, and what was left — a bare tool chip —
  // had already been classed as a human turn. So it rendered right-aligned, as
  // a lone «⊙ 1» floating on the person's side of a transcript they had said
  // nothing in.
  const onlyToolResults = blocks.every((b) => b.kind === 'tool_result');
  const isBubble = isUser && !onlyToolResults;
  const cls = isBubble ? 'msg user' : 'msg assistant';
  // Who is talking used to be 11px mono caps in --text-faint, the quietest tone
  // in the system, and only the human turn got a label at all — the agent's was
  // a CSS ::before. At a glance the two speakers read the same. The identity
  // motif everywhere else in this app is the warm gradient mark, so use it here
  // too: a mark plus a name that is actually legible, still in the gutter, still
  // out of the reading measure.
  const speaker = isBubble ? you : agent;
  const firstText = blocks.findIndex((b) => b.kind === 'text');
  const lastText = blocks.length - 1 - [...blocks].reverse().findIndex((b) => b.kind === 'text');
  // A plated turn with prose to hang the clock on. Without a text block (an
  // image on its own) there is no last line to float into, so the stamp stays
  // where it was.
  const stampInBubble = isBubble && firstText >= 0 && msg.ts !== undefined && showStamp;
  // The agent's clock rides the END of its last paragraph, beside the folded
  // machinery chip (27.09.2026, by request) — not a row of its own under the
  // turn. Only when that paragraph IS the end of the turn: a clock followed by
  // more blocks would be a time in the middle of a message.
  const stampInline = !isBubble && firstText >= 0 && lastText === blocks.length - 1 && msg.ts !== undefined && showStamp;
  // Attachment chips for a plated turn, to be carried inside the plate. Only
  // when there IS a plate to carry them: an image-only turn has no text block,
  // so its chip keeps the sibling path and renders on its own.
  const bubbleAtt =
    isBubble && firstText >= 0
      ? blocks
          .map((b, i) => (b.kind === 'image' ? <BlockView key={`att${i}`} block={b} /> : null))
          .filter(Boolean)
      : [];
  const ask = isBubble
    ? askText(blocks.map((b) => (b.kind === 'text' ? b.text : '')).filter(Boolean).join('\n'))
    : undefined;
  return (
    <div className={cont ? `${cls} cont` : cls} data-ask={ask || undefined}>
      {!cont && <SpeakerGutter name={speaker} />}
      {/* Any turn may be stamped, continuation or not: the header is what a run
          of same-speaker turns shares, the clock is not — "when was THIS one"
          usually has a different answer on each. Usually, not always: when the
          answer repeats verbatim, grouping already silenced it (stampedOnce). */}
      {/* On a plated turn the clock rides INSIDE the plate instead — see
          UserText. It only stays a sibling here for turns that have no plate to
          ride in, where the stylesheet hides it anyway. */}
      {msg.ts !== undefined && showStamp && !stampInBubble && !stampInline && (
        <time className="when" dateTime={new Date(msg.ts).toISOString()}>
          {stamp(msg.ts)}
        </time>
      )}
      {blocks.map((b, i) => {
        // An attachment on a plated turn belongs INSIDE the plate. It used to
        // render as a sibling of it, which put the chip on its own row BELOW
        // the message and pulled it to the LEFT edge (`justify-self: start`)
        // while the plate sits right — so a message with a picture read as two
        // unrelated things, and the clock floating in the plate above it looked
        // crooked by association. Nothing is dropped: an image-only turn still
        // renders its chip through the sibling path below.
        if (isBubble && b.kind === 'image') return null;
        // User turns are PLAIN TEXT, never markdown — CLI-injected context is
        // full of `#` lines that must not explode into h1s inside a bubble.
        if (isBubble && b.kind === 'text')
          return (
            <UserText
              key={i}
              text={b.text}
              attachments={i === lastText && bubbleAtt.length > 0 ? <>{bubbleAtt}</> : undefined}
              stamp={
                stampInBubble && i === lastText ? (
                  <time className="when" dateTime={new Date(msg.ts!).toISOString()}>
                    {stamp(msg.ts!)}
                  </time>
                ) : undefined
              }
            />
          );
        // Attached machinery rides the prose itself, at the END of the LAST
        // text block: what ran before this turn's prose and what it announced
        // are one chip. It used to open the first line when the prose reported
        // on it, and a gear at the head of a paragraph read as a bullet
        // (04.10.2026).
        // An agent text block that is EXACTLY the CLI's «not logged in» line
        // (history replays arrive here, not through the live renderer).
        if (!isBubble && b.kind === 'text') {
          const nl = notLoggedInRuntime(b.text);
          if (nl) return <Fragment key={i}><NotLoggedIn runtime={nl} /></Fragment>;
        }
        if (!isBubble && b.kind === 'text' && (runBefore || runAfter || stampInline)) {
          const ran = i === lastText ? [...(runBefore ?? []), ...(runAfter ?? [])] : [];
          const run = ran.length ? <ToolRunRow blocks={ran} /> : undefined;
          const clock =
            stampInline && i === lastText ? (
              <time className="when" dateTime={new Date(msg.ts!).toISOString()}>
                {stamp(msg.ts!)}
              </time>
            ) : undefined;
          const tail = run || clock ? <>{run}{clock}</> : undefined;
          if (tail)
            return (
              <Fragment key={i}>
                <Md text={b.text} tail={tail} />
                <FilePreviews text={b.text} />
              </Fragment>
            );
        }
        // The files an answer names (a screenshot's path on its last line) are
        // drawn under its text — the agent's prose only, never the person's
        // own message, thinking or tool output.
        if (!isBubble && b.kind === 'text')
          return (
            <Fragment key={i}>
              <BlockView block={b} />
              <FilePreviews text={b.text} />
            </Fragment>
          );
        return <BlockView key={i} block={b} />;
      })}
      {!isBubble && <SubagentCards calls={agentCallsFromBlocks([...(runBefore ?? []), ...(runAfter ?? [])])} />}
    </div>
  );
});
