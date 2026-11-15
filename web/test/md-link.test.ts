import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mdLinkHref } from '../src/render/Blocks.js';

// A report link in agent prose used to load into the app's own tab and wipe
// the column split (08.10.2026). Now it opens beside the app; on the desktop
// shell, same-site links ask for their own window.
const HERE = 'https://code.acme.test/w/sessions/columns?s=m1:a,m2:b';

test('same-site link gets the own-window flag when the shell can build one', () => {
  assert.equal(
    mdLinkHref('https://code.acme.test/w/reports/abc', HERE, 'window'),
    'https://code.acme.test/w/reports/abc?w=1',
  );
  assert.equal(mdLinkHref('/w/reports/abc', HERE, 'window'), 'https://code.acme.test/w/reports/abc?w=1');
});

// «Чтобы открывалась в браузере, а не в самом аппе» (10.10.2026): a shell that
// understands the browser flag gets it instead of the own-window one.
test('same-site link asks for the browser where the shell supports it', () => {
  assert.equal(
    mdLinkHref('https://code.acme.test/w/reports/abc', HERE, 'browser'),
    'https://code.acme.test/w/reports/abc?ext=1',
  );
  assert.equal(mdLinkHref('https://youtu.be/x', HERE, 'browser'), 'https://youtu.be/x');
});

test('no flag where the shell cannot build a second window safely', () => {
  assert.equal(mdLinkHref('https://code.acme.test/w/reports/abc', HERE, 'none'), 'https://code.acme.test/w/reports/abc');
});

test('other sites and anchors are left as written', () => {
  assert.equal(mdLinkHref('https://youtu.be/x', HERE, 'browser'), 'https://youtu.be/x');
  assert.equal(mdLinkHref('#part', HERE, 'browser'), '#part');
  assert.equal(mdLinkHref('mailto:a@b.c', HERE, 'browser'), 'mailto:a@b.c');
});

// Links went unnoticed: light theme paints them ink with no underline, and a
// human's own URL was never a link at all (09.10.2026).
import { linkifyPlain } from '../src/render/Blocks.js';

test('plain human text: urls become links, trailing punctuation does not', () => {
  const parts = linkifyPlain('смотри https://a.b/x?y=1, и (https://c.d).');
  const links = parts.filter((p) => typeof p !== 'string') as { props: { href: string } }[];
  assert.deepEqual(links.map((l) => l.props.href), ['https://a.b/x?y=1', 'https://c.d']);
  assert.equal(parts.filter((p) => typeof p === 'string').join(''), 'смотри , и ().');
});

// «Если перезагружаешь приложение — открывай последние открытые вкладки»
// (10.10.2026): the shell starts with `?restore=1`; what is stored and put back
// is the app screen without one-shot flags.
import { restorableAddress } from '../src/router.js';

test('the remembered screen keeps the split and drops one-shot flags', () => {
  assert.equal(
    restorableAddress('/w/sessions/columns', '?s=m1:a,m2:b&w=1&ext=1&restore=1'),
    '/w/sessions/columns?s=m1:a,m2:b',
  );
  assert.equal(restorableAddress('/w/sessions', '?restore=1'), '/w/sessions');
  assert.equal(restorableAddress('/login', ''), null);
  assert.equal(restorableAddress('/', '?restore=1'), null);
});

import { parseRoute } from '../src/router.js';

test('a restored split parses back to the same panes', () => {
  const at = restorableAddress('/w/sessions/columns', '?s=m1:a,m2:b&restore=1')!;
  const [p, q] = at.split('?');
  const r = parseRoute(p, `?${q}`) as { kind: string; panes?: unknown[] };
  assert.equal(r.kind, 'columns');
  assert.equal(r.panes?.length, 2);
});
