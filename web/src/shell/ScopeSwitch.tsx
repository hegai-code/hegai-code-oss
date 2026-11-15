import { useRef } from 'react';
import { X } from '../icons.js';
import type { SessionScope } from '../lib.js';
import { useScopeAvailable, useSessionScope } from '../components/MineOnly.js';

const OPTIONS: [SessionScope, string, string][] = [
  ['mine', 'Мои', 'Только мои сессии'],
  ['team', 'Команда', 'Сессии команды — без моих, по людям'],
  ['all', 'Все', 'Мои и командные вместе, с подписью автора'],
];

export const SCOPE_LABEL: Record<SessionScope, string> = { mine: 'Мои', team: 'Команда', all: 'Все' };

/**
 * «Мои · Команда · Все» — whose sessions the lists show (29.09.2026).
 *
 * A segmented control in the top bar, beside the limits. Quiet on «Мои», LIT
 * on the other two: the old «Только мои» chip failed because it could be left
 * off and forgotten (see `MineOnly.tsx`), so being off «Мои» has to be visible
 * from every screen. The value is not remembered — a reload starts at «Мои».
 *
 * Renders nothing for a viewer without the switch (`canSwitchScope`), and on
 * «Мои» when nobody else's work is in the snapshot: two positions that would
 * show the same list as the first are noise. Off «Мои» it always renders, so
 * the way back never disappears.
 */
export function ScopeSwitch({ othersWork }: { othersWork: boolean }) {
  const available = useScopeAvailable();
  const [scope, setScope] = useSessionScope();
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  if (!available || (!othersWork && scope === 'mine')) return null;
  return (
    <div className={`scope-seg${scope !== 'mine' ? ' lit' : ''}`} role="radiogroup" aria-label="Чьи сессии показывать">
      {OPTIONS.map(([v, label, hint], index) => (
        <button
          key={v}
          ref={(el) => { buttons.current[index] = el; }}
          type="button"
          role="radio"
          aria-checked={scope === v}
          tabIndex={scope === v ? 0 : -1}
          className={scope === v ? 'on' : ''}
          title={hint}
          onClick={() => setScope(v)}
          onKeyDown={(e) => {
            let next: number;
            switch (e.key) {
              case 'ArrowRight': case 'ArrowDown': next = (index + 1) % OPTIONS.length; break;
              case 'ArrowLeft': case 'ArrowUp': next = (index + OPTIONS.length - 1) % OPTIONS.length; break;
              case 'Home': next = 0; break;
              case 'End': next = OPTIONS.length - 1; break;
              default: return;
            }
            e.preventDefault();
            setScope(OPTIONS[next][0]);
            buttons.current[next]?.focus();
          }}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/**
 * The phone's reminder: the top bar has no room for three segments beside the
 * limits pill, so the switch itself lives at the head of the session drawer,
 * and the bar keeps only this — «Команда ✕» while the lists are off «Мои».
 * One tap returns to «Мои».
 */
export function ScopeChip() {
  const [scope, setScope] = useSessionScope();
  if (scope === 'mine') return null;
  return (
    <button
      type="button"
      className="scope-chip"
      onClick={() => setScope('mine')}
      title="Показаны не только мои сессии. Нажмите, чтобы вернуться к своим."
      aria-label={`Режим «${SCOPE_LABEL[scope]}». Вернуться к своим`}
    >
      {SCOPE_LABEL[scope]}
      <X size={12} />
    </button>
  );
}
