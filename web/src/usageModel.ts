import type { ViewerContext, UsageDayRow, UsageMember, UsageSubscription, UsageSubWindow } from '@cc-remote/shared';

/**
 * Pure helpers behind «Расходы» (UsageViews.tsx): periods, number formatting,
 * the bar tone and what a subscription window says. No React, so they are
 * unit-tested directly.
 */

export type UsagePeriod = 7 | 30;

const DAY = 86_400_000;

/** `YYYY-MM-DD` of an instant in UTC — the hub buckets days in UTC. */
export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** The last `days` UTC days ending today, inclusive. */
export function periodRange(days: UsagePeriod, now = Date.now()): { from: string; to: string } {
  return { from: utcDay(now - (days - 1) * DAY), to: utcDay(now) };
}

/** Every day from `from` to `to`, with the tokens of that day (0 when quiet). */
export function fillDays(days: UsageDayRow[], from: string, to: string): number[] {
  const byDay = new Map(days.map((d) => [d.day, d.tokens]));
  const out: number[] = [];
  const end = Date.parse(`${to}T00:00:00Z`);
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= end; t += DAY) out.push(byDay.get(utcDay(t)) ?? 0);
  return out;
}

/** 1 234 → «1,2 тыс», 3 400 000 → «3,4 млн». */
export function fmtTokens(n: number): string {
  const trim = (x: number) => (x >= 100 ? Math.round(x) : Math.round(x * 10) / 10).toString().replace('.', ',');
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${trim(n / 1000)} тыс`;
  if (n < 1_000_000_000) return `${trim(n / 1_000_000)} млн`;
  return `${trim(n / 1_000_000_000)} млрд`;
}

export type BarTone = 'ok' | 'edge' | 'over';
export function barTone(percent: number): BarTone {
  return percent >= 90 ? 'over' : percent >= 70 ? 'edge' : 'ok';
}

/** A window whose reset has passed shows the reading of a window that is over. */
export function windowIsOver(w: Pick<UsageSubWindow, 'resetsAt'>, now = Date.now()): boolean {
  return w.resetsAt !== undefined && w.resetsAt <= now;
}

export const PROVIDER_LABEL: Record<UsageSubscription['provider'], string> = { claude: 'Claude', codex: 'Codex' };

/** Share of a model in the person's tokens, whole percent. */
export function modelShare(tokens: number, total: number): number {
  return total > 0 ? Math.round((tokens / total) * 100) : 0;
}

/** What the person has to show: any gateway traffic or any subscription reading. */
export function hasUsage(m: UsageMember): boolean {
  return m.gateway.requests > 0 || m.subscriptions.length > 0;
}

/** Heaviest users first; people with nothing last, by name. */
export function sortMembers(members: UsageMember[]): UsageMember[] {
  return [...members].sort((a, b) => b.gateway.totalTokens - a.gateway.totalTokens);
}

/** «Расходы» is a lead's tab: the owner and managers of a team, on a hub that has a gateway. */
export function canSeeUsageTab(viewer: Pick<ViewerContext, 'llmUsage' | 'workspace'> | null | undefined): boolean {
  const role = viewer?.workspace?.role;
  return !!viewer?.llmUsage && (role === 'owner' || role === 'manager');
}
