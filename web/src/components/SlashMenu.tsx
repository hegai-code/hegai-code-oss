import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import type { CommandsResult, SlashCommandInfo } from '@cc-remote/shared';
import type { CentralState } from '../useCentral.js';

/**
 * The composer's «/» menu (28.09.2026, by request — Claude's VS Code extension
 * has one): type `/` at the start of the field, or press the «/» button, and
 * the session's commands and skills come up; ↑↓ to pick, Enter or Tab to put
 * `/name ` in the field, Esc to close. What is sent is ordinary text — the
 * agent hands `/name …` to the runtime as input, which is how the CLI runs it.
 *
 * The list comes from `commands.list`: the live run's own (built-ins, skills,
 * plugins) when there is one, the skills and commands on disk otherwise. Cached
 * per machine and session/folder for a few minutes — a skill added mid-session
 * shows up on the next open after that.
 */

const TTL_MS = 5 * 60_000;
const SHOWN = 60;
const cache = new Map<string, { at: number; list: SlashCommandInfo[] }>();

/** Prefix matches first (in list order), then the rest that contain the query. */
export function filterCommands(list: SlashCommandInfo[], query: string): SlashCommandInfo[] {
  const q = query.toLowerCase();
  if (!q) return list.slice(0, SHOWN);
  const starts: SlashCommandInfo[] = [];
  const contains: SlashCommandInfo[] = [];
  for (const c of list) {
    const n = c.name.toLowerCase();
    if (n.startsWith(q)) starts.push(c);
    else if (n.includes(q) || c.description?.toLowerCase().includes(q)) contains.push(c);
  }
  return [...starts, ...contains].slice(0, SHOWN);
}

/** The query while the field is a bare command being typed: `/`, `/ra`… —
 *  null once there is a space (the arguments have started) or no slash. */
export function slashQuery(draft: string): string | null {
  const m = /^\/(\S*)$/.exec(draft);
  return m ? m[1]! : null;
}

export function useSlashMenu({
  central,
  machineId,
  sessionId,
  cwd,
  enabled,
  draft,
  setDraft,
  taRef,
}: {
  central: Pick<CentralState, 'rpc'>;
  machineId: string;
  sessionId?: string;
  cwd?: string;
  /** Off for Codex: it has no slash commands we can drive. */
  enabled: boolean;
  draft: string;
  setDraft: (v: string) => void;
  taRef: RefObject<HTMLTextAreaElement | null>;
}): {
  /** Put before the field's own key handling; true = the menu took the key. */
  onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => boolean;
  /** The «/» button beside «+». */
  button: ReactNode;
  /** The popover, rendered inside the composer box. */
  menu: ReactNode;
} {
  const [list, setList] = useState<SlashCommandInfo[] | null>(null);
  const [index, setIndex] = useState(0);
  // Esc closes the menu for THIS draft; typing on reopens it.
  const [dismissed, setDismissed] = useState<string | null>(null);
  // The button opens it over a draft that is not a bare command — for that
  // draft only: typing on closes it, so Enter goes back to sending.
  const [forcedAt, setForcedAt] = useState<string | null>(null);
  const forced = forcedAt !== null && forcedAt === draft;
  const setForced = (on: boolean) => setForcedAt(on ? draft : null);
  const key = `${machineId}::${sessionId || cwd || ''}`;

  const typed = slashQuery(draft);
  const query = typed ?? (forced ? '' : null);
  const open = enabled && query !== null && dismissed !== draft;

  useEffect(() => {
    if (!open) return;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < TTL_MS) {
      setList(hit.list);
      return;
    }
    let cancelled = false;
    central
      .rpc<CommandsResult>(machineId, 'commands.list', { ...(sessionId ? { sessionId } : {}), ...(cwd ? { cwd } : {}) }, true)
      .then((r) => {
        const got = r.commands ?? [];
        cache.set(key, { at: Date.now(), list: got });
        if (!cancelled) setList(got);
      })
      .catch(() => {
        if (!cancelled) setList([]);
      });
    return () => {
      cancelled = true;
    };
  }, [open, key, central.rpc, machineId, sessionId, cwd]);

  const items = useMemo(() => (open && list ? filterCommands(list, query ?? '') : []), [open, list, query]);
  useEffect(() => setIndex(0), [query]);
  useEffect(() => {
    if (typed === null && !forced) setDismissed(null);
  }, [typed, forced]);

  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-i="${index}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [index]);

  const choose = (c: SlashCommandInfo) => {
    // Over a bare command the pick replaces it; opened by the button over
    // text, the command goes in front of what was written.
    const rest = typed === null ? draft.trim() : '';
    setDraft(`/${c.name} ${rest}`.replace(/\s+$/, ' '));
    setForced(false);
    setDismissed(null);
    requestAnimationFrame(() => {
      const ta = taRef.current;
      if (!ta) return;
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
    });
  };
  const close = () => {
    setForced(false);
    setDismissed(draft);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!open) return false;
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
      return true;
    }
    if (!items.length) return false;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const d = e.key === 'ArrowDown' ? 1 : -1;
      setIndex((i) => (i + d + items.length) % items.length);
      return true;
    }
    // ⌘/Ctrl+Enter always sends (enterShouldSend) — the menu never takes it.
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) return false;
    if ((e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) || e.key === 'Tab') {
      const c = items[Math.min(index, items.length - 1)];
      if (!c) return false;
      e.preventDefault();
      choose(c);
      return true;
    }
    return false;
  };

  const button = enabled ? (
    <button
      type="button"
      className="round-btn slash-btn"
      title="Команды и скиллы (/)"
      aria-label="Команды и скиллы"
      aria-expanded={open}
      onClick={() => {
        if (open) {
          close();
          return;
        }
        setDismissed(null);
        if (!draft) setDraft('/');
        else if (slashQuery(draft) === null) setForced(true);
        taRef.current?.focus();
      }}
    >
      <span className="slash-glyph" aria-hidden="true">/</span>
    </button>
  ) : null;

  const menu = open ? (
    <div className="slash-menu" role="listbox" aria-label="Команды" ref={listRef}>
      {list === null ? (
        <div className="slash-empty">Загружаю команды…</div>
      ) : items.length === 0 ? (
        <div className="slash-empty">{list.length ? 'Ничего не нашлось' : 'Команд нет'}</div>
      ) : (
        items.map((c, i) => (
          <button
            type="button"
            key={c.name}
            data-i={i}
            role="option"
            aria-selected={i === index}
            className={`slash-item${i === index ? ' on' : ''}`}
            // mousedown, not click: the field must not lose focus first.
            onMouseDown={(e) => {
              e.preventDefault();
              choose(c);
            }}
            onMouseEnter={() => setIndex(i)}
          >
            <span className="slash-name">/{c.name}</span>
            {c.argumentHint && <span className="slash-hint">{c.argumentHint}</span>}
            {c.description && <span className="slash-desc">{c.description}</span>}
          </button>
        ))
      )}
    </div>
  ) : null;

  return { onKeyDown, button, menu };
}
