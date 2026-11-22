import { useEffect, useRef, useState } from 'react';
import type { CentralState } from '../useCentral.js';
import type { UsageInfo, UsageLimit } from '@cc-remote/shared';
import { budgetResetMs, budgetWindowLabel, useSeat, type BudgetInfo } from '../appHooks.js';
import { codexOnGateway, withoutClaudeOff } from './runtimeChips.js';
import { AgentMark } from './AgentMark.js';
import { fmtSpan, paceOf, paceText, windowMsOf, worsePace, type Pace } from './usagePace.js';

/**
 * Top-right Claude + Codex usage meter. Each row
 * is a USED-percent bar (fills as you consume) with a reset — Session (5hr),
 * Weekly (7 day), and per-model weeklies like "Weekly Fable". Data is
 * per-machine (each agent reports its own account), so we dedupe by account and
 * headline the most-consumed one; the popover breaks it down.
 */

// A machine on an older agent only reports fiveHour/sevenDay — synthesize rows
// from those so the meter still works during a rollout.
function limitsOf(u: UsageInfo): UsageLimit[] {
  if (u.limits && u.limits.length) return u.limits;
  const out: UsageLimit[] = [];
  if (u.fiveHour) out.push({ key: 'session', label: 'Сессия (5 ч)', group: 'session', percent: u.fiveHour.utilization, resetsAt: u.fiveHour.resetsAt });
  if (u.sevenDay) out.push({ key: 'weekly_all', label: 'Неделя (7 дней)', group: 'weekly', percent: u.sevenDay.utilization, resetsAt: u.sevenDay.resetsAt });
  return out;
}

/** Shared Codex subscription quota (from /api/gateway-quota) — global, one figure
 * for the whole team, mapped into the same UsageInfo shape as per-machine usage. */
export type GatewayQuota = {
  ok?: boolean;
  plan?: string | null;
  primary_used_percent?: number | null;
  primary_window_minutes?: number | null;
  primary_reset_at?: number | null;
  secondary_used_percent?: number | null;
  secondary_window_minutes?: number | null;
  secondary_reset_at?: number | null;
  updated_at?: number | null;
  /** OpenCode Go has three windows (5 h, week, month); the Codex snapshot two. */
  windows?: { key: string; used_percent?: number | null; window_minutes?: number | null; reset_at?: number | null }[] | null;
  /** [admin] Every pool's counter, from `/api/gateway-quota.pools`. */
  pools?: GatewayPool[];
  /** [admin] Which of `pools` the caller's own seat routes to. */
  ownPool?: string;
};

/** One gateway account's counter: `pool-a` (Owner's), `pool-c` (the bureau's),
 *  `pool-go` (OpenCode Go). */
export type GatewayPool = { pool: string; quota: GatewayQuota };

const POOL_NAMES: Record<string, string> = {
  'pool-a': 'pool-a · основной',
  'pool-b': 'pool-b · запасной',
  'pool-c': 'pool-c · бюро',
};
const poolName = (pool: string) => POOL_NAMES[pool] ?? pool;
const isGoPool = (pool: string) => pool === 'pool-go';

