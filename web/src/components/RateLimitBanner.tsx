import { useEffect, useState } from 'react';
import { X } from '../icons.js';
import { rateLimitCurrent, rateLimitDismissKey, rateLimitText, type RateLimitNotice } from '../rateLimit.js';
import { storageGet, storageSet } from '../storage.js';

const KEY = 'cc-rate-limit-shown';

/** Warnings already shown somewhere — in this tab, another pane, another tab. */
function readShown(): string[] {
  try {
    const v = JSON.parse(storageGet(KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [];
  } catch {
    return [];
  }
}

/** Per-page fallback when storage is unavailable (private window). */
const shownHere = new Set<string>();

/** Claim a warning for ONE banner: true the first time anyone asks for it. */
function claim(key: string): boolean {
  if (shownHere.has(key) || readShown().includes(key)) return false;
  shownHere.add(key);
  // A short list: each entry names one window's reset, so old ones are dead.
  // (Private window: the write is dropped and `shownHere` covers this page.)
  storageSet(KEY, JSON.stringify([key, ...readShown()].slice(0, 30)));
  return true;
}

/**
 * The plan-limit strip that sits on top of the composer, like VS Code's
 * «You've used 76% of your weekly limit · resets in 2d ×». See `rateLimit.ts`
 * for why it is a strip and not a transcript line.
 *
 * ONCE per warning (29.09.2026, «на хуя он появляется в сессиях повторно?
 * раза на старте достаточно»): the hub replays a run's events on every
 * subscribe, and every pane of the machine got the same notice — so each
 * session opened was the same «76%» again. Now the first banner to see a
 * warning claims it (localStorage, so other panes and tabs too) and the rest
 * stay quiet; it comes back only when the news gets worse — the next ten
 * percent, or the window spent (`rateLimitDismissKey`). «×» hides it here.
 */
export function RateLimitBanner({ machineId, notice }: { machineId: string; notice: RateLimitNotice | null }) {
  const [now, setNow] = useState(() => Date.now());
  const [mine, setMine] = useState<string | null>(null);
  const key = notice ? rateLimitDismissKey(machineId, notice) : null;
  // «через 5 ч» has to keep counting down in a tab left open overnight, and a
  // notice past its reset has to go by itself.
  useEffect(() => {
    if (!notice) return;
    // A pane lives for hours: count from NOW, not from when it mounted.
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, [notice]);
  useEffect(() => {
    if (key && notice && rateLimitCurrent(notice, Date.now()) && claim(key)) setMine(key);
  }, [key, notice]);

  if (!rateLimitCurrent(notice, now) || !key || mine !== key) return null;
  return (
    <div className={`rl-banner ${notice.status === 'rejected' ? 'spent' : ''}`} role="status">
      <span className="rl-banner-text">{rateLimitText(notice, now)}</span>
      <button type="button" className="rl-banner-x" aria-label="Скрыть предупреждение о лимите" onClick={() => setMine(null)}>
        <X size={14} />
      </button>
    </div>
  );
}
