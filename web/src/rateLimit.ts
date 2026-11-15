/**
 * The plan-limit notice over the composer — what the CLI calls
 * `rate_limit_event` and VS Code shows as «You've used 76% of your weekly
 * limit · resets in 2d».
 *
 * It used to be a status LINE in the transcript («approaching the rate limit
 * (seven_day) — resets 01.10.2026, 13:00:00»): repeated after every request,
 * without the one number that matters, and scrolled away by the next answer.
 * A limit is a property of the ACCOUNT the machine's CLI is signed in to, not
 * of one turn, so it lives next to the field you are about to spend it from.
 *
 * The agent forwards the SDK's `rate_limit_info` verbatim in `data`
 * (`agent/src/claude-session.ts`, `rate_limit_event`); `utilization` is a
 * FRACTION (0–1) — the CLI prints `Math.floor(utilization * 100)`.
 */

import { toMillis } from './lib.js';

export interface RateLimitNotice {
  /** `allowed_warning` — getting close; `rejected` — the window is spent. */
  status: 'allowed_warning' | 'rejected';
  /** `five_hour`, `seven_day`, `seven_day_opus`, … — absent on old CLIs. */
  type?: string;
  /** Used share of the window, 0–100, floored like the CLI does. */
  percent?: number;
  /** When the window resets, ms epoch. */
  resetsAt?: number;
}

/** The window, in the genitive the sentence needs («…% недельного лимита»). */
const WINDOW_OF: Record<string, string> = {
  five_hour: 'лимита сессии (5 ч)',
  seven_day: 'недельного лимита',
  seven_day_opus: 'недельного лимита Opus',
  seven_day_sonnet: 'недельного лимита Sonnet',
  seven_day_overage_included: 'недельного лимита модели',
  overage: 'кредитов',
};

/** …and in the nominative, for «исчерпан». */
const WINDOW_IS: Record<string, string> = {
  five_hour: 'Лимит сессии (5 ч)',
  seven_day: 'Недельный лимит',
  seven_day_opus: 'Недельный лимит Opus',
  seven_day_sonnet: 'Недельный лимит Sonnet',
  seven_day_overage_included: 'Недельный лимит модели',
  overage: 'Лимит кредитов',
};

/** A `rate_limit` status's `data` → the notice, or null when there is nothing
 *  to warn about (`allowed`, malformed). */
export function parseRateLimit(data: Record<string, unknown> | undefined): RateLimitNotice | null {
  if (!data) return null;
  const status = data['status'];
  if (status !== 'allowed_warning' && status !== 'rejected') return null;
  const n: RateLimitNotice = { status };
  if (typeof data['rateLimitType'] === 'string') n.type = data['rateLimitType'];
  const u = data['utilization'];
  if (typeof u === 'number' && Number.isFinite(u) && u > 0) {
    // A fraction per the SDK; a value above 1 would be a CLI that switched to
    // percent — take it as such rather than print «7600%».
    n.percent = Math.min(100, Math.floor(u > 1 ? u : u * 100));
  }
  const r = data['resetsAt'];
  if (typeof r === 'number' && r > 0) n.resetsAt = toMillis(r); // SDK sends seconds
  return n;
}

/** «через 2 дн.», «через 5 ч», «через 12 мин» — the CLI's «resets in 2d». */
export function resetsIn(at: number, now: number): string {
  const mins = Math.max(1, Math.ceil((at - now) / 60_000));
  if (mins < 60) return `через ${mins} мин`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `через ${h} ч`;
  return `через ${Math.floor(h / 24)} дн.`;
}

/** The banner's sentence. */
export function rateLimitText(n: RateLimitNotice, now: number): string {
  const when = n.resetsAt && n.resetsAt > now ? ` · сброс ${resetsIn(n.resetsAt, now)}` : '';
  if (n.status === 'rejected') {
    return `${(n.type && WINDOW_IS[n.type]) || 'Лимит подписки'} исчерпан${when}`;
  }
  const of = (n.type && WINDOW_OF[n.type]) || 'лимита подписки';
  return n.percent !== undefined ? `Использовано ${n.percent}% ${of}${when}` : `Близко к исчерпанию ${of}${when}`;
}

/** A notice past its reset is history: the window it warned about is gone. */
export function rateLimitCurrent(n: RateLimitNotice | null, now: number): n is RateLimitNotice {
  return !!n && (!n.resetsAt || n.resetsAt > now);
}

/**
 * What makes ONE warning — shown once across panes and tabs (RateLimitBanner).
 * The window and its reset name it; the status and the tens of percent are in
 * the key so the banner comes back when the news gets worse (76% → 90%, or
 * the window runs out) — the CLI re-warns on the same thresholds.
 */
export function rateLimitDismissKey(machineId: string, n: RateLimitNotice): string {
  const band = n.status === 'rejected' ? 'x' : String(Math.floor((n.percent ?? 0) / 10));
  return `${machineId}|${n.type ?? ''}|${n.resetsAt ?? ''}|${band}`;
}
