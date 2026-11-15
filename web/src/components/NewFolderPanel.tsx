import { useState } from 'react';
import type { CentralState } from '../useCentral.js';
import { X } from '../icons.js';
import { NO_HUB, RPC_TIMEOUT } from '../useCentral.js';

/** The hub's rule for a member's folder (`single_folder_name` in rpc.rs):
 *  one name, no separators, nothing hidden, no drive colon, up to 64. */
export function folderNameError(name: string): string {
  if (!name.trim()) return '';
  if (name !== name.trim()) return 'Пробелы по краям не нужны.';
  if (name.length > 64) return 'Не длиннее 64 символов.';
  if (name === '.' || name === '..' || name.startsWith('.')) return 'Имя не может начинаться с точки.';
  // eslint-disable-next-line no-control-regex
  if (/[/\\:\u0000-\u001f\u007f]/.test(name)) return 'Одно имя: без «/», «\\» и «:».';
  return '';
}

function normForCompare(p: string): string {
  const s = p.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  return /^([a-zA-Z]:|\/\/)/.test(s) ? s.toLowerCase() : s;
}

/** The shared root (as the hub knows it) that contains `cwd`, the deepest one.
 *  The hub only lets a member make a folder AT such a root, never deeper. */
export function shareRootFor(cwd: string, roots: string[]): string | undefined {
  const c = normForCompare(cwd);
  let best: string | undefined;
  for (const r of roots) {
    const n = normForCompare(r);
    if ((c === n || c.startsWith(`${n}/`)) && (!best || n.length > normForCompare(best).length)) best = r;
  }
  return best;
}

function describeMkdirError(message: string): string {
  if (message === NO_HUB || message === RPC_TIMEOUT || /not connected|rpc timeout/i.test(message)) {
    return 'Машина не ответила — подключение потерялось. Попробуй ещё раз.';
  }
  if (/Папка с таким именем уже есть|already exists|EEXIST/i.test(message)) return 'Папка с таким именем уже есть.';
  if (/Read-only workspace/i.test(message)) return 'Здесь нельзя создавать папки — только внутри общей папки.';
  return message;
}

/**
 * «Новая папка» for a member on a shared machine: one folder directly inside
 * the chosen shared folder, then a session starts in it. The hub allows
 * nothing else to a member (`fs.mkdir`, a single name, under a shared root).
 */
export function NewFolderPanel({
  machineId,
  root,
  rpc,
  onCreated,
  onClose,
}: {
  machineId: string;
  /** The shared ROOT the new folder is made in (the hub refuses anything deeper). */
  root: string;
  rpc: CentralState['rpc'];
  onCreated: (cwd: string, label: string) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const nameError = folderNameError(name);
  const canSubmit = name.length > 0 && !nameError && !busy;

  const submit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError('');
    try {
      const r = await rpc<{ created?: boolean }>(machineId, 'fs.mkdir', { cwd: root, path: name });
      // An existing folder is never a fresh one: no session starts as if it were new.
      if (r?.created === false) {
        setError('Папка с таким именем уже есть.');
        return;
      }
      const sep = root.includes('\\') && !root.includes('/') ? '\\' : '/';
      onCreated(`${root.replace(/[/\\]+$/, '')}${sep}${name}`, name);
    } catch (err) {
      setError(describeMkdirError((err as Error).message));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="proj-pop newproj" onSubmit={submit} aria-label="Новая папка">
      <div className="np-head">
        <span className="np-title">Новая папка</span>
        <button type="button" className="icon-btn" onClick={onClose} title="Закрыть" aria-label="Закрыть">
          <X size={15} />
        </button>
      </div>
      <label className="np-field">
        <span>Имя</span>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="например, отчёт"
          spellCheck={false}
          disabled={busy}
          aria-invalid={!!nameError}
        />
        {nameError && <small className="np-hint">{nameError}</small>}
      </label>
      <div className="np-actions">
        <button type="submit" className="btn primary" disabled={!canSubmit}>
          {busy ? 'Создаём…' : 'Создать и начать'}
        </button>
        <small className="np-note">Создастся внутри {root} — в общей папке, где у тебя есть доступ.</small>
      </div>
      {error && <div className="np-error" role="alert">{error}</div>}
    </form>
  );
}
