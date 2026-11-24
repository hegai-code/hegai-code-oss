import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FsEntry } from '@cc-remote/shared';
import type { useCentral } from '../../useCentral.js';
import { navigate, linkProps, type Route } from '../../router.js';
import { fileSizeLabel, sessionKey, type ProjectTarget } from '../../lib.js';
import {
  UploadIcon,
  FolderPlus,
  RefreshCw,
  X,
  Folder,
  ArrowUpIcon,
  GridViewIcon,
  ListViewIcon,
} from '../../icons.js';
import { useFiles, MAX_DOWNLOAD_BYTES, type UploadRow } from './useFiles.js';

/** A preview is held in the tab's memory, so it is bounded far below a download. */
const MAX_PREVIEW_BYTES = 8 * 1024 * 1024;
import { FileTree } from './FileTree.js';
import { FileList, sortEntries, MOVE_MIME, type RowAction, type Sort, type SortKey } from './FileList.js';
import { ContextMenu, type MenuAt } from '../ContextMenu.js';
import { FileGrid } from './FileGrid.js';
import { FilePreview } from './FilePreview.js';
import { SendToSession } from './SendToSession.js';
import { joinRel, parentRel, segments } from './paths.js';
import { storageGet, storageSet } from '../../storage.js';
import { askConfirm, askText } from '../../dialogs.js';
import { SaveStatusBar } from './SaveStatusBar.js';
import { useFileSave } from '../../useFileSave.js';

type Central = ReturnType<typeof useCentral>;

/** Remembered so the rail does not ask "which project" every single time. */
const LAST_KEY = 'cc-files-last';

/**
 * «Файлы» — a file manager over one machine's project roots.
 *
 * Full-width, no context column. Every screen that renders one vanishes below
 * 860px (`.sidebar.ctxcol + .main-col { display: none }`) — the bug that made
 * /w/new unreachable on a phone — and Hardware, the only other machine-keyed
 * destination, is full-width for exactly this reason.
 */
