import { useEffect, useMemo, useState } from 'react';
import type { MachineSnapshot, ProjectCreateResult, ProjectsResult, ViewerContext, WorkspaceSummary } from '@cc-remote/shared';
import type { CentralState } from '../useCentral.js';
import { teamApi } from '../teamApi.js';
import { teamsOf } from '../shell/workspace.js';
import { X } from '../icons.js';
import { NO_HUB, RPC_TIMEOUT } from '../useCentral.js';

/** The agent's rule (`shared/src/rpc.ts`, `projects.create`), checked live. */
export const PROJECT_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** Where `projects.create` puts a project: `<projects root>/<name>`, written
 *  with the separator the machine's own root uses. `undefined` until the agent
 *  has reported its root (an older agent never does). */
export function projectPathPreview(root: string | undefined, name: string): string | undefined {
  if (!root) return undefined;
  const sep = root.includes('\\') && !root.includes('/') ? '\\' : '/';
  return `${root.replace(/[\\/]+$/, '')}${sep}${name || '…'}`;
}

/** What typing becomes: lowercase, spaces to dashes — the name is a directory. */
export function normalizeProjectName(raw: string): string {
  return raw.toLowerCase().replace(/\s+/g, '-');
}

/** A name to suggest from a clone URL: the last path segment without `.git`. */
export function nameFromGitUrl(url: string): string {
  const seg = url.trim().replace(/\/+$/, '').split('/').pop() ?? '';
  return normalizeProjectName(seg.replace(/\.git$/i, ''));
}

/** The first prompt the composer suggests for a project made here. Shaped by
 *  how it was made: an empty repo wants a plan before code, a clone wants a
 *  reading before changes. Both end with the agent not touching anything yet. */
export const FIRST_PROMPT: Record<'empty' | 'clone', string> = {
  empty:
    'Опиши, что мы строим: кто пользователь, какую задачу решает, какой стек. Начни с карты и плана структуры репозитория — код не пиши, пока не согласуем.',
  clone: 'Разберись в этом репозитории: что это, как запускается, где главное. Доложи, ничего не меняя.',
};

/** The agent's error text → a sentence in the person's language. The raw
 *  message stays for anything unrecognised: a wrong guess would hide the one
 *  line that says what actually happened. */
export function describeCreateError(message: string): string {
  if (/already exists/i.test(message)) return 'Проект с таким именем уже есть.';
  if (/limit reached/i.test(message)) return 'На машине уже максимум проектов — уберите один, и место освободится.';
  if (/timed out/i.test(message)) return 'Git не ответил за две минуты — проверьте адрес или попробуйте позже.';
  if (message === NO_HUB || message === RPC_TIMEOUT || /not connected|rpc timeout/i.test(message)) return 'Машина не ответила — подключение потерялось. Попробуйте ещё раз.';
  if (/Read-only workspace/i.test(message)) return 'В этом пространстве у вас только просмотр — создать проект можно на своей машине.';
  return message;
}

export interface CreatedProject {
  machineId: string;
  cwd: string;
  label: string;
  kind: 'empty' | 'clone';
  /** The directory already existed (empty) and was reused. */
  reused: boolean;
  /** Sharing to the team was asked for and failed — the project still exists. */
  shareError?: string;
}

/**
 * «Новый проект» — a folder with git inside, which is all a session needs.
 *
 * Lives in the start screen's `.proj-pop` slot, where the project picker
 * lives, because it IS a way to pick a project: one that did not exist a
 * moment ago. Machine first (the sandbox is preselected when there is one),
 * a name checked as it is typed, empty or clone, and — only when the current
 * workspace is a team the viewer owns — a checkbox that publishes the root to
 * that team with control, so a teammate can start a session in it. The
 * caption says exactly what that opens and what it does not.
 */
