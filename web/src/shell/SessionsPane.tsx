import { memo } from 'react';
import type { CentralState } from '../useCentral.js';
import type { RunIndex } from '../lib.js';
import { DragScrollRow } from '../components/DragScrollRow.js';
import { PinnedNav } from '../components/PinnedNav.js';
import { ProjectList } from '../components/ProjectList.js';
import { linkProps } from '../router.js';

/**
 * The session list: machine chips, the pinned region, the project tree.
 *
 * It exists as a component because it now has TWO placements — the context
 * column on a desktop, and the phone's drawer over an open session — and a
 * second hand-written list is how the two would start disagreeing about what a
 * project is, which sessions are hidden, or where a favourite goes. `/w/sessions`
 * on a phone already IS this pane; the drawer is the same pane, reachable
 * without leaving the conversation.
 *
 * What it deliberately does NOT own: the search button and the collapse handle.
 * Those belong to the frame around it, and the frame differs — the drawer has a
 * close affordance and no width to drag.
 */
export const SessionsPane = memo(function SessionsPane({
  activeRuns,
  machines,
  machineFilter,
  onMachineFilter,
  selected,
  runIndex,
  favorites,
  onSelect,
  onToggleFav,
  drilled,
  onDrillChange,
  onSessionMenu,
  viewerId,
  showMachines = true,
  onAddColumn,
  onNewChatIn,
  query = '',
}: {
  /** The side panel's search field: filters the project cards in place. */
  query?: string;
  /** Only what this subtree reads. It used to take the whole `central` object,
   *  which is a fresh literal on every render of App — so the list re-rendered
   *  on every streamed token, all of it, including every session row. */
  activeRuns: CentralState['activeRuns'];
  /** Already filtered for the sidebar's hidden machines — see HIDDEN_MACHINES. */
  machines: CentralState['machines'];
  machineFilter: string;
  onMachineFilter: (id: string) => void;
  /** Every session on screen, by `sessionKey` — see ProjectList. */
  selected: Set<string>;
  runIndex: RunIndex;
  favorites: Set<string>;
  onSelect: (machineId: string, sessionId: string) => void;
  onToggleFav: (key: string) => void;
  /** ProjectList is drilled into one project — the pinned region steps aside.
   *  State per PLACEMENT, not per app: two mounted lists drill independently. */
  drilled: boolean;
  onDrillChange: (v: boolean) => void;
  /** A row was right-clicked (or long-pressed), at these viewport coordinates.
   *  The rows only REPORT; the menu itself is one instance at the app root, so
   *  the two placements of this pane cannot open two of them. */
  onSessionMenu: (machineId: string, sessionId: string, x: number, y: number) => void;
  viewerId?: string;
  /** Draw the row of machine chips above the list. The phone's drawer turns it
   *  off: a horizontal scroller of box names, at the top of a 340px panel whose
   *  job is "get me to a session", is furniture — the project cards below name
   *  their machine anyway, and a filter you set by accident is a list with
   *  sessions missing from it and nothing on screen saying why. The desk column
   *  keeps it, where there is width for it and the chips are always visible. */
  showMachines?: boolean;
  /** «+» on each row that is not on screen — see useSessionMenu.addColumn.
   *  Absent (the phone drawer) = no button: a phone has no split. */
  onAddColumn?: ((machineId: string, sessionId: string) => void) | null;
  /** A project's pencil: a new chat aimed at it, beside what is on screen.
   *  Absent (the phone drawer) = the pencil is a plain link. Must be stable —
   *  this component is memoised. */
  onNewChatIn?: (aim: { machineId: string; cwd: string }) => void;
}) {
  const total = machines.reduce((n, m) => n + m.sessions.length, 0);
  // No chips, no filter: a filter you cannot see or undo is sessions missing
  // from the list with nothing saying why.
  const filter = showMachines ? machineFilter : 'all';
  return (
    <>
      {showMachines && machines.length > 1 && (
        <DragScrollRow className="folders" label="Машины">
          <button
            className={`folder ${machineFilter === 'all' ? 'active' : ''}`}
            onClick={() => onMachineFilter('all')}
          >
            Все<span className="fcnt">{total}</span>
          </button>
          {machines.map((m) => (
            <button
              key={m.machine.machineId}
              className={`folder ${machineFilter === m.machine.machineId ? 'active' : ''}`}
              onClick={() =>
                onMachineFilter(machineFilter === m.machine.machineId ? 'all' : m.machine.machineId)
              }
            >
              {m.machine.name}
              {m.sessions.length > 0 && <span className="fcnt">{m.sessions.length}</span>}
            </button>
          ))}
        </DragScrollRow>
      )}
      <div className="sidebar-scroll">
        {!drilled && !query.trim() && (
          <PinnedNav
            machines={machines}
            favorites={favorites}
            onSelect={onSelect}
            onToggleFav={onToggleFav}
            onSessionMenu={onSessionMenu}
          />
        )}
        {/* A dead end until now: the one line a person sees when nothing works
            yet said only that nothing works yet. The door goes where the code
            is minted. */}
        {machines.length === 0 && (
          <div className="empty">
            Нет подключённых машин.{' '}
            <a {...linkProps({ kind: 'start' })}>Как подключить</a>
          </div>
        )}
        <ProjectList
          machines={
            filter === 'all'
              ? machines
              : machines.filter((m) => m.machine.machineId === filter)
          }
          selected={selected}
          runIndex={runIndex}
          activeRuns={activeRuns}
          favorites={favorites}
          onSelect={onSelect}
          onToggleFav={onToggleFav}
          onDrillChange={onDrillChange}
          onSessionMenu={onSessionMenu}
          viewerId={viewerId}
          onAddColumn={onAddColumn}
          onNewChatIn={onNewChatIn}
          query={query}
        />
      </div>
    </>
  );
});
