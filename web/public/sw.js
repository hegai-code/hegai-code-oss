/*
 * Service worker for Hegai Code.
 *
 * It exists for ONE thing: a cold start with no network, or a bad one, should
 * put the app on screen instead of the browser's dinosaur. Everything else it
 * could do — background sync, push, offline mutations — it deliberately does
 * not: this is a control plane for LIVE sessions, and work that cannot reach
 * the hub has not happened.
 *
 * That one job is worth having only while its failure mode stays cheap, and on
 * 21.09.2026 it was not cheap. A phone that woke up without a network was
 * pinned to a three-hour-old build — in a standalone window with no address
 * bar, no pull-to-refresh and no way out, because deleting the home-screen icon
 * does not touch this registration or these caches. Three deploys were reported
 * as «не доехало» before anyone suspected the worker; the note in index.html
 * was still swearing there wasn't one. Read all four rules before changing
 * anything here.
 *
 * 1. A CACHED DOCUMENT IS A LOAN, NOT AN ANSWER. Navigations are network-first
 *    against a clock; when the clock wins, the cached shell goes out AND the
 *    request keeps running. If what eventually arrives names a different entry
 *    chunk, every client is told (`cc-shell-stale`) and buildWatch.ts reloads a
 *    page nobody has typed in. The first version of this worker served the
 *    cache and said nothing, which is the whole incident above.
 *
 * 2. NEVER STORE SOMETHING THAT IS NOT WHAT THE URL PROMISED. Until the hub
 *    learned to 404 (`asset_missing` in server-rs/src/main.rs), a chunk
 *    requested across a deploy came back as index.html with a 200, and this
 *    worker filed 6 KB of markup under a .js URL forever — behind a year of
 *    `immutable`. Both halves are fixed now; `typeMatches` is the half that
 *    does not depend on a server being right, and `looksLikeShell` is the same
 *    guard for the document, because an SSO login page is also HTML with a 200.
 *
 * 3. HASHED ASSETS ARE CACHE-FIRST AND THE CACHE IS NOT VERSIONED. `/assets/*`
 *    carries a content hash, so an entry can never be stale and a deploy has no
 *    reason to throw it away. That is also exactly what makes `skipWaiting()`
 *    safe: a tab running the old build keeps finding its own chunks after a new
 *    worker takes over, because the new worker reads the same cache under the
 *    same rules. Rename this cache and every open tab breaks on every deploy.
 *    The shell cache is unversioned for the mirror reason: a per-build shell
 *    cache would be EMPTY on the first start of a new worker, which is a
 *    dinosaur for exactly the offline user this file is for.
 *
 * 4. THE HUB IS NEVER CACHED. `/api/*`, `/agent`, `/ui`, `/install/*` are live
 *    state or real endpoints. They pass through untouched.
 *
 * Kill switch: replace this file with a worker that unregisters itself and
 * deletes every cache (see the note in web/index.html). `/sw.js` is served
 * `no-cache`, so that retires the whole thing within one navigation. Having
 * that exit is the reason a worker is allowed in front of a live control plane
 * at all.
 */

/** The entry chunk this worker shipped with, e.g. `/assets/index-abc123.js`.
 *  Substituted at build time by `stampServiceWorker` in web/vite.config.ts —
 *  the literal below is what the source carries and what the plugin looks for,
 *  and the build FAILS if it is missing. It is the same string buildWatch.ts
 *  compares, so the page and the worker cannot disagree about what a version
 *  is. It also means the worker's BYTES change on every deploy, which is what
 *  schedules the repair in `activate` — and it lets an operator ask production
 *  which build is live with `curl -s .../sw.js | head`. */
const BUILD = '__CC_BUILD__';

const SHELL = 'cc-shell-v1';
const ASSETS = 'cc-assets-v1';
const KEEP = new Set([SHELL, ASSETS]);
/** Every session deep link returns the same SPA document; caching them per-URL
 *  would fill the disk with identical copies. */
const SHELL_KEY = '/w/';
const ENTRY = /\/assets\/index-[A-Za-z0-9_-]+\.js/;

/** How long a navigation may hang before the cached shell goes out instead.
 *  The failure this covers is not a refused connection — that rejects at once —
 *  it is a phone with a radio and no route, where fetch simply never settles. */
const NET_TIMEOUT_MS = 3500;

