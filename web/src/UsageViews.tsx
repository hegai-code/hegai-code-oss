import { useEffect, useState } from 'react';
import type { UsageMember, UsageReport, UsageSubscription } from '@cc-remote/shared';
import { teamApi } from './teamApi.js';
import { budgetWindowLabel } from './appHooks.js';
import { displayName, pluralRu, relTimeRu } from './lib.js';
import { fmtSpan } from './components/usagePace.js';
import {
  barTone,
  fillDays,
  fmtTokens,
  modelShare,
  PROVIDER_LABEL,
  periodRange,
  sortMembers,
  windowIsOver,
  type UsagePeriod,
} from './usageModel.js';

/**
 * «Расходы»: per person, what the gateway seat spent and where the person's
 * own Claude / Codex subscription stands. The two are shown side by side and
 * never added up. `UsageList` is presentational (the screens fixture mounts it
 * on stub data); `useUsage` is the fetch.
 */

export function PeriodSwitch({ value, onChange }: { value: UsagePeriod; onChange: (p: UsagePeriod) => void }) {
  return <div className="usage-period" role="group" aria-label="Период">
    {([7, 30] as const).map((d) => (
      <button key={d} className={`tab ${d === value ? 'active' : ''}`} aria-pressed={d === value} onClick={() => onChange(d)}>{d} дней</button>
    ))}
  </div>;
}

/** Load a report for a period; `load` differs between the team tab and the personal card. */
export function useUsage(load: (from: string, to: string) => Promise<UsageReport>, period: UsagePeriod, key: string) {
  const [report, setReport] = useState<UsageReport | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    // Never show the previous workspace's or period's numbers under the new header.
    setReport(null);
    setError('');
    const { from, to } = periodRange(period);
    load(from, to).then((r) => { if (live) setReport(r); }).catch((e: Error) => { if (live) setError(e.message || 'не удалось загрузить'); });
    return () => { live = false; };
    // `load` is a closure over `key`; the key is what actually changes.
  }, [period, key]);
  return { report, error };
}

function Spark({ values }: { values: number[] }) {
  const max = Math.max(1, ...values);
  const n = Math.max(1, values.length - 1);
  const pts = values.map((v, i) => `${((i / n) * 118 + 1).toFixed(1)},${(27 - (v / max) * 24).toFixed(1)}`).join(' ');
  return <svg className="usage-spark" viewBox="0 0 120 28" preserveAspectRatio="none" role="img" aria-label="Токены по дням">
    <polyline points={pts} fill="none" stroke="currentColor" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
  </svg>;
}

function Bar({ percent, label, hint }: { percent: number; label: string; hint?: string }) {
  const p = Math.max(0, Math.min(100, percent));
  return <div className={`usage-bar ${barTone(percent)} ${label ? '' : 'bare'}`} title={hint}>
    {label && <span className="usage-bar-label">{label}</span>}
    <span className="usage-bar-track"><i style={{ width: `${p}%` }} /></span>
    <b>{Math.round(percent)}%</b>
  </div>;
}

function resetText(resetsAt: number | undefined, over: boolean, now: number): string {
  if (resetsAt === undefined) return '';
  return over ? 'окно сброшено' : `сброс через ${fmtSpan(resetsAt - now)}`;
}

function Subscription({ sub, now }: { sub: UsageSubscription; now: number }) {
  return <div className="usage-sub">
    <small>{PROVIDER_LABEL[sub.provider]}{sub.account ? ` · ${sub.account}` : ''}</small>
    {sub.windows.slice(0, 3).map((w) => {
      const over = windowIsOver(w, now);
      return <Bar key={w.key} percent={over ? 0 : w.percent} label={w.label}
        hint={[resetText(w.resetsAt, over, now), `пик за период ${Math.round(w.peakPercent)}%`, w.hitDays > 0 ? `у лимита ${w.hitDays} ${pluralRu(w.hitDays, ['день', 'дня', 'дней'])}` : '', `данные ${relTimeRu(w.sampledAt, now)}`].filter(Boolean).join(' · ')} />;
    })}
    {(() => {
      const next = sub.windows.find((w) => w.resetsAt !== undefined);
      const r = next ? resetText(next.resetsAt, windowIsOver(next, now), now) : '';
      return next && r ? <small className="usage-reset">{next.label}: {r}</small> : null;
    })()}
  </div>;
}

