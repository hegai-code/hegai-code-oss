import { useCallback, useMemo, useState } from 'react';
import type { ProjectForgetResult } from '@cc-remote/shared';
import { FolderPlus, FolderTree, Plus, Trash2 } from '../../icons.js';
import { linkProps, navigate, type Route } from '../../router.js';
import { isRootish, isScratchCwd, relTimeRu, scopeKeeps, sessionIsMine, sessionIsWorking, sessionKey, type RunIndex } from '../../lib.js';
import { useSessionScope } from '../MineOnly.js';
import type { OwnedProject } from '../../appHooks.js';
import type { CentralState } from '../../useCentral.js';
import { AdoptPanel } from './AdoptPanel.js';
import { ProjectDetail } from './ProjectDetail.js';
import { askConfirm } from '../../dialogs.js';

/**
 * «Проекты» — the fleet's work, with the MACHINE as the axis.
 *
 * Every other project surface in this app is derived from sessions and keys on
 * the label alone (`ProjectList.tsx`), which has two consequences it cannot
 * escape: `crm` on two boxes collapses into one card with the machine demoted to
 * a `+1` badge, and a repository nobody has started a session in does not exist
 * at all. On a box whose nineteen repositories live in `/srv` that second rule
 * hid almost everything — the platform insisted the machine had two projects,
 * both inferred from cron loops.
 *
 * So this screen asks the AGENT (`projects.list`) instead of reading the
 * snapshot, groups by machine and then by the root the directory sits under, and
 * counts sessions rather than being built out of them. A project with zero
 * sessions is a first-class row here; that is the whole point.
 *
 * Full-width, no context column — the reason is stated in `navModel.ts`: every
 * screen that renders one vanishes below 860px.
 */

/** A machine that can answer `projects.list` and be started on. */
interface MachineRow {
  machineId: string;
  name: string;
  online: boolean;
  canControl: boolean;
}

interface Row extends OwnedProject {
  live: number;
  attention: number;
}

/** Longest declared root that contains this cwd, so `/srv/crm` files under
 *  `/srv` rather than under a home directory that happens to share a prefix. */
function rootOf(cwd: string, roots: string[]): string {
  let best = '';
  for (const r of roots) {
    const norm = r.replace(/[\\/]+$/, '');
    if ((cwd === norm || cwd.startsWith(norm + '/') || cwd.startsWith(norm + '\\')) && norm.length > best.length) {
      best = norm;
    }
  }
  return best;
}

/** Where a project sits when no declared root claims it — its parent directory.
 *  A session-derived cwd can be anywhere, and bucketing those under «прочее»
 *  would hide the one fact that makes the row legible. */
function bucketOf(cwd: string, roots: string[]): string {
  const root = rootOf(cwd, roots);
  if (root) return root;
  const cut = Math.max(cwd.lastIndexOf('/'), cwd.lastIndexOf('\\'));
  return cut > 0 ? cwd.slice(0, cut) : cwd;
}

/**
 * One spelling per directory.
 *
 * A Windows agent reports whatever case the session recorded — `d:\Hegai_VScode`
 * from one and `D:\Hegai_VScode` from another — and `path.resolve` on the Linux
 * hub cannot know those name one directory. Left alone, buildbox-pc showed
 * `claudehegai`, `PGS` and `crypto` twice each, under two buckets differing only
 * in a drive letter's case. Only the DRIVE is folded: the rest of a Windows path
 * is case-insensitive too, but folding it would merge directories that a
 * cross-platform checkout can legitimately keep apart.
 */
function canonPath(cwd: string): string {
  return /^[a-z]:/.test(cwd) ? cwd[0]!.toUpperCase() + cwd.slice(1) : cwd;
}

function originLabel(origin: OwnedProject['origin']): string | null {
  if (origin === 'adopted') return 'добавлен вручную';
  if (origin === 'sessions') return 'по сессиям';
  return null;
}