/** Entries kept in the asset cache. Nothing ever evicted them before, so it
 *  grew by a whole build on every deploy. One build is ~40 files; this is
 *  several builds' worth of headroom. */
const ASSET_CAP = 300;

/** What each extension must actually be. Deliberately coarse: the point is to
 *  catch HTML under a .js URL, not to police charsets. */
const TYPE_BY_EXT = {
  js: 'javascript',
  mjs: 'javascript',
  css: 'css',
  woff2: 'font',
  woff: 'font',
  svg: 'svg',
  png: 'png',
  webp: 'webp',
  jpg: 'jpeg',
  jpeg: 'jpeg',
  json: 'json',
  map: 'json',
  ico: 'icon',
};

/** Rule 2, for assets. An unknown extension or a missing content-type is a NO:
 *  this cache is forever, and something that cannot be checked does not go in. */
function typeMatches(url, res) {
  const ext = (/\.([a-z0-9]+)$/i.exec(url.pathname)?.[1] ?? '').toLowerCase();
  const want = TYPE_BY_EXT[ext];
  const got = (res.headers.get('content-type') ?? '').toLowerCase();
  return Boolean(want) && got.includes(want);
}

/** Rule 2, for the document. A 200 is not enough: an SSO login page, an nginx
 *  error page and a captive portal are all HTML with a 200, and any of them
 *  cached here would be served as the app on every offline start. The one
 *  thing only OUR shell has is the entry script tag. */
async function looksLikeShell(res) {
  if (!res || !res.ok || res.redirected || res.type !== 'basic') return false;
  if (!(res.headers.get('content-type') ?? '').toLowerCase().includes('text/html')) return false;
  try {
    return ENTRY.test(await res.clone().text());
  } catch {
    return false;
  }
}

async function entryOf(res) {
  try {
    return ENTRY.exec(await res.text())?.[0] ?? null;
  } catch {
    return null;
  }
}

async function notify(msg) {
  const cs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const c of cs) c.postMessage(msg);
}

/** Set when this worker has handed out a shell it later learned was behind the
 *  server. Kept because the notice sent during a navigation can have no client
 *  to reach yet — the page says `cc-hello` a moment later and is told then. */
let staleShell = false;

self.addEventListener('install', (e) => {
  e.waitUntil(
    (async () => {
      // Fetch the shell once up front so the very first offline start works even
      // if the user never navigated while online after installing.
      try {
        const res = await fetch(SHELL_KEY, { credentials: 'same-origin', cache: 'reload' });
        if (await looksLikeShell(res)) {
          await (await caches.open(SHELL)).put(SHELL_KEY, res);
        }
      } catch {
        // Offline at install time: the previous shell is still in the cache and
        // still valid — the cache is unversioned precisely so that is true.
      }
      // skipWaiting, which this worker used to refuse. The refusal was about ONE
      // risk: that a new worker would hand a mid-session tab a different set of
      // caches. It cannot — the names and the rules above are fixed — so the
      // cost is zero, and the benefit is that a FIX reaches a stuck client on
      // its next navigation instead of its next cold start. On iOS standalone
      // those are hours apart, which is the whole incident.
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => !KEEP.has(k)).map((k) => caches.delete(k)));
      await repairAssets();
      await self.clients.claim();
      // Anyone on screen is running whatever the previous worker handed them.
      // Say a new worker is live; the page checks against `/w/` before believing
      // anything (buildWatch.ts) — a worker that reloads pages on its own
      // authority is the same bug from the other side.
      await notify({ type: 'cc-sw-activated', build: BUILD });
    })(),
  );
});

/**
 * Evict what should never have been stored, then bound what is left.
 *
 * Runs on every activate, which is once per deploy because the stamp above
 * changes the worker's bytes. Idempotent and metadata-only — `match` does not
 * read the body — so a clean cache costs milliseconds. This is also the ONE
 * repair available to clients already poisoned by the 200-index.html era: they
 * cannot be reached any other way, and renaming the cache instead would take
 * every honest chunk of every open tab with it.
 */
async function repairAssets() {
  let cache;
  try {
    cache = await caches.open(ASSETS);
  } catch {
    return;
  }
  for (const req of await cache.keys()) {
    const hit = await cache.match(req);
    if (!hit || !typeMatches(new URL(req.url), hit)) await cache.delete(req);
  }
  // keys() is insertion order, so the front is the oldest. Nothing here is ever
  // stale — a changed file is a different URL — this is only about the disk.
  const left = await cache.keys();
  if (left.length > ASSET_CAP) {
    await Promise.all(left.slice(0, left.length - ASSET_CAP).map((r) => cache.delete(r)));
  }
}

