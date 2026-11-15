import { useState } from 'react';
import type { PlanItem, PlanProgress } from '@cc-remote/shared';
import { CaretDown } from '../icons.js';
import { TodoList } from '../render/Blocks.js';

/** «3/7 · прогоняю тесты» — the counts and what is in progress. With no step in
 *  progress the first pending item stands in; a finished plan is only counts. */
export function planLabel(p: PlanProgress, items?: readonly PlanItem[]): string {
  const next = p.active ?? items?.find((i) => i.status === 'pending')?.content.trim();
  return next ? `${p.done}/${p.total} · ${next}` : `${p.done}/${p.total}`;
}

/** The thin progress bar: one place, drawn by the strip and the helper cards. */
export function PlanBar({ done, total }: { done: number; total: number }) {
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  return (
    <div className="plan-bar" role="progressbar" aria-label="Выполнено шагов плана" aria-valuemin={0} aria-valuenow={done} aria-valuemax={total}>
      <div className="plan-bar-fill" style={{ width: `${pct}%` }} />
    </div>
  );
}

/** A helper's own plan on its card: the same line and bar as the session's. */
export function PlanLine({ plan }: { plan: PlanProgress }) {
  if (plan.total <= 0) return null;
  return (
    <div className="plan-line-card">
      <div className="plan-text">{planLabel(plan)}</div>
      <PlanBar done={plan.done} total={plan.total} />
    </div>
  );
}

/**
 * Pinned over the composer while a session works: how far along it is. Tapping
 * the line opens the full checklist above it; collapsed by default.
 */
export function PlanStrip({ items, progress }: { items: PlanItem[]; progress: PlanProgress }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`plan-strip${open ? ' open' : ''}`}>
      {open && (
        <div className="plan-strip-list">
          <TodoList todos={items as unknown as Array<Record<string, unknown>>} />
        </div>
      )}
      <button type="button" className="plan-strip-line" onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-label={`План: ${planLabel(progress, items)}`}>
        <span className="plan-text">{planLabel(progress, items)}</span>
        <CaretDown size={14} className="plan-chev" aria-hidden />
      </button>
      <PlanBar done={progress.done} total={progress.total} />
    </div>
  );
}
