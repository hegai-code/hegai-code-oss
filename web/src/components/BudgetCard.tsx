import { budgetResetMs, useSeat } from '../appHooks.js';
import { linkProps, navigate } from '../router.js';

/**
 * The gateway said no for quota — what the transcript shows instead of a red
 * mono line.
 *
 * Two voices, one card. A community seat has a share of the pool, and the
 * honest thing to say is what the share is and when it comes back; the card
 * then leads to the meter and to «Забрать своё», because the exit stays
 * visible even here. An employee's Claude hits the same classifier on an
 * Anthropic rate limit (`agent/src/model-error.ts` errs towards the code), and
 * for them there is no "share" — the card reads neutrally and offers nothing
 * it cannot keep.
 *
 * Tone: the attention plate (`--attn` with `--on-attn` ink), never the red
 * fill, and no modal — nothing here is the person's fault, and nothing needs
 * dismissing. The session is kept; that is the whole message.
 */

/** The first words of `BUDGET_EXHAUSTED_TEXT` in agent/src/model-error.ts.
 *  The stream event carries `code: 'budget_exhausted'` too, but the browser's
 *  transcript fold (`central-reducers.ts:foldStreamEvent`) keeps only kind and
 *  text today, so the text is the mark that survives to the render. */
export const BUDGET_TEXT_MARK = 'The model gateway refused for quota';

/** Whether an `error` line is the quota refusal the card is for. Reads `code`
 *  when a future fold carries it, the text otherwise. */
export function isBudgetLine(line: { kind: string; text: string; code?: string }): boolean {
  if (line.kind !== 'error') return false;
  if (line.code === 'budget_exhausted') return true;
  return line.text.trim().startsWith(BUDGET_TEXT_MARK);
}

/** "1,2 млн", "340 тыс.", "812". */
export function fmtCount(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1).replace(/\.0$/, '').replace('.', ',')} млн`;
  if (n >= 1e3) return `${Math.round(n / 1e3)} тыс.`;
  return String(Math.round(n));
}

/** "через 40 мин", "через 3 ч", "через 2 д"; '' once it is due. */
export function fmtUntil(ms: number | undefined, now = Date.now()): string {
  if (!ms) return '';
  const d = ms - now;
  if (d <= 0) return 'вот-вот';
  const mins = Math.ceil(d / 60_000);
  if (mins < 60) return `через ${mins} мин`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `через ${h} ч`;
  return `через ${Math.floor(h / 24)} д`;
}

export function BudgetCard() {
  const seat = useSeat();
  if (!seat.community) {
    return (
      <div className="budget-card" role="status">
        <div className="bc-title">Лимит модели исчерпан — подождите сброса или смените модель.</div>
      </div>
    );
  }
  const l = seat.budget?.limits;
  const used = l?.tokensUsed;
  const limit = l?.tokens;
  const until = fmtUntil(budgetResetMs(l));
  const figures =
    limit && limit > 0
      ? `${fmtCount(used ?? limit)} из ${fmtCount(limit)}${until ? `; сброс ${until}` : ''}`
      : until
        ? `сброс ${until}`
        : '';
  return (
    <div className="budget-card" role="status">
      <div className="bc-title">Твоя доля моделей на сегодня исчерпана.</div>
      <div className="bc-body">Сессия не потеряна — продолжишь после сброса.</div>
      {figures && <div className="bc-meta">{figures}</div>}
      <div className="bc-links">
        <a {...linkProps({ kind: 'settings', tab: 'overview' })}>Мой лимит</a>
        {/* Home opens «Забрать своё» for the `#take` hash — the card has no
            project of its own to name, so the shelf there picks the latest.
            A hash is not a route, so this is a hand-rolled SPA link. */}
        <a
          href="/w/#take"
          onClick={(e) => {
            if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
            e.preventDefault();
            navigate('/w/#take');
          }}
        >
          Забрать своё
        </a>
      </div>
    </div>
  );
}
