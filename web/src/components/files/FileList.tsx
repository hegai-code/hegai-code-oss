import { useEffect, useRef, useState } from 'react';
import type { FsEntry } from '@cc-remote/shared';
import { MoreIcon } from '../../icons.js';
import { FileGlyph } from './fileIcon.js';
import { fileSizeLabel } from '../../lib.js';
import { ContextMenu, type MenuAction, type MenuAt } from '../ContextMenu.js';

/**
 * The work surface of the file manager.
 *
 * Built on `.mtable` — the same CSS grid the sessions table uses — rather than a
 * new table: hover, dividers, row height and truncation all come for free, and
 * two tables that drift apart is the rot the design system exists to prevent.
 * Only `grid-template-columns` is overridden.
 *
 * What makes it read as a FILE MANAGER rather than a list of names is the set of
 * gestures people already have in their hands from Finder and Explorer: drag a
 * row onto a folder to move it, shift-click a range, right-click for the menu,
 * rename in place, sort by clicking a header, walk it with the arrow keys. Each
 * one is muscle memory somewhere else; a file manager missing them feels broken
 * without the person being able to say why.
 */

/** The drag payload for an internal MOVE, kept distinct from an OS file drop.
 *  `dataTransfer.types` is the only thing readable during dragover, so the two
 *  gestures have to be told apart by type alone. */
export const MOVE_MIME = 'application/x-ccr-move';

export type SortKey = 'name' | 'size' | 'mtime';
export interface Sort {
  key: SortKey;
  dir: 1 | -1;
}

/** Directories first, always — every file manager does this, and a listing that
 *  interleaves them reads as a bug. */
export function sortEntries(entries: FsEntry[], sort: Sort): FsEntry[] {
  const out = [...entries];
  out.sort((a, b) => {
    if ((a.kind === 'dir') !== (b.kind === 'dir')) return a.kind === 'dir' ? -1 : 1;
    let n = 0;
    if (sort.key === 'name') n = a.name.localeCompare(b.name, undefined, { numeric: true });
    else if (sort.key === 'size') n = (a.size ?? -1) - (b.size ?? -1);
    else n = (a.mtime ?? 0) - (b.mtime ?? 0);
    // Name as the tiebreak, so equal sizes or equal dates keep a stable order
    // instead of shuffling between renders.
    if (n === 0) n = a.name.localeCompare(b.name, undefined, { numeric: true });
    return n * sort.dir;
  });
  return out;
}

