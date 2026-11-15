import { useEffect, useMemo, useState } from 'react';
import type { ActiveRunInfo, MachineSnapshot, SessionSummary } from '@cc-remote/shared';
import { FolderTree, NotePencil } from '../../icons.js';
import { linkProps, navigate, SESSIONS, useRoute } from '../../router.js';
import { AgentMark } from '../AgentMark.js';
import {
  attentionLabel,
  compareByAttention,
  sessionCreated,
  sessionUrgency,
  avatarIdx,
  cleanTitle,
  initialOf,
  relTimeRu,
  scopeKeeps,
  sessionIsMine,
  sessionIsWorking,
  sessionKey,
  sessionOwner,
  type RunIndex,
 panelProjectKey } from '../../lib.js';
import { useSessionScope } from '../MineOnly.js';

type Row = { machineId: string; machineName: string; session: SessionSummary };

const PAGE = 40;

/**
 * `/w/p/:project` — every session of one project, in the main column.
 *
 * Pressing a project in the side panel used to land on the COMPOSER aimed at
 * it, while the panel itself drilled into the list. So the one press that
 * says «show me this project» answered with an empty box asking what to do
 * next, and the sessions were squeezed into the 300px beside it. The phone app
 * does the obvious thing — a project opens onto its sessions, with «Новый чат»
 * one press away on top — and this is that.
 *
 * Keyed by the LABEL, as the panel's cards are: a card merges a name across
 * machines (`crm` on two boxes is one card), so the page it opens has to show
 * what the card counted, with the machine on each row when there is more than
 * one. The per-machine, per-folder page is `ProjectDetail` (/w/projects/:m).
 */
