import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The light shell — the bundle the hub serves on `remote.acme.test`
 * (`WEB_LITE_DIST` + `CC_REMOTE_LITE_HOSTS`, server-rs `StaticSites`).
 *
 * A second Vite ROOT inside the same workspace, not a second package: it
 * imports `../src` directly, so there is one `package.json`, one React, one
 * tsconfig and one copy of the socket, reducers and cache. A root of its own
 * rather than a second page of the main build, because a document, a manifest
 * and `/sw.js` are per-origin files at fixed paths, and the main build's
 * worker stamp (`vite.config.ts`) assumes exactly one entry.
 *
 * `fs.allow` names `web/` because the root is `web/lite` and the entry imports
 * a sibling of it; the build is unaffected (Rollup reads what it is given).
 */
const hub = process.env['VITE_DEV_HUB'] ?? 'http://127.0.0.1:4319';

export default defineConfig({
  root: resolve(import.meta.dirname, 'lite'),
  plugins: [react()],
  server: {
    port: 5174,
    host: true,
    fs: { allow: [import.meta.dirname] },
    // REST always goes to the page origin (teamApi.ts) and so does the socket
    // (useCentral.ts), so in dev the page origin has to reach the hub.
    proxy: {
      '/api': hub,
      '/transcribe': hub,
      '/polish': hub,
      '/ui': { target: hub, ws: true },
    },
  },
  build: {
    outDir: resolve(import.meta.dirname, 'lite/dist'),
    emptyOutDir: true,
    chunkSizeWarningLimit: 1600,
  },
});
