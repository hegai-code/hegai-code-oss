import { useEffect, useRef, useState } from 'react';
import type { FsEntry } from '@cc-remote/shared';
import { fileSizeLabel } from '../../lib.js';
import { FileGlyph } from './fileIcon.js';
import { isImage } from './paths.js';
import { MOVE_MIME } from './FileList.js';

/**
 * The icon view.
 *
 * This is the half of a desktop file manager the list cannot do: a folder of
 * photographs that looks like photographs. Finder opens in it by default, and
 * its absence is the single biggest reason the first version read as a table of
 * paths rather than a place where files live.
 *
 * Thumbnails are fetched lazily and bounded — each one is a real windowed
 * download over the same socket that carries the sessions, so a directory of
 * four hundred images must not become four hundred transfers.
 */

/** Images larger than this get their glyph instead of a picture. */
const MAX_THUMB_BYTES = 2 * 1024 * 1024;
/** Thumbnails loaded per directory view. Past this, glyphs. */
const MAX_THUMBS = 60;

export function FileGrid({
  entries,
  selected,
  active,
  renaming,
  canWrite,
  dirKey,
  readObjectUrl,
  onOpen,
  onSelect,
  onActivate,
  onKeyNav,
  onContext,
  onDragFiles,
  onMoveInto,
  onDropUpload,
  onSpring,
  emptyHint,
}: {
  entries: FsEntry[];
  selected: Set<string>;
  active: number;
  renaming: string | null;
  canWrite: boolean;
  /** Identifies the directory, so thumbnails are dropped when it changes. */
  dirKey: string;
  readObjectUrl: (rel: string, maxBytes: number) => Promise<string>;
  onOpen: (entry: FsEntry) => void;
  onSelect: (entry: FsEntry, index: number, mode: 'set' | 'toggle' | 'range') => void;
  onActivate: (index: number) => void;
  onKeyNav: (key: string, shift: boolean) => void;
  onContext: (entry: FsEntry, index: number, x: number, y: number) => void;
  onDragFiles: (entry: FsEntry) => string[];
  onMoveInto: (targetDir: string, names: string[]) => void;
  onDropUpload: (dir: string, data: DataTransfer) => void;
  /** Hovering a folder with a drag in hand opens it — Finder's spring-loading. */
  onSpring: (entry: FsEntry) => void;
  emptyHint: string;
}) {
  const [thumbs, setThumbs] = useState<Map<string, string>>(new Map());
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const springTimer = useRef<number>(0);

  // One thumbnail pass per directory. Revoking on the way out matters: these
  // are object URLs, and a browse through twenty folders would otherwise retain
  // every picture it ever showed.
  useEffect(() => {
    let cancelled = false;
    const made: string[] = [];
    setThumbs(new Map());
    const wanted = entries
      .filter((e) => e.kind === 'file' && isImage(e.name) && (e.size ?? 0) <= MAX_THUMB_BYTES)
      .slice(0, MAX_THUMBS);
    void (async () => {
      for (const e of wanted) {
        if (cancelled) break;
        try {
          const url = await readObjectUrl(e.name, MAX_THUMB_BYTES);
          if (cancelled) {
            URL.revokeObjectURL(url);
            break;
          }
          made.push(url);
          setThumbs((prev) => new Map(prev).set(e.name, url));
        } catch {
          // A thumbnail that will not load is not an error worth a message —
          // the glyph is a complete answer on its own.
        }
      }
    })();
    return () => {
      cancelled = true;
      for (const u of made) URL.revokeObjectURL(u);
    };
  }, [dirKey, entries, readObjectUrl]);

  useEffect(() => () => window.clearTimeout(springTimer.current), []);

  if (!entries.length) {
    return (
      <div className="placeholder">
        Папка пуста
        <div className="ph-sub">{emptyHint}</div>
      </div>
    );
  }

  return (
    <div
      className="fgrid"
      role="listbox"
      aria-label="Файлы"
      aria-multiselectable
      tabIndex={0}
      onKeyDown={(e) => {
        if (renaming) return;
        const keys = ['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'Enter', 'Backspace', ' ', 'a', 'A', 'F2'];
        if (!keys.includes(e.key)) return;
        if ((e.key === 'a' || e.key === 'A') && !(e.metaKey || e.ctrlKey)) return;
        e.preventDefault();
        onKeyNav(e.key === 'A' ? 'a' : e.key, e.shiftKey);
      }}
    >
      {entries.map((e, i) => {
        const isSel = selected.has(e.name);
        const thumb = thumbs.get(e.name);
        return (
          <div
            key={e.name}
            className={[
              'fgrid-cell',
              isSel ? 'selected' : '',
              active === i ? 'active' : '',
              dropTarget === e.name ? 'drop-into' : '',
            ]
              .filter(Boolean)
              .join(' ')}
            role="option"
            aria-selected={isSel}
            draggable={canWrite && !renaming}
            onDragStart={(ev) => {
              ev.dataTransfer.setData(MOVE_MIME, JSON.stringify(onDragFiles(e)));
              ev.dataTransfer.effectAllowed = 'move';
            }}
            onDragOver={(ev) => {
              if (e.kind !== 'dir' || !canWrite) return;
              const isMove = ev.dataTransfer.types.includes(MOVE_MIME);
              if (!isMove && !ev.dataTransfer.types.includes('Files')) return;
              ev.preventDefault();
              ev.stopPropagation();
              ev.dataTransfer.dropEffect = isMove ? 'move' : 'copy';
              if (dropTarget !== e.name) {
                setDropTarget(e.name);
                // Spring-loading: hold a drag over a folder and it opens, so a
                // file can be carried three levels down in one gesture.
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
                onMoveInto(e.name, (JSON.parse(moved) as string[]).filter((n) => n !== e.name));
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
              ev.preventDefault();
              onActivate(i);
              if (!isSel) onSelect(e, i, 'set');
              onContext(e, i, ev.clientX, ev.clientY);
            }}
          >
            <div className="fgrid-art">
              {thumb ? (
                <img className="fgrid-thumb" src={thumb} alt="" loading="lazy" />
              ) : (
                <FileGlyph entry={e} size={34} />
              )}
            </div>
            <div className="fgrid-name" title={e.name}>
              {e.name}
            </div>
            <div className="fgrid-meta">
              {e.kind === 'dir' ? 'папка' : fileSizeLabel(e.size ?? 0)}
            </div>
          </div>
        );
      })}
    </div>
  );
}
