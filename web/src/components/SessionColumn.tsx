import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { AttentionState, SessionSummary } from '@cc-remote/shared';
import type { CentralState } from '../useCentral.js';
import { useSessionChannel } from '../sessionChannel.js';
import { Chat } from '../panels/Chat.js';
import { attentionTitle, displayName, shortName } from '../lib.js';
import { QuestionModal } from './QuestionModal.js';
import { AgentMark } from './AgentMark.js';
import { AlertTriangle, Check, MoreIcon, X } from '../icons.js';

/**
 * A pane's heading that turns into its own editor on click.
 *
 * Enter or leaving the field saves; Esc, an empty field or an unchanged one
 * cancels without a request. The new title shows at once and stays until the
 * inventory catches up (the agent renames, then rescans), so the heading never
 * flicks back to the old name in between; a failed rename puts the old one
 * back. Without `onRename` it is plain text — nothing to click.
 */
export function InlineTitle({
  title,
  onRename,
  onEditingChange,
}: {
  title: string;
  onRename?: (title: string) => Promise<void>;
  onEditingChange: (editing: boolean) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [shown, setShown] = useState<string | null>(null);
  const settled = useRef(false);

  // The inventory caught up (or somebody else renamed it): drop the optimistic copy.
  useEffect(() => setShown(null), [title]);

  const begin = () => {
    settled.current = false;
    setDraft(shown ?? title);
    onEditingChange(true);
  };
  const end = (save: boolean) => {
    if (settled.current || draft === null) return;
    settled.current = true;
    const next = draft.trim();
    setDraft(null);
    onEditingChange(false);
    if (!save || !next || next === (shown ?? title) || !onRename) return;
    setShown(next);
    onRename(next).catch(() => setShown(null));
  };

  if (draft !== null) {
    return (
      <input
        className="sc-col-title sc-col-title-input"
        value={draft}
        autoFocus
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            end(true);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            end(false);
          }
        }}
        onBlur={() => end(true)}
        aria-label="Название сессии"
      />
    );
  }
  const text = shown ?? title;
  if (!onRename) {
    return <div className="sc-col-title static" title={text}>{text}</div>;
  }
  return (
    <button type="button" className="sc-col-title" title={`${text} — переименовать`} onClick={begin}>
      {text}
    </button>
  );
}

// The per-state dot colours lived here. The dot itself is gone (see the state
// row below), and an unused map of colours is how a removed element quietly
// comes back — so the colours went with it. `.sc-col-state` is keyed by state
// in CSS if these ever need to be said again.

/** The state, SAID. The dot alone carried it as a `title` attribute, which is a
 *  tooltip — unreachable on touch and invisible while skimming four panes at
 *  once, which is the whole reason this lens exists. A colour plus a word is
 *  also the one status encoding that survives a colour-blind reader. */
/** The socket's state, said in the product's language (it printed the raw
 *  `connecting` / `closed` enum). */
const STATUS_LABEL: Record<string, string> = { connecting: 'подключение…', closed: 'нет связи' };

const STATE_LABEL: Record<AttentionState, string> = {
  working: 'Работает',
  // `needs_attention` is resolved through `attentionTitle` at the call site —
  // it depends on WHAT is pending, which this table cannot see. Kept here so
  // the record stays exhaustive over AttentionState.
  needs_attention: 'Нужно решение',
  idle: 'Готово',
  error: 'Ошибка',
};

/**
 * One live session pane in the multi-column grid.
 *
 * A pane is a session VIEW on the window's one hub socket
 * (`useSessionChannel(central.link)`), not a socket of its own. It used to own
 * a whole `useCentral` — a second handshake and a second copy of the fleet
 * snapshot per pane, and an empty machine list that said «Машина офлайн» until
 * that snapshot landed. Now the fleet, the status and the machines are the
 * shell's, already loaded; what the pane keeps is only the run it follows.
 * Reuses the full `Chat` panel; renders its own tool-approval (the main App's
 * approval modal is bound to the shell's own view, not this one).
 */