function GatewayLimit({ m, now }: { m: UsageMember; now: number }) {
  const l = m.limit;
  if (!l) return <div className="usage-cell"><small>Лимит шлюза</small><span className="usage-none">нет ключа</span></div>;
  const parts: string[] = [];
  if (l.tokens !== undefined) parts.push(`${fmtTokens(l.tokensUsed ?? 0)} из ${fmtTokens(l.tokens)} токенов${l.tokensWindow ? ` за ${budgetWindowLabel(l.tokensWindow)}` : ''}`);
  if (l.requests !== undefined) parts.push(`${l.requestsUsed ?? 0} из ${l.requests} запросов${l.requestsWindow ? ` за ${budgetWindowLabel(l.requestsWindow)}` : ''}`);
  return <div className="usage-cell">
    <small>Лимит шлюза{!l.active && ' · ключ отключён'}</small>
    {l.percent !== undefined ? <Bar percent={l.percent} label="" hint={parts.join('\n')} /> : <span className="usage-none">без лимита</span>}
    {[
      l.resetAt !== undefined && l.resetAt > now ? `токены через ${fmtSpan(l.resetAt - now)}` : '',
      l.requestsResetAt !== undefined && l.requestsResetAt > now ? `запросы через ${fmtSpan(l.requestsResetAt - now)}` : '',
    ].filter(Boolean).map((t) => <small key={t} className="usage-reset">сброс: {t}</small>)}
  </div>;
}

export function UsageRow({ m, from, to, now }: { m: UsageMember; from: string; to: string; now: number }) {
  const g = m.gateway;
  const empty = g.requests === 0 && m.subscriptions.length === 0;
  return <article className={`usage-row ${empty ? 'quiet' : ''}`}>
    <header>
      <b>{displayName(m)}</b>
      {m.role && <span className="role-chip">{m.role === 'owner' ? 'владелец' : m.role === 'manager' ? 'менеджер' : 'участник'}</span>}
      {m.hitsLimit && <span className="role-chip attn" title="Окно подписки доходило до 90% в несколько дней периода">часто упирается в лимит</span>}
    </header>
    <div className="usage-grid">
      <div className="usage-cell">
        <small>Токены шлюза</small>
        <b className="usage-num">{fmtTokens(g.totalTokens)}</b>
        <Spark values={fillDays(g.days, from, to)} />
        {g.cachedTokens > 0 && <small>из них в кэше {fmtTokens(g.cachedTokens)}</small>}
      </div>
      <div className="usage-cell">
        <small>Запросы</small>
        <b className="usage-num">{g.requests}</b>
        <small className={g.errors > 0 ? 'usage-err' : ''}>{g.errors > 0 ? `ошибок ${g.errors}` : 'без ошибок'}</small>
      </div>
      <div className="usage-cell usage-models">
        <small>Модели</small>
        {g.models.length === 0 ? <span className="usage-none">нет запросов</span>
          : g.models.slice(0, 3).map((x) => <span key={x.model} title={`${x.requests} запросов`}><code>{x.model}</code> {modelShare(x.tokens, g.totalTokens)}%</span>)}
      </div>
      <GatewayLimit m={m} now={now} />
      <div className="usage-cell usage-subs">
        <small>Своя подписка</small>
        {m.subscriptions.length === 0 ? <span className="usage-none">нет данных</span>
          : m.subscriptions.map((s) => <Subscription key={`${s.provider}:${s.account ?? ''}`} sub={s} now={now} />)}
      </div>
    </div>
  </article>;
}

export function UsageList({ report, now = Date.now() }: { report: UsageReport; now?: number }) {
  const members = sortMembers(report.members);
  if (!report.configured) return <div className="team-empty">Шлюз моделей не подключён — расходов нет.</div>;
  return <>
    {report.limitsUnavailable && <div className="team-note">Лимиты ключей сейчас недоступны: шлюз не ответил.</div>}
    <section className="usage-list">
      {members.length === 0 && <div className="team-empty">Некого показывать.</div>}
      {members.map((m) => <UsageRow key={m.userId} m={m} from={report.from} to={report.to} now={now} />)}
    </section>
    <p className="team-help usage-foot">
      Токены — по журналу шлюза, дни по UTC{report.collectedAt ? `, обновлено ${relTimeRu(report.collectedAt, now)}` : ', журнал ещё собирается'}.
      Лимиты подписок Claude и Codex — то, что показывают агенты самих людей; они не складываются.
      {report.scope === 'assigned' && ' Вам видны назначенные вам участники.'}
    </p>
  </>;
}

/** The card itself, on data it is given. */
export function MyUsageView({ report, error, period, onPeriod }: { report: UsageReport | null; error: string; period: UsagePeriod; onPeriod: (p: UsagePeriod) => void }) {
  const me = report?.members[0];
  return <section className="team-card settings-section usage-card">
    <h3>Мои расходы</h3>
    <PeriodSwitch value={period} onChange={onPeriod} />
    {error && <div className="team-note">{error}</div>}
    {!report && !error && <div className="team-empty">Загружаю…</div>}
    {report && me && <UsageRow m={me} from={report.from} to={report.to} now={Date.now()} />}
    <p className="team-help">Токены и запросы — по вашему ключу шлюза; лимиты подписок — ваши собственные Claude и Codex.</p>
  </section>;
}

/** «Мои расходы» in Настройки → Аккаунт. Rendered only where the hub has a gateway. */
export function MyUsageCard() {
  const [period, setPeriod] = useState<UsagePeriod>(7);
  const { report, error } = useUsage(teamApi.myUsage, period, 'me');
  return <MyUsageView report={report} error={error} period={period} onPeriod={setPeriod} />;
}
