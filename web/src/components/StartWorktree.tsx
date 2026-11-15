import { useCallback, useEffect, useState } from 'react';
import type { GitStatusResult, GitWorktree } from '@cc-remote/shared';
import type { CentralState } from '../useCentral.js';
import { askConfirm } from '../dialogs.js';

export interface WorktreeChoice {
  on: boolean;
  /** What the person typed; empty until they touch the field. */
  branch: string;
}

const CYR: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm',
  н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch',
  ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

/** `agent/<short-slug>-<MMDD>`: the first words of the task, latin, lower-case. */
export function defaultBranchName(task: string, now = new Date()): string {
  const words = task
    .toLowerCase()
    .replace(/[а-яё]/g, (c) => CYR[c] ?? '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .slice(0, 3)
    .join('-')
    .slice(0, 24)
    .replace(/-+$/, '');
  const date = `${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  return `agent/${words || 'task'}-${date}`;
}

/** Whether `cwd` on `machineId` is a git repository (quiet read). */
export function useIsRepo(central: CentralState, machineId: string | undefined, cwd: string | undefined): boolean {
  const [repo, setRepo] = useState<{ of: string; is: boolean } | null>(null);
  const rpc = central.rpc;
  const open = central.status === 'open';
  const of = machineId && cwd ? `${machineId}::${cwd}` : '';
  useEffect(() => {
    if (!of || !machineId || !cwd || !open) return;
    let alive = true;
    rpc<GitStatusResult>(machineId, 'git.status', { cwd }, true)
      .then((r) => alive && setRepo({ of, is: r.isRepo }))
      .catch(() => alive && setRepo({ of, is: false }));
    return () => {
      alive = false;
    };
  }, [rpc, open, machineId, cwd, of]);
  return repo?.of === of && repo.is;
}

/**
 * «В отдельной ветке (worktree)»: start the agent in its own checkout of a new
 * branch, so several agents can work on one repository side by side. Below it,
 * the repository's worktrees with a remove action.
 */
export function StartWorktree({
  central,
  machineId,
  cwd,
  draft,
  value,
  onChange,
  onNote,
}: {
  central: CentralState;
  machineId: string;
  cwd: string;
  draft: string;
  value: WorktreeChoice;
  onChange: (next: WorktreeChoice) => void;
  onNote: (text: string) => void;
}) {
  const rpc = central.rpc;
  const [list, setList] = useState<GitWorktree[]>([]);
  const [busy, setBusy] = useState('');
  const refresh = useCallback(() => {
    rpc<{ worktrees: GitWorktree[] }>(machineId, 'git.worktree.list', { cwd }, true)
      .then((r) => setList(r.worktrees.filter((w) => !w.main)))
      .catch(() => setList([]));
  }, [rpc, machineId, cwd]);
  useEffect(refresh, [refresh]);

  const remove = async (w: GitWorktree) => {
    if (w.dirty > 0 && !(await askConfirm(`В «${w.branch ?? w.path}» есть незакоммиченные изменения (${w.dirty}). Удалить вместе с ними?`, { confirmLabel: 'Удалить', danger: true }))) return;
    setBusy(w.path);
    try {
      const r = await rpc<{ ok: boolean; output: string }>(machineId, 'git.worktree.remove', { cwd, path: w.path, force: w.dirty > 0 }, true);
      onNote(r.ok ? `Worktree «${w.branch ?? w.path}» удалён (ветка осталась).` : r.output);
    } catch (e) {
      onNote(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy('');
      refresh();
    }
  };

  return (
    <div className="wt-opt">
      <div className="wt-row">
        <label className="wt-check">
          <input type="checkbox" checked={value.on} onChange={(e) => onChange({ ...value, on: e.target.checked })} />
          В отдельной ветке (worktree)
        </label>
        {value.on && (
          <input
            className="rv-input wt-branch"
            value={value.branch || defaultBranchName(draft)}
            onChange={(e) => onChange({ ...value, branch: e.target.value })}
            aria-label="Имя ветки"
            spellCheck={false}
          />
        )}
      </div>
      {list.length > 0 && (
        <details>
          <summary>Worktree проекта: {list.length}</summary>
          <div className="wt-list">
            {list.map((w) => (
              <div key={w.path} className="wt-item">
                <span className="mono" title={w.path}>
                  {w.branch ?? w.head}
                  {w.dirty > 0 ? ` · изменений ${w.dirty}` : ''}
                  {w.ahead ? ` · +${w.ahead}` : ''}
                  {w.busy ? ' · работает' : ''}
                </span>
                <button type="button" className="ghost" disabled={!!busy || w.busy} onClick={() => void remove(w)}>
                  Удалить
                </button>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
