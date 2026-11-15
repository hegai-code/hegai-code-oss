import { isGoModel } from './run-settings.js';
import { useEffect, useRef, useState } from 'react';
import type { SessionSummary } from '@cc-remote/shared';
import { relTimeRu } from '../lib.js';
import { useSeat } from '../appHooks.js';
import { Check, CopyIcon, Pencil, RefreshCw, Trash2 } from '../icons.js';
import { PermissionModePicker } from './PermissionModePicker.js';
import type { CentralState } from '../useCentral.js';

/**
 * The info column for a session: identity up top, then flat
 * label/value rows, actions at the bottom. Renders only on wide viewports
 * (hidden under 1200px via CSS); when open, the header's Recap and action
 * buttons hide — this panel carries them instead.
 */
export function SessionInfo({
  session,
  machineName,
  machineId,
  central,
  canControl,
  onRename,
  onDelete,
  onToggleClosed,
  compact = false,
}: {
  session: SessionSummary;
  machineName: string;
  /** Both needed by the permission-mode row: it is a live-run control, so it
   *  has to reach the socket and the machine's offered modes. */
  machineId: string;
  central: CentralState;
  canControl: boolean;
  onRename: () => void;
  onDelete: () => void;
  /** Close this session (kanban stage `done`), or put it back to work. */
  onToggleClosed: () => void;
  /**
   * CONTROLS ONLY — the narrow-viewport rendering, where this is a sheet over
   * the transcript rather than a column beside it.
   *
   * A column can afford to describe: it is always there, costs nothing to
   * ignore, and the eye skips it. A sheet is a thing you opened on purpose,
   * and it was answering with nine label/value rows — machine, author,
   * project, agent, branch, folder, created, id — none of which you tapped a
   * session TITLE to find out. Worse, it scrolled, so the three actions that
   * are the only reason to open it were below the fold.
   *
   * What survives is what you can DO here (the permission mode, close, rename,
   * delete) plus the one line that is a warning rather than a fact — that you
   * are driving somebody else's session. Everything removed is still one width
   * away on a desk, and none of it is reachable only here.
   */
  compact?: boolean;
}) {
  const isCodex = session.source === 'codex';
  // OpenCode is Codex on a `pool-go/` model, and only a live run names its model.
  const onGo = isCodex && isGoModel(central.runSettings?.activeModel ?? central.runSettings?.model);
  const closed = session.stage === 'done';
  const live = !!session.livePid || !!session.active;
  const status = session.livePid
    ? `запущена в ${session.entrypoint ?? 'редакторе'}`
    : session.active
      ? 'активна сейчас'
      : `активна ${relTimeRu(session.lastModified)}`;

  // [community] Who started it, and whether the person reading this is someone
  // else holding its run right now. The "you are driving" line wants to sit
  // under the composer; that composer lives in panels/Chat.tsx, so until it
  // grows the line itself, the info column carries it — it is the one place
  // that already says whose session this is.
  const seat = useSeat();
  const owner = session.owner;
  const ownerName = owner?.fullName || owner?.email;
  const drivingTheirs =
    !!owner && !!ownerName && !!seat.viewerId && owner.userId !== seat.viewerId && seat.activeSessionId === session.sessionId;

  const [copied, setCopied] = useState(false);
  const timer = useRef(0);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const copyId = () => {
    if (!navigator.clipboard) return;
    navigator.clipboard.writeText(session.sessionId).then(() => {
      setCopied(true);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 1200);
    });
  };

  return (
    <aside className={`ws-info ${compact ? 'si-compact' : ''}`}>
      {/* The name and the status are the header you TAPPED to get here, said
          again two lines lower. On a desk the column is not opened, so it has
          to identify itself; in a sheet it does not. */}
      {!compact && (
        <div className="si-head">
          <div className="si-name">{session.title || session.sessionId.slice(0, 8)}</div>
          <div className={`si-status ${live ? 'live' : ''}`}>{status}</div>
        </div>
      )}
      {/* Kept at every width: not a fact about the session, a warning about
          what your next keystroke does to somebody else's. */}
      {drivingTheirs && <div className="si-drive">сессия {ownerName} — вы ведёте её сейчас</div>}

      <div className="si-rows">
        {!compact && (
          <div className="si-row">
            <span className="si-label">Машина</span>
            <span className="si-value">{machineName}</span>
          </div>
        )}
        {!compact && ownerName && (
          <div className="si-row">
            <span className="si-label">Автор</span>
            <span className="si-value">{ownerName}</span>
          </div>
        )}
        {!compact && session.project && (
          <div className="si-row">
            <span className="si-label">Проект</span>
            <span className="si-value">{session.project}</span>
          </div>
        )}
        {!compact && (
          <div className="si-row">
            <span className="si-label">Агент</span>
            <span className="si-value">
              {isCodex ? (onGo ? 'OpenCode' : 'OpenAI Codex') : 'Claude Code'}
              {session.cliVersion ? ` · v${session.cliVersion}` : ''}
            </span>
          </div>
        )}
        {/* Directly under the agent that obeys it, and the ONE row that stays
            in the compact rendering — it is a control, not a description.
            Renders nothing unless a run is attached — see PermissionModePicker. */}
        <PermissionModePicker central={central} session={session} machineId={machineId} />
        {!compact && session.gitBranch && (
          <div className="si-row">
            <span className="si-label">Ветка</span>
            <span className="si-value mono">{session.gitBranch}</span>
          </div>
        )}
        {!compact && session.cwd && (
          <div className="si-row">
            <span className="si-label">Папка</span>
            <span className="si-value mono">{session.cwd}</span>
          </div>
        )}
        {!compact && session.createdAt && (
          <div className="si-row">
            <span className="si-label">Создана</span>
            <span className="si-value">{new Date(session.createdAt).toLocaleDateString('ru-RU')}</span>
          </div>
        )}
        {!compact && (
          <div className="si-row">
            <span className="si-label">Сессия</span>
            <span className="si-value mono">
              {session.sessionId.slice(0, 8)}
              <button className="si-copy" onClick={copyId} title="Скопировать полный id сессии" aria-label="Скопировать id сессии">
                {copied ? <Check size={13} /> : <CopyIcon size={13} />}
              </button>
            </span>
          </div>
        )}
      </div>

      {canControl && (
        <div className="si-actions">
          {/* Closing is not deleting, and the two must not look alike: the
              transcript stays, the session simply stops asking to be looked at.
              So it sits with Rename in the plain tone and Delete keeps the
              danger one to itself. */}
          <button className="ghost si-close" onClick={onToggleClosed}>
            {closed ? <RefreshCw size={14} /> : <Check size={14} />}{' '}
            {closed ? 'Вернуть в работу' : 'Закрыть сессию'}
          </button>
          <button className="ghost" onClick={onRename}>
            <Pencil size={14} /> Переименовать
          </button>
          <button className="ghost danger" onClick={onDelete}>
            <Trash2 size={14} /> Удалить
          </button>
        </div>
      )}
    </aside>
  );
}
