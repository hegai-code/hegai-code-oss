import { useCallback, useEffect, useState } from 'react';
import { Cpu, RefreshCw } from '../icons.js';
import { linkProps } from '../router.js';
import { ConnectMachine } from './ConnectMachine.js';
import { MyDevices } from '../TeamViews.js';
import { RuntimeRows } from './RuntimeRows.js';
import { pluralRu, relTimeRu } from '../lib.js';
import { teamRuntimeState } from './runtimeChips.js';
import type { MachineStats, ProcessSample, ProcListResult, ProcKillResult, RuntimeStatus, SyncState, TeamMachine, ViewerContext } from '@cc-remote/shared';
import type { CentralState } from '../useCentral.js';
import { requestPairDialog, usePrivacy } from '../e2ee/ring.js';
import { askConfirm } from '../dialogs.js';

/** Hardware view: per-machine live telemetry (30s samples pushed by agents)
 *  plus an on-demand process list with kill controls. */

const GB = 1024 ** 3;
const MB = 1024 ** 2;

/** Processes worth spotting at a glance on a loaded box. */
const HOT_CMD = /claude|\.vscode-server|code-server|vscode|codex/i;

function fmtBytes(n: number): string {
  if (n >= 10 * GB) return `${Math.round(n / GB)}G`;
  if (n >= GB) return `${(n / GB).toFixed(1)}G`;
  return `${Math.max(0, Math.round(n / MB))}M`;
}

function fmtUptime(sec: number): string {
  const d = Math.floor(sec / 86_400);
  const h = Math.floor((sec % 86_400) / 3600);
  if (d > 0) return `${d} д ${h} ч`;
  const m = Math.floor((sec % 3600) / 60);
  return h > 0 ? `${h} ч ${m} мин` : `${m} мин`;
}

function pctClass(pct: number): string {
  if (pct >= 90) return ' crit';
  if (pct >= 75) return ' warn';
  return '';
}

function Meter({ label, pct, display, title }: { label: string; pct: number; display: string; title?: string }) {
  const w = Math.min(100, Math.max(0, pct));
  return (
    <div className="hw-meter" title={title}>
      <span className="hw-meter-top">
        <span className="hw-meter-label">{label}</span>
        <span className="hw-meter-val">{display}</span>
      </span>
      <span className="barrow-track">
        <span className={`barrow-fill${pctClass(w)}`} style={{ width: `${w}%` }} />
      </span>
    </div>
  );
}

/** CPU / Память / Диск — shared by the viewer's own cards and the read-only
 *  team ones. */
function HwMeters({ stats }: { stats: MachineStats }) {
  return (
    <div className="hw-meters">
      <Meter
        label="CPU"
        pct={stats.cpuPercent}
        display={`${stats.cpuPercent.toFixed(0)}%`}
        title={`Нагрузка la ${stats.load1.toFixed(2)}`}
      />
      <Meter
        label="Память"
        pct={(stats.memUsed / stats.memTotal) * 100}
        display={`${fmtBytes(stats.memUsed)} / ${fmtBytes(stats.memTotal)}`}
        title={stats.swapTotal > 0 ? `Подкачка ${fmtBytes(stats.swapUsed)} / ${fmtBytes(stats.swapTotal)}` : undefined}
      />
      {stats.diskTotal > 0 && (
        <Meter
          label="Диск"
          pct={(stats.diskUsed / stats.diskTotal) * 100}
          display={`${fmtBytes(stats.diskUsed)} / ${fmtBytes(stats.diskTotal)}`}
          title={`${fmtBytes(Math.max(0, stats.diskTotal - stats.diskUsed))} свободно`}
        />
      )}
    </div>
  );
}

/** «platform · N ядер · uptime» — the card header's right-hand meta. */
function HwMeta({ stats, stale, staleSec }: { stats: MachineStats; stale: boolean; staleSec: number }) {
  return (
    <span className="hw-meta">
      {stats.platform} · {stats.cpuCount} {pluralRu(stats.cpuCount, ['ядро', 'ядра', 'ядер'])} · {fmtUptime(stats.uptimeSec)}
      {stale ? ` · данные ${staleSec} с назад` : ''}
    </span>
  );
}

