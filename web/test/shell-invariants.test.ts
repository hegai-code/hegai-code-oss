import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// `.pathname` is a URL path, not a filesystem path: on Windows it comes back as
// `/D:/…`, which readdir then resolves against the drive root as `D:\D:\…`.
// fileURLToPath is the only correct conversion on both platforms.
const SRC = fileURLToPath(new URL('../src/', import.meta.url));

function sources(dir = SRC, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sources(p, out);
    else if (/\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

/** Source-relative and always `/`-separated. The invariants below name the one
 *  exempt file as `shell/workspace.ts`; on Windows `join` spells it
 *  `shell\workspace.ts`, so the exemption silently missed and the test failed on
 *  the file it was written to allow. */
const rel = (p: string): string => p.slice(SRC.length).split(sep).join('/');

const files = sources().map((path) => ({ path: rel(path), text: readFileSync(path, 'utf8') }));

/**
 * There is ONE app shell. `workspace.kind` distinguishes a personal row from an
 * organization row in the database and drives access control in the hub — it is
 * not a mode the interface should operate in. Branching on it here is what grew
 * the two disjoint navigations that made "Моя работа" and the organization read
 * as two different products, and it grows back the moment someone adds
 * `kind === 'organization'` to a component.
 *
 * The sanctioned place to ask is shell/workspace.ts, which turns it into a
 * decision (which workspace to use, whether inviting can work) exactly once.
 */
test('the UI does not branch on workspace.kind', () => {
  const offenders = files
    .filter(({ path }) => path !== 'shell/workspace.ts')
    .filter(({ text }) => /\bkind\s*===\s*['"](organization|personal)['"]/.test(text))
    .map(({ path }) => path);
  assert.deepEqual(
    offenders,
    [],
    `branch on workspace.kind outside shell/workspace.ts: ${offenders.join(', ')}`,
  );
});

/**
 * `central.viewer` is null until the socket delivers its hello. Any component
 * that dereferences it with `!` renders a blank page — not an error state, a
 * BLANK PAGE — if it is reached before that.
 *
 * This used to be impossible by accident: the team screens were only offered
 * once `isOrganization` was known, which required a viewer. With a permanent
 * rail and real URLs, every screen is reachable on first paint and by deep link,
 * so the guard that used to be implicit has to be checked.
 */
/**
 * A destination is a place, and a place has an address. Every screen already
 * had a URL, but for a while nothing was an `<a href>` — the rail and the
 * bottom bar were buttons calling `navigate()`, so ⌘-click, middle-click,
 * "copy link address", the status-bar preview and link semantics for a screen
 * reader were all simply absent. Nothing about that failed loudly; it just
 * quietly was not there, which is exactly the kind of regression that comes
 * back the next time someone adds a nav item by copying a `<button>`.
 *
 * So: anything that renders the DESTINATIONS list has to go through
 * `linkProps`, which is the only sanctioned way to keep SPA navigation on a
 * plain click while leaving every modified click to the browser.
 */
test('navigation destinations render as real links', () => {
  const offenders = files
    .filter(({ path }) => !path.endsWith('shell/navModel.ts'))
    .filter(({ text }) => /\bDESTINATIONS\b/.test(text))
    .filter(({ text }) => !/\blinkProps\b/.test(text))
    .map(({ path }) => path.slice(SRC.length));
  assert.deepEqual(
    offenders,
    [],
    `render destinations with <a {...linkProps(route)}>, not <button onClick={navigate}>: ${offenders.join(', ')}`,
  );
});

test('no component dereferences central.viewer with a non-null assertion', () => {
  const offenders = files
    .filter(({ text }) => /\bviewer!\s*\./.test(text))
    .map(({ path }) => path);
  assert.deepEqual(
    offenders,
    [],
    `viewer! can be null before the socket connects — guard at the render site instead: ${offenders.join(', ')}`,
  );
});

/**
 * A public page must be able to scroll to its own end.
 *
 * The app pins `#root { position: fixed; inset: 0 }` so the shell measures
 * against the viewport rect. The three whole-document pages — the landing,
 * `/install`, `/install/app` — opt out with `html.install-document`, and that
 * opt-out released only HEIGHT for a long time. A fixed box is out of flow, so
 * the document stayed exactly one screen tall while the content ran past it:
 * measured on prod 22.09.2026, `/install/app` laid out 2807px inside a 900px
 * root and `document.scrollHeight` was 900. Nothing below the fold could be
 * reached — on the pages whose entire job is to be read to the end, and which
 * are what gets pasted at someone who has nothing installed yet.
 *
 * Pinned as a rule rather than a screenshot because a full-page screenshot
 * captures content the viewer cannot actually scroll to, which is precisely how
 * this passed review.
 */
test('the public-document escape releases #root from fixed positioning, not only its height', () => {
  // styles.css is only the list of @imports of src/styles/NN-*.css; read the sheets.
  const sheets = fileURLToPath(new URL('../src/styles/', import.meta.url));
  const css = readdirSync(sheets)
    .filter((f) => f.endsWith('.css'))
    .sort()
    .map((f) => readFileSync(join(sheets, f), 'utf8'))
    .join('\n');
  const rule = /html\.install-document\s+#root\s*\{([^}]*)\}/.exec(css);
  assert.ok(rule, 'html.install-document #root rule is gone — public pages inherit the fixed shell root');
  assert.match(
    rule[1],
    /position:\s*static/,
    'html.install-document #root must set `position: static`, or the page cannot scroll',
  );
});

/**
 * The light shell (`src/lite`, served on remote.acme.test) is a second ENTRY
 * into this workspace, and the boundary runs one way.
 *
 * It imports the full client's data layer, router and transcript — that is the
 * point: one socket, one set of reducers, one device cache. It must not import
 * the full client's SHELL: `App.tsx` and the chrome around it are the thing it
 * exists to be an alternative to, and pulling one of them in drags the side
 * panel, the split and the tab strip into a bundle whose whole claim is that
 * they are not there.
 *
 * And nothing outside `src/lite` imports from it. The moment the full client
 * reaches in for a helper, the light shell stops being removable and every
 * change to it becomes a change to the product everybody uses — a shared piece
 * belongs in `src/`, where both already look.
 */
test('the light shell imports the data layer, never the full shell — and nothing imports it back', () => {
  const FULL_SHELL = /from\s+['"][^'"]*\/(App|CommandPalette|Landing|shell\/(SidePanel|TopBar|SessionDrawer|SessionWorkspace|SessionsPane)|components\/(SessionColumns?|TabStrip|StartScreen))\.js['"]/;
  const reachesIn = files
    .filter(({ path }) => path.startsWith('lite/'))
    .filter(({ text }) => FULL_SHELL.test(text))
    .map(({ path }) => path);
  assert.deepEqual(reachesIn, [], `the light shell imports the full shell: ${reachesIn.join(', ')}`);

  const reachesBack = files
    .filter(({ path }) => !path.startsWith('lite/'))
    .filter(({ text }) => /from\s+['"][^'"]*\/lite\/[^'"]+['"]/.test(text))
    .map(({ path }) => path);
  assert.deepEqual(reachesBack, [], `imports from src/lite outside it: ${reachesBack.join(', ')}`);
});
