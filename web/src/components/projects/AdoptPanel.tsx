import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FsEntry, FsListResult, ProjectAdoptResult } from '@cc-remote/shared';
import { ArrowLeft, Check, Folder, X } from '../../icons.js';
import type { CentralState } from '../../useCentral.js';

/**
 * «Добавить проект» — turn a folder that already exists on the machine into a
 * project.
 *
 * The gap it fills is narrow and specific. The agent's root scan admits a
 * directory only if it holds `.git`, at depth one or two under a declared root,
 * so a plain working folder is invisible however many roots are declared — and
 * the only cure was to start a session in it, which you cannot do from a picker
 * that will not list it. `projects.create` does not help either: it only ever
 * makes something NEW, flat inside the projects root.
 *
 * Browsing goes through `fs.list`, so the boundary is the agent's own
 * allow-list (`assertRoot`) rather than anything invented here: you can adopt
 * exactly what you could already open in «Файлы». A folder outside every
 * declared root is not reachable — that needs a new root on the machine, which
 * is an operator's decision and lives in `agent.env`, not in a dialog.
 */

/** One rung of the browse stack: an absolute directory and how we got there. */
interface Level {
  /** Absolute path of the directory being shown. */
  dir: string;
  /** The root it is inside — `fs.list` is always addressed relative to a root
   *  the allow-list admits, never to an arbitrary absolute path. */
  root: string;
}

function relFrom(root: string, dir: string): string {
  const norm = root.replace(/[\\/]+$/, '');
  if (dir === norm) return '';
  const rest = dir.slice(norm.length).replace(/^[\\/]+/, '');
  return rest;
}

function joinPath(dir: string, name: string): string {
  const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/';
  return dir.endsWith(sep) ? `${dir}${name}` : `${dir}${sep}${name}`;
}

export function AdoptPanel({
  central,
  machineId,
  machineName,
  roots,
  known,
  onClose,
  onAdopted,
}: {
  central: CentralState;
  machineId: string;
  machineName: string;
  roots: string[];
  /** cwds this machine already reports as projects, so a row can say so instead
   *  of offering to add what is already there. */
  known: Set<string>;
  onClose: () => void;
  onAdopted: () => void;
}) {
  const [level, setLevel] = useState<Level | null>(null);
  const [entries, setEntries] = useState<FsEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [added, setAdded] = useState<Set<string>>(new Set());

  // One root needs no chooser — opening straight into it saves a click that
  // only ever has one answer.
  useEffect(() => {
    if (!level && roots.length === 1) setLevel({ dir: roots[0]!, root: roots[0]! });
  }, [roots, level]);

  useEffect(() => {
    if (!level) return;
    let alive = true;
    setLoading(true);
    setError(null);
    central
      .rpc<FsListResult>(machineId, 'fs.list', { cwd: level.root, path: relFrom(level.root, level.dir) })
      .then((res) => {
        if (!alive) return;
        setEntries(res.entries.filter((e) => e.kind === 'dir' && !e.name.startsWith('.')));
      })
      .catch((err: Error) => {
        if (alive) setError(err.message);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [central, machineId, level]);

  const adopt = useCallback(
    async (dir: string) => {
      setBusy(dir);
      setError(null);
      try {
        const res = await central.rpc<ProjectAdoptResult>(machineId, 'projects.adopt', { cwd: dir });
        setAdded((prev) => new Set(prev).add(res.cwd));
        onAdopted();
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setBusy(null);
      }
    },
    [central, machineId, onAdopted],
  );

  const canGoUp = useMemo(
    () => !!level && level.dir.replace(/[\\/]+$/, '') !== level.root.replace(/[\\/]+$/, ''),
    [level],
  );

  const goUp = useCallback(() => {
    if (!level || !canGoUp) return;
    const cut = Math.max(level.dir.lastIndexOf('/'), level.dir.lastIndexOf('\\'));
    setLevel({ dir: cut > 0 ? level.dir.slice(0, cut) : level.root, root: level.root });
  }, [level, canGoUp]);

  return (
    <div className="adopt-scrim" onClick={onClose}>
      <div className="adopt" onClick={(e) => e.stopPropagation()}>
        <div className="adopt-head">
          <div className="eyebrow eyebrow--mark">ДОБАВИТЬ ПРОЕКТ · {machineName}</div>
          <button className="adopt-x" onClick={onClose} title="Закрыть">
            <X size={16} />
          </button>
        </div>

        {roots.length === 0 ? (
          <div className="adopt-empty">
            Агент этой машины не сообщает свои корни — он старше этой возможности.
            Обновите бандл агента, и папки появятся здесь.
          </div>
        ) : (
          <>
            <div className="adopt-bar">
              <button className="adopt-up" onClick={goUp} disabled={!canGoUp} title="Вверх">
                <ArrowLeft size={14} />
              </button>
              <span className="adopt-crumb">{level?.dir ?? 'Выберите корень'}</span>
            </div>

            {!level ? (
              <div className="adopt-list">
                {roots.map((r) => (
                  <button key={r} className="adopt-row" onClick={() => setLevel({ dir: r, root: r })}>
                    <Folder size={14} />
                    <span className="adopt-name">{r}</span>
                  </button>
                ))}
              </div>
            ) : (
              <div className="adopt-list">
                {loading && <div className="adopt-empty">Читаю папку…</div>}
                {!loading && entries.length === 0 && (
                  <div className="adopt-empty">Внутри нет подпапок.</div>
                )}
                {entries.map((e) => {
                  const dir = joinPath(level.dir, e.name);
                  const isKnown = known.has(dir) || added.has(dir);
                  return (
                    <div className="adopt-row" key={e.name}>
                      <button
                        className="adopt-open"
                        onClick={() => setLevel({ dir, root: level.root })}
                        title="Открыть"
                      >
                        <Folder size={14} />
                        <span className="adopt-name">{e.name}</span>
                      </button>
                      {isKnown ? (
                        <span className="adopt-known">
                          <Check size={13} /> уже проект
                        </span>
                      ) : (
                        <button
                          className="adopt-btn"
                          disabled={busy === dir}
                          onClick={() => adopt(dir)}
                        >
                          {busy === dir ? '…' : 'Сделать проектом'}
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {level && (
              <div className="adopt-foot">
                {known.has(level.dir) || added.has(level.dir) ? (
                  <span className="adopt-known">
                    <Check size={13} /> эта папка уже проект
                  </span>
                ) : (
                  <button
                    className="adopt-btn wide"
                    disabled={busy === level.dir}
                    onClick={() => adopt(level.dir)}
                  >
                    {busy === level.dir ? '…' : `Сделать проектом «${level.dir.split(/[\\/]/).pop()}»`}
                  </button>
                )}
              </div>
            )}
          </>
        )}

        {error && <div className="adopt-error">{error}</div>}
        <div className="adopt-note">
          Ничего не создаётся и не перемещается — папка просто попадает в список.
          Убрать её оттуда можно тут же, диск это не тронет.
        </div>
      </div>
    </div>
  );
}
