/**
 * The two promises `web/public/sw.js` must never quietly stop keeping.
 *
 * Both are checked here rather than in review because both failed silently in
 * production and neither is visible in a screenshot: the worker cached a lie
 * and nobody could tell, and the page ran three-hour-old code while reporting
 * itself current.
 *
 * `sw.js` is a classic script, so it loads into a `node:vm` context with a
 * stubbed `self` and its `function` declarations land on that context's global
 * — no export plumbing needed in the worker itself.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';

const SW_PATH = fileURLToPath(new URL('../public/sw.js', import.meta.url));
const SW = readFileSync(SW_PATH, 'utf8');

type Ctx = {
  typeMatches: (u: URL, r: unknown) => boolean;
  BUILD: string;
};

function load(): Ctx {
  const noop = () => {};
  const ctx = createContext({
    self: {
      addEventListener: noop,
      location: { origin: 'https://code.acme.test' },
      clients: { matchAll: async () => [], claim: async () => {} },
      registration: {},
      skipWaiting: async () => {},
    },
    caches: {
      open: async () => ({
        keys: async () => [],
        match: async () => undefined,
        put: async () => {},
        delete: async () => {},
      }),
      keys: async () => [],
      delete: async () => {},
    },
    fetch: async () => {
      throw new Error('no network in this test');
    },
    URL,
    Response: class {},
    Promise,
    Symbol,
    setTimeout,
    clearTimeout,
    console,
  });
  runInContext(SW, ctx);
  return ctx as unknown as Ctx;
}

const res = (contentType: string | null) => ({ headers: { get: () => contentType } });

/**
 * The bug this file is named after. A deploy landed between a document and one
 * of its chunks; the SPA fallback answered with index.html and a 200; the
 * worker filed 6 KB of markup under a `.js` URL — forever, since the asset
 * cache is never evicted, and behind a year of `immutable` in nginx. A 200 is
 * not evidence about what a body IS.
 */
test('HTML never goes into the asset cache under a .js url', () => {
  const sw = load();
  assert.equal(
    sw.typeMatches(new URL('https://x/assets/index-abc.js'), res('text/html; charset=utf-8')),
    false,
    'index.html under a .js url is the exact poisoning that happened',
  );
  assert.equal(sw.typeMatches(new URL('https://x/assets/index-abc.js'), res('text/javascript')), true);
  assert.equal(sw.typeMatches(new URL('https://x/assets/Onest-400.woff2'), res('font/woff2')), true);
  assert.equal(sw.typeMatches(new URL('https://x/assets/index-abc.css'), res('text/css')), true);
  assert.equal(
    sw.typeMatches(new URL('https://x/assets/index-abc.css'), res(null)),
    false,
    'a missing content-type is not a pass: this cache is forever',
  );
  assert.equal(
    sw.typeMatches(new URL('https://x/assets/weird.xyz'), res('text/javascript')),
    false,
    'an extension with no expected type cannot be checked, so it does not go in',
  );
});

/**
 * The build plugin (`stampServiceWorker` in vite.config.ts) throws when this
 * literal is gone — but only if somebody notices a build failed. Say it here
 * too, where it fails in the same run as everything else: an unstamped worker
 * looks identical across deploys and silently stops reinstalling, which is what
 * schedules the cache repair.
 */
test('the worker carries a build stamp for the plugin to replace', () => {
  assert.match(SW, /__CC_BUILD__/, 'sw.js lost its stamp placeholder');
  const vite = readFileSync(fileURLToPath(new URL('../vite.config.ts', import.meta.url)), 'utf8');
  assert.match(vite, /__CC_BUILD__/, 'the plugin no longer looks for the stamp');
});

/**
 * Rule 3 in the worker's own header, restated as a test because breaking it is
 * a one-word edit with no visible symptom until the next deploy: renaming the
 * asset cache would strand every open tab's chunks, which is precisely what
 * makes `skipWaiting()` cheap enough to keep.
 */
test('the asset cache name carries no build version', () => {
  const name = /const ASSETS = '([^']+)'/.exec(SW)?.[1];
  assert.ok(name, 'ASSETS constant not found');
  assert.doesNotMatch(
    SW.slice(SW.indexOf('const ASSETS')),
    new RegExp(`const ASSETS = '[^']*' \\+`),
    'the asset cache name must not be built from the stamp',
  );
  assert.equal(name.includes('BUILD'), false);
});
