import { useEffect, useState, type MouseEvent } from 'react';
import type { GitStatusResult, SessionSummary } from '@cc-remote/shared';
import type { CentralState } from '../useCentral.js';
import { cleanTitle } from '../lib.js';
import { SESSIONS, linkProps, navigate, pathFor } from '../router.js';
import { ArrowLeft, ArrowSquareOut } from '../icons.js';
import { AgentMark } from '../components/AgentMark.js';
import { Chat } from '../panels/Chat.js';
import { Mirror } from '../panels/Mirror.js';
import { FULL_ORIGIN, fullHref } from './origin.js';

/**
 * One task: what the agent said, what it asks, and a box to answer in.
 *
 * The transcript and the composer are the full client's `Chat`, in its `lite`
 * variant — so history paging, the cache-first read, the questions-as-buttons
 * strip and «работает… 1:42» are not rewritten here, and a fix to any of them
 * lands in both shells at once. The head carries only what a person who did
 * not come for the machinery needs: the way back, the task's name, what
 * changed in the project, and the door to the full client for everything else.
 */

/** A link to a report this hub serves — the agent writes them as full
 *  addresses on the full client's host. */
const REPORT_PATH = /^\/w\/reports\/([^/?#]+)$/;

function codeLabel(code: string): string {
  const c = code.trim();
  if (c === '??') return 'новый';
  if (c.includes('D')) return 'удалён';
  if (c.includes('A')) return 'добавлен';
  if (c.includes('R')) return 'переименован';
  return 'изменён';
}

/**
 * «Изменения в проекте»: the working tree's uncommitted files.
 *
 * Named for what it is. `git status` answers for the PROJECT, not for this
 * task — two tasks in one folder show the same list — and a heading that
 * claimed «что сделала эта задача» would be wrong exactly when it matters.
 */
function useChanges(c: CentralState, machineId: string, cwd: string | undefined, settledKey: string) {
  // Stamped with the folder it was read from. This view is reused from one
  // task to the next, and an answer kept bare would go on being shown under a
  // task in another folder — or under one with no folder at all, for which
  // nothing is ever asked. A re-read of the SAME folder keeps the old list on
  // screen until the new one lands, so the count does not blink on every turn.
  const [status, setStatus] = useState<{ of: string; data: GitStatusResult } | null>(null);
  const rpc = c.rpc;
  const open = c.status === 'open';
  const of = cwd ? `${machineId}::${cwd}` : '';
  useEffect(() => {
    if (!cwd || !open) return;
    let alive = true;
    // `quiet`: a read the screen makes on its own must not raise a toast.
    rpc<GitStatusResult>(machineId, 'git.status', { cwd }, true)
      .then((data) => {
        if (alive) setStatus({ of, data });
      })
      // A member without file access, an agent mid-reconnect, a folder that is
      // gone: there is simply no list to show.
      .catch(() => {
        if (alive) setStatus(null);
      });
    return () => {
      alive = false;
    };
  }, [rpc, open, machineId, cwd, of, settledKey]);
  return status && status.of === of && status.data.isRepo ? status.data : null;
}

export function TaskView({
  central: c,
  session,
  machineId,
  working,
  canDrive,
  ownsSelected,
}: {
  central: CentralState;
  session: SessionSummary;
  machineId: string;
  working: boolean;
  /** May the viewer send to this session (controls the machine, or was given
   *  the folder with control)? */
  canDrive: boolean;
  /** This shell's run holds the session — see `LiteApp`. */
  ownsSelected: boolean;
}) {
  const sessionId = session.sessionId;
  // Re-read when a turn ends: that is when the tree has changed.
  const changes = useChanges(c, machineId, session.cwd, `${sessionId}:${c.busy ? 'busy' : c.turnPhase}`);
  const [showChanges, setShowChanges] = useState(false);
  useEffect(() => setShowChanges(false), [sessionId]);
  const count = changes?.files.length ?? 0;

  /** A report opens here, under this shell's head — not as a second tab on the
   *  full client. Anything else in the transcript is an ordinary link. */
  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
    if (!a) return;
    let url: URL;
    try {
      url = new URL(a.href, location.href);
    } catch {
      return;
    }
    if (url.origin !== location.origin && url.origin !== FULL_ORIGIN) return;
    const m = REPORT_PATH.exec(url.pathname);
    if (!m) return;
    e.preventDefault();
    navigate({ kind: 'reports', id: decodeURIComponent(m[1]!) });
  };

  const title = cleanTitle(session.title) || 'Задача';
  const here = pathFor({ kind: 'session', machineId, sessionId });
  return (
    <div className="lt-task" onClick={onClick}>
      <div className="lt-task-head">
        <a className="icon-btn" {...linkProps(SESSIONS)} title="К задачам" aria-label="К задачам">
          <ArrowLeft size={18} />
        </a>
        <div className="lt-task-titles">
          {working && <AgentMark source={session.source} provider={session.provider} size={14} className="srun" />}
          {session.project && (
            <>
              <span className="lt-task-proj" title={session.cwd}>
                {session.project}
              </span>
              <span className="lt-task-sep" aria-hidden>
                /
              </span>
            </>
          )}
          <h1 className="lt-task-title" title={title}>
            {title}
          </h1>
        </div>
        {count > 0 && (
          <button
            type="button"
            className={`lt-head-btn${showChanges ? ' on' : ''}`}
            aria-expanded={showChanges}
            onClick={() => setShowChanges((v) => !v)}
            title="Незакоммиченные изменения в папке проекта"
          >
            Изменения <span className="lt-pile-n">{count}</span>
          </button>
        )}
        {sessionId && (
          <a className="lt-head-btn" href={fullHref(here)} title="Эта же сессия в полной версии: модель, файлы, терминал, колонки">
            <span className="lt-head-btn-text">Полная версия</span> <ArrowSquareOut size={13} />
          </a>
        )}
      </div>

      {showChanges && changes && (
        <div className="lt-changes" role="region" aria-label="Изменения в проекте">
          <div className="lt-changes-head">
            <span>
              Изменения в проекте <span className="lt-changes-branch">{changes.branch}</span>
            </span>
            {session.cwd && (
              <a className="lt-quiet" href={fullHref(pathFor({ kind: 'files', machineId, root: session.cwd }))}>
                Открыть файлы <ArrowSquareOut size={12} />
              </a>
            )}
          </div>
          <ul className="lt-changes-list">
            {changes.files.slice(0, 200).map((f) => (
              <li key={f.path}>
                <span className="lt-change-path">{f.path}</span>
                <span className="lt-change-kind">{codeLabel(f.code)}</span>
              </li>
            ))}
          </ul>
          {changes.files.length > 200 && <div className="lt-note">…и ещё {changes.files.length - 200}</div>}
        </div>
      )}

      <div className="panel">
        {session.livePid && !ownsSelected ? (
          // Open in an editor or a terminal on the machine: a read-only view
          // whose composer takes the session over on send, as everywhere else.
          <Mirror
            central={c}
            session={session}
            machineId={machineId}
            readOnly={!canDrive}
            onSend={(message, images, files) => c.takeover(machineId, sessionId, message, images, files)}
          />
        ) : (
          <Chat
            key={sessionId}
            variant="lite"
            central={c}
            session={session}
            machineId={machineId}
            takingOver={!!session.livePid && !c.active?.runId}
            readOnly={!canDrive}
          />
        )}
      </div>
    </div>
  );
}
