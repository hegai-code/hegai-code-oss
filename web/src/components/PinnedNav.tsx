import { memo, useState, type ReactNode } from 'react';
import { Star } from '../icons.js';
import type { SessionSummary } from '@cc-remote/shared';
import type { CentralState } from '../useCentral.js';
import { sessionKey } from '../lib.js';
import { longPressProps } from './ContextMenu.js';

/**
 * Pinned top-of-sidebar region: starred sessions, persisted in localStorage.
 *
 * It used to carry a «Сейчас в работе» section above this one, and that
 * section was a lie of omission: it listed `central.activeRuns`, i.e. only
 * runs THIS hub started, while almost all real work here starts in VS Code or
 * a terminal and reaches us as a session-level `livePid` with no run at all.
 * A column that answers "what is running" by showing two of twelve is worse
 * than one that does not answer it, so live work now lives where it belongs —
 * in its own project's card, in `ProjectList`.
 */
export const PinnedNav = memo(function PinnedNav({
  machines,
  favorites,
  onSelect,
  onToggleFav,
  onSessionMenu,
}: {
  /** Same reason as SessionsPane: the whole `central` object changes identity
   *  on every render, so taking it here would re-render the pinned region on
   *  every streamed token too. */
  machines: CentralState['machines'];
  favorites: Set<string>;
  onSelect: (machineId: string, sessionId: string) => void;
  onToggleFav: (key: string) => void;
  onSessionMenu: (machineId: string, sessionId: string, x: number, y: number) => void;
}) {
  const favs: { machineId: string; machineName: string; session: SessionSummary }[] = [];
  for (const m of machines) {
    for (const s of m.sessions) {
      if (favorites.has(sessionKey(m.machine.machineId, s.sessionId))) {
        favs.push({ machineId: m.machine.machineId, machineName: m.machine.name, session: s });
      }
    }
  }
  if (favs.length === 0) return null;

  return (
    <div className="pinned">
      <PinnedSection title="Избранное" icon={<Star size={13} />} count={favs.length}>
        {favs.map(({ machineId, machineName, session: s }) => (
          <button
            className="pin-row"
            key={sessionKey(machineId, s.sessionId)}
            onClick={() => onSelect(machineId, s.sessionId)}
            onContextMenu={(e) => {
              e.preventDefault();
              onSessionMenu(machineId, s.sessionId, e.clientX, e.clientY);
            }}
            {...longPressProps((x, y) => onSessionMenu(machineId, s.sessionId, x, y))}
          >
            <Star size={13} className="pin-star" fill="currentColor" />
            <span className="pin-title">{s.title}</span>
            <span className="pin-sub">{machineName}</span>
          </button>
        ))}
      </PinnedSection>
    </div>
  );
});

/** A collapsible sidebar section: mono-caps title, icon, count on the right.
 *  Exported because the project column's «Команда» group is the same object —
 *  a second implementation would drift in a week. */
export function PinnedSection({
  title,
  icon,
  count,
  defaultOpen = true,
  children,
}: {
  title: string;
  icon: ReactNode;
  count: number;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="pin-section">
      <div className="pin-head" onClick={() => setOpen((v) => !v)}>
        <span className="tw">{open ? '▾' : '▸'}</span>
        {icon}
        <span className="pin-name">{title}</span>
        <span className="pin-count">{count}</span>
      </div>
      {open && children}
    </div>
  );
}