/** «2ч» / «3 д» / a date. Relative where relative is the useful answer. */
function whenLabel(ms?: number): string {
  if (!ms) return '—';
  const diff = Date.now() - ms;
  if (diff < 60_000) return 'только что';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} мин`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} ч`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} д`;
  return new Date(ms).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
}

/**
 * What a row can do — the same shape the session list's menu uses.
 *
 * It was its own interface here, and the menu that drew it was hand-rolled
 * twice inside this folder. `MenuAction` is that interface with two additions
 * (a disabled reason, a separator) and one component behind it; keeping the
 * name is what stops this file's call sites from churning.
 *
 * Note `when` rather than `disabled` remains the convention for permissions
 * here: a disabled control is a promise the hub will not keep.
 */
export type RowAction = MenuAction<FsEntry>;

export function FileList({
  entries,
  truncated,
  total,
  selected,
  active,
  sort,
  renaming,
  onSort,
  onOpen,
  onSelect,
  onActivate,
  onKeyNav,
  onDragFiles,
  onMoveInto,
  onDropUpload,
  onRenameCommit,
  onRenameCancel,
  onSpring,
  actions,
  emptyHint,
  canWrite,
}: {
  entries: FsEntry[];
  truncated?: boolean;
  total?: number;
  selected: Set<string>;
  /** The keyboard cursor. Separate from selection, exactly as in a real
   *  explorer: arrows move it, space/click selects. */
  active: number;
  sort: Sort;
  /** Name of the entry being renamed in place, if any. */
  renaming: string | null;
  onSort: (key: SortKey) => void;
  onOpen: (entry: FsEntry) => void;
  onSelect: (entry: FsEntry, index: number, mode: 'set' | 'toggle' | 'range') => void;
  onActivate: (index: number) => void;
  onKeyNav: (key: string, shift: boolean) => void;
  /** Names being dragged, for the move payload. */
  onDragFiles: (entry: FsEntry) => string[];
  onMoveInto: (targetDir: string, names: string[]) => void;
  onDropUpload: (dir: string, data: DataTransfer) => void;
  onRenameCommit: (from: string, to: string) => void;
  onRenameCancel: () => void;
  /** Hovering a folder with a drag in hand opens it — Finder's spring-loading. */
  onSpring: (entry: FsEntry) => void;
  actions: RowAction[];
  emptyHint: string;
  canWrite: boolean;
}) {
  // Closing on an outside click, on Escape and on a scroll under it is
  // `ContextMenu`'s business now — it was three effects here and three more in
  // `Files` for the icon view, and neither copy flipped the menu above the
  // pointer near the bottom of the window.
  const [ctx, setCtx] = useState<MenuAt<FsEntry> | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const springTimer = useRef<number>(0);
  useEffect(() => () => window.clearTimeout(springTimer.current), []);

  // A menu pointing at a row that no longer exists is worse than no menu.
  useEffect(() => setCtx(null), [entries]);

  if (!entries.length) {
    return (
      <div className="placeholder">
        Папка пуста
        <div className="ph-sub">{emptyHint}</div>
      </div>
    );
  }

  const header = (key: SortKey, label: string): React.ReactElement => (
    <span
      className={`fl-th${sort.key === key ? ' sorted' : ''}`}
      onClick={() => onSort(key)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSort(key);
        }
      }}
    >
      {label}
      {sort.key === key ? <span className="fl-sortmark">{sort.dir === 1 ? '▲' : '▼'}</span> : null}
    </span>
  );

  return (
    <div
      className="mtable files"
      role="listbox"
      aria-label="Файлы"
      aria-multiselectable
      tabIndex={0}
      ref={listRef}
      onKeyDown={(e) => {
        if (renaming) return; // the input owns the keyboard while it is open
        const handled = ['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', 'Backspace', ' ', 'a', 'A'];
        if (!handled.includes(e.key) && !(e.key === 'F2')) return;
        // ⌘A is select-all here; ⌘K stays the app's palette, which is why only
        // these keys are claimed.
        if ((e.key === 'a' || e.key === 'A') && !(e.metaKey || e.ctrlKey)) return;
        e.preventDefault();
        onKeyNav(e.key === 'A' ? 'a' : e.key, e.shiftKey);
      }}
    >
      <div className="mtable-headrow">
        <span />
        {header('name', 'Имя')}
        {header('size', 'Размер')}
        {header('mtime', 'Изменён')}
        <span />
      </div>

      {entries.map((e, i) => {
        const available = actions.filter((a) => !a.when || a.when(e));
        const isSel = selected.has(e.name);
        return (
          <div
            key={e.name}
            data-index={i}
            className={[
              'mtable-row fl-row',
              isSel ? 'selected' : '',
              active === i ? 'active' : '',
              dropTarget === e.name ? 'drop-into' : '',
            ]
              .filter(Boolean)
              .join(' ')}
            role="option"
            aria-selected={isSel}
            // Dragging a row is how a file is moved. Only when the viewer may
            // write — otherwise the gesture promises something the hub refuses.
            draggable={canWrite && !renaming}
            onDragStart={(ev) => {
              const names = onDragFiles(e);
              ev.dataTransfer.setData(MOVE_MIME, JSON.stringify(names));
              ev.dataTransfer.effectAllowed = 'move';
            }}
            onDragOver={(ev) => {
              if (e.kind !== 'dir' || !canWrite) return;
              const isMove = ev.dataTransfer.types.includes(MOVE_MIME);
              const isUpload = ev.dataTransfer.types.includes('Files');
              if (!isMove && !isUpload) return;
              ev.preventDefault();
              ev.stopPropagation();
              ev.dataTransfer.dropEffect = isMove ? 'move' : 'copy';
              if (dropTarget !== e.name) {
                setDropTarget(e.name);
                // Hold a drag over a folder and it opens — without this a file
                // cannot be carried more than one level in a single gesture.
                window.clearTimeout(springTimer.current);
                springTimer.current = window.setTimeout(() => onSpring(e), 800);
              }
            }}
            onDragLeave={(ev) => {
              if (ev.currentTarget.contains(ev.relatedTarget as Node | null)) return;
              window.clearTimeout(springTimer.current);
              setDropTarget((t) => (t === e.name ? null : t));
            }}
            onDrop={(ev) => {
              if (e.kind !== 'dir' || !canWrite) return;
              ev.preventDefault();
              ev.stopPropagation();
              window.clearTimeout(springTimer.current);
              setDropTarget(null);
              const moved = ev.dataTransfer.getData(MOVE_MIME);
              if (moved) {
                const names: string[] = JSON.parse(moved);
                // Dropping a folder on itself is a no-op, not an error.
                onMoveInto(e.name, names.filter((n) => n !== e.name));
                return;
              }
              if (ev.dataTransfer.files.length || ev.dataTransfer.items.length) {
                onDropUpload(e.name, ev.dataTransfer);
              }
            }}
            onClick={(ev) => {
              onActivate(i);
              onSelect(e, i, ev.shiftKey ? 'range' : ev.metaKey || ev.ctrlKey ? 'toggle' : 'set');
            }}
            onDoubleClick={() => onOpen(e)}
            onContextMenu={(ev) => {
              if (!available.length) return;
              ev.preventDefault();
              onActivate(i);
              if (!isSel) onSelect(e, i, 'set');
              setCtx({ target: e, x: ev.clientX, y: ev.clientY });
            }}
          >
            <span className="fl-kind">
              <FileGlyph entry={e} size={15} />
            </span>
            <span className="fl-name">
              {renaming === e.name ? (
                <RenameInput name={e.name} onCommit={(to) => onRenameCommit(e.name, to)} onCancel={onRenameCancel} />
              ) : (
                <>
                  {/* The name needs its own box: `.fl-name` is a flex container
                      so the link badge can sit beside it, and `text-overflow`
                      does nothing on a flex container — a long filename then
                      pushes the whole row past the viewport. */}
                  <span className="fl-name-text" title={e.name}>
                    {e.name}
                  </span>
                  {e.link ? <span className="fl-link" title="Символическая ссылка">↗</span> : null}
                </>
              )}
            </span>
            <span className="fl-size">{e.kind === 'dir' ? '—' : fileSizeLabel(e.size ?? 0)}</span>
            <span className="fl-time">{whenLabel(e.mtime)}</span>
            <span className="fl-actions">
              {available.length ? (
                <details className="fl-more" onClick={(ev) => ev.stopPropagation()}>
                  <summary aria-label="Действия">
                    <MoreIcon size={14} />
                  </summary>
                  <div className="ws-more-pop">
                    {available.map((a) => (
                      <button
                        key={a.label}
                        type="button"
                        className={`ws-more-item${a.danger ? ' danger' : ''}`}
                        onClick={(ev) => {
                          (ev.currentTarget.closest('details') as HTMLDetailsElement | null)?.removeAttribute('open');
                          a.run(e);
                        }}
                      >
                        {a.label}
                      </button>
                    ))}
                  </div>
                </details>
              ) : null}
            </span>
          </div>
        );
      })}

      {truncated ? (
        <div className="fl-truncated">
          Показаны первые {entries.length} из {total ?? '?'} — откройте папку на машине, чтобы
          увидеть остальное
        </div>
      ) : null}

      {/* Right-click IS the primary interaction of a desktop file manager. It
          is the session list's too now, which is why the menu is a component
          rather than markup that happens to live here. */}
      <ContextMenu at={ctx} actions={actions} onClose={() => setCtx(null)} label="Действия с файлом" />
    </div>
  );
}

/** Rename where the name is, the way both desktop managers do it. A modal
 *  `window.prompt` for this is the tell that a thing is a web page pretending. */
function RenameInput({
  name,
  onCommit,
  onCancel,
}: {
  name: string;
  onCommit: (to: string) => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    // Select the stem, not the extension — renaming `report.final.pdf` almost
    // never means retyping `.pdf`.
    const dot = name.lastIndexOf('.');
    el.setSelectionRange(0, dot > 0 ? dot : name.length);
  }, [name]);
  return (
    <input
      ref={ref}
      className="fl-rename"
      defaultValue={name}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onBlur={(e) => {
        const next = e.currentTarget.value.trim();
        if (next && next !== name) onCommit(next);
        else onCancel();
      }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Escape') onCancel();
        if (e.key === 'Enter') {
          const next = e.currentTarget.value.trim();
          if (next && next !== name) onCommit(next);
          else onCancel();
        }
      }}
    />
  );
}