function quotaToUsage(q: GatewayQuota | null | undefined): UsageInfo | null {
  if (!q || !q.ok) return null;
  const limits: UsageLimit[] = [];
  const add = (pct?: number | null, win?: number | null, reset?: number | null) => {
    if (win == null || win <= 0) return;
    const weekly = win >= 10080; // 7 days
    // The window's length rides in the label: the pace (usagePace.ts) reads it
    // there, so a 10-day or 3-hour window is not mistaken for 7 days / 5 hours.
    const span = win % 1440 === 0 ? `${win / 1440} дн` : win % 60 === 0 ? `${win / 60} ч` : `${win} мин`;
    limits.push({
      key: weekly ? 'weekly_all' : 'session',
      label: win === 10080 ? 'Неделя (7 дней)' : `${weekly ? 'Окно' : 'Сессия'} (${span})`,
      group: weekly ? 'weekly' : 'session',
      percent: pct ?? 0,
      resetsAt: reset ? reset * 1000 : undefined, // header is epoch seconds
    });
  };
  if (q.windows?.length) {
    for (const w of q.windows) {
      const win = w.window_minutes;
      if (win == null || win <= 0) continue;
      if (win <= 10080) add(w.used_percent, win, w.reset_at);
      else {
        // A month: its own group, so the pill (session/weekly only) leaves it
        // to the popover.
        const days = Math.round(win / 1440);
        limits.push({
          key: `window_${w.key}`,
          label: `Месяц (${days} дн)`,
          group: 'monthly',
          percent: w.used_percent ?? 0,
          resetsAt: w.reset_at ? w.reset_at * 1000 : undefined,
        });
      }
    }
  } else {
    add(q.primary_used_percent, q.primary_window_minutes, q.primary_reset_at);
    add(q.secondary_used_percent, q.secondary_window_minutes, q.secondary_reset_at);
  }
  if (!limits.length) return null;
  return { limits, subscription: q.plan ?? undefined, updatedAt: q.updated_at ? q.updated_at * 1000 : Date.now() };
}

/** [community] The seat's own ceiling (`/api/budget`) in the meter's shape.
 *  Tokens ride the `session` group so the pill's bar is the daily share; the
 *  per-hour request cap has no group the pill knows, so it lives in the
 *  popover only. `null` when there is no ceiling to draw. */
function budgetToUsage(b: BudgetInfo | null): UsageInfo | null {
  const l = b?.limits;
  if (!l) return null;
  const limits: UsageLimit[] = [];
  const resetsAt = budgetResetMs(l);
  const pct = (usedN: number | undefined, cap: number | undefined) =>
    cap && cap > 0 ? Math.min(100, ((usedN ?? 0) / cap) * 100) : undefined;
  const tokens = pct(l.tokensUsed, l.tokens);
  if (tokens !== undefined) {
    const win = budgetWindowLabel(l.tokensWindow);
    limits.push({ key: 'budget_tokens', label: win ? `Токены · ${win}` : 'Токены', group: 'session', percent: tokens, resetsAt });
  }
  const requests = pct(l.requestsUsed, l.requests);
  if (requests !== undefined) {
    const win = budgetWindowLabel(l.requestsWindow);
    limits.push({ key: 'budget_requests', label: win ? `Запросы · ${win}` : 'Запросы', group: 'requests', percent: requests });
  }
  if (!limits.length) return null;
  return { limits, subscription: b?.plan ?? undefined, updatedAt: Date.now() };
}

const used = (p: number) => Math.max(0, p);
/* The level a window is at travels as a class NAME — `pace-ok/edge/over/out`
 * (usagePace.ts) since 20.10.2026, `lvl-*` before. Prefixed on purpose: they
 * were once bare `warn` / `crit`, and `warn` was ALSO the transcript's
 * warning-banner class, so a limit at 75–89% put on the banner's orange plate
 * and padding. A semantic level must not answer to a component's name. */
const maxUsed = (ls: UsageLimit[]) => ls.reduce((m, l) => Math.max(m, l.percent), 0);

/** A COLUMN now, not a sentence: this is the last cell of a one-line row, so it
 *  is the number and its unit and nothing else. Russian, like the rest of the
 *  panel; the window's own name stays English because it comes from the agent
 *  and matches Claude's own /usage. */
function fmtReset(ms?: number): string {
  if (!ms) return '';
  const d = ms - Date.now();
  if (d <= 0) return 'сброс';
  const mins = Math.floor(d / 60_000);
  const h = Math.floor(mins / 60);
  const days = Math.floor(h / 24);
  if (days >= 1) return `${days} д`;
  if (h >= 1) return `${h} ч`;
  return `${mins} мин`;
}

/** The bar both the pill and the panel draw: the fill is what is spent, the
 *  tick is where the fill «should» be by now (the share of the window gone).
 *  Fill short of the tick — a margin; past it — spending ahead of time. The
 *  colour (`pace-*`) says the same in one glance; see usagePace.ts. */
