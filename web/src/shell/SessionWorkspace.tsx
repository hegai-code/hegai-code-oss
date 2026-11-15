import { useEffect, useState } from 'react';
import type { SessionSummary } from '@cc-remote/shared';
import { GitBranch, InfoIcon, Menu } from '../icons.js';
import { SideSheet } from '../components/SideSheet.js';
import { ChangesPanel } from '../components/review/ChangesPanel.js';
import { InlineTitle } from '../components/SessionColumn.js';
import { AgentMark } from '../components/AgentMark.js';
import { isGoModel } from '../components/run-settings.js';
import type { CentralState } from '../useCentral.js';
import { machineNameOf, runAttachedTo, sessionIsWorking, sessionKey, type RunIndex } from '../lib.js';
import { OtherAuthor } from '../components/SessionColumn.js';

import { SessionInfo } from '../components/SessionInfo.js';
import { Chat } from '../panels/Chat.js';
import { Mirror } from '../panels/Mirror.js';
import { ScopeChip } from './ScopeSwitch.js';

/**
 * One open session: title bar, recap, and either the live Chat or the read-only
 * Mirror, plus the "chat info" column beside it.
 *
 * A session that is live in an editor renders the Mirror (read-only, with a
 * composer that force-takes-over on send) UNLESS we are mid-takeover or already
 * own its run — `ownsSelected` carries that, because a stale livePid can outlive
 * a successful takeover by one inventory refresh.
 */
