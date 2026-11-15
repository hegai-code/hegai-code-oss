import { useCallback, useEffect, useMemo, useState } from 'react';
import { BrainIcon, RefreshCw, Trash2 } from '../icons.js';
import type { MemoryEntry } from '@cc-remote/shared';
import type { CentralState } from '../useCentral.js';
import { Md } from '../render/Blocks.js';
import { fileSizeLabel, pluralRu, relTimeRu } from '../lib.js';
import { askConfirm } from '../dialogs.js';

/** Memory view: what the hub remembers for the signed-in user.
 *
 * There is no EDIT control, deliberately. The Claude Code harness writes these
 * same files on each machine, and content sync is one-way by design: local
 * always wins, the hub is a courier and never an author. Editing here would put
 * a second writer on those files, which is what this project already refuses
 * for transcripts.
 *
 * Delete is offered, because a wrong memory is worse than a missing one — it
 * reloads into context as trusted context every session. It works by
 * tombstoning the row; agents see the marker in their catalog, stop offering
 * their copy back up, and move the local file into ~/.cc-remote/deleted-memories
 * rather than destroying it. */

function scopeLabel(entry: MemoryEntry, machineName: (id: string) => string): string {
  if (entry.scope === 'fleet') return 'Для всех машин';
  if (entry.scope === 'machine') return machineName(entry.scopeKey);
  return entry.scopeKey || 'Неизвестный проект';
}

/** `github.com/mirror/a.test` reads as `mirror/a.test` in a list where every
 *  row is already a repository — the host is noise until it differs. */
function shortProject(key: string): string {
  const parts = key.split('/');
  return parts.length > 2 ? parts.slice(1).join('/') : key;
}

/** The index Claude Code loads on EVERY session in a project. Everything else
 *  is pulled in on relevance, so this one file is what actually costs context
 *  as a corpus grows — worth showing, and worth flagging once it gets heavy.
 *  Pruning stays a human decision: silently trimming someone's memory would be
 *  a far worse failure than a fat index. */
const INDEX_FILE = 'MEMORY.md';
const INDEX_HEAVY_BYTES = 8 * 1024;

function fmtWhen(ms: number): string {
  return relTimeRu(ms);
}