function PaceBar({ percent, pace, cls }: { percent: number; pace: Pace; cls: string }) {
  return (
    <span className={`${cls}-bar`}>
      <span className={`${cls}-fill`} style={{ width: `${Math.min(100, used(percent))}%` }} />
      {pace.expected !== undefined && pace.status !== 'out' ? (
        <span className="pace-tick" style={{ left: `${Math.min(100, pace.expected)}%` }} />
      ) : null}
    </span>
  );
}

/** The pill's short name for a window: «нед» for a week, else its length
 *  («5 ч», «1 ч»), read from the same place the pace reads it. */
function shortWindow(l: UsageLimit): string {
  const ms = windowMsOf(l);
  if (ms === 7 * 86_400_000 || (!ms && l.group === 'weekly')) return 'нед';
  return ms ? fmtSpan(ms) : '5 ч';
}

/**
 * One provider in the pill: a bar and ONE named figure («57% нед», «17% 5 ч»).
 * Of all the provider's windows (5-hour, week, per-model weeks) it shows the
 * one in the worse PACE (20.10.2026) — the one that will stop you first; on a
 * tie, the one closer to its ceiling. Every window is in the tooltip.
 */
function CompactMeterlets({ limits }: { limits: UsageLimit[] }) {
  // ONE number, named (27.09.2026, by request): «17% / 57%» asked the reader
  // to know which window was which.
  const now = Date.now();
  const rows = limits.filter((l) => l.group === 'session' || l.group === 'weekly').map((l) => ({ l, pace: paceOf(l, now) }));
  const top = rows.reduce<(typeof rows)[number] | undefined>(
    (a, b) => (!a || worsePace(b.pace.status, a.pace.status) > 0 || (worsePace(b.pace.status, a.pace.status) === 0 && b.l.percent > a.l.percent) ? b : a),
    undefined,
  );
  const tip = rows
    .map(({ l, pace }) => {
      const t = paceText(pace);
      return `${l.label}: ${Math.round(l.percent)}%${t ? ` — ${t}` : ''}`;
    })
    .join('\n');

  return (
    <span className={`meterlet pace-${top?.pace.status ?? 'ok'}`} title={tip || undefined}>
      <PaceBar percent={top?.l.percent ?? 0} pace={top?.pace ?? { status: 'ok' }} cls="meterlet" />
      <span className="meterlet-val">
        {top ? (
          <>
            {Math.round(top.l.percent)}%<span className="meterlet-week"> {shortWindow(top.l)}</span>
          </>
        ) : (
          '—'
        )}
      </span>
    </span>
  );
}

/**
 * One limit, ONE line: name, bar, percent, reset. Four columns, the same shape
 * every row, so the panel reads down its numbers instead of down its furniture.
 *
 * It was three lines (label+reset, bar, «12% · осталось 88%») and that is how a
 * panel of nine limits reached ~1000px. The count is not ours to bound either —
 * `weekly:${model}` is generated for every `weekly_scoped` Anthropic returns
 * (agent/src/usage.ts:62), and every machine signed into a new account adds a
 * whole block — so the row had to get cheaper, not the list shorter.
 *
 * SPENT, not left. «12% · осталось 88%» said one number twice and was the
 * widest thing in the panel. The pill directly above shows spent, Claude's own
 * /usage shows spent, and the bar fills as you spend. The iOS card still leads
 * with the remainder; that is its screen, where there is one figure and room to
 * spell it out.
 */
function LimitRow({ l }: { l: UsageLimit }) {
  const pace = paceOf(l);
  return (
    <div className={`uwin pace-${pace.status}`} title={paceText(pace) || undefined}>
      <span className="uwin-label">{l.label}</span>
      <PaceBar percent={l.percent} pace={pace} cls="uwin" />
      <span className="uwin-val">{Math.round(l.percent)}%</span>
      <span className="uwin-reset">{fmtReset(l.resetsAt)}</span>
    </div>
  );
}