export function SessionColumn({
  central: shell,
  session,
  machineId,
  machineName,
  onClose,
  onMenu,
  dragging = false,
  dropTarget = false,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
  onRename,
  focused = false,
  onFocusPane,
  grow,
  tabs,
}: {
  /** The group's tab strip and drop zone (TabStrip.tsx), drawn above the head. */
  tabs?: ReactNode;
  /** This pane's share of the split's width (`flex-grow`), set by dragging
   *  the handle beside it — see SessionColumns. Absent = an equal share. */
  grow?: number;
  /** The pane everything chosen outside the split opens in (router `splitFocus`). */
  focused?: boolean;
  /** Pressing anywhere in the pane makes it the focused one. */
  onFocusPane?: () => void;
  /** Save a new title. Absent when the viewer may not rename this session (a
   *  control-share member drives it but does not own its name) — the title is
   *  then plain text. */
  onRename?: (title: string) => Promise<void>;
  /** The shell's hub state — the socket this pane shares, and the fleet. */
  central: CentralState;
  session: SessionSummary;
  machineId: string;
  machineName?: string;
  onClose: () => void;
  /** «…» left of the close button: the session's menu (the side panel's
   *  right-click one), dropped at these viewport coordinates. */
  onMenu?: (x: number, y: number) => void;
  /** Reordering, driven by the grid that owns the set. The HEADER is the
   *  handle, never the pane: a draggable pane would eat every text selection in
   *  the transcript and every drag of the composer. */
  dragging?: boolean;
  dropTarget?: boolean;
  onDragStart?: () => void;
  onDragEnd?: () => void;
  onDragOver?: () => void;
  onDrop?: () => void;
}) {
  const view = useSessionChannel(shell.link);
  // What `Chat` reads: the shell's socket and fleet, with THIS pane's session
  // view laid over it.
  const central = useMemo<CentralState>(() => ({ ...shell, ...view }), [shell, view]);
  const [editing, setEditing] = useState(false);

  // Attach on mount. focusSession subscribes to a live run if one exists;
  // if the session is dormant, it stays dormant. When activity arrives and the
  // run appears, re-attach. Reset attached when the session ID changes.
  const attached = useRef(false);
  useEffect(() => {
    attached.current = false;
  }, [machineId, session.sessionId]);

  const runExists = !!central.runFor(machineId, session.sessionId);
  useEffect(() => {
    if (attached.current || !session.sessionId) return;
    attached.current = true;
    central.focusSession(machineId, session.sessionId);
  }, [runExists, machineId, session.sessionId, central]);

  const run = central.runFor(machineId, session.sessionId);
  const live = central.active?.sessionId === session.sessionId && !!central.active?.runId;
  const state: AttentionState | undefined = run?.state ?? (live && central.busy ? 'working' : undefined);

  const req = central.toolReq;

  return (
    <section
      className={`session-col${focused ? ' focused' : ''}${dragging ? ' dragging' : ''}${dropTarget ? ' drop' : ''}`}
      aria-current={focused ? 'true' : undefined}
      style={grow !== undefined ? { flexGrow: grow } : undefined}
      onPointerDownCapture={onFocusPane}
      onFocusCapture={onFocusPane}
      onDragOver={
        onDragOver
          ? (e) => {
              // Without preventDefault the browser refuses the drop outright.
              e.preventDefault();
              e.dataTransfer.dropEffect = 'move';
              onDragOver();
            }
          : undefined
      }
      onDrop={
        onDrop
          ? (e) => {
              e.preventDefault();
              onDrop();
            }
          : undefined
      }
    >
      {tabs}
      <header
        className="sc-col-head"
        title={`${machineName ?? machineId}${session.project ? ` · ${session.project}` : ''}`}
        // Not while the title is an input: a draggable ancestor turns every
        // attempt to select text in the field into a drag of the whole pane.
        draggable={!!onDragStart && !editing}
        onDragStart={
          onDragStart
            ? (e) => {
                e.dataTransfer.effectAllowed = 'move';
                // Firefox starts no drag at all without payload on the event.
                e.dataTransfer.setData('text/plain', session.sessionId);
                onDragStart();
              }
            : undefined
        }
        onDragEnd={onDragEnd}
      >
        {/* One mark for every state, `working` included — it used to ride on the
            avatar's corner dot, and dropping the avatar without this would leave
            a running column indistinguishable from an idle one. */}
        <div className="sc-col-heading">
        <div className="sc-col-titles">
          {/* The title RENAMES, as it does in Claude Code (24.09.2026, by
              request). It used to open the session on its own, which made the
              one click everybody makes on a heading throw the split away. The
              way from a split to one session is closing the other panes — a
              split of one dissolves into the session view by itself. Renaming
              everything else (close, delete) stays on the row's right-click. */}
          {/* The project leads the title, quietly — «remotehegai / Design
              review» (27.09.2026, by request): with four panes open, which
              PROJECT each one is in was the first question and nothing
              answered it. */}
          {session.project && (
            <>
              <span className="sc-col-proj" title={session.cwd}>{session.project}</span>
              <span className="sc-col-sep" aria-hidden>/</span>
            </>
          )}
          <div className="sc-col-title-slot">
            <InlineTitle
              title={session.title || session.sessionId.slice(0, 8)}
              onRename={onRename}
              onEditingChange={setEditing}
            />
          </div>
        </div>
        <OtherAuthor session={session} viewerId={shell.viewer?.userId} />
        </div>
        {/* ONE line (27.09.2026, by request): the title, then the state as a
            quiet word on the right. «машина · проект» moved into the header's
            tooltip — it is the same for the whole life of the pane, and a
            second line of it under every title was the busiest part of a
            split. The state keeps its agent mark while working. */}
        {state && (
          <span className={`sc-col-state ${state}`}>
            {state === 'working' && <AgentMark source={session.source} provider={session.provider} size={12} />}
            {state === 'needs_attention' ? attentionTitle(run) : STATE_LABEL[state]}
          </span>
        )}
        {central.status !== 'open' ? <span className="sc-col-state">{STATUS_LABEL[central.status] ?? central.status}</span> : null}
        {onMenu && (
          <button
            type="button"
            className="icon-btn sc-col-more"
            onClick={(e) => {
              e.stopPropagation();
              const r = e.currentTarget.getBoundingClientRect();
              onMenu(r.left, r.bottom + 4);
            }}
            title="Действия с сессией"
            aria-label="Действия с сессией"
            aria-haspopup="menu"
          >
            <MoreIcon size={16} weight="bold" />
          </button>
        )}
        <button className="icon-btn sc-col-close" onClick={onClose} title="Закрыть колонку" aria-label="Закрыть колонку">
          <X size={16} />
        </button>
      </header>

      {/* No takeover flow in a pane: just resume. If the session is editor-held,
          the hub/agent yields with a clear message rather than a stuck composer. */}
      <Chat central={central} session={session} machineId={machineId} takingOver={false} />

      {/* Approval for THIS column's run (each pane can prompt independently). */}
      {req &&
        (req.tool === 'AskUserQuestion' || req.tool === 'EnterPlanMode' || req.tool === 'ExitPlanMode' ? (
          <QuestionModal req={req} onDecide={central.decideTool} />
        ) : (
          <div className="modal-backdrop">
            <div className="modal">
              <h3>
                <AlertTriangle size={18} /> Нужно разрешение
              </h3>
              <div className="tool-name">{req.title ?? req.tool}</div>
              <pre className="tool-input">{JSON.stringify(req.input, null, 2)}</pre>
              <div className="modal-actions">
                <button className="btn danger" onClick={() => central.decideTool(false)}>
                  <X size={15} /> Запретить
                </button>
                <button className="btn primary" onClick={() => central.decideTool(true)}>
                  <Check size={15} /> Разрешить
                </button>
              </div>
            </div>
          </div>
        ))}
    </section>
  );
}

/**
 * «автор: Аня» in a session's header when the session is somebody else's
 * (29.09.2026). With «Команда» and «Все» in the side panel a colleague's
 * session is one click away, and its header looked exactly like yours — the
 * composer under it would send as YOU into THEIR conversation. The hub still
 * decides whether you may write there (control + the single writer); this only
 * makes sure you know whose it is before you do.
 *
 * Only a RECORDED owner counts: an ownerless session on your own laptop is
 * yours, and on a shared box its author is unknown — naming the box's owner
 * there would be a guess presented as a fact.
 */
export function OtherAuthor({ session, viewerId }: { session: Pick<SessionSummary, 'owner'>; viewerId?: string }) {
  const o = session.owner;
  if (!o || !viewerId || o.userId === viewerId) return null;
  const name = displayName(o);
  return (
    <span className="sc-col-who" title={`Чужая сессия — её начал(а) ${name}`}>
      <span>автор:</span> <span className="sc-col-who-name">{shortName(name)}</span>
    </span>
  );
}
