import type { UsageLimit } from '@cc-remote/shared';

/**
 * Is a limit being spent at a pace that lasts until it resets? (20.10.2026,
 * by request.) «48% of the week» says nothing on its own: on day six it is a
 * comfortable margin, on day one it runs out on Wednesday. So the colour
 * follows the PACE, not the percent:
 *
 *   ok    — at the average rate so far, the window resets before it runs out;
 *   edge  — runs out within the last 1/7 of the window (a day of a week);
 *   over  — runs out earlier than that;
 *   out   — already at 100%, you are stopped.
 *
 * The rate is the window's own average (used ÷ elapsed): no history is kept
 * or needed, the length of the window and its reset time give the elapsed
 * part. The first 1/7 of a window (a day, or ~43 min of a 5-hour one) is
 * too short to extrapolate — 10% in six hours reads as «runs out in 2.5
 * days» — so there the old absolute thresholds decide.
 */
export type PaceStatus = 'ok' | 'edge' | 'over' | 'out';

export type Pace = {
  status: PaceStatus;
  /** Where the bar «should» be now, 0–100 — the share of the window gone. */
  expected?: number;
  /** ms from now until 100% at the average rate; absent when not projected. */
  runsOutInMs?: number;
  /** ms from now until the window resets. */
  resetInMs?: number;
};

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const UNIT: Record<string, number> = {
  week: 7 * DAY, нед: 7 * DAY, day: DAY, дн: DAY, д: DAY, hr: HOUR, ч: HOUR, min: 60_000, мин: 60_000,
};

/** The window's length. The label carries it where it is known — the agents
 *  write «Session (5hr)», «Weekly (7 day)», and Codex its real window («Session
 *  (1 week)» on a plan with no 5-hour limit), so `group: 'session'` alone is
 *  not «5 hours». The group is the fallback. Seat budgets have no fixed window
 *  the meter knows — they keep the absolute thresholds. */
export function windowMsOf(l: UsageLimit): number | undefined {
  if (l.key.startsWith('budget_')) return undefined;
  const m = /\((\d+)\s*(week|нед|day|дн|д|hr|ч|min|мин)/.exec(l.label);
  if (m && Number(m[1]) > 0) return Number(m[1]) * UNIT[m[2]!]!;
  if (l.group === 'weekly') return 7 * DAY;
  if (l.group === 'session') return 5 * HOUR;
  return undefined;
}

const absolute = (p: number): PaceStatus => (p >= 100 ? 'out' : p >= 90 ? 'over' : p >= 75 ? 'edge' : 'ok');

export function paceOf(l: UsageLimit, now = Date.now()): Pace {
  const p = Math.max(0, l.percent);
  if (p >= 100) return { status: 'out', ...(l.resetsAt ? { resetInMs: Math.max(0, l.resetsAt - now) } : {}) };
  const win = windowMsOf(l);
  if (!win || !l.resetsAt) return { status: absolute(p) };
  const left = l.resetsAt - now;
  if (left <= 0 || left > win) return { status: absolute(p), resetInMs: Math.max(0, left) };
  const elapsed = win - left;
  const expected = (elapsed / win) * 100;
  const warmup = win / 7;
  if (elapsed < warmup) return { status: absolute(p), expected, resetInMs: left };
  if (p <= 0) return { status: 'ok', expected, resetInMs: left };
  const runsOutInMs = ((100 - p) * elapsed) / p;
  const slack = left - runsOutInMs; // how much earlier than the reset it runs out
  const status: PaceStatus = slack <= 0 ? 'ok' : slack < warmup ? 'edge' : 'over';
  return { status, expected, runsOutInMs, resetInMs: left };
}

const RANK: Record<PaceStatus, number> = { ok: 0, edge: 1, over: 2, out: 3 };
export const worsePace = (a: PaceStatus, b: PaceStatus) => RANK[a] - RANK[b];

/** «3 д», «5 ч», «40 мин», «1,5 д» — a duration for a tooltip. */
export function fmtSpan(ms: number): string {
  if (ms < HOUR) return `${Math.max(1, Math.round(ms / 60_000))} мин`;
  if (ms < DAY) return `${Math.round(ms / HOUR)} ч`;
  const d = ms / DAY;
  return `${d < 10 ? (Math.round(d * 2) / 2).toString().replace('.', ',') : Math.round(d)} д`;
}

/** One sentence on the pace, for a tooltip. */
export function paceText(pace: Pace): string {
  const reset =
    pace.resetInMs === undefined ? '' : pace.resetInMs <= 0 ? 'сброс сейчас' : `сброс через ${fmtSpan(pace.resetInMs)}`;
  if (pace.status === 'out') return ['лимит исчерпан', reset].filter(Boolean).join(' · ');
  if (pace.runsOutInMs === undefined) return reset;
  const lasts = pace.status === 'ok' ? 'в этом темпе хватит' : `в этом темпе кончится через ${fmtSpan(pace.runsOutInMs)}`;
  return [lasts, reset].filter(Boolean).join(' · ');
}