export function NewProjectPanel({
  machines,
  viewer,
  workspace,
  rpc,
  onCreated,
  onClose,
}: {
  /** Online machines the viewer controls — the only ones an agent will create on. */
  machines: MachineSnapshot[];
  viewer: ViewerContext | null | undefined;
  /** The workspace the socket is scoped to (`central.viewer.workspace`). */
  workspace: WorkspaceSummary | undefined;
  rpc: CentralState['rpc'];
  onCreated: (p: CreatedProject) => void;
  onClose: () => void;
}) {
  const [machineId, setMachineId] = useState(
    () => (machines.find((m) => m.kind === 'sandbox') ?? machines[0])?.machine.machineId ?? '',
  );
  // A machine that drops offline mid-form takes its option with it.
  useEffect(() => {
    if (!machines.some((m) => m.machine.machineId === machineId)) {
      setMachineId((machines.find((m) => m.kind === 'sandbox') ?? machines[0])?.machine.machineId ?? '');
    }
  }, [machines, machineId]);
  const [name, setName] = useState('');
  // The agent's projects root, asked once per machine for the «где создастся» line.
  const [roots, setRoots] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!machineId || roots[machineId] !== undefined) return;
    let live = true;
    rpc<ProjectsResult>(machineId, 'projects.list', {})
      .then((r) => { if (live) setRoots((prev) => ({ ...prev, [machineId]: r.roots?.[0] ?? '' })); })
      .catch(() => { if (live) setRoots((prev) => ({ ...prev, [machineId]: '' })); });
    return () => { live = false; };
  }, [machineId, rpc, roots]);
  const where = projectPathPreview(roots[machineId] || undefined, name);
  const [mode, setMode] = useState<'empty' | 'clone'>('empty');
  const [gitUrl, setGitUrl] = useState('');
  const [share, setShare] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // The team this could be published to: the CURRENT workspace, and only if
  // it is one of the viewer's teams that they own (`teamsOf` is the sanctioned
  // reading; the component never asks what kind a workspace is).
  const team = useMemo(() => {
    if (!workspace) return undefined;
    return teamsOf(viewer).find((w) => w.workspaceId === workspace.workspaceId && w.role === 'owner');
  }, [viewer, workspace]);

  const nameOk = PROJECT_NAME_RE.test(name);
  const urlOk = /^https:\/\/\S+$/.test(gitUrl.trim());
  const canSubmit = !!machineId && nameOk && (mode === 'empty' || urlOk) && !busy;

  const submit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError('');
    try {
      const r = await rpc<ProjectCreateResult>(machineId, 'projects.create', {
        name,
        ...(mode === 'clone' ? { gitUrl: gitUrl.trim() } : { template: 'empty' }),
      });
      let shareError: string | undefined;
      if (share && team) {
        try {
          await teamApi.shareProject(team.workspaceId, machineId, r.cwd, r.label, 'control', 'everyone');
        } catch (err) {
          shareError = (err as Error).message;
        }
      }
      onCreated({
        machineId,
        cwd: r.cwd,
        label: r.label,
        kind: r.git === 'clone' ? 'clone' : 'empty',
        reused: !r.created,
        ...(shareError ? { shareError } : {}),
      });
    } catch (err) {
      setError(describeCreateError((err as Error).message));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="proj-pop newproj" onSubmit={submit} aria-label="Новый проект">
      <div className="np-head">
        <span className="np-title">Новый проект</span>
        <button type="button" className="icon-btn" onClick={onClose} title="Закрыть" aria-label="Закрыть">
          <X size={15} />
        </button>
      </div>

      <label className="np-field">
        <span>Машина</span>
        <select value={machineId} onChange={(e) => setMachineId(e.target.value)} disabled={busy}>
          {machines.map((m) => (
            <option key={m.machine.machineId} value={m.machine.machineId}>
              {m.machine.name}
              {m.kind === 'sandbox' ? ' · песочница' : ''}
            </option>
          ))}
        </select>
      </label>

      <label className="np-field">
        <span>Имя</span>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(normalizeProjectName(e.target.value))}
          placeholder="my-app"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          disabled={busy}
          aria-invalid={name.length > 0 && !nameOk}
        />
        {name.length > 0 && !nameOk ? (
          <small className="np-hint">
            Строчные латинские буквы, цифры, точка, дефис и подчёркивание; первый символ — буква или цифра; до 64.
          </small>
        ) : (
          <small className="np-hint">Создастся {where ? <code className="np-path">{where}</code> : 'в рабочей папке машины'}</small>
        )}
      </label>

      <div className="np-mode" role="group" aria-label="Откуда">
        {(['empty', 'clone'] as const).map((m) => (
          <button
            key={m}
            type="button"
            className={`np-mode-opt ${mode === m ? 'active' : ''}`}
            aria-pressed={mode === m}
            disabled={busy}
            onClick={() => setMode(m)}
          >
            {m === 'empty' ? 'Пустой' : 'Из репозитория'}
          </button>
        ))}
      </div>

      {mode === 'clone' && (
        <label className="np-field">
          <span>Адрес https</span>
          <input
            value={gitUrl}
            onChange={(e) => {
              setGitUrl(e.target.value);
              if (!name) setName(nameFromGitUrl(e.target.value));
            }}
            placeholder="https://github.com/you/project.git"
            spellCheck={false}
            inputMode="url"
            disabled={busy}
            aria-invalid={gitUrl.length > 0 && !urlOk}
          />
          <small className="np-hint">Только https — у машины нет SSH-ключей. Приватный репозиторий попросит токен уже в сессии.</small>
        </label>
      )}

      {team && (
        <label className="np-check">
          <input type="checkbox" checked={share} onChange={(e) => setShare(e.target.checked)} disabled={busy} />
          <span>
            <b>Сделать командным</b>
            <small>
              Люди из команды смогут запускать сессии в этой папке на вашей машине. Остальные папки остаются
              личными.
            </small>
          </span>
        </label>
      )}

      {error && <div className="np-error" role="alert">{error}</div>}

      <div className="np-actions">
        <button type="submit" className="btn primary" disabled={!canSubmit}>
          {busy ? (mode === 'clone' ? 'Клонируем…' : 'Создаём…') : 'Создать'}
        </button>
        <small className="np-note">
          {mode === 'clone' ? 'git clone в папку проектов на машине.' : 'git init, README и первый коммит — дальше ваше.'}
        </small>
      </div>
    </form>
  );
}