export function SessionWorkspace({
  central: c,
  session,
  selected,
  runIndex,
  infoOpen,
  onToggleInfo,
  canEdit,
  canDrive,
  ownsSelected,
  carriedDraft,
  onRename,
  onRenameTo,
  onDelete,
  onToggleClosed,
  onOpenDrawer,
}: {
  central: CentralState;
  session: SessionSummary;
  selected: { machineId: string; sessionId: string };
  runIndex: RunIndex;
  infoOpen: boolean;
  onToggleInfo: () => void;
  canEdit: boolean;
  canDrive: boolean;
  ownsSelected: boolean;
  carriedDraft?: string;
  onRename: () => void;
  /** Rename in place from the title (the same control as a pane's head);
   *  absent when the viewer cannot edit this session. */
  onRenameTo?: (title: string) => Promise<void>;
  onDelete: () => void;
  /** Mark the session done, or put it back to work (see `closeSession`). */
  onToggleClosed: () => void;
  /** The phone's session drawer. The ☰ that calls this is hidden above 860px:
   *  wider than that, the session list is already a column on the left. */
  onOpenDrawer: () => void;
}) {
  // Жест шторки живёт НЕ здесь. С 22.09 тяга интерактивная, а вести карточку и
  // шторку на одно и то же число пикселей может только тот, кто знает оба, —
  // поэтому единственный слушатель висит на `.app` (`useDrawerDrag` в App.tsx),
  // как `AppShell` на телефоне. Побочно это чинит и охват: раньше свайпом
  // открыть шторку можно было только над ОТКРЫТОЙ сессией, хотя на телефоне
  // шторка — единственная навигация и на всех остальных экранах тоже.
  const machineName = machineNameOf(c.machines, selected.machineId);
  const run = runIndex.get(sessionKey(selected.machineId, selected.sessionId));
  const working = sessionIsWorking(session, run);

  // «Изменения»: the diff review sheet. A review goes back as ONE user turn by
  // the route the composer takes — a live run takes an `input` frame; a session
  // that is only resting resumes on it; one live in an editor is taken over.
  const [changesOpen, setChangesOpen] = useState(false);
  // Another session selected: the sheet belongs to the old one — close it.
  useEffect(() => setChangesOpen(false), [selected.machineId, selected.sessionId]);
  const attached = runAttachedTo(c.active, selected.machineId, session.sessionId);
  const machine = c.machines.find((m) => m.machine.machineId === selected.machineId);
  // Local git needs what the hub calls can_control; push/PR only the device owner.
  const canGit = machine?.canControl !== false;
  const isDeviceOwner = !!machine?.owner?.userId && machine.owner.userId === c.viewer?.userId;
  const sendReview = (text: string): boolean => {
    if (attached) return c.sendInput(text);
    if (session.livePid && !ownsSelected) return c.takeover(selected.machineId, selected.sessionId, text);
    return c.open(selected.machineId, selected.sessionId, text);
  };

  return (
    <div className={`workspace ${infoOpen ? 'info-open' : ''}`}>
      <div className="ws-main">
        <div className="ws-head">
          <div className="ws-titlebar">
            {/* The phone's ☰. It leads the row because this row is the only
                chrome a session gets on a phone now: the top bar above it —
                back, the limits pill, theme, notifications, settings — is
                hidden here, which is five controls for a screen whose whole
                job is one conversation. What that bar was actually FOR, on a
                phone, was getting to another session; that is what this opens,
                and it opens it without leaving this one. */}
            <button
              className="icon-btn ws-menu"
              onClick={onOpenDrawer}
              title="Сессии"
              aria-label="Сессии"
            >
              <Menu size={18} />
            </button>
            {/* The lettered mark is gone. In a list it tells one row from
                another; on the one session already filling the screen it
                identifies nothing you did not just tap. The live state it
                carried is said in words by the Mirror banner and by
                «работает…» under the composer. */}
            {/* The title RENAMES, as a pane's does (27.09.2026, by request;
                Astra's review): the same-looking heading used to open «О
                сессии» here and rename in a split — one control with two
                meanings a keystroke apart. «О сессии» is its own button on the
                right now. */}
            {working && <AgentMark
                source={session.source}
                provider={session.provider ?? (attached && isGoModel(c.runSettings?.model ?? c.runSettings?.activeModel) ? 'opencode' : undefined)} size={14} className="srun" />}
            <div className="sc-col-heading">
            <div className="sc-col-titles">
            {session.project && (
              <>
                <span className="sc-col-proj" title={session.cwd}>{session.project}</span>
                <span className="sc-col-sep" aria-hidden>/</span>
              </>
            )}
            <div className="ws-title-slot">
              <InlineTitle title={session.title} onRename={onRenameTo} onEditingChange={() => {}} />
            </div>
            </div>
            <OtherAuthor session={session} viewerId={c.viewer?.userId} />
            </div>
            <span className="ws-scope"><ScopeChip /></span>
            {session.cwd && canGit && (
              <button
                className={`icon-btn ws-info-btn${changesOpen ? ' active' : ''}`}
                onClick={() => setChangesOpen(true)}
                title="Изменения"
                aria-label="Изменения"
              >
                <GitBranch size={17} />
              </button>
            )}
            <button
              className={`icon-btn ws-info-btn${infoOpen ? ' active' : ''}`}
              onClick={onToggleInfo}
              aria-expanded={infoOpen}
              title="О сессии"
              aria-label="О сессии"
            >
              <InfoIcon size={17} />
            </button>
            {/* Rename and Delete were two labelled buttons sharing the row with
                the title. They are rare, deliberate actions, and at any width
                narrow enough to matter they pushed the title — the one thing
                that says which session you are in — out of sight entirely. Put
                them behind the overflow mark, where destructive-and-rare
                belongs, and the title gets the row back. */}
            {/* The «···» menu is gone. Every item in it — Закрыть сессию,
                Переименовать, Удалить — already exists in the info panel's
                `si-actions`, so it was a second door to the same three things,
                parked in the narrowest row on the screen. One door, and it is
                the title. */}
            {/* The `+` that opened the split is gone with the picker it opened.
                A second session is chosen where the sessions are — right-click
                a row in the side panel, «Добавить в колонку» — rather than in a
                popover that had to re-list the whole fleet to offer what the
                column beside it was already showing. */}
          </div>
          {/* The recap strip (machine · project · branch · when · live) is gone
              from the header. Every one of those fields is already in the info
              panel one tap away — Machine, Project, Agent, Branch, Folder,
              Created — and as a permanent second row it cost the transcript
              height on every screen to tell you what you knew when you opened
              the session. */}
        </div>

        <div className="panel">
          {session.livePid && !ownsSelected ? (
            <Mirror
              central={c}
              session={session}
              machineId={selected.machineId}
              readOnly={!canDrive}
              onSend={(message, images, files) =>
                c.takeover(selected.machineId, selected.sessionId, message, images, files)
              }
            />
          ) : (
            <Chat
              key={selected.sessionId}
              central={c}
              session={session}
              machineId={selected.machineId}
              takingOver={!!session.livePid && !c.active?.runId}
              readOnly={!canDrive}
              carriedDraft={carriedDraft}
            />
          )}
        </div>
      </div>

      {changesOpen && session.cwd && canGit && (
        <SideSheet
          title="Изменения"
          wide
          bodyClassName="rv-body"
          // Esc inside a note box cancels the note, not the whole sheet.
          closeOnEscape={() => !(document.activeElement instanceof HTMLTextAreaElement || document.activeElement instanceof HTMLInputElement)}
          onClose={() => setChangesOpen(false)}
        >
          <ChangesPanel
            // One review per session: switching sessions must never carry notes,
            // a commit message or an in-flight result into another cwd.
            key={`${selected.machineId}:${selected.sessionId}`}
            central={c}
            machineId={selected.machineId}
            sessionId={selected.sessionId}
            cwd={session.cwd}
            settledKey={`${working}:${session.lastModified}`}
            onSendReview={(text) => {
              // The sheet stays open: the notes are kept until the run takes them.
              return sendReview(text);
            }}
            canDrive={canDrive}
            canPublish={isDeviceOwner}
          />
        </SideSheet>
      )}

      {/* Two placements, one state. Below 1200px the inline column is hidden,
          which used to make the ⓘ button a dead control on every laptop — it
          flipped a flag and localStorage and changed nothing on screen. The
          sheet is what it toggles there. */}
      {infoOpen && (
        <>
          <SessionInfo
            session={session}
            machineName={machineName}
            machineId={selected.machineId}
            central={c}
            canControl={canEdit}
            onRename={onRename}
            onDelete={onDelete}
            onToggleClosed={onToggleClosed}
          />
          <div className="si-scrim" onClick={onToggleInfo} />
          {/* `compact`: in a sheet this panel is CONTROLS, not a description —
              see the prop's note in SessionInfo. The two renderings are the
              same component on purpose; the narrow one is not a second design,
              it is the same one with the reading matter dropped. */}
          <div className="si-sheet" role="dialog" aria-label="О сессии">
            <div className="sheet-grip" />
            <SessionInfo
              compact
              session={session}
              machineName={machineName}
              machineId={selected.machineId}
              central={c}
              canControl={canEdit}
              onRename={onRename}
              onDelete={onDelete}
              onToggleClosed={onToggleClosed}
            />
          </div>
        </>
      )}
    </div>
  );
}
