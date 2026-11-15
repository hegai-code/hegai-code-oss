import type { ActiveRunInfo, MachineSnapshot, SessionSummary } from '@cc-remote/shared';
import { attentionLabel, cleanTitle, isAutomatedSession, sessionIsMine, sessionKey, type RunIndex } from '../lib.js';
import { storageGet, storageSet } from '../storage.js';

/**
 * The light shell's home: the person's work as three piles.
 *
 * The full client lists SESSIONS, by project, on every screen — the right
 * answer for somebody who lives in it and the wrong one for somebody who asked
 * for something and wants to know one thing: is it waiting for me, still going,
 * or done. Those are the three piles, the same ones the phone's home screen has
 * shown since the iOS rewrite (`HomeSessions.swift`); this is that rule in
 * TypeScript, over frames the socket already delivers. No hub code and no RPC
 * per row — a list that costs a round trip per task is a list that is late.
 */

export type TaskGroup = 'attention' | 'working' | 'done';

export interface Task {
  key: string;
  machineId: string;
  sessionId: string;
  title: string;
  project?: string;
  machineName: string;
  source?: 'claude' | 'codex';
  provider?: string;
  group: TaskGroup;
  /** «ждёт ответа» / «ждёт подтверждения» / «ошибка» — attention rows only. */
  label?: string;
  /** The last line the agent said, when the hub has one. */
  preview?: string;
  /** What the row is ordered by, and what «готово» prints as its time: when it
   *  started waiting, when the turn began, when it finished. */
  at: number;
  /** A result the person has not opened since it arrived. */
  unread: boolean;
}

export interface Tasks {
  attention: Task[];
  working: Task[];
  done: Task[];
}

/**
 * What this browser knows about what the person has looked at.
 *
 * `base` is the first visit: everything that finished before the shell was
 * ever opened here counts as seen, or the first screen a new person meets is
 * a week of «new» results they have all read somewhere else. `at` is, per
 * task, the last time it was on screen.
 */
export interface Seen {
  base: number;
  at: Record<string, number>;
}

/** Read results kept on the list: the eight most recent of the last day. An
 *  unread one stays however old it is — it is the thing the list is for. */
export const DONE_KEEP = 8;
export const DONE_WINDOW_MS = 24 * 60 * 60 * 1000;

type State = ActiveRunInfo['state'] | undefined;

/** A run reports through `activity`; a session open in an editor or a terminal
 *  reports through the inventory (`livePid` + the status in its own pid file). */
export function sessionState(session: Pick<SessionSummary, 'livePid' | 'liveStatus'>, run: ActiveRunInfo | undefined): State {
  if (run) return run.state;
  if (!session.livePid) return undefined;
  if (session.liveStatus === 'busy') return 'working';
  if (session.liveStatus === 'waiting') return 'needs_attention';
  if (session.liveStatus === 'idle') return 'idle';
  return undefined;
}

function place(
  out: Tasks,
  base: Omit<Task, 'group' | 'at' | 'unread' | 'label'>,
  state: State,
  run: ActiveRunInfo | undefined,
  lastModified: number,
  seen: Seen,
  /** The hub names the viewer as the one who started this session — i.e. it
   *  was started through this product, not found on disk. */
  started: boolean,
): void {
  if (state === 'needs_attention' || state === 'error') {
    out.attention.push({
      ...base,
      group: 'attention',
      label: state === 'error' ? 'ошибка' : attentionLabel(run),
      at: run?.since ?? lastModified,
      unread: false,
    });
    return;
  }
  if (state === 'working') {
    out.working.push({ ...base, group: 'working', at: run?.taskStartedAt ?? run?.since ?? lastModified, unread: false });
    return;
  }
  // Finished. A run that went idle says when; otherwise the transcript's last
  // write is the best there is.
  const at = run ? run.since : lastModified;
  // Only work this product is DRIVING can be news. A session somebody is typing
  // into in their own terminal moves `lastModified` on every turn — marking
  // each of those «new» here would be telling a person about a reply they are
  // looking at. So: a run the hub holds, a session the hub says this person
  // started through the product (an idle run is released when its agent
  // restarts — the result must not stop being news because of that), or a
  // task opened from this shell.
  const tracked = run !== undefined || started || base.key in seen.at;
  const unread = tracked && at > (seen.at[base.key] ?? seen.base);
  out.done.push({ ...base, group: 'done', at, unread });
}