export function UsageMeter({
  central,
  gatewayQuota,
  compact = false,
}: {
  central: CentralState;
  gatewayQuota?: GatewayQuota | null;
  /** One provider on the pill instead of all of them — the phone's top bar.
   *
   *  The pill used to be off the phone entirely, and the reason was sound: three
   *  providers, each a name plus a bar plus two numbers, was the widest thing in
   *  the chrome of a 390px screen. But the answer to "too wide" is not "not at
   *  all" — the figure is exactly what you want on a phone, where you are
   *  deciding whether to start something rather than watching it. So the pill
   *  shows the ONE provider closest to its ceiling (`providers` is already
   *  sorted that way) and the popover still breaks down every one of them. */
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  // [community] A seat's share of the pool. Read from the seat context rather
  // than a prop: this meter is mounted twice (top bar and lens bar) and both
  // must show the same figure without either polling.
  const seat = useSeat();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  type Account = { usage: UsageInfo; machines: string[] };
  const collect = (values: Record<string, UsageInfo>): Account[] => {
    const byAccount = new Map<string, Account>();
    for (const [mid, u] of Object.entries(values)) {
      if (!limitsOf(u).length) continue;
      const name = central.machines.find((m) => m.machine.machineId === mid)?.machine.name ?? mid;
      const key = u.account ?? `${u.subscription ?? 'account'}:${limitsOf(u).map((l) => `${l.key}:${l.resetsAt ?? 0}`).join('|')}`;
      const cur = byAccount.get(key);
      if (!cur) byAccount.set(key, { usage: u, machines: [name] });
      else {
        if (!cur.machines.includes(name)) cur.machines.push(name);
        if (u.updatedAt > cur.usage.updatedAt) cur.usage = u;
      }
    }
    return [...byAccount.values()].sort((a, b) => maxUsed(limitsOf(b.usage)) - maxUsed(limitsOf(a.usage)));
  };
  const budgetUsage = seat.community ? budgetToUsage(seat.budget) : null;

  // Per-machine runtime problems («Claude · нет входа», «Codex не найден»)
  // are NOT listed here: removed 09.10.2026 by request after two rounds of
  // filtering still showed seven dead-login servers. The popover is limits
  // only; a machine's runtime state lives on its «Железо» card.
  // Machines whose Codex is routed through a gateway: they spend the shared
  // allowance, so they are listed under it, not under their own account.
  const gatewayMachines = central.machines
    .filter((m) => m.online && codexOnGateway(central.runtimes[m.machine.machineId] ?? m.runtimes))
    .map((m) => m.machine.name);
  // The shared meter is shown to whoever it concerns: a platform admin (it is
  // a team-health figure), anyone with a machine on the gateway, and — as
  // before — anyone whose machines have not said either way. Only a fleet
  // that positively runs on its own logins stops seeing a pool it does not use.
  const anyUnknown = central.machines.some((m) => m.online && !(central.runtimes[m.machine.machineId] ?? m.runtimes)?.codex);
  // [external hubs] A gateway machine reports its own key's limits (the agent
  // asks the gateway). They stand in for the hub's quota when it has none, and
  // are never listed again under «прочие».
  const isGwMachine = (mid: string) =>
    codexOnGateway(central.runtimes[mid] ?? central.machines.find((m) => m.machine.machineId === mid)?.runtimes);
  // Only the ACCOUNT's windows (`gw-*`) are shared by every machine on the
  // pool; a key's own budget belongs to that key, and merging machines by
  // account would show one key's budget as everyone's.
  const gwMachineUsage = Object.fromEntries(
    Object.entries(central.codexUsage)
      .filter(([mid]) => isGwMachine(mid))
      .map(([mid, u]) => [mid, { ...u, limits: (u.limits ?? []).filter((l) => l.key.startsWith('gw-')) }] as const)
      .filter(([, u]) => u.limits.length > 0),
  );
  const gwUsage = quotaToUsage(gatewayQuota) ?? collect(gwMachineUsage)[0]?.usage ?? null;
  const showGateway = Boolean(gwUsage) && (central.viewer?.platformAdmin || gatewayMachines.length > 0 || anyUnknown);

  // The MAIN subscriptions first, the rest folded (25.09.2026, by request).
  // «Main» Claude = the account the most machines are signed into — the
  // team's subscription, not a one-off login on a laptop. Codex = the shared
  // gateway when it is shown; the per-machine Codex logins (a MacBook, a
  // test box) are the «прочие» — real numbers, but not the ones anyone
  // decides by, and they were pushing the two that matter out of the pill.
  const claudeUsage = withoutClaudeOff(central.usage, (mid) =>
    central.runtimes[mid] ?? central.machines.find((x) => x.machine.machineId === mid)?.runtimes,
  );
  const claudeAccounts = collect(claudeUsage).sort(
    (a, b) => b.machines.length - a.machines.length || maxUsed(limitsOf(b.usage)) - maxUsed(limitsOf(a.usage)),
  );
  const codexAccounts = collect(Object.fromEntries(Object.entries(central.codexUsage).filter(([mid]) => !isGwMachine(mid))));
  const gateway = showGateway && gwUsage ? { usage: gwUsage, machines: gatewayMachines } : null;
  // [admin] Every gateway account in the popover, not only the caller's own:
  // pool-a, the bureau's pool-c, and OpenCode Go in a section of its own. The
  // caller's pool (`ownPool`, named by the hub) carries the gateway machines.
  const poolAccounts = (gatewayQuota?.pools ?? []).flatMap((p) => {
    const u = quotaToUsage(p.quota);
    if (!u) return [];
    const own = !isGoPool(p.pool) && p.pool === gatewayQuota?.ownPool;
    return [{ pool: p.pool, usage: { ...u, account: isGoPool(p.pool) ? 'подписка Go' : poolName(p.pool) }, machines: own ? gatewayMachines : [] }];
  });
  const codexPools = poolAccounts.filter((p) => !isGoPool(p.pool));
  const goPools = poolAccounts.filter((p) => isGoPool(p.pool));
  const providers: { id: string; label: string; sub?: string; pill?: UsageInfo; accounts: { usage: UsageInfo; machines: string[] }[] }[] = [
    // «Мой лимит» leads for a community seat: it is the one figure that is
    // theirs, and the one the welcome card points at.
    ...(budgetUsage ? [{ id: 'budget', label: 'Мой лимит', accounts: [{ usage: budgetUsage, machines: [] }] }] : []),
    { id: 'claude', label: 'Claude', accounts: claudeAccounts.slice(0, 1) },
    gateway
      ? { id: 'gateway', label: 'Codex', sub: 'шлюз', pill: gateway.usage, accounts: codexPools.length ? codexPools : [gateway] }
      : codexPools.length
        ? // The caller's own counter is down, the other pools are not: list
          // them, but keep their numbers off the pill (not the caller's).
          { id: 'gateway-pools', label: 'Codex', sub: 'шлюз', accounts: codexPools }
        : { id: 'codex', label: 'Codex', accounts: codexAccounts.slice(0, 1) },
    // Popover only: the pill stays Claude + Codex.
    ...(goPools.length ? [{ id: 'opencode', label: 'OpenCode', accounts: goPools }] : []),
  ].filter((provider) => provider.accounts.length > 0);
  // Everything that is not a main subscription, for the folded block.
  const others = [
    ...claudeAccounts.slice(1).map((a) => ({ runtime: 'Claude', a })),
    ...(gateway || codexPools.length ? codexAccounts : codexAccounts.slice(1)).map((a) => ({ runtime: 'Codex', a })),
  ];
  if (!providers.length && !others.length) return null;

  // What the pill shows: the main subscriptions — Claude and Codex — on every
  // width. The phone used to keep ONE (whichever was nearest its ceiling), and
  // in practice that was always Codex, so Claude vanished from the phone
  // entirely. A community seat's «Мой лимит» is still the one figure on a
  // phone: it is the only number that is actually theirs.
  const withLimits = providers.filter((p) => p.accounts.length > 0);
  const budget = withLimits.find((p) => p.id === 'budget');
  const pill = compact && budget ? [budget] : withLimits.filter((p) => p.id !== 'opencode' && p.id !== 'gateway-pools' && (p.id !== 'budget' || !compact));

  return (
    <div className={`usage${compact ? ' compact' : ''}${open ? ' open' : ''}`} ref={ref}>
      <button className="usage-pill" onClick={() => setOpen((o) => !o)} title="Лимиты Claude и Codex">
        {/* Only popover sections left (own pool down, no Claude): still a
            label to click, not an empty button. */}
        {pill.length === 0 ? <span className="usage-provider-name">Лимиты</span> : null}
        {pill.map((provider, index) => {
          const head = limitsOf(provider.pill ?? provider.accounts[0]!.usage);
          return <span className="usage-provider" key={provider.id}>
            {index > 0 ? <span className="usage-sep" /> : null}
            {/* On a phone the two names do not fit beside the back arrows —
                the agent's mark says which is which in a fifth of the width. */}
            {/* The agent's own mark beside its name (20.10.2026, by request);
                on a phone the mark alone — the names do not fit beside the
                back arrows. */}
            {provider.id === 'claude' || provider.id === 'codex' || provider.id === 'gateway' ? (
              <AgentMark source={provider.id === 'claude' ? 'claude' : 'codex'} size={13} label={provider.label} className="usage-mark" />
            ) : null}
            {compact && provider.id !== 'budget' ? null : <span className="usage-provider-name">{provider.label}</span>}
            <CompactMeterlets limits={head} />
          </span>;
        })}
      </button>
      {open && (
        <div className="usage-pop">
          <div className="usage-pop-head">Лимиты</div>
          {providers.map((provider) => <section className="usage-section" key={provider.id}>
            <div className="usage-section-title">
              {provider.label}
              {provider.sub ? <span className="uacct-machines"> · {provider.sub}</span> : null}
            </div>
            {provider.accounts.map((a, i) => {
              const ls = limitsOf(a.usage);
              return (
                <div key={i} className="uacct">
                  {/* Who, where and on what plan — one line. The machines used
                      to be a line of their own UNDER the limits, which put the
                      answer to "whose numbers are these" below the numbers. */}
                  {provider.accounts.length > 1 || a.usage.account || a.usage.subscription ? (
                    <div className="uacct-head">
                      <span className="uacct-name">{a.usage.account ?? a.machines.join(', ')}</span>
                      {a.usage.account && a.machines.length > 0 ? (
                        <span className="uacct-machines">{a.machines.join(' · ')}</span>
                      ) : null}
                      {a.usage.subscription ? <span className="uacct-sub">{a.usage.subscription}</span> : null}
                    </div>
                  ) : null}
                  {ls.map((l) => (
                    <LimitRow key={l.key} l={l} />
                  ))}
                </div>
              );
            })}
          </section>)}
          {others.length > 0 && (
            <details className="usage-section usage-others">
              <summary className="usage-section-title">Прочие аккаунты · {others.length}</summary>
              {others.map(({ runtime, a }, i) => (
                <div key={i} className="uacct">
                  <div className="uacct-head">
                    <span className="uacct-name">
                      {runtime} · {a.usage.account ?? a.machines.join(', ')}
                    </span>
                    {a.usage.account && a.machines.length > 0 ? (
                      <span className="uacct-machines">{a.machines.join(' · ')}</span>
                    ) : null}
                    {a.usage.subscription ? <span className="uacct-sub">{a.usage.subscription}</span> : null}
                  </div>
                  {limitsOf(a.usage).map((l) => (
                    <LimitRow key={l.key} l={l} />
                  ))}
                </div>
              ))}
            </details>
          )}
        </div>
      )}
    </div>
  );
}