self.addEventListener('message', (e) => {
  // Pages of older builds still post this bare string (buildWatch.ts).
  if (e.data === 'cc-skip-waiting') {
    void self.skipWaiting();
    return;
  }
  if (e.data && e.data.type === 'cc-hello') {
    // The page is listening now. Tell it which build this worker shipped with —
    // if that disagrees with the document's own entry script, one of the two is
    // behind, and the page is the one that can ask the server which.
    e.source?.postMessage({ type: 'cc-sw-here', build: BUILD, staleShell });
  }
});

const isAsset = (url) => url.origin === self.location.origin && url.pathname.startsWith('/assets/');
const isHub = (url) =>
  url.pathname.startsWith('/api/') ||
  url.pathname.startsWith('/install/') ||
  url.pathname === '/agent' ||
  url.pathname === '/ui';

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || isHub(url)) return;

  // Both handlers keep working after the response has been returned (the late
  // revalidation, the cache write). `waitUntil` must be called SYNCHRONOUSLY
  // here — calling it after an await throws once the event has settled — so the
  // lifetime is opened now and closed by the handler's `done`.
  let done;
  e.waitUntil(new Promise((r) => (done = r)));

  // Legal pages are plain HTML, not the app: the cached app shell must never answer for them.
  if (req.mode === 'navigate' && !/^\/(privacy|delete-account)(\/|$)/.test(url.pathname)) {
    e.respondWith(navigate(req, done));
    return;
  }
  if (isAsset(url)) {
    e.respondWith(asset(req, url, done));
    return;
  }
  done();
});

async function navigate(req, done) {
  const net = fetch(req).then(async (res) => {
    if (await looksLikeShell(res)) {
      try {
        await (await caches.open(SHELL)).put(SHELL_KEY, res.clone());
      } catch {
        /* quota, or a body already disturbed — the response still goes out */
      }
    }
    return res;
  });

  let cached;
  try {
    cached = await (await caches.open(SHELL)).match(SHELL_KEY);
  } catch {
    cached = undefined;
  }
  if (!cached) {
    // Nothing to fall back to: the network is the only answer there is.
    try {
      return await net;
    } catch {
      return Response.error();
    } finally {
      done();
    }
  }

  // Read the cached document's entry NOW: once it is returned, the page owns
  // the body and it can no longer be inspected.
  const mine = await entryOf(cached.clone());

  let timer;
  const TIMEOUT = Symbol('timeout');
  const clock = new Promise((r) => (timer = setTimeout(() => r(TIMEOUT), NET_TIMEOUT_MS)));
  let raced;
  try {
    raced = await Promise.race([net, clock]);
  } catch {
    raced = TIMEOUT; // refused outright: offline
  }
  clearTimeout(timer);

  if (raced !== TIMEOUT) {
    done();
    return raced;
  }

  // Serving yesterday's document. Rule 1: this is a loan. The request is still
  // running; when it lands, decide whether the loan has to be called in.
  void (async () => {
    try {
      let fresh;
      try {
        fresh = await net;
      } catch {
        return; // never answered: no claim to make
      }
      if (!(await looksLikeShell(fresh))) return;
      const served = await entryOf(fresh);
      if (served && mine && served !== mine) {
        staleShell = true;
        await notify({ type: 'cc-shell-stale', build: BUILD });
      }
    } finally {
      done();
    }
  })();
  return cached;
}

async function asset(req, url, done) {
  try {
    const cache = await caches.open(ASSETS);
    const hit = await cache.match(req);
    if (hit) return hit;
    const res = await fetch(req);
    if (res.ok && !res.redirected && typeMatches(url, res)) {
      try {
        await cache.put(req, res.clone());
      } catch {
        /* quota */
      }
    } else if (res.status === 404) {
      // The build this page came from is gone from the server: a deploy landed
      // between the document and one of its chunks. The page cannot render that
      // screen — tell it, so it reloads onto a build that exists rather than
      // showing a blank panel.
      await notify({ type: 'cc-asset-gone', path: url.pathname, build: BUILD });
    }
    return res;
  } catch {
    return Response.error();
  } finally {
    done();
  }
}