export function deriveTasks(
  machines: MachineSnapshot[],
  runs: RunIndex,
  viewerId: string | undefined,
  seen: Seen,
  now: number = Date.now(),
): Tasks {
  const out: Tasks = { attention: [], working: [], done: [] };
  const listed = new Set<string>();
  for (const m of machines) {
    for (const s of m.sessions) {
      if (!sessionIsMine(s, m, viewerId) || isAutomatedSession(s)) continue;
      const key = sessionKey(m.machine.machineId, s.sessionId);
      listed.add(key);
      const run = runs.get(key);
      place(
        out,
        {
          key,
          machineId: m.machine.machineId,
          sessionId: s.sessionId,
          title: cleanTitle(run?.title ?? s.title) || 'Без названия',
          machineName: m.machine.name,
          ...(s.project ? { project: s.project } : {}),
          ...(s.source ? { source: s.source } : {}),
          ...(s.provider ? { provider: s.provider } : {}),
          ...(run?.preview ? { preview: run.preview } : {}),
        },
        sessionState(s, run),
        run,
        s.lastModified,
        seen,
        !!viewerId && s.owner?.userId === viewerId,
      );
    }
  }
  // A task started a moment ago: the run exists, the transcript is not in the
  // inventory yet. Without this the thing just sent is the one thing missing
  // from the list — for its whole first turn.
  for (const [key, run] of runs) {
    if (listed.has(key) || !run.sessionId) continue;
    if (!viewerId || run.ownerUserId !== viewerId) continue;
    place(
      out,
      {
        key,
        machineId: run.machineId,
        sessionId: run.sessionId,
        title: cleanTitle(run.title) || 'Новая задача',
        machineName: run.machineName ?? '',
        ...(run.project ? { project: run.project } : {}),
        ...(run.preview ? { preview: run.preview } : {}),
      },
      run.state,
      run,
      run.since,
      seen,
      true,
    );
  }
  const newest = (a: Task, b: Task) => b.at - a.at || (a.key < b.key ? -1 : 1);
  // The longest wait leads: it is the one that has been holding work up.
  out.attention.sort((a, b) => a.at - b.at || (a.key < b.key ? -1 : 1));
  out.working.sort(newest);
  out.done.sort(newest);
  // A read receipt changes the dot, not the row's place: every unread result,
  // plus a bounded tail of recently read ones, in completion order.
  const read = out.done.filter((t) => !t.unread && now - t.at < DONE_WINDOW_MS).slice(0, DONE_KEEP);
  const keep = new Set(read.map((t) => t.key));
  out.done = out.done.filter((t) => t.unread || keep.has(t.key));
  return out;
}

const SEEN_PREFIX = 'lite-seen:';
/** Entries older than this are dropped on write: the map is per task, and a
 *  task nobody has opened in a month is not coming back as «new». */
const SEEN_TTL_MS = 30 * DONE_WINDOW_MS;

export function loadSeen(userId: string, now: number = Date.now()): Seen {
  try {
    const raw = storageGet(SEEN_PREFIX + userId);
    if (raw) {
      const v = JSON.parse(raw) as Partial<Seen>;
      if (typeof v.base === 'number' && v.at && typeof v.at === 'object') {
        return { base: v.base, at: v.at as Record<string, number> };
      }
    }
  } catch {
    /* private mode or a corrupt value — start over */
  }
  const fresh: Seen = { base: now, at: {} };
  saveSeen(userId, fresh);
  return fresh;
}

export function saveSeen(userId: string, seen: Seen): void {
  // No storage: the dots simply do not survive a reload.
  storageSet(SEEN_PREFIX + userId, JSON.stringify(seen));
}

/** `seen` plus what the person's other devices have read (hub time), so a
 *  result seen elsewhere clears its dot here. Same object when nothing moves. */
export function withReads(seen: Seen, reads: ReadonlyMap<string, number>): Seen {
  let at: Record<string, number> | null = null;
  for (const [key, v] of reads) {
    if ((seen.at[key] ?? -Infinity) < v) (at ??= { ...seen.at })[key] = v;
  }
  return at ? { base: seen.base, at } : seen;
}

/** `seen` with this task marked as looked at now. Returns the same object when
 *  nothing would change, so a caller can use identity to skip a write. */
export function markSeen(seen: Seen, key: string, now: number = Date.now()): Seen {
  if ((seen.at[key] ?? 0) >= now) return seen;
  const at: Record<string, number> = {};
  for (const [k, v] of Object.entries(seen.at)) {
    if (now - v < SEEN_TTL_MS) at[k] = v;
  }
  at[key] = now;
  return { base: seen.base, at };
}
