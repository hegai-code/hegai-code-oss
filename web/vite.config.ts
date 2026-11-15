import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/** What `sw.js` carries in source until the plugin below replaces it. */
const STAMP = '__CC_BUILD__';

/**
 * Stamp the service worker with the build it shipped with.
 *
 * `web/public/sw.js` is copied verbatim — Vite never parses it — so the worker
 * had no way to know its own version, and there was no way to ask production
 * which worker was live short of diffing bytes. That mattered on 21.09.2026,
 * when a phone sat three hours behind and nobody could tell.
 *
 * The stamp is the ENTRY CHUNK'S NAME, not a timestamp: an identical rebuild
 * then produces an identical worker (no pointless reinstall on every deploy),
 * and it is the exact string `buildWatch.ts` compares — so page and worker
 * cannot disagree about what a version is. Changing the worker's bytes is also
 * what schedules its `activate` repair once per deploy.
 *
 * Runs in `closeBundle` because `public/` is copied in `prepareOutDir`, i.e.
 * BEFORE the bundle is written; by the last hook the file is certainly there.
 * It THROWS rather than skipping: an unstamped worker would look identical
 * forever and quietly stop reinstalling, which is the one failure this whole
 * arrangement exists to make impossible.
 */
function stampServiceWorker(): Plugin {
  let entry = '';
  let swPath = '';
  return {
    name: 'cc-stamp-sw',
    apply: 'build',
    configResolved(c) {
      swPath = resolve(c.root, c.build.outDir, 'sw.js');
    },
    generateBundle(_options, bundle) {
      for (const [file, out] of Object.entries(bundle)) {
        if (out.type === 'chunk' && out.isEntry) entry = file;
      }
    },
    closeBundle() {
      if (!entry) throw new Error('[cc-stamp-sw] the bundle has no entry chunk');
      const src = readFileSync(swPath, 'utf8');
      if (!src.includes(STAMP)) {
        throw new Error(`[cc-stamp-sw] ${swPath} does not contain ${STAMP}`);
      }
      writeFileSync(swPath, src.replace(STAMP, `/${entry}`));
    },
  };
}

export default defineConfig({
  plugins: [react(), stampServiceWorker()],
  server: { port: 5173, host: true },
  // No manual vendor chunks: forcing markdown/react into named chunks created a
  // circular chunk dependency (TDZ "Cannot access 'MO' before initialization")
  // that blanked the app.
  //
  // The rest of this comment used to claim that lazy Files/Git/Terminal panels
  // already split CodeMirror and xterm off the initial load. That has been false
  // since those panels were deleted and their dependencies removed — the app
  // ships as ONE chunk and has no code-split boundary at all. Left corrected
  // rather than deleted, because read as permission it would send the next
  // person straight back into the TDZ bug above.
  build: { chunkSizeWarningLimit: 1600 },
});