export function ProjectSessions({
  project,
  machines,
  activeRuns,
  runIndex,
  onOpen,
  onSessionMenu,
  viewerId,
}: {
  project: string;
  /** Already filtered the way the side panel filters them (hidden machines). */
  machines: MachineSnapshot[];
  /** Runs the inventory has not caught up with yet — the panel's card counts
   *  them (ProjectList), so the page it opens must list them too. */
  activeRuns: ActiveRunInfo[];
  runIndex: RunIndex;
  onOpen: (machineId: string, sessionId: string) => void;
  onSessionMenu: (machineId: string, sessionId: string, x: number, y: number) => void;
  viewerId?: string;
}) {
  const [scope] = useSessionScope();
  const [limit, setLimit] = useState(PAGE);
  useEffect(() => setLimit(PAGE), [project, scope]);

  const allRows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    for (const m of machines) {
      for (const s of m.sessions) {
        // The panel's own key (`panelProjectKey`): «—» also takes `/`, `/root`
        // and home dirs, so a card and its page cannot disagree on membership.
        if (panelProjectKey(s) !== project || !s.sessionId) continue;
        out.push({
          machineId: m.machine.machineId, machineName: m.machine.name,
          session: { ...s, owner: sessionOwner(s, runIndex.get(sessionKey(m.machine.machineId, s.sessionId))) },
        });
      }
    }
    // A session started a moment ago is a run before it is an inventory entry
    // (the agent debounces its inventory by seconds). Without these the page
    // opened from a card listing that run found nothing and bounced away.
    const seen = new Set(out.map((r) => sessionKey(r.machineId, r.session.sessionId)));
    const visible = new Map(machines.map((m) => [m.machine.machineId, m]));
    for (const r of activeRuns) {
      const m = visible.get(r.machineId);
      if (!m || !r.sessionId || (r.project ?? '—') !== project || seen.has(sessionKey(r.machineId, r.sessionId))) continue;
      out.push({
        machineId: r.machineId,
        machineName: r.machineName ?? m.machine.name,
        session: {
          sessionId: r.sessionId, title: r.title ?? '', project: r.project, lastModified: r.since, category: r.category,
          owner: sessionOwner({}, r),
        },
      });
    }
    // The panel's order (11.11.2026): waits-for-you, then working, then newest
    // CREATED — so the rows the card previewed are the rows this page starts
    // with, and a fresh message does not reshuffle the page.
    const key = (r: Row) => ({
      urgency: sessionUrgency(runIndex.get(sessionKey(r.machineId, r.session.sessionId))),
      created: sessionCreated(r.session),
      id: r.session.sessionId,
    });
    return out.sort((a, b) => compareByAttention(key(a), key(b)));
  }, [machines, activeRuns, project, runIndex]);

  const rows = useMemo(() => {
    const byId = new Map(machines.map((m) => [m.machine.machineId, m]));
    return allRows.filter((r) => scopeKeeps(scope, sessionIsMine(r.session, byId.get(r.machineId), viewerId)));
  }, [allRows, machines, scope, viewerId]);

  // A project that is gone once the inventory is here: back to the landing
  // rather than an empty page with a name on it. Guarded on `machines.length`
  // so a deep link survives the first paint, before the snapshot lands.
  //
  // Only when this page IS the screen. Inside a split, `navigate` goes into
  // the focused pane — which may be somebody else's session — so a pane of
  // a vanished project says so in place instead.
  const route = useRoute();
  const whole = route.kind === 'project' && route.project === project;
  const loaded = machines.length > 0;
  useEffect(() => {
    if (whole && loaded && allRows.length === 0) navigate(SESSIONS, { replace: true });
  }, [whole, loaded, allRows.length]);

  const label = project === '—' ? 'Без проекта' : project;
  const machinesIn = [...new Set(rows.map((r) => r.machineName))];
  // Where «Новый чат» starts: the freshest session's folder on its machine —
  // a label alone cannot say WHICH `crm`, the pair can.
  const aim = [...rows].sort((a, b) => b.session.lastModified - a.session.lastModified).find((r) => r.session.cwd);

  return (
    <div className="board pj-detail proj-sessions">
      <div className="board-head">
        <h2>{label}</h2>
        <span className="sub">
          {machinesIn.join(', ')}
          {rows.length > 0 ? ` · ${rows.length} ${sessionWord(rows.length)}` : ''}
        </span>
      </div>

      {aim && project !== '—' && (
        <div className="pjd-acts">
          <a className="pjd-primary" {...linkProps({ kind: 'new', machineId: aim.machineId, cwd: aim.session.cwd as string })}>
            <NotePencil size={16} /> Новый чат здесь
          </a>
          <a className="pjd-second" {...linkProps({ kind: 'files', machineId: aim.machineId, root: aim.session.cwd as string })}>
            <FolderTree size={16} /> Файлы
          </a>
        </div>
      )}

      {rows.length === 0 ? (
        <div className="pj-empty">{!loaded ? 'Загружаем сессии…' : allRows.length === 0
          ? 'В этом проекте больше нет сессий.'
          : scope === 'team' ? 'В этом проекте нет чужих сессий.' : 'В этом проекте нет ваших сессий.'}</div>
      ) : (
        <div className="pjd-list">
          {rows.slice(0, limit).map(({ machineId, machineName, session: s }) => {
            const run = runIndex.get(sessionKey(machineId, s.sessionId));
            const working = sessionIsWorking(s, run);
            const attn = run?.state === 'needs_attention' || run?.state === 'error';
            const title = cleanTitle(s.title);
            return (
              <button
                key={sessionKey(machineId, s.sessionId)}
                className="pjd-row"
                onClick={() => onOpen(machineId, s.sessionId)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  onSessionMenu(machineId, s.sessionId, e.clientX, e.clientY);
                }}
              >
                <span className={`av av${avatarIdx(title || s.sessionId)}`}>{initialOf(title)}</span>
                <span className="pjd-title">{title || 'Без названия'}</span>
                {working && <AgentMark source={s.source} provider={s.provider} size={13} />}
                {attn && <span className="pjd-state attn">{run?.state === 'error' ? 'ошибка' : attentionLabel(run)}</span>}
                {s.archived && (
                  <span className="pjd-state archived" title="Файл переписки удалён с машины: можно читать, продолжить нельзя">
                    архив
                  </span>
                )}
                {machinesIn.length > 1 && <span className="pjd-mach">{machineName}</span>}
                <span className="pjd-when">{relTimeRu(s.lastModified)}</span>
              </button>
            );
          })}
          {rows.length > limit && (
            <button className="show-more" onClick={() => setLimit((l) => l + PAGE)}>
              Показать ещё · {rows.length - limit}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function sessionWord(n: number): string {
  const t = n % 100;
  if (t >= 11 && t <= 14) return 'сессий';
  switch (n % 10) {
    case 1: return 'сессия';
    case 2:
    case 3:
    case 4: return 'сессии';
    default: return 'сессий';
  }
}
