import { useMemo } from 'react';
import type { MachineSnapshot, SessionSummary } from '@cc-remote/shared';
import { ArrowLeft, FolderTree, Plus } from '../../icons.js';
import { linkProps } from '../../router.js';
import { attentionLabel, avatarIdx, cleanTitle, initialOf, relTimeRu, scopeKeeps, sessionIsMine, sessionIsWorking, sessionKey, type RunIndex } from '../../lib.js';
import { useSessionScope } from '../MineOnly.js';

/**
 * ONE project — the pair (machine, cwd) — and every session in it.
 *
 * This exists because `/w/p/:label`, the app's other project page, cannot answer
 * the question the Проекты screen makes people ask. It is keyed on the LABEL, so
 * opening `crm` from stage shows devbox's `crm` sessions too; and it bounces
 * straight back to the session list when a project has none — which is exactly
 * the case this whole feature exists to surface. Fifteen of stage's twenty
 * repositories have zero sessions, and every one of them was a dead link.
 *
 * So: scoped to the machine, works at zero sessions, and puts the two things you
 * actually came to do — start work here, open the files — in front of you
 * instead of behind a 24px icon that only appears on hover.
 */
export function ProjectDetail({
  machine,
  cwd,
  label,
  sessions,
  agentCount,
  viewerId,
  runIndex,
  canStart,
  showAutomated,
  onShowAutomated,
  onOpen,
  backTo,
}: {
  machine: MachineSnapshot;
  cwd: string;
  label: string;
  sessions: SessionSummary[];
  /**
   * How many transcripts the AGENT counts in this directory — a different
   * number from `sessions.length`, and both are true.
   *
   * The agent counts everything on disk; the snapshot this list is built from
   * has scripted runs filtered out (`useCentral.ts`) and is capped by the hub.
   * On stage `/srv/crm` that is 115 against 0, because its sessions are a cron
   * loop. Showing one number and listing the other is how a row promising «115
   * сесс» opened onto «сессий пока нет».
   */
  agentCount: number;
  /** Who is looking — the other half of the scope (see `sessionIsMine`;
   *  the machine snapshot above is the first half). */
  viewerId?: string;
  runIndex: RunIndex;
  canStart: boolean;
  showAutomated: boolean;
  onShowAutomated: (v: boolean) => void;
  onOpen: (machineId: string, sessionId: string) => void;
  backTo: { machineId?: string };
}) {
  const machineId = machine.machine.machineId;
  const [scope] = useSessionScope();
  const rows = useMemo(() => {
    const list = sessions.filter((s) => scopeKeeps(scope, sessionIsMine(s, machine, viewerId)));
    return [...list].sort((a, b) => b.lastModified - a.lastModified);
  }, [sessions, scope, machine, viewerId]);
  /** Sessions of this project that belong to somebody else. Named rather than
   *  dropped for the same reason as `hidden` below: a list that quietly shrinks
   *  is the one people stop believing. */
  const hiddenMine = sessions.length - rows.length;
  /** What the agent counts but the snapshot cannot show — scripted runs and the
   *  hub's cap — measured against the UNFILTERED list, so the sentence about
   *  scripts keeps meaning scripts whatever the scope. Never negative: the
   *  two numbers come from different snapshots and can cross briefly. */
  const hidden = Math.max(0, agentCount - sessions.length);

  return (
    <div className="board pj-detail">
      <div className="board-head">
        <a
          className="pjd-back"
          title="Ко всем проектам"
          {...linkProps({ kind: 'projects', ...backTo })}
        >
          <ArrowLeft size={16} />
        </a>
        <h2>{label}</h2>
        <span className="sub">
          {machine.machine.name} · {agentCount > 0 ? `${agentCount} сесс по данным агента` : 'сессий пока нет'}
        </span>
      </div>

      <div className="pjd-path">{cwd}</div>

      <div className="pjd-acts">
        {canStart && (
          <a className="pjd-primary" {...linkProps({ kind: 'new', machineId, cwd })}>
            <Plus size={16} /> Новая сессия здесь
          </a>
        )}
        <a className="pjd-second" {...linkProps({ kind: 'files', machineId, root: cwd })}>
          <FolderTree size={16} /> Файлы
        </a>
      </div>

      {(hidden > 0 || hiddenMine > 0) && (
        <div className="pjd-note">
          {hidden > 0 &&
            (showAutomated
              ? `Показано ${rows.length} из ${agentCount}: хаб отдаёт ограниченный срез инвентаря машины.`
              : `Показано ${rows.length} из ${agentCount} — остальные запускались скриптом или ушли в воркtree агента.`)}
          {hiddenMine > 0 &&
            (scope === 'team'
              ? ` Режим «Команда» прячет здесь ещё ${hiddenMine} ваших.`
              : ` Режим «Мои» прячет здесь ещё ${hiddenMine} чужих.`)}
          {hidden > 0 && !showAutomated && (
            <button className="pjd-link" onClick={() => onShowAutomated(true)}>
              показать автоматические
            </button>
          )}
        </div>
      )}

      {rows.length === 0 ? (
        <div className="pj-empty">
          {/* Not an error, and not a dead end — the previous page treated it as
              both. A repository with no sessions is the normal state of a
              checkout nobody has driven from here yet. */}
          {hiddenMine > 0
            ? scope === 'team'
              ? `Здесь только ваши сессии (${hiddenMine}) — режим «Команда» их прячет.`
              : `Здесь работает кто-то другой: режим «Мои» прячет ${hiddenMine}. Твоих сессий в этом проекте пока нет.`
            : agentCount > 0
              ? 'Все сессии этого проекта скрыты фильтрами — ни одна не была запущена человеком отсюда.'
              : 'В этом проекте ещё не было ни одной сессии. Начните первую — кнопка выше.'}
        </div>
      ) : (
        <div className="pjd-list">
          {rows.map((s) => {
            const run = runIndex.get(sessionKey(machineId, s.sessionId));
            const live = sessionIsWorking(s, run);
            const attn = run?.state === 'needs_attention' || run?.state === 'error';
            const title = cleanTitle(s.title);
            return (
              <button
                key={s.sessionId}
                className="pjd-row"
                onClick={() => onOpen(machineId, s.sessionId)}
              >
                <span className={`av av${avatarIdx(title || s.sessionId)}`}>{initialOf(title)}</span>
                <span className="pjd-title">{title || 'Без названия'}</span>
                {live && <span className="pjd-state live">в работе</span>}
                {attn && <span className="pjd-state attn">{run?.state === 'error' ? 'ошибка' : attentionLabel(run)}</span>}
                <span className="pjd-when">{relTimeRu(s.lastModified)}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
