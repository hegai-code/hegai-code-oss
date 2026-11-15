/*
 * The light shell (remote.acme.test) registers NO service worker.
 *
 * This file is the way out for one that got here anyway. The full client's
 * worker (web/public/sw.js) caches its own document and its own chunks; if this
 * host is ever answered with the full client's bundle — a misordered rollout,
 * a wrong `CC_REMOTE_LITE_HOSTS` — that worker registers on THIS origin and
 * goes on serving the full client here after the right bundle has arrived. A
 * registration is the one thing on an origin that outlives a deploy.
 *
 * The browser re-fetches `/sw.js` on every navigation it controls. Finding this
 * file instead of the old worker, it installs it, and it removes itself and
 * every cache the old one kept, then reloads the pages it held so they come
 * back from the network. On an origin that never had a worker this file is
 * never requested at all.
 *
 * (The hub also refuses to serve the full bundle to a light host — 503, see
 * `StaticSites` in server-rs/src/main.rs. This is the second wall.)
 */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) await caches.delete(key);
      await self.registration.unregister();
      // Awaited: `waitUntil` ends with this promise, and a worker that is
      // allowed to stop before the navigations were issued leaves the old
      // pages standing. A page that refuses to navigate must not fail the
      // rest (`allSettled`).
      const clients = await self.clients.matchAll({ type: 'window' });
      await Promise.allSettled(clients.map((c) => c.navigate(c.url)));
    })(),
  );
});
