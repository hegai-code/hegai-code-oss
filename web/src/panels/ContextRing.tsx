import { useEffect, useRef, useState } from 'react';
import type { useCentral } from '../useCentral.js';

type ContextUsage = NonNullable<ReturnType<typeof useCentral>['contextUsage']>;

/** Percent at which the runtime compacts on its own. The SDK has sent this as
 *  a fraction (0.95) and, on 1M-context models, as a TOKEN count (967000) —
 *  multiplied by 100 that printed «автосжатие на 96700000%» (27.09.2026). */
export function tripPercent(usage: ContextUsage): number {
  const t = usage.autoCompactThreshold;
  if (!usage.autoCompactEnabled || !t || t <= 0) return 100;
  const pct = t <= 1 ? t * 100 : t <= 100 ? t : usage.maxTokens > 0 ? (t / usage.maxTokens) * 100 : 100;
  return Math.min(100, Math.round(pct));
}

/**
 * How full the context is, as a ring beside the model — and the one way to
 * compact it (27.09.2026, by request: «объём контекста иконкой рядом с
 * моделью, при нажатии спрашивать, хотите ли сжать»).
 *
 * It replaced a whole line under the composer («Контекст 39%» + «Сжать
 * контекст»), which cost a row on every session for a number that matters
 * once in a long while. The ring keeps the number one glance away (and in the
 * tooltip, with tokens and the auto-compact threshold); the question is there
 * because compacting rewrites what the agent remembers, so it must not be one
 * stray click away.
 */
export function ContextRing({
  usage,
  cost,
  compacting,
  onCompact,
}: {
  usage: ContextUsage;
  cost: number | null;
  compacting: boolean;
  onCompact: () => void;
}) {
  const [asking, setAsking] = useState(false);
  const wrap = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!asking) return;
    const onDown = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setAsking(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setAsking(false);
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [asking]);

  const pct = Math.min(100, Math.max(0, Math.round(usage.percentage)));
  // Warn relative to where the runtime compacts on its own, not to a magic
  // number: «80%» means different things on different runtimes.
  const trip = tripPercent(usage);
  const near = pct >= Math.max(50, trip - 15);
  const k = (n: number) => `${Math.round(n / 1000)}k`;
  const detail = `${k(usage.totalTokens)} из ${k(usage.maxTokens)} токенов${
    usage.autoCompactEnabled ? ` · автосжатие на ${trip}%` : ' · автосжатие выключено'
  }${cost !== null ? ` · сессия $${cost.toFixed(2)}` : ''}`;
  const R = 7;
  const C = 2 * Math.PI * R;
  return (
    <div className="ctx-ring-wrap" ref={wrap}>
      <button
        type="button"
        className={`ctx-ring ${near ? 'warn' : ''} ${compacting ? 'busy' : ''}`}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => !compacting && setAsking((v) => !v)}
        title={compacting ? 'Сжимаю контекст — выполнится после текущего хода' : `Контекст ${pct}% · ${detail}`}
        aria-label={`Контекст ${pct}%`}
        aria-expanded={asking}
      >
        <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden>
          <circle cx="9" cy="9" r={R} className="ctx-ring-track" />
          <circle
            cx="9"
            cy="9"
            r={R}
            className="ctx-ring-fill"
            strokeDasharray={`${(C * pct) / 100} ${C}`}
            transform="rotate(-90 9 9)"
          />
        </svg>
      </button>
      {asking && (
        <div className="ctx-ask" role="dialog" aria-label="Сжать контекст">
          <div className="ctx-ask-title">Сжать контекст?</div>
          <div className="ctx-ask-sub">
            Занято {pct}% — {detail}. Ранние ходы свернутся в пересказ; выполнится после текущего хода.
          </div>
          <div className="ctx-ask-acts">
            <button type="button" className="ctx-ask-no" onClick={() => setAsking(false)}>
              Отмена
            </button>
            <button
              type="button"
              className="ctx-ask-yes"
              onClick={() => {
                setAsking(false);
                onCompact();
              }}
            >
              Сжать
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