export function Files({
  central,
  route,
  targets,
  canControl,
}: {
  central: Central;
  route: Extract<Route, { kind: 'files' }>;
  targets: ProjectTarget[];
  canControl: (machineId: string) => boolean;
}) {
  const { machineId, root } = route;
  const rel = route.p ?? '';
  const api = useFiles(central, machineId, root, rel);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  /** Keyboard cursor, separate from selection — arrows move it, as in Finder. */
  const [active, setActive] = useState(0);
  const [sort, setSort] = useState<Sort>({ key: 'name', dir: 1 });
  const [renaming, setRenaming] = useState<string | null>(null);
  const [crumbDrop, setCrumbDrop] = useState<string | null>(null);
  /** Right-click menu for the icon view. The list owns its own instance; both
   *  are the same `ContextMenu` — the grid raises coordinates because its rows
   *  are a child component and the menu must not be clipped by the scroller. */
  const [gridCtx, setGridCtx] = useState<MenuAt<FsEntry> | null>(null);
  /** Icons or list. Finder opens in icons; remembered, because it is a habit,
   *  not a per-visit decision. */
  const [view, setView] = useState<'grid' | 'list'>(() =>
    storageGet('cc-files-view') === 'list' ? 'list' : 'grid',
  );
  useEffect(() => {
    storageSet('cc-files-view', view);
  }, [view]);
  /** Bumped after any mutation so the tree re-reads; without it a folder you
   *  just created never appears on the left. */
  const [treeVersion, setTreeVersion] = useState(0);
  const anchor = useRef(0);
  const [dropDir, setDropDir] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const fileSave = useFileSave();
  const saveState = fileSave.state;
  const downloading = saveState?.phase === 'loading';
  const pickRef = useRef<HTMLInputElement>(null);
  const restored = useRef(false);

  const machine = central.machines.find((m) => m.machine.machineId === machineId);
  const writable = machineId ? canControl(machineId) : false;
  const online = machine?.online ?? false;

  // Selection is per directory: carrying names across a navigation would act on
  // whatever happened to share a name here.
  useEffect(() => {
    setSelected(new Set());
    setActive(0);
    setRenaming(null);
    anchor.current = 0;
  }, [machineId, root, rel]);

  // Open where you were last, once per mount. A ref latch rather than a
  // dependency: clicking «Все машины» keeps this component mounted, and bouncing
  // the person straight back would make that crumb unusable.
  useEffect(() => {
    if (restored.current) return;
    // Arriving straight at a project latches too: otherwise clicking «Все
    // машины» would bounce you back into the remembered one immediately.
    if (machineId) {
      restored.current = true;
      return;
    }
    // Wait for the shelf. Latching before `projects.list` has answered means a
    // cold load never restores anything.
    if (!targets.length) return;
    restored.current = true;
    // Private mode: no `last` — the shelf is a fine place to land.
    const last = storageGet(LAST_KEY);
    const hit = last && targets.find((t) => sessionKey(t.machineId, t.cwd) === last);
    if (hit) navigate({ kind: 'files', machineId: hit.machineId, root: hit.cwd }, { replace: true });
  }, [machineId, targets]);

  useEffect(() => {
    if (!machineId || !root) return;
    storageSet(LAST_KEY, sessionKey(machineId, root));
  }, [machineId, root]);

  const go = useCallback(
    (next: Partial<Extract<Route, { kind: 'files' }>>, replace = false) => {
      navigate({ kind: 'files', machineId, root, ...next }, replace ? { replace: true } : undefined);
    },
    [machineId, root],
  );

  const openDir = useCallback((target: string) => go({ p: target || undefined }), [go]);
  // A file is a lens on the directory, not a place: selecting one should not
  // cost a back press, and Back from a file lands on its folder.
  const openFile = useCallback((name: string) => go({ p: rel || undefined, f: name }, true), [go, rel]);

  /** Image previews go through the same windowed reader as a download, so they
   *  inherit its size ceiling and its mtime check. */
  const readImage = useCallback(
    (target: string): Promise<string> => api.readObjectUrl(target, MAX_PREVIEW_BYTES),
    [api],
  );

  const entries = useMemo(
    () => sortEntries(api.entries?.entries ?? [], sort),
    [api.entries, sort],
  );
  const openEntry = useMemo(
    () => (route.f ? entries.find((e) => e.name === route.f && e.kind === 'file') : undefined),
    [entries, route.f],
  );

  const selectRange = useCallback(
    (to: number, list: FsEntry[]) => {
      const [a, b] = anchor.current <= to ? [anchor.current, to] : [to, anchor.current];
      setSelected(new Set(list.slice(a, b + 1).map((e) => e.name)));
    },
    [],
  );

  const onSelect = useCallback(
    (entry: FsEntry, index: number, mode: 'set' | 'toggle' | 'range') => {
      if (mode === 'range') {
        selectRange(index, entries);
        return;
      }
      anchor.current = index;
      setSelected((prev) => {
        if (mode === 'toggle') {
          const next = new Set(prev);
          if (next.has(entry.name)) next.delete(entry.name);
          else next.add(entry.name);
          return next;
        }
        return new Set([entry.name]);
      });
    },
    [entries, selectRange],
  );

  const onOpen = useCallback(
    (entry: FsEntry) => {
      if (entry.kind === 'dir') openDir(joinRel(rel, entry.name));
      else openFile(entry.name);
    },
    [openDir, openFile, rel],
  );

  /** A drag held over a folder opens it, so something can be carried several
   *  levels down in one gesture. */
  const springInto = useCallback(
    (entry: FsEntry) => {
      if (entry.kind === 'dir') openDir(joinRel(rel, entry.name));
    },
    [openDir, rel],
  );

  const goUp = useCallback(() => {
    if (!rel) return;
    openDir(parentRel(rel));
  }, [rel, openDir]);

  /**
   * The keys a file manager is expected to answer to.
   *
   * Arrows move the cursor AND the selection, the way both desktop managers do;
   * shift extends from the anchor; Backspace goes up a level; F2 renames in
   * place. ⌘A is claimed here, ⌘K deliberately is not — that belongs to the
   * app's palette.
   */
  const onKeyNav = useCallback(
    (k: string, shift: boolean) => {
      const n = entries.length;
      if (!n) return;
      const move = (to: number): void => {
        const i = Math.max(0, Math.min(n - 1, to));
        setActive(i);
        const hit = entries[i];
        if (!hit) return;
        if (shift) selectRange(i, entries);
        else {
          anchor.current = i;
          setSelected(new Set([hit.name]));
        }
      };
      if (k === 'ArrowDown') move(active + 1);
      else if (k === 'ArrowUp') move(active - 1);
      else if (k === 'Home') move(0);
      else if (k === 'End') move(n - 1);
      else if (k === 'Backspace') goUp();
      else if (k === 'a') setSelected(new Set(entries.map((e) => e.name)));
      else if (k === ' ') {
        const hit = entries[active];
        if (hit) onSelect(hit, active, 'toggle');
      } else if (k === 'Enter') {
        const hit = entries[active];
        if (hit) onOpen(hit);
      } else if (k === 'F2') {
        const hit = entries[active];
        if (hit && writable) setRenaming(hit.name);
      }
    },
    [entries, active, goUp, onOpen, onSelect, selectRange, writable],
  );

  const run = useCallback(async (what: () => Promise<unknown>) => {
    setBusy(null);
    try {
      await what();
      // Anything that changed the filesystem may have changed the tree too.
      setTreeVersion((v) => v + 1);
    } catch (err) {
      setBusy((err as Error).message);
    }
  }, []);

  const { start: startSave } = fileSave;
  const downloadingRef = useRef(false);
  downloadingRef.current = downloading;
  const startDownload = useCallback(
    (target: string, name: string) => {
      if (downloadingRef.current) return Promise.resolve();
      setBusy(null);
      return startSave(name, (onProgress) => api.download(target, onProgress));
    },
    [api, startSave],
  );

  const actions: RowAction[] = useMemo(() => {
    const out: RowAction[] = [
      {
        label: 'Скачать',
        when: (e) => e.kind === 'file' && (e.size ?? 0) <= MAX_DOWNLOAD_BYTES && !downloading,
        run: (e) => void startDownload(joinRel(rel, e.name), e.name),
      },
    ];
    if (!writable) return out;
    // Write actions are ABSENT, not disabled, for a viewer who cannot write: a
    // greyed-out button is a promise the hub will refuse to keep.
    out.push(
      {
        // In place, not through `window.prompt`: a modal for a rename is the
        // tell that a thing is a web page imitating a file manager.
        label: 'Переименовать',
        run: (e) => setRenaming(e.name),
      },
      {
        label: 'Удалить',
        danger: true,
        run: async (e) => {
          // Acting on the whole selection when the clicked row is part of it is
          // what every manager does — deleting one of six highlighted files
          // would be a surprise.
          const names = selected.has(e.name) && selected.size > 1 ? [...selected] : [e.name];
          const what = names.length > 1 ? `${names.length} объект(ов)` : `«${names[0]}»`;
          if (!(await askConfirm(`Удалить ${what}? Уйдёт в корзину агента.`, { confirmLabel: 'Удалить', danger: true }))) return;
          void run(async () => {
            let last = '';
            for (const n of names) last = await api.trash(joinRel(rel, n));
            setBusy(names.length > 1 ? `Удалено: ${names.length}` : `Удалено → ${last}`);
            setSelected(new Set());
          });
        },
      },
    );
    return out;
  }, [api, rel, run, startDownload, downloading, writable]);

  /**
   * Move by drag — the gesture that makes this a file manager rather than a
   * list. `fs.rename` is already a move within one cwd, so nothing new crosses
   * the wire.
   */
  const moveInto = useCallback(
    (targetDir: string, names: string[]) => {
      if (!names.length) return;
      void run(async () => {
        for (const n of names) {
          await api.rename(joinRel(rel, n), joinRel(joinRel(rel, targetDir), n));
        }
        setSelected(new Set());
        setBusy(names.length > 1 ? `Перенесено: ${names.length} → ${targetDir}` : null);
      });
    },
    [api, rel, run],
  );

  /** Move to any directory under the root, named by its rel path. */
  const moveToPath = useCallback(
    (targetRel: string, names: string[]) => {
      if (!names.length) return;
      void run(async () => {
        for (const n of names) {
          await api.rename(joinRel(rel, n), joinRel(targetRel, n));
        }
        setSelected(new Set());
        setBusy(`Перенесено: ${names.length} → ${targetRel || 'корень'}`);
      });
    },
    [api, rel, run],
  );

  /** What a drag carries: the whole selection when the grabbed row is part of
   *  it, otherwise just that row — same rule as the delete action. */
  const dragPayload = useCallback(
    (e: FsEntry) => (selected.has(e.name) && selected.size > 1 ? [...selected] : [e.name]),
    [selected],
  );

  /** Flatten a drop, including folders. */
  const filesFromDrop = useCallback(async (dt: DataTransfer, baseDir: string) => {
    const out: { file: File; dir: string }[] = [];
    const skipped: string[] = [];
    const items = [...dt.items].filter((i) => i.kind === 'file');
    const entriesApi = items.map((i) => i.webkitGetAsEntry?.() ?? null);
    const walk = async (entry: FileSystemEntry | null, dir: string): Promise<void> => {
      if (!entry) return;
      if (entry.isFile) {
        const f = await new Promise<File | null>((resolve) =>
          (entry as FileSystemFileEntry).file(resolve, () => resolve(null)),
        );
        // A file the browser refuses to read must not vanish quietly: the drop
        // would otherwise report success having skipped it.
        if (f) out.push({ file: f, dir });
        else skipped.push(entry.name);
        return;
      }
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((resolve) =>
          reader.readEntries(resolve, () => resolve([])),
        );
        if (!batch.length) break;
        for (const child of batch) await walk(child, joinRel(dir, entry.name));
      }
    };
    if (entriesApi.some(Boolean)) {
      for (const e of entriesApi) await walk(e, baseDir);
    } else {
      // No entries API: a plain file list. A FOLDER dropped this way yields
      // nothing at all, which is why the walk above is not optional.
      for (const f of [...dt.files]) out.push({ file: f, dir: baseDir });
    }
    return { picked: out, skipped };
  }, []);

  /** A drop of OS files onto a folder, in either view. */
  const uploadInto = useCallback(
    (dir: string, data: DataTransfer) => {
      void (async () => {
        const { picked, skipped } = await filesFromDrop(data, joinRel(rel, dir));
        if (picked.length) api.addUploads(picked);
        if (skipped.length) setBusy(`Не удалось прочитать: ${skipped.slice(0, 5).join(', ')}`);
      })();
    },
    [api, filesFromDrop, rel],
  );

  const onDrop = useCallback(
    (e: React.DragEvent<HTMLElement>) => {
      if (!writable) return;
      // An internal move is handled by the row it was dropped on; reaching the
      // pane means it was dropped on empty space, which is not a move.
      if (!e.dataTransfer.types.includes('Files')) return;
      e.preventDefault();
      setDragging(false);
      const target = dropDir ?? rel;
      setDropDir(null);
      void (async () => {
        const { picked, skipped } = await filesFromDrop(e.dataTransfer, target);
        if (picked.length) api.addUploads(picked);
        if (skipped.length) setBusy(`Не удалось прочитать: ${skipped.slice(0, 5).join(', ')}`);
      })();
    },
    [api, dropDir, filesFromDrop, rel, writable],
  );

  // ---- the shelf: pick a machine and a root ------------------------------
  if (!machineId || !root) {
    const byMachine = new Map<string, ProjectTarget[]>();
    for (const t of targets) {
      const list = byMachine.get(t.machineId) ?? [];
      list.push(t);
      byMachine.set(t.machineId, list);
    }
    return (
      <div className="board files-shelf">
        <div className="board-head">
          <span className="eyebrow eyebrow--mark">Файлы</span>
        </div>
        {byMachine.size === 0 ? (
          <div className="placeholder">
            Нет доступных проектов
            <div className="ph-sub">
              Подключите машину — её проекты появятся здесь.{' '}
              <a {...linkProps({ kind: 'start' })}>Как подключить</a>
            </div>
          </div>
        ) : null}
        {[...byMachine.entries()].map(([mid, list]) => {
          const snap = central.machines.find((m) => m.machine.machineId === mid);
          return (
            <section key={mid} className="files-shelf-group">
              <div className="files-shelf-head">
                <span className={`hw-dot${snap?.online ? ' on' : ''}`} />
                {list[0]?.machineName ?? mid}
              </div>
              <div className="files-shelf-grid">
                {list.map((t) => (
                  <a
                    key={t.cwd}
                    className="root-card"
                    {...linkProps({ kind: 'files', machineId: t.machineId, root: t.cwd })}
                  >
                    <span className="root-card-name">
                      <Folder size={15} /> {t.label}
                    </span>
                    <span className="root-card-path" title={t.cwd}>
                      {t.cwd}
                    </span>
                  </a>
                ))}
              </div>
            </section>
          );
        })}
      </div>
    );
  }

  // ---- the explorer --------------------------------------------------------
  const crumbs = segments(rel);
  const selectedRels = [...selected].map((n) => joinRel(rel, n));

  return (
    <div className="files">
      <div className="files-bar">
        <nav className="fcrumbs" aria-label="Путь">
          <a className="fcrumb" {...linkProps({ kind: 'files' })}>
            Все машины
          </a>
          <span className="fcrumb-sep">/</span>
          {/* The MACHINE, named. Without it the path read «Все машины / hegai»
              where `hegai` was merely the root's basename — you could not tell
              which machine you were on, and a project named after a host made
              the two indistinguishable. */}
          <span className="fcrumb fcrumb-machine" title={root}>
            {machine?.machine.name ?? machineId}
          </span>
          <span className="fcrumb-sep">/</span>
          <a className="fcrumb" {...linkProps({ kind: 'files', machineId, root })}>
            {root.split(/[\\/]/).filter(Boolean).pop() ?? root}
          </a>
          {crumbs.map((c) => (
            <span key={c.rel}>
              <span className="fcrumb-sep">/</span>
              <a
                className={`fcrumb${crumbDrop === c.rel ? ' drop-into' : ''}`}
                {...linkProps({ kind: 'files', machineId, root, p: c.rel })}
                // A crumb is a drop target, because moving something UP a level
                // is half of what dragging in a file manager is for.
                onDragOver={(ev) => {
                  if (!writable || !ev.dataTransfer.types.includes(MOVE_MIME)) return;
                  ev.preventDefault();
                  ev.dataTransfer.dropEffect = 'move';
                  setCrumbDrop(c.rel);
                }}
                onDragLeave={() => setCrumbDrop((t) => (t === c.rel ? null : t))}
                onDrop={(ev) => {
                  if (!writable) return;
                  const raw = ev.dataTransfer.getData(MOVE_MIME);
                  if (!raw) return;
                  ev.preventDefault();
                  setCrumbDrop(null);
                  moveToPath(c.rel, JSON.parse(raw) as string[]);
                }}
              >
                {c.name}
              </a>
            </span>
          ))}
        </nav>
        <div className="files-bar-actions">
          {rel ? (
            <button type="button" className="iconbtn" title="На уровень вверх (Backspace)" onClick={goUp}>
              <ArrowUpIcon size={15} />
            </button>
          ) : null}
          {selected.size && machineId ? (
            <SendToSession machine={machine} machineId={machineId} root={root} rels={selectedRels} />
          ) : null}
          {writable ? (
            <>
              <button
                type="button"
                className="iconbtn"
                title="Загрузить файлы"
                onClick={() => pickRef.current?.click()}
              >
                <UploadIcon size={15} />
              </button>
              <button
                type="button"
                className="iconbtn"
                title="Создать папку"
                onClick={async () => {
                  // The one prompt left: there is no row to edit in place until
                  // the folder exists.
                  const name = await askText('Имя новой папки');
                  if (name) void run(() => api.mkdir(joinRel(rel, name)));
                }}
              >
                <FolderPlus size={15} />
              </button>
            </>
          ) : null}
          <button
            type="button"
            className="iconbtn"
            title={view === 'grid' ? 'Списком' : 'Значками'}
            onClick={() => setView((v) => (v === 'grid' ? 'list' : 'grid'))}
          >
            {view === 'grid' ? <ListViewIcon size={15} /> : <GridViewIcon size={15} />}
          </button>
          <button type="button" className="iconbtn" title="Обновить" onClick={api.reload}>
            <RefreshCw size={15} />
          </button>
        </div>
        <input
          ref={pickRef}
          type="file"
          multiple
          hidden
          // No `accept` filter, deliberately — same reason the composer has
          // none: a file the model cannot read is still a file the person meant
          // to put there.
          onChange={(e) => {
            const picked = [...(e.target.files ?? [])].map((f) => ({ file: f, dir: rel }));
            e.target.value = '';
            if (picked.length) api.addUploads(picked);
          }}
        />
      </div>

      {busy ? (
        <div className="files-note">
          {busy}
          <button type="button" className="iconbtn" onClick={() => setBusy(null)} aria-label="Скрыть">
            <X size={12} />
          </button>
        </div>
      ) : null}
      {saveState ? (
        <SaveStatusBar
          state={saveState}
          onSave={() => saveState.phase === 'ready' && fileSave.save(saveState)}
          onDismiss={fileSave.dismiss}
        />
      ) : null}
      {!online ? (
        <div className="files-note files-offline">Машина офлайн — показано последнее состояние</div>
      ) : null}
      {api.error ? <div className="files-err">{api.error}</div> : null}

      <div className={`files-panes${openEntry ? ' with-prev' : ''}`}>
        <FileTree
          rootLabel={root.split(/[\\/]/).filter(Boolean).pop() ?? root}
          activeRel={rel}
          list={api.list}
          onOpen={openDir}
          ready={api.ready}
          version={treeVersion}
        />

        <main
          className={`files-main${dragging ? ' dropping' : ''}`}
          onDragOver={(e) => {
            if (!writable || !e.dataTransfer?.types?.includes('Files')) return;
            // Without preventDefault the browser navigates away to the file,
            // which loses the page.
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={(e) => {
            // Fires when crossing into a CHILD too; ignore those or the hint
            // flickers on every internal boundary.
            if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
            setDragging(false);
            setDropDir(null);
          }}
          onDrop={onDrop}
        >
          {api.loading && !api.entries ? (
            <div className="skel-list">
              {Array.from({ length: 6 }, (_, i) => (
                <div key={i} className="skel-row" />
              ))}
            </div>
          ) : (
            view === 'grid' ? (
              <FileGrid
                entries={entries}
                selected={selected}
                active={active}
                renaming={renaming}
                canWrite={writable}
                dirKey={`${machineId}|${root}|${rel}`}
                readObjectUrl={api.readObjectUrl}
                onOpen={onOpen}
                onSelect={onSelect}
                onActivate={setActive}
                onKeyNav={onKeyNav}
                onContext={(e, i, x, y) => setGridCtx({ target: e, x, y })}
                onDragFiles={dragPayload}
                onMoveInto={moveInto}
                onDropUpload={uploadInto}
                onSpring={springInto}
                emptyHint={writable ? 'Перетащите файлы сюда' : 'Здесь пока ничего нет'}
              />
            ) : (
              <FileList
                entries={entries}
              truncated={api.entries?.truncated}
              total={api.entries?.total}
              selected={selected}
              active={active}
              sort={sort}
              renaming={renaming}
              canWrite={writable}
              onSort={(k: SortKey) =>
                setSort((prev) => (prev.key === k ? { key: k, dir: prev.dir === 1 ? -1 : 1 } : { key: k, dir: 1 }))
              }
              onOpen={onOpen}
              onSelect={onSelect}
              onActivate={setActive}
              onKeyNav={onKeyNav}
              onDragFiles={dragPayload}
              onMoveInto={moveInto}
              onDropUpload={uploadInto}
              onSpring={springInto}
              onRenameCommit={(from, to) => {
                setRenaming(null);
                void run(() => api.rename(joinRel(rel, from), joinRel(rel, to)));
              }}
              onRenameCancel={() => setRenaming(null)}
              actions={actions}
              emptyHint={writable ? 'Перетащите файлы сюда' : 'Здесь пока ничего нет'}
            />
            )
          )}

          <ContextMenu
            at={gridCtx}
            actions={actions}
            onClose={() => setGridCtx(null)}
            label="Действия с файлом"
          />

          {dragging ? (
            <div className="files-drop">
              Загрузить в <b>{(dropDir ?? rel) || 'корень проекта'}</b>
            </div>
          ) : null}

          {api.uploads.length ? (
            <UploadTray
              rows={api.uploads}
              onRetry={api.retryUpload}
              onDismiss={api.dismissUpload}
            />
          ) : null}
        </main>

        {openEntry && machineId ? (
          <FilePreview
            entry={openEntry}
            rel={joinRel(rel, openEntry.name)}
            root={root}
            ready={api.ready}
            read={api.read}
            readImage={readImage}
            onClose={() => go({ p: rel || undefined })}
            downloading={downloading}
            onDownload={() => void startDownload(joinRel(rel, openEntry.name), openEntry.name)}
            sendSlot={
              <SendToSession
                machine={machine}
                machineId={machineId}
                root={root}
                rels={[joinRel(rel, openEntry.name)]}
              />
            }
            compact={false}
          />
        ) : null}
      </div>
    </div>
  );
}

function UploadTray({
  rows,
  onRetry,
  onDismiss,
}: {
  rows: UploadRow[];
  onRetry: (id: string) => void;
  onDismiss: (id: string) => void;
}) {
  return (
    <div className="files-up" aria-live="polite">
      {rows.map((u) => (
        <div key={u.id} className={`files-up-row ${u.status}`}>
          <span className="files-up-name" title={u.name}>
            {u.name}
          </span>
          <span className="files-up-size">{fileSizeLabel(u.size)}</span>
          {u.status === 'failed' ? (
            <span className="files-up-err" title={u.error}>
              {u.error}
            </span>
          ) : (
            <span className="barrow-track">
              <span
                className="files-up-fill"
                style={{ width: `${u.size ? Math.round((u.sent / u.size) * 100) : 100}%` }}
              />
            </span>
          )}
          {u.status === 'failed' ? (
            <button type="button" className="ghost" onClick={() => onRetry(u.id)}>
              Повторить
            </button>
          ) : null}
          <button
            type="button"
            className="iconbtn"
            onClick={() => onDismiss(u.id)}
            aria-label="Убрать"
          >
            <X size={12} />
          </button>
        </div>
      ))}
    </div>
  );
}