export function Memory({ central }: { central: CentralState }) {
  const [entries, setEntries] = useState<MemoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<MemoryEntry | null>(null);
  const [body, setBody] = useState<string | null>(null);
  const [bodyError, setBodyError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [deleting, setDeleting] = useState(false);

  const machineName = useCallback(
    (id: string) =>
      central.machines.find((m) => m.machine.machineId === id)?.machine.name ?? id,
    [central.machines],
  );

  const refresh = useCallback(async () => {
    setError(null);
    try {
      setEntries(await central.memoryList());
    } catch (err) {
      setError((err as Error).message);
    }
  }, [central]);
  useEffect(() => void refresh(), [refresh]);

  const select = useCallback(
    async (entry: MemoryEntry) => {
      setSelected(entry);
      setBody(null);
      setBodyError(null);
      try {
        setBody(await central.memoryRead(entry.scope, entry.scopeKey, entry.path));
      } catch (err) {
        setBodyError((err as Error).message);
      }
    },
    [central],
  );

  /** Tombstone on the hub; every agent retires its local copy on the next
   *  catalog. Confirmed because it is fleet-wide and not undoable from here —
   *  the machines keep a copy under ~/.cc-remote/deleted-memories, but nothing
   *  in this UI puts it back. */
  const remove = useCallback(
    async (entry: MemoryEntry) => {
      const where = shortProject(scopeLabel(entry, machineName));
      if (!(await askConfirm(`Удалить «${entry.path}» (${where})?\n\nЗаметка удалится на всех машинах.`, { confirmLabel: 'Удалить', danger: true }))) return;
      setDeleting(true);
      try {
        await central.memoryDelete(entry.scope, entry.scopeKey, entry.path);
        setSelected(null);
        setBody(null);
        await refresh();
      } catch (err) {
        setBodyError((err as Error).message);
      } finally {
        setDeleting(false);
      }
    },
    [central, machineName, refresh],
  );

  const groups = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const matched = (entries ?? []).filter(
      (e) =>
        !needle ||
        e.path.toLowerCase().includes(needle) ||
        e.scopeKey.toLowerCase().includes(needle),
    );
    const byKey = new Map<string, { label: string; entries: MemoryEntry[] }>();
    for (const entry of matched) {
      const id = `${entry.scope}:${entry.scopeKey}`;
      let group = byKey.get(id);
      if (!group) {
        group = { label: scopeLabel(entry, machineName), entries: [] };
        byKey.set(id, group);
      }
      group.entries.push(entry);
    }
    return [...byKey.values()]
      .map((g) => ({
        ...g,
        bytes: g.entries.reduce((n, e) => n + e.bytes, 0),
        indexBytes: g.entries.find((e) => e.path === INDEX_FILE)?.bytes ?? 0,
      }))
      .sort((a, b) => b.entries.length - a.entries.length || a.label.localeCompare(b.label));
  }, [entries, filter, machineName]);

  const total = entries?.length ?? 0;
  const shown = groups.reduce((n, g) => n + g.entries.length, 0);

  return (
    <div className="board">
      <div className="board-head">
        <BrainIcon size={20} />
        <h2>Память</h2>
        <span className="sub">
          {entries === null
            ? 'загружаем…'
            : `${total} ${pluralRu(total, ['заметка', 'заметки', 'заметок'])} в ${groups.length} ${pluralRu(
                groups.length,
                ['проекте', 'проектах', 'проектах'],
              )}${filter.trim() && shown !== total ? ` · показано ${shown}` : ''}`}
        </span>
        <button className="hw-btn mem-refresh" onClick={() => void refresh()}>
          <RefreshCw size={14} /> Обновить
        </button>
      </div>

      {error ? (
        <div className="placeholder">
          <div className="ph-sub">Не удалось загрузить память: {error}</div>
        </div>
      ) : entries !== null && total === 0 ? (
        <div className="placeholder">
          <div className="ph-sub">
            Пока ничего не запомнено. Память приходит только с машин, где задан
            CC_REMOTE_MEMORY_SYNC, и только из папок с git remote.
          </div>
        </div>
      ) : (
        <div className="mem-layout">
          <div className="mem-list">
            <input
              className="mem-filter"
              placeholder="Фильтр заметок…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
            {groups.map((group) => (
              <div className="mem-group" key={group.label}>
                <div className="mem-group-head">
                  <span className="mem-group-name">{shortProject(group.label)}</span>
                  <span className="mem-group-count">
                    {group.indexBytes > 0 && (
                      <span
                        className={`mem-index${group.indexBytes >= INDEX_HEAVY_BYTES ? ' heavy' : ''}`}
                        title={`${INDEX_FILE}: ${fileSizeLabel(group.indexBytes)}, загружается в контекст каждой сессии`}
                      >
                        индекс {fileSizeLabel(group.indexBytes)}
                      </span>
                    )}
                    {group.entries.length}
                  </span>
                </div>
                {group.entries.map((entry) => {
                  const active =
                    selected?.path === entry.path &&
                    selected?.scopeKey === entry.scopeKey &&
                    selected?.scope === entry.scope;
                  return (
                    <button
                      key={`${entry.scope}:${entry.scopeKey}:${entry.path}`}
                      className={`mem-row${active ? ' active' : ''}`}
                      onClick={() => void select(entry)}
                    >
                      <span className="mem-row-path">{entry.path.replace(/\.md$/, '')}</span>
                      <span className="mem-row-when">{fmtWhen(entry.updatedAt)}</span>
                    </button>
                  );
                })}
              </div>
            ))}
          </div>

          <div className="mem-body">
            {!selected ? (
              <div className="placeholder">
                <div className="ph-sub">Выберите заметку, чтобы прочитать.</div>
              </div>
            ) : (
              <>
                <div className="mem-body-head">
                  <span className="mem-body-title">{selected.path}</span>
                  <span className="mem-body-meta">
                    {shortProject(scopeLabel(selected, machineName))} · версия {selected.revision} ·{' '}
                    {fileSizeLabel(selected.bytes)} · {fmtWhen(selected.updatedAt)}
                  </span>
                  <button
                    className="hw-btn danger mem-delete"
                    disabled={deleting}
                    onClick={() => void remove(selected)}
                  >
                    <Trash2 size={13} /> {deleting ? 'Удаляем…' : 'Удалить'}
                  </button>
                </div>
                {bodyError ? (
                  <div className="mem-body-error">{bodyError}</div>
                ) : body === null ? (
                  <div className="mem-body-loading">Загружаем…</div>
                ) : (
                  <div className="mem-body-text">
                    <Md text={body} />
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