/** «104 МБ» / «1.2 ГБ» — the agent's own footprint, in words the footer can say. */
function fmtMb(n: number): string {
  return n >= GB ? `${(n / GB).toFixed(1)} ГБ` : `${Math.max(0, Math.round(n / MB))} МБ`;
}

function ProcTable({
  machineId,
  central,
  onClose,
  canKill,
}: {
  machineId: string;
  central: CentralState;
  onClose: () => void;
  /** False on a chat-only machine: the agent refuses `proc.kill` there. */
  canKill: boolean;
}) {
  const [procs, setProcs] = useState<ProcessSample[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [busyPid, setBusyPid] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const res = await central.rpc<ProcListResult>(machineId, 'proc.list', {});
      setProcs(res.processes);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [central, machineId]);
  useEffect(() => void refresh(), [refresh]);

  const kill = async (p: ProcessSample, signal: 'TERM' | 'KILL') => {
    const label = signal === 'KILL' ? 'Убить принудительно' : 'Завершить';
    if (!(await askConfirm(`${label} процесс ${p.pid}?\n\n${p.command.slice(0, 90)}`, { confirmLabel: label, danger: true }))) return;
    setBusyPid(p.pid);
    try {
      const res = await central.rpc<ProcKillResult>(machineId, 'proc.kill', { pid: p.pid, signal });
      if (!res.ok) setError(res.error ?? 'не удалось завершить процесс');
      // TERM needs a moment to land before the refreshed list reflects it.
      await new Promise((r) => setTimeout(r, 700));
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusyPid(null);
    }
  };

  const q = filter.trim().toLowerCase();
  const shown = (procs ?? []).filter((p) => !q || p.command.toLowerCase().includes(q) || String(p.pid).includes(q));

  return (
    <div className="hw-procs">
      <div className="hw-procs-bar">
        <input
          className="hw-filter"
          placeholder="Фильтр процессов… (vscode, claude, node)"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <button className="hw-btn" onClick={() => void refresh()} title="Обновить" aria-label="Обновить">
          <RefreshCw size={14} />
        </button>
        <button className="hw-btn" onClick={onClose}>
          Закрыть
        </button>
      </div>
      {error && <div className="hw-error">{error}</div>}
      {procs === null ? (
        <div className="hw-empty">Загружаем…</div>
      ) : shown.length === 0 ? (
        <div className="hw-empty">Таких процессов нет.</div>
      ) : (
        <div className="hw-table">
          <div className="hw-row hw-headrow">
            <span className="hw-pid">PID</span>
            <span className="hw-cpu">CPU%</span>
            <span className="hw-mem">Память</span>
            <span className="hw-cmd">Команда</span>
            <span className="hw-act" />
          </div>
          {shown.map((p) => (
            <div className={`hw-row${HOT_CMD.test(p.command) ? ' hot' : ''}`} key={p.pid}>
              <span className="hw-pid">{p.pid}</span>
              <span className="hw-cpu">{p.cpu.toFixed(1)}</span>
              <span className="hw-mem">{fmtBytes(p.rss)}</span>
              <span className="hw-cmd" title={p.command}>
                {p.command}
              </span>
              {canKill && (
                <span className="hw-act">
                  <button className="hw-btn danger" disabled={busyPid === p.pid} onClick={() => void kill(p, 'TERM')} title="Завершить процесс (SIGTERM)">
                    стоп
                  </button>
                  <button className="hw-btn danger" disabled={busyPid === p.pid} onClick={() => void kill(p, 'KILL')} title="Убить принудительно (SIGKILL)">
                    убить
                  </button>
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Which folders' sessions leave the machine (agent/src/policy.ts). The agent
 * decides and remembers — this only asks it (`sync.list`) and tells it
 * (`sync.set`). A new machine starts with nothing picked; on a chat-only one
 * the list is read-only here, because only the owner changes it, on the machine.
 */
function SyncPanel({ machineId, central, onClose }: { machineId: string; central: CentralState; onClose: () => void }) {
  const [state, setState] = useState<SyncState | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await central.rpc<SyncState>(machineId, 'sync.list', {});
      setState(res);
      setPicked(new Set(res.projects));
    } catch (err) {
      setError((err as Error).message);
    }
  }, [central, machineId]);
  useEffect(() => void load(), [load]);

  const apply = async (params: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    try {
      const res = await central.rpc<SyncState>(machineId, 'sync.set', params);
      setState(res);
      setPicked(new Set(res.projects));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!state) {
    return (
      <div className="hw-procs">
        {error ? <div className="hw-error">{error}</div> : <div className="hw-empty">Спрашиваю машину…</div>}
      </div>
    );
  }
  const locked = state.chatOnly;
  // Folders already picked but with no session on disk right now still show,
  // so a pick can be undone.
  const rows = [
    ...state.candidates,
    ...state.projects.filter((p) => !state.candidates.some((c) => c.cwd === p)).map((cwd) => ({ cwd, sessions: 0 })),
  ];
  const dirty =
    state.mode === 'selected' &&
    (picked.size !== state.projects.length || [...picked].some((p) => !state.projects.includes(p)));
  return (
    <div className="hw-procs">
      <div className="hw-empty">
        {state.mode === 'all'
          ? 'Сейчас на сервер уходят все сессии этой машины.'
          : 'На сервер уходят только сессии из отмеченных папок. Остальные остаются на машине — их не видно ни здесь, ни на телефоне.'}
        {locked && ' Машина в режиме «только чат»: список меняет её владелец на самой машине — node agent.mjs policy sync …'}
      </div>
      {!locked && (
        <div className="hw-procs-bar">
          {state.mode === 'all' ? (
            <button
              className="hw-btn"
              disabled={busy}
              onClick={async () => {
                if (await askConfirm('Синхронизировать только выбранные папки? Копии остальных сессий будут удалены с сервера.', { confirmLabel: 'Синхронизировать', danger: true })) void apply({ mode: 'selected' });
              }}
            >
              Только выбранные папки
            </button>
          ) : (
            <>
              <button className="hw-btn" disabled={busy || !dirty} onClick={() => void apply({
                add: [...picked].filter((p) => !state.projects.includes(p)),
                remove: state.projects.filter((p) => !picked.has(p)),
              })}>
                Сохранить
              </button>
              <button className="hw-btn" disabled={busy} onClick={() => void apply({ mode: 'all' })}>
                Все сессии
              </button>
            </>
          )}
          <button className="hw-btn" onClick={onClose}>Закрыть</button>
        </div>
      )}
      {error && <div className="hw-error">{error}</div>}
      {state.mode === 'selected' && (
        <div className="hw-table">
          {rows.length === 0 && <div className="hw-empty">На машине пока нет сессий. Папка добавится сама, когда вы начнёте в ней сессию отсюда.</div>}
          {rows.map((r) => (
            <label className="hw-row" key={r.cwd}>
              <input
                type="checkbox"
                disabled={locked || busy}
                checked={picked.has(r.cwd)}
                onChange={(e) => {
                  const next = new Set(picked);
                  if (e.target.checked) next.add(r.cwd);
                  else next.delete(r.cwd);
                  setPicked(next);
                }}
              />
              <span className="hw-cmd" title={r.cwd}>{r.cwd}</span>
              <span className="hw-mem">{r.sessions || ''}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

/** «Приватная»: the machine's sessions are end-to-end encrypted. The chip says
 *  whether THIS browser holds the key, and is the door to the pairing dialog. */
function PrivateChip({ machineId, name }: { machineId: string; name: string }) {
  const { hasKey } = usePrivacy(machineId, true);
  return (
    <>
      <span
        className="role-chip hw-chip"
        title="Содержимое сессий этой машины шифруется на ней самой: сервер Hegai Code хранит и передаёт его, но прочитать не может. Включает владелец машины (~/.cc-remote/policy.json)."
      >
        приватная
      </span>
      <button
        type="button"
        className="hw-btn"
        onClick={() => requestPairDialog({ machineId, machineName: name })}
        title={hasKey ? 'Ключ уже есть в этом браузере. Ввести новый код — например, после смены ключа.' : 'Без ключа сессии этой машины здесь не читаются.'}
      >
        {hasKey ? 'Ключ есть · сменить' : 'Ввести код пары'}
      </button>
    </>
  );
}

/** The machine is not private any more but this browser still holds its key,
 *  so it would refuse the machine's now-clear output: the way out is to forget it. */
function LeftoverKey({ machineId, name }: { machineId: string; name: string }) {
  const { hasKey } = usePrivacy(machineId, true);
  if (!hasKey) return null;
  return (
    <button
      type="button"
      className="hw-btn"
      onClick={() => requestPairDialog({ machineId, machineName: name })}
      title="Машина больше не приватная, но в этом браузере остался её ключ. Забудьте его, чтобы снова читать её сессии."
    >
      Ключ остался · забыть
    </button>
  );
}

function MachineCard({
  name,
  online,
  canControl,
  chatOnly,
  syncMode,
  retentionDays,
  isPrivate,
  sandbox,
  stats,
  runtimes,
  machineId,
  central,
}: {
  name: string;
  online: boolean;
  canControl: boolean;
  /** The machine's owner switched it to chat-only (`policy.json` there). */
  chatOnly: boolean;
  /** What leaves the machine, as its agent reports it; absent = an older agent,
   *  which syncs everything. */
  syncMode: 'all' | 'selected';
  /** How long the hub keeps this machine's transcripts, as its owner set it
   *  there; absent = indefinitely. */
  retentionDays?: number;
  /** The owner marked the machine private (end-to-end encrypted sessions). */
  isPrivate: boolean;
  /** A hosted machine the hub provisioned for its owner. */
  sandbox: boolean;
  stats?: MachineStats;
  /** What the machine's Claude and Codex ARE; absent for an older agent. */
  runtimes?: RuntimeStatus;
  machineId: string;
  central: CentralState;
}) {
  const [procsOpen, setProcsOpen] = useState(false);
  const [syncOpen, setSyncOpen] = useState(false);
  const staleSec = stats ? Math.round((Date.now() - stats.ts) / 1000) : 0;
  const syncLabel = syncMode === 'all' ? 'Синхронизация: всё' : 'Синхронизация: выбранное';
  const stale = online && staleSec > 90;
  return (
    <div className={`hw-card${online ? '' : ' offline'}`}>
      <div className="hw-head">
        <span className={`hw-dot${online ? ' on' : ''}`} />
        <span className="hw-name" title={name}>{name}</span>
        {sandbox && <span className="role-chip hw-chip">песочница</span>}
        {chatOnly && (
          <span className="role-chip hw-chip" title="Владелец машины выключил на ней терминал, запись файлов, git, завершение процессов и режим без подтверждений (~/.cc-remote/policy.json)">
            только чат
          </span>
        )}
        {isPrivate && <PrivateChip machineId={machineId} name={name} />}
        {!isPrivate && <LeftoverKey machineId={machineId} name={name} />}
        {retentionDays !== undefined && (
          <span
            className="role-chip hw-chip"
            title={`Переписка хранится на сервере ${retentionDays} ${pluralRu(retentionDays, ['день', 'дня', 'дней'])} после последнего сообщения, затем удаляется. На самой машине она остаётся. Срок задаёт владелец машины (~/.cc-remote/policy.json).`}
          >
            хранится {retentionDays} {pluralRu(retentionDays, ['день', 'дня', 'дней'])}
          </span>
        )}
        {stats && <HwMeta stats={stats} stale={stale} staleSec={staleSec} />}
      </div>
      {online && canControl && !chatOnly && <RuntimeRows central={central} machineId={machineId} compact />}
      {!stats ? (
        <div className="hw-empty">{online ? 'Данных пока нет — агента нужно обновить.' : 'Не в сети.'}</div>
      ) : (
        <>
          <HwMeters stats={stats} />
          <div className="hw-foot">
            <span className="hw-agent">
              агент {fmtMb(stats.agentRss)} · {stats.agentCpuPercent.toFixed(1)}% CPU
            </span>
            <span className="hw-actions">
              {/* Железо was a leaf with no way out of it — not one link in the
                  whole view. A machine you are looking at is the most natural
                  place to ask "and what is ON it", so that question now has a
                  door. */}
              <a className="hw-btn" {...linkProps({ kind: 'projects', machineId })}>
                Проекты
              </a>
              {canControl && online && (
                <button className={`hw-btn${syncOpen ? ' on' : ''}`} aria-expanded={syncOpen} title={syncLabel} onClick={() => setSyncOpen((v) => !v)}>
                  Синхронизация
                </button>
              )}
              {canControl && online && (
                <button className={`hw-btn${procsOpen ? ' on' : ''}`} aria-expanded={procsOpen} onClick={() => setProcsOpen((v) => !v)}>
                  Процессы
                </button>
              )}
            </span>
          </div>
          {syncOpen && <SyncPanel machineId={machineId} central={central} onClose={() => setSyncOpen(false)} />}
          {procsOpen && (
            <ProcTable machineId={machineId} central={central} onClose={() => setProcsOpen(false)} canKill={!chatOnly} />
          )}
        </>
      )}
    </div>
  );
}

/**
 * A team member's machine, seen by the workspace owner / a manager: READ-ONLY.
 * The same card canon as `MachineCard` (status mark, name, meta, meters) but no
 * way in — no buttons, no footer, no agent line; Claude and Codex are quiet
 * text from present/auth, since the hub strips account and plan from them.
 */
function TeamMachineCard({ team, stats, runtimes }: { team: TeamMachine; stats?: MachineStats; runtimes?: RuntimeStatus }) {
  const { machine, owner, online, lastSeen } = team;
  const who = owner.fullName?.trim() || owner.email || '';
  const staleSec = stats ? Math.round((Date.now() - stats.ts) / 1000) : 0;
  const rows: Array<[string, ReturnType<typeof teamRuntimeState>]> = [
    ['Claude Code', teamRuntimeState(runtimes?.claude)],
    ['Codex', teamRuntimeState(runtimes?.codex)],
  ];
  return (
    <div className={`hw-card hw-team${online ? '' : ' offline'}`}>
      <div className="hw-head">
        <span className={`hw-dot${online ? ' on' : ''}`} />
        <span className="hw-name" title={machine.name}>{machine.name}</span>
        {who && <span className="hw-owner" title={owner.email ?? who}>{who}</span>}
        {stats && online && <HwMeta stats={stats} stale={staleSec > 90} staleSec={staleSec} />}
      </div>
      {!online ? (
        <div className="hw-empty">Не в сети{lastSeen > 0 ? ` · был(а) ${relTimeRu(lastSeen)}` : ''}</div>
      ) : (
        <>
          {runtimes && (
            <div className="rt-rows compact">
              {rows.map(([name, st]) => (
                <div className="rt-row" key={name}>
                  <span className="rt-name">{name}</span>
                  <span className="rt-state"><span className={`rt-status ${st.tone}`}>{st.tone === 'attn' && <span className="rt-mark" />}{st.text}</span></span>
                </div>
              ))}
            </div>
          )}
          {stats ? <HwMeters stats={stats} /> : <div className="hw-empty">Данных пока нет.</div>}
        </>
      )}
    </div>
  );
}

/**
 * The viewer's sandbox before it has joined the fleet. Drawn from
 * `viewer.access.sandbox` while the provisioner is still at work, so the page
 * says "coming" instead of "no machines". Nothing to measure yet, so no meters.
 */
function PendingSandboxCard({ name, status }: { name: string; status: 'queued' | 'running' }) {
  return (
    <div className="hw-card pending">
      <div className="hw-head">
        <span className="hw-dot pending" />
        <span className="hw-name">{name}</span>
        <span className="role-chip hw-chip">песочница</span>
      </div>
      <div className="hw-empty">{status === 'queued' ? 'Готовится — обычно 2–5 минут, появится сама.' : 'Устанавливается — ещё минута-другая.'}</div>
    </div>
  );
}

export function Hardware({ central, viewer }: { central: CentralState; viewer?: ViewerContext | null }) {
  // The hub sends hardware samples only to a screen that asks (`statsOnDemand`):
  // hold the interest while this one is mounted, release it on the way out.
  const { watchStats } = central;
  useEffect(() => watchStats(), [watchStats]);
  // A machine the viewer only sees through a share (no control) that the hub
  // also lists under «Машины команды» is drawn once, there — its hardware is
  // stripped from the share's own entry.
  const teamIds = new Set((central.teamMachines ?? []).map((t) => t.machine.machineId));
  const machines = central.machines
    .filter((m) => m.canControl !== false || !teamIds.has(m.machine.machineId))
    .sort(
    (a, b) => Number(b.online) - Number(a.online) || a.machine.name.localeCompare(b.machine.name),
  );
  const team = [...(central.teamMachines ?? [])].sort(
    (a, b) => Number(b.online) - Number(a.online) || a.machine.name.localeCompare(b.machine.name),
  );
  const sandbox = (viewer ?? central.viewer)?.access?.sandbox;
  const pending =
    sandbox && (sandbox.status === 'queued' || sandbox.status === 'running') &&
    !machines.some((m) => m.machine.machineId === sandbox.machineId)
      ? sandbox
      : undefined;
  return (
    <div className="board hw-board">
      <div className="board-head">
        <Cpu size={20} />
        <h2>Машины</h2>
        <span className="sub">
          {machines.filter((m) => m.online).length} из {machines.length} на связи
        </span>
      </div>
      {machines.length === 0 && !pending ? (
        // Someone standing here has exactly one question, so the answer is the
        // whole view: the same one-command block the first-run screen shows.
        <section className="team-card settings-section hw-empty-card">
          <h3>Подключить машину</h3>
          <ConnectMachine />
        </section>
      ) : (
        <div className="hw-grid">
          {pending && (
            <PendingSandboxCard name={pending.machineName ?? 'песочница'} status={pending.status as 'queued' | 'running'} />
          )}
          {machines.map((m) => (
            <MachineCard
              key={m.machine.machineId}
              name={m.machine.name}
              online={m.online}
              canControl={m.canControl !== false}
              chatOnly={m.machine.policy?.chatOnly === true}
              syncMode={m.machine.policy?.sync ?? 'all'}
              retentionDays={m.machine.policy?.transcriptRetentionDays}
              isPrivate={m.machine.private === true}
              sandbox={m.kind === 'sandbox'}
              stats={central.machineStats[m.machine.machineId] ?? m.stats}
              runtimes={central.runtimes[m.machine.machineId] ?? m.runtimes}
              machineId={m.machine.machineId}
              central={central}
            />
          ))}
        </div>
      )}
      {team.length > 0 && (
        <>
          <h3 className="hw-section">Машины команды</h3>
          <div className="hw-grid">
            {team.map((t) => (
              <TeamMachineCard
                key={t.machine.machineId}
                team={t}
                stats={central.machineStats[t.machine.machineId] ?? t.stats}
                runtimes={central.runtimes[t.machine.machineId] ?? t.runtimes}
              />
            ))}
          </div>
        </>
      )}
      {/* Kept below the cards once machines exist: connecting the SECOND machine
          is the common case here (a laptop beside a server). Collapsed, because
          nobody reads it twice. */}
      {(machines.length > 0 || pending) && (
        <details className="hw-connect">
          <summary>Подключить ещё машину</summary>
          <ConnectMachine />
        </details>
      )}
      <details className="hw-connect">
        <summary>Доступ устройств</summary>
        <MyDevices central={central} viewer={viewer} />
      </details>
    </div>
  );
}