function ProjectRow({
  row,
  machine,
  onForget,
  busy,
}: {
  row: Row;
  machine: MachineRow;
  onForget: (row: Row) => void;
  busy: boolean;
}) {
  const mark = originLabel(row.origin);
  return (
    // The whole row is the link. It used to be a div whose only way in was a
    // 24px icon at `opacity: 0` until hover — invisible on a phone, which has no
    // hover at all, and a 24px target under the 44px minimum besides.
    <a
      className="pj-row"
      {...linkProps({ kind: 'projects', machineId: row.machineId, cwd: row.cwd })}
    >
      <span className={`pj-mark${row.live ? ' live' : ''}${row.attention ? ' attn' : ''}`} />
      <span className="pj-label">{row.label}</span>
      <span className="pj-path">{row.cwd}</span>
      <span className="pj-count">
        {row.count > 0 ? `${row.count} сесс` : '—'}
        {row.live > 0 ? ` · ${row.live} в работе` : ''}
      </span>
      <span className="pj-when">{row.lastModified ? relTimeRu(row.lastModified) : ''}</span>
      {mark && <span className="pj-origin">{mark}</span>}
      <span className="pj-actions">
        <a
          className="pj-act"
          title="Файлы проекта"
          // `preventDefault` is what `linkProps` honours to let a row host its
          // own buttons: without it this click would also follow the row.
          onClickCapture={(e) => e.stopPropagation()}
          {...linkProps({ kind: 'files', machineId: row.machineId, root: row.cwd })}
        >
          <FolderTree size={14} />
        </a>
        {machine.online && machine.canControl && (
          <a
            className="pj-act"
            title="Новая сессия здесь"
            onClickCapture={(e) => e.stopPropagation()}
            {...linkProps({ kind: 'new', machineId: row.machineId, cwd: row.cwd })}
          >
            <Plus size={14} />
          </a>
        )}
        {row.origin === 'adopted' && (
          <button
            className="pj-act"
            title="Убрать из списка (папка на диске остаётся)"
            disabled={busy}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onForget(row);
            }}
          >
            <Trash2 size={14} />
          </button>
        )}
      </span>
    </a>
  );
}

