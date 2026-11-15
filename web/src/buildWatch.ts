import { useEffect, useState } from 'react';

/**
 * Notices that the hub is serving a NEWER build than the one this page is
 * running, and gets the page onto it.
 *
 * Why this exists: a deploy changes the bundle's hash, but a tab that is
 * already open keeps executing the JavaScript it loaded — reconnecting the
 * socket does not reload code. In a browser that is a shrug (F5). In the
 * Windows app it is a trap with no exit: the shell is a WebView2 with no
 * address bar, no reload item and a close button that hides to the tray, so
 * the page can outlive several deploys. 19.09.2026 a fix shipped, was verified
 * live in the served bundle, and still did not exist for the person looking at
 * it — they were on the desktop app.
 *
 * The check is the cheapest honest one: re-fetch the SPA entry document and
 * compare the script it points at with the script this page came from. No new
 * endpoint, no version file to keep in sync, nothing to forget on deploy —
 * the artifact IS the version.
 */

const ENTRY_SCRIPT = /\/assets\/index-[A-Za-z0-9_-]+\.js/;

/** The bundle this page is actually running, e.g. `/assets/index-abc123.js`.
 *
 *  Read off the document's own entry `<script>`, NOT `import.meta.url`. The
 *  two agree only while everything lives in one chunk; the app now splits its
 *  screens, and if the bundler ever moved this module into a helper chunk,
 *  `import.meta.url` would name a file the served document never mentions — so
 *  the comparison below would report "new build" on every single poll and
 *  reload the app in a loop. The entry tag is the thing actually being
 *  compared, so read that. */
const MINE = (() => {
  try {
    const tag = document.querySelector<HTMLScriptElement>('script[type="module"][src*="/assets/index-"]');
    const fromDoc = tag && new URL(tag.src, location.href).pathname;
    if (fromDoc) return fromDoc;
    const fromModule = new URL(import.meta.url).pathname;
    return ENTRY_SCRIPT.test(fromModule) ? fromModule : '';
  } catch {
    return '';
  }
})();

/** What the server hands a fresh visitor right now. Null when unknown — an
 *  offline poll must never be read as "a new build appeared". */
async function servedBundle(): Promise<string | null> {
  try {
    const res = await fetch('/w/', { cache: 'no-store', credentials: 'same-origin' });
    if (!res.ok) return null;
    return ENTRY_SCRIPT.exec(await res.text())?.[0] ?? null;
  } catch {
    return null;
  }
}

/** True when nothing is half-written anywhere on screen. Reloading is only
 *  ever free if it costs no words: drafts live in component state and do not
 *  survive a navigation. Read off the DOM deliberately — the alternative is
 *  threading "is something typed" through every composer on every screen. */
function nothingTyped(): boolean {
  const fields = document.querySelectorAll<HTMLTextAreaElement | HTMLInputElement>(
    'textarea, input[type="text"]',
  );
  for (const f of fields) if (f.value.trim()) return false;
  return true;
}

/** Ten minutes: a deploy is not an emergency, and the poll costs a request. */
const EVERY_MS = 10 * 60 * 1000;

/** When this document started.
 *
 *  A page nobody has looked at for half a minute yet can be replaced under them
 *  for free: a reload that early is indistinguishable from a slow start. The
 *  old rule was `document.hidden` alone, and it was never true for the case
 *  this exists for — somebody staring at a standalone iOS window that has just
 *  come up on a shell out of the cache. The worker's stale notice arrives a few
 *  seconds after that navigation, which is squarely inside this window. */
const BORN = Date.now();
const FRESH_MS = 30_000;

/**
 * Reload onto the build the server is serving.
 *
 * The service worker deliberately does not `skipWaiting()` on its own — a tab
 * mid-session keeps the worker it started under. This is the one moment the
 * swap is wanted, so ask for it and give it a beat to take over before the
 * navigation; if anything about that goes wrong, reload anyway. A failed
 * handover must never be the reason someone is stuck on an old build.
 */
async function reloadOntoNewBuild(): Promise<void> {
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg?.waiting) {
      reg.waiting.postMessage('cc-skip-waiting');
      await new Promise((r) => setTimeout(r, 150));
    }
  } catch {
    // no worker, or it refused — the reload below is what matters
  }
  location.reload();
}

export function useBuildWatch(): { stale: boolean; reload: () => void } {
  const [stale, setStale] = useState(false);

  useEffect(() => {
    if (!MINE) return; // dev server / unknown layout — nothing to compare against
    let dead = false;

    const check = async () => {
      if (dead || stale) return;
      const served = await servedBundle();
      if (dead || !served || served === MINE) return;
      // Hidden means the desktop app is in the tray or the tab is in the
      // background: nobody is mid-sentence, so take the update silently and
      // let them come back to a current app rather than to a nag. Freshly
      // opened counts too — see BORN.
      if (nothingTyped() && (document.hidden || Date.now() - BORN < FRESH_MS)) {
        void reloadOntoNewBuild();
        return;
      }
      setStale(true);
    };

    const timer = setInterval(check, EVERY_MS);
    // A window that has been in the tray for hours is exactly the one most
    // likely to be stale, and this fires the moment it is looked at again.
    const onVisible = () => {
      if (!document.hidden) void check();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', onVisible);

    /**
     * The worker's side of the same question.
     *
     * `cc-shell-stale` means it served this document out of the cache and the
     * network later disagreed; `cc-asset-gone` means a chunk this build asks
     * for is no longer on the server; `cc-sw-here` carries the build the WORKER
     * shipped with, and that disagreeing with ours proves one of the two is
     * behind. None is believed on its own — each just triggers the same check
     * against `/w/`, which is the only authority. That is also what makes a
     * reload loop impossible: the server has to agree.
     */
    const onSw = (ev: MessageEvent) => {
      const d = ev.data as { type?: string; build?: string } | undefined;
      if (!d?.type) return;
      if (d.type === 'cc-sw-here' && d.build === MINE) return;
      void check();
    };
    navigator.serviceWorker?.addEventListener('message', onSw);
    // Say hello: a notice sent while this document was still committing had no
    // client to reach, and the worker holds that answer for exactly this.
    try {
      navigator.serviceWorker?.controller?.postMessage({ type: 'cc-hello' });
    } catch {
      /* no worker */
    }

    void check();
    return () => {
      dead = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onVisible);
      navigator.serviceWorker?.removeEventListener('message', onSw);
    };
  }, [stale]);

  return { stale, reload: () => void reloadOntoNewBuild() };
}
