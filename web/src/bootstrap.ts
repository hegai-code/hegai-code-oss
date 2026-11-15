/**
 * What both entrypoints do after first paint — the full client (`main.tsx`) and
 * the light shell (`lite/main.tsx`). Two copies of this had already begun to
 * differ in formatting; a difference in behaviour would be a reload loop in one
 * of them and nobody noticing in the other.
 */
import { loadMarkdown } from './render/markdown-lib.js';

/**
 * Warm the markdown chunk once the first paint is done and the main thread is
 * idle. It is off the critical path either way; this keeps it from also being
 * late when the first transcript opens.
 */
export function warmMarkdownWhenIdle(): void {
  const warm = () => void loadMarkdown();
  if ('requestIdleCallback' in window) {
    (window as unknown as { requestIdleCallback: (cb: () => void, o?: { timeout: number }) => void })
      .requestIdleCallback(warm, { timeout: 4000 });
  } else {
    setTimeout(warm, 1500);
  }
}

/**
 * A chunk that no longer exists on the server.
 *
 * Screens are lazy, so a deploy landing between this document and the first
 * time somebody opens Files takes that import down with it. The hub answers
 * 404 for a vanished `/assets/*` on purpose (`asset_missing` there): a rejected
 * import is recoverable, and the 200-index.html it used to return was not —
 * that HTML got cached under a .js URL for a year. Recovery is a reload: the
 * document that arrives names chunks that do exist. Once, guarded by
 * sessionStorage, because a genuinely broken server must produce one blank
 * screen rather than a reload loop.
 */
const CHUNK_RELOAD = 'cc-chunk-reload';

function recoverFromMissingChunk(): void {
  let last = 0;
  try {
    last = Number(sessionStorage.getItem(CHUNK_RELOAD) ?? '0');
  } catch {
    /* private mode: no guard, but one reload still beats none */
  }
  if (Date.now() - last < 60_000) return;
  try {
    sessionStorage.setItem(CHUNK_RELOAD, String(Date.now()));
  } catch {
    /* ignore */
  }
  location.reload();
}

/** Reload once when a lazy import points at a chunk a deploy has removed. */
export function installChunkRecovery(): void {
  window.addEventListener('vite:preloadError', ((e: Event) => {
    e.preventDefault(); // otherwise Vite rethrows and the reload never happens
    recoverFromMissingChunk();
  }) as EventListener);
  window.addEventListener('unhandledrejection', (e) => {
    const m = String((e.reason as { message?: string } | undefined)?.message ?? e.reason ?? '');
    if (/dynamically imported module|Importing a module script failed/i.test(m)) {
      recoverFromMissingChunk();
    }
  });
}