export function Projects({
  central,
  route,
  projects,
  roots,
  runIndex,
  loading,
  onOpen,
  refresh,
}: {
  central: CentralState;
  route: Extract<Route, { kind: 'projects' }>;
  projects: OwnedProject[];
  roots: Record<string, string[]>;
  runIndex: RunIndex;
  /** A round of `projects.list` is still in flight. Everything below that says
   *  "nothing here" has to check this first: an unanswered agent and an agent
   *  with no repositories are the same empty array. */
  loading: boolean;
  onOpen: (machineId: string, sessionId: string) => void;
  refresh: () => void;
}) {
  const [busyCwd, setBusyCwd] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  /**
   * The session scope reaches the two SESSION-derived facts on this screen: the
   * live/attention marks on a row, and the list inside a project.
   *
   * It cannot reach the rows themselves, and should not try to. A project here
   * is a directory the AGENT reports (`projects.list`) — a checkout has no
   * owner, only its sessions do, and hiding a repository because a colleague
   * happened to open a session in it would hide the place you both work in.
   * What the filter answers is «чья это работа», which is exactly the mark and
   * the list.
   */
  const [scope] = useSessionScope();
  const viewerId = central.viewer?.userId;

  /** One project addressed directly: `/w/projects/:machineId?cwd=…`. */
  const detail = useMemo(() => {
    if (!route.machineId || !route.cwd) return undefined;
    const m = central.machines.find((x) => x.machine.machineId === route.machineId);
    if (!m) return undefined;
    const cwd = route.cwd;
    const known = projects.find((p) => p.machineId === m.machine.machineId && p.cwd === cwd);
    return {
      machine: m,
      cwd,
      // The agent's own count, carried through so the detail can reconcile it
      // with the (filtered, capped) snapshot list instead of contradicting it.
      agentCount: known?.count ?? 0,
      label: known?.label ?? cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd,
      // Sessions of THIS project on THIS machine — the scoping `/w/p/:label`
      // cannot do, and the reason `crm` used to mix two boxes together.
      sessions: m.sessions.filter((s) => s.cwd === cwd),
      canStart: m.online && (m.canControl === true || m.canStart === true),
    };
  }, [route.machineId, route.cwd, central.machines, projects]);

  const machines = useMemo<MachineRow[]>(
    () =>
      central.machines.map((m) => ({
        machineId: m.machine.machineId,
        name: m.machine.name,
        online: m.online,
        canControl: m.canControl === true,
      })),
    [central.machines],
  );

  /**
   * Live/attention counts per cwd, from the run index rather than from
   * `projects.list`. The agent's `count` is how many transcripts sit in a
   * directory; whether something is RUNNING there is the hub's fact, and it
   * changes every few seconds.
   */
  const rows = useMemo<Row[]>(() => {
    const liveBy = new Map<string, { live: number; attention: number }>();
    for (const m of central.machines) {
      for (const s of m.sessions) {
        if (!s.cwd) continue;
        if (!scopeKeeps(scope, sessionIsMine(s, m, viewerId))) continue;
        const run = runIndex.get(sessionKey(m.machine.machineId, s.sessionId));
        const isLive = sessionIsWorking(s, run);
        const isAttn = run?.state === 'needs_attention' || run?.state === 'error';
        if (!isLive && !isAttn) continue;
        const key = `${m.machine.machineId}::${s.cwd}`;
        const prev = liveBy.get(key) ?? { live: 0, attention: 0 };
        if (isLive) prev.live += 1;
        if (isAttn) prev.attention += 1;
        liveBy.set(key, prev);
      }
    }
    // The same two exclusions the start-screen shelf applies (`projectTargets`),
    // and for the same reason — they are about what a PROJECT is, not about one
    // screen's taste. `/root` is a cwd a session started from a bare shell
    // records; `/tmp/claude-501/…/scratchpad/eptest` and
    // `…\Temp\codex-probe-4Jqi49` are directories the OS handed out to a harness.
    // Both arrived here as real rows the moment this view stopped filtering, and
    // neither is a place anyone works.
    const byCwd = new Map<string, Row>();
    for (const p of projects) {
      if (isRootish(p.cwd) || isScratchCwd(p.cwd)) continue;
      const key = `${p.machineId}::${canonPath(p.cwd)}`;
      const live = liveBy.get(`${p.machineId}::${p.cwd}`) ?? { live: 0, attention: 0 };
      const prev = byCwd.get(key);
      if (!prev) {
        byCwd.set(key, { ...p, ...live });
        continue;
      }
      // Two spellings of one directory: keep the fuller row rather than the
      // first one seen.
      prev.count += p.count;
      prev.live += live.live;
      prev.attention += live.attention;
      if (p.lastModified > prev.lastModified) prev.lastModified = p.lastModified;
      if (prev.origin === 'sessions' && p.origin) prev.origin = p.origin;
    }
    return [...byCwd.values()];
  }, [projects, central.machines, runIndex, scope, viewerId]);

  /** Machines that actually have something to show, in fleet order. */
  const shown = useMemo(() => {
    const byMachine = new Map<string, Row[]>();
    for (const r of rows) {
      const list = byMachine.get(r.machineId) ?? [];
      list.push(r);
      byMachine.set(r.machineId, list);
    }
    return machines
      .filter((m) => byMachine.has(m.machineId) || (m.online && m.canControl))
      .filter((m) => !route.machineId || m.machineId === route.machineId)
      .map((m) => ({
        machine: m,
        projects: (byMachine.get(m.machineId) ?? []).sort((a, b) => b.lastModified - a.lastModified),
      }));
  }, [rows, machines, route.machineId]);

  const forget = useCallback(
    async (row: Row) => {
      const ok = await askConfirm(
        `Убрать «${row.label}» из списка проектов?\n\n${row.cwd}\n\n` +
          'Папка на диске останется на месте — исчезнет только строка здесь.',
        { confirmLabel: 'Убрать', danger: true },
      );
      if (!ok) return;
      setBusyCwd(row.cwd);
      setError(null);
      try {
        const res = await central.rpc<ProjectForgetResult>(row.machineId, 'projects.forget', {
          cwd: row.cwd,
        });
        if (!res.forgot) {
          setError(
            `«${row.label}» находится сканированием корня — эту строку убрать нельзя, ` +
              'она вернётся при следующем опросе.',
          );
        }
        refresh();
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setBusyCwd(null);
      }
    },
    [central, refresh],
  );

  const total = rows.length;
  /** Nothing known AND still asking. Once even one machine has answered, the
   *  sections are real and a straggler shows its own «спрашиваю» line instead of
   *  blanking the page everyone else has already filled. */
  const waiting = loading && rows.length === 0;
  const adoptMachine = route.adopt ? route.machineId : undefined;

  if (detail) {
    return (
      <ProjectDetail
        machine={detail.machine}
        cwd={detail.cwd}
        label={detail.label}
        sessions={detail.sessions}
        agentCount={detail.agentCount}
        // Whole-machine scope plus the viewer: the detail applies the session scope
        // itself, because it is the screen that has to explain the gap between
        // what it lists and what the agent counted.
        viewerId={viewerId}
        runIndex={runIndex}
        canStart={detail.canStart}
        showAutomated={central.showAutomated}
        onShowAutomated={central.setShowAutomated}
        onOpen={onOpen}
        // Back to the machine you came from, not to the whole fleet.
        backTo={{ machineId: route.machineId }}
      />
    );
  }

  return (
    <div className="board pj">
      <div className="board-head">
        <FolderPlus size={20} />
        <h2>Проекты</h2>
        <span className="sub">
          {waiting
            ? 'спрашиваю агентов…'
            : `${total} на ${shown.length} ${shown.length === 1 ? 'машине' : 'машинах'} · инвентарь от агента, не из сессий`}
        </span>
      </div>

      <div className="pj-chips">
        <a className={`chip${route.machineId ? '' : ' on'}`} {...linkProps({ kind: 'projects' })}>
          Все
        </a>
        {machines
          .filter((m) => m.online || rows.some((r) => r.machineId === m.machineId))
          .map((m) => (
            <a
              key={m.machineId}
              className={`chip${route.machineId === m.machineId ? ' on' : ''}${m.online ? '' : ' off'}`}
              {...linkProps({ kind: 'projects', machineId: m.machineId })}
            >
              {m.name}
              <span className="chip-n">{rows.filter((r) => r.machineId === m.machineId).length}</span>
            </a>
          ))}
      </div>

      {error && <div className="pj-error">{error}</div>}

      {waiting && (
        <div className="pj-empty">Спрашиваю агентов, что у них на диске…</div>
      )}

      {!waiting && shown.length === 0 && (
        <div className="pj-empty">
          Ни одна машина не ответила. Проекты приходят от агента: машина должна быть в сети
          и быть вашей.
        </div>
      )}

      {!waiting && shown.map(({ machine, projects: list }) => {
        const machineRoots = roots[machine.machineId] ?? [];
        const buckets = new Map<string, Row[]>();
        for (const p of list) {
          const key = canonPath(bucketOf(p.cwd, machineRoots));
          const arr = buckets.get(key) ?? [];
          arr.push(p);
          buckets.set(key, arr);
        }
        // Declared roots first and in the agent's own order — that is the order
        // it scans them, and the projects root leading is meaningful.
        const ordered = [...buckets.keys()].sort((a, b) => {
          const ia = machineRoots.indexOf(a);
          const ib = machineRoots.indexOf(b);
          if (ia !== ib) return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
          return a.localeCompare(b);
        });
        return (
          <section className="pj-machine" key={machine.machineId}>
            <div className="pj-mhead">
              <span className={`pj-mdot${machine.online ? ' on' : ''}`} />
              <span className="pj-mname">{machine.name}</span>
              <span className="pj-mmeta">
                {list.length} {list.length === 1 ? 'проект' : 'проектов'}
                {machine.online ? '' : ' · офлайн'}
              </span>
              {machine.online && machine.canControl && (
                <a
                  className="pj-add"
                  {...linkProps({ kind: 'projects', machineId: machine.machineId, adopt: true })}
                >
                  <FolderPlus size={14} /> Добавить проект
                </a>
              )}
            </div>
            {list.length === 0 ? (
              <div className="pj-empty">
                {loading
                  ? 'Спрашиваю агента…'
                  : 'Агент не нашёл здесь ни одного репозитория. «Добавить проект» покажет папки машины.'}
              </div>
            ) : (
              ordered.map((bucket) => (
                <div className="pj-bucket" key={bucket}>
                  <div className="pj-broot">{bucket}</div>
                  {(buckets.get(bucket) ?? []).map((row) => (
                    <ProjectRow
                      key={row.cwd}
                      row={row}
                      machine={machine}
                      busy={busyCwd === row.cwd}
                      onForget={forget}
                    />
                  ))}
                </div>
              ))
            )}
          </section>
        );
      })}

      {adoptMachine && (
        <AdoptPanel
          central={central}
          machineId={adoptMachine}
          machineName={machines.find((m) => m.machineId === adoptMachine)?.name ?? ''}
          roots={roots[adoptMachine] ?? []}
          known={new Set(rows.filter((r) => r.machineId === adoptMachine).map((r) => r.cwd))}
          onClose={() => navigate({ kind: 'projects', machineId: adoptMachine })}
          onAdopted={refresh}
        />
      )}
    </div>
  );
}
