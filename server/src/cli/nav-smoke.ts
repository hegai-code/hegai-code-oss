/**
 * The navigation, in a real browser, at a desk AND on a phone.
 *
 * This file exists because the change it guards was a DELETION: Главная, the
 * Доска and Таблица lenses, three rail destinations, the bottom tab bar and the
 * phone layout of the split all went at once. A deletion is not proved by "it
 * compiles" — it is proved by "nothing became unreachable", and half the risk
 * here is invisible to a desktop run, because below 861px this app hides whole
 * limbs of itself with CSS (`.sidebar.sidepanel` goes). A
 * control rendered on the wrong side of that line still runs
 * its handlers and shows nothing. That is exactly how the Inbox bug lived: the
 * bell was in the bottom bar, its panel rendered inside the hidden `.main-col`,
 * the tap did nothing visible and `markRead()` still emptied the unread state.
 *
 * What it proves, in order:
 *   desktop — the landing is the session list, ONE panel carries both the
 *     destinations and that list (on every screen, not just Сессии), the three
 *     retired addresses still open their new home, all four retired lenses
 *     degrade instead of blanking, and the limits popover stays inside the
 *     viewport while scrolling its own content;
 *   phone   — there is ONE page and ONE drawer: `/w/sessions` is the composer
 *     rather than a second session list, the context column is not even
 *     mounted, the ☰ in the top bar opens the drawer and the drawer carries
 *     both the list and every destination, the bottom bar is gone from the DOM
 *     in all three states that used to toggle it, the Inbox opens over the page
 *     instead of revealing a hidden half, the swipe still works inside a
 *     session, and a link to the split lands on a session rather than a
 *     crippled deck.
 *
 * The agent is FAKE. Nothing here is about what an agent does; it is about
 * which of this app's screens you can reach and see. What is real: the browser,
 * the production web bundle, the hub binary, and every frame between them.
 *
 * Run it (two terminals, or see deploy/SMOKE-TESTS.md for the copy-paste):
 *
 *   npm run build --workspace shared && npm run build --workspace web
 *   cargo build --manifest-path server-rs/Cargo.toml
 *
 *   CC_REMOTE_TOKEN=dev-token \
 *   CC_REMOTE_SSO_SECRET=smoke-sso-secret-0123456789-0123456789 \
 *   CC_REMOTE_PLATFORM_ADMIN_IDS=legacy-owner \
 *   CC_REMOTE_PUBLIC_URL=http://127.0.0.1:4319 \
 *   CC_REMOTE_DB_PATH=/tmp/cc-remote-nav.sqlite3 \
 *   WEB_DIST=web/dist PORT=4319 \
 *   ./server-rs/target/debug/cc-remote-server
 *
 *   CC_REMOTE_SSO_SECRET=<same> tsx server/src/cli/nav-smoke.ts
 *
 * Screenshots of every step land in /tmp/nav-smoke/ — look at them. The
 * assertions below can only check what I thought to assert.
 */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import type { UsageLimit } from '@cc-remote/shared';
import {
  adminLogin,
  connectUiAs,
  enrollFakeAgent,
  fail,
  fakeSession,
  nextBrowserFrame,
  smokeTarget,
  sleep,
  step,
  launchBrowser,
} from './_harness.js';

const SHOTS = '/tmp/nav-smoke';

/** The destinations the side panel lists, in reading order (`work` then
 *  `fleet`). «Сессии» is NOT among them: its list is the body of the panel, so
 *  a row leading to it would point at what you are already looking at. */
/** The icon row beside «Новый чат» (`PLACES` in SidePanel.tsx), by aria-label,
 *  in its order. Проекты is not in this row — it lives in the account popover
 *  and the phone drawer, which step 7 checks by name. */
const NAV = ['Настройки', 'Доска', 'Команда', 'Файлы'];

const DESK = { width: 1280, height: 900 };
/** iPhone 14 metrics. Set through the protocol, NOT `--window-size`: headless
 *  Chrome clamps a window at 500px, so a "phone" screenshot comes back cropped
 *  rather than narrow, which reads as a layout bug that is not there.
 *  `hasTouch` is separate and load-bearing — `useSwipe` listens for raw
 *  `touchstart`/`touchend` and reads `e.touches`, so without it
 *  `page.touchscreen` fires into nothing and the swipe "does not reproduce"
 *  for a reason that has nothing to do with the code. */
const PHONE = { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true };

const target = smokeTarget(process.argv);
const timer = setTimeout(() => fail('timed out (180s)'), 180_000);

function ok(what: string): void {
  console.log(`  ✓ ${what}`);
}

/**
 * Is this element actually ON SCREEN, rather than merely in the DOM?
 *
 * `offsetParent !== null` is the usual shorthand and it is wrong here: it is
 * also null for a `position: fixed` box, which is what both phone panels are.
 * `getClientRects()` is empty for `display: none` (and for anything inside a
 * `display: none` subtree, which is the failure this whole file is about) and
 * non-empty for a fixed box that is painted.
 */
const VISIBLE = (sel: string) =>
  `(() => { const e = document.querySelector(${JSON.stringify(sel)});
            return !!e && e.getClientRects().length > 0; })()`;

/** Every limit Claude's endpoint can hand us, and then some. The panel's height
 *  is not ours to bound — `weekly:${model}` is generated for any `weekly_scoped`
 *  Anthropic returns (agent/src/usage.ts) — so the fixture makes that real. */
function manyLimits(n: number): UsageLimit[] {
  const out: UsageLimit[] = [
    { key: 'session', label: 'Session (5hr)', group: 'session', percent: 88, resetsAt: Date.now() + 26 * 60_000 },
    { key: 'weekly_all', label: 'Weekly (7 day)', group: 'weekly', percent: 15, resetsAt: Date.now() + 4 * 864e5 },
  ];
  for (let i = 0; i < n; i += 1) {
    out.push({
      key: `weekly:model-${i}`,
      label: `Weekly Model ${i}`,
      group: 'weekly',
      percent: 10 + i * 3,
      resetsAt: Date.now() + 3 * 864e5,
    });
  }
  return out;
}

async function main(): Promise<void> {
  const secret = target.ssoSecret;
  if (!secret) fail('CC_REMOTE_SSO_SECRET must match the hub');
  mkdirSync(SHOTS, { recursive: true });

  // ------------------------------------------------------- 1. a fleet to look at
  step('1. Owner signs in; two fake machines, each with a session and its own limits');
  // The BOOTSTRAP owner on purpose: on a localhost origin the SPA logs into
  // /ui with the fleet token, which the hub resolves to that account — a
  // machine enrolled by anyone else is invisible to the browser even with the
  // right cookie. (compact-smoke.ts burned twenty minutes on this once.)
  const owner = await adminLogin(target.http, secret);
  // TWO machines, not more: the hub mints at most `ENROLLMENTS_PER_HOUR = 5`
  // codes per account (access.rs), and a smoke nobody can run twice in an hour
  // is a smoke nobody runs. A fresh `CC_REMOTE_DB_PATH` per run — the pattern
  // deploy/SMOKE-TESTS.md already prescribes — removes the ceiling entirely.
  //
  // The cwds are NOT under /tmp: `isScratchCwd` marks those as scratch sessions
  // and the web hides them, so the snapshot would carry what the screen does not.
  const boxes = await Promise.all(
    ['alpha', 'beta'].map((name, i) =>
      enrollFakeAgent(target, owner, {
        name: `nav-${name}`,
        sessions: [fakeSession(`/home/smoke/${name}`, `Сессия ${i + 1}`)],
      }),
    ),
  );
  // Two DIFFERENT Claude accounts plus a Codex one: three blocks under two
  // section titles, which is what the popover looked like on 20.09.2026 when it
  // ran ~1000px tall and fell off the bottom of a 1080p screen. Ten per-model
  // rows apiece is not a stress test either — `weekly:${model}` is generated
  // for every `weekly_scoped` Anthropic returns, so the count is theirs.
  for (const [i, box] of boxes.entries()) {
    box.ws.send(
      JSON.stringify({
        type: 'usage',
        usage: {
          limits: manyLimits(10),
          account: `smoke-${i}@example.com`,
          subscription: i === 0 ? 'max' : 'pro',
          updatedAt: Date.now(),
        },
      }),
    );
  }
  boxes[0]!.ws.send(
    JSON.stringify({
      type: 'codex_usage',
      usage: {
        limits: manyLimits(0),
        account: 'smoke-codex@example.com',
        subscription: 'plus',
        updatedAt: Date.now(),
      },
    }),
  );
  await sleep(500);

  // Assert the hub publishes all of it BEFORE the browser is blamed for not
  // showing it.
  const probe = await connectUiAs(target.ws, owner);
  const snap = await nextBrowserFrame(probe, 'snapshot', (s) => s.machines.length >= 2);
  probe.close();
  const sessions = snap.machines.flatMap((m) => m.sessions);
  assert.ok(sessions.length >= 2, `hub publishes the sessions (saw ${sessions.length})`);
  ok(`hub snapshot carries ${snap.machines.length} machines and ${sessions.length} sessions`);
  const first = boxes[0]!;
  const firstSession = snap.machines.find((m) => m.machine.machineId === first.machineId)?.sessions[0];
  if (!firstSession) fail('the first machine reported no session');

  // ----------------------------------------------------------------- browser
  const browser = await launchBrowser({
    args: [
      // Chrome's own overscroll-to-go-back, off — and this one cost an hour.
      // A CDP-synthesised horizontal drag is handed to the browser's history
      // gesture before the page ever sees `touchend`: the tab navigated to
      // `about:blank` (the entry behind the session), the listener's
      // `touchstart` and `touchmove` had already arrived, and the drawer
      // "simply did not open". `html, body { overscroll-behavior: none }` is
      // set at ≤860px and did NOT stop it here. This disables a piece of
      // browser chrome, not app behaviour, so the gesture under test is still
      // the app's own.
      '--disable-features=OverscrollHistoryNavigation',
    ],
  });
  const cookie = owner.cookie.split(';')[0] ?? '';
  const [cookieName, ...cookieRest] = cookie.split('=');
  await browser.setCookie({
    name: (cookieName ?? '').trim(),
    value: cookieRest.join('='),
    domain: '127.0.0.1',
    path: '/',
  });
  const page = await browser.newPage();
  page.on('console', (m: { type: () => string; text: () => string }) => {
    if (m.type() === 'error') console.log(`  [browser error] ${m.text()}`);
  });

  /** Go somewhere and wait for the shell, not merely for the network. */
  const at = async (path: string, ready = '.sidebar.sidepanel, .startscreen'): Promise<string> => {
    await page.goto(`${target.http}${path}`, { waitUntil: 'networkidle2' });
    await page.waitForSelector(ready, { timeout: 20_000 });
    return page.evaluate('location.pathname + location.search') as Promise<string>;
  };
  /** `body` clips overflow-x, so anything that escapes sideways does not become
   *  a scrollbar — it simply cannot be reached. Worth asserting on every
   *  screen, not once. */
  const noSideways = async (where: string): Promise<void> => {
    const over = (await page.evaluate(
      'document.documentElement.scrollWidth - window.innerWidth',
    )) as number;
    assert.ok(over <= 1, `${where}: no horizontal overflow (scrollWidth - innerWidth = ${over})`);
  };

  // ========================================================= DESKTOP
  step('2. Desktop 1280×900 — the landing is the session list');
  await page.setViewport(DESK);
  assert.equal(await at('/w/'), '/w/sessions', '/w/ lands on the session list');
  // The root is where SSO drops you: the hub answers `302 /` and nothing under
  // `/w/`, so this is the first screen after signing in.
  assert.equal(await at('/'), '/w/sessions', 'the root — where SSO drops you — lands there too');
  // An unknown address under `/w/` RENDERS the list; the address itself is left
  // alone, as it always was. `normalizeEntryPath` runs on every render, so
  // canonicalising every path there would mean rewriting the URL under an
  // in-flight navigation — a bigger risk than a typo that stays in the bar.
  await at('/w/zzz-nonsense', '.startscreen, .sidebar.sidepanel');
  assert.ok(
    await page.evaluate(VISIBLE('.sidebar.sidepanel')),
    'an unknown address renders the session list rather than a blank screen',
  );
  await page.screenshot({ path: `${SHOTS}/1-desk-landing.png` });
  await noSideways('landing');
  ok('/ and /w/ land on /w/sessions; an unknown path renders the list');

  step('3a. Desktop — «Доска» is a destination with its own data');
  // The hub has no cards yet, so this is the EMPTY board: the head, the filter
  // rows and the placeholder — and the page must answer `/api/board` itself
  // (a 404 here would mean a web built against a hub without the endpoint).
  assert.equal(await at('/w/board', '.bd .board-head'), '/w/board', '/w/board is an address');
  assert.ok(await page.evaluate(VISIBLE('.bd .board-head h2')), 'the board has its heading');
  await page.waitForSelector('.bd-placeholder, .bd-cols, .bd-error', { timeout: 10_000 });
  assert.ok(
    !(await page.evaluate(`!!document.querySelector('.bd-error')`)),
    'the hub answered /api/board (no error note)',
  );
  assert.equal(
    await page.evaluate(`document.querySelector('.sidebar.sidepanel a.side-place[aria-current="page"]')?.getAttribute('aria-label')`),
    'Доска',
    'the places row marks Доска as «you are here»',
  );
  await page.screenshot({ path: `${SHOTS}/3a-desk-board.png` });
  await noSideways('board');
  ok('/w/board renders on its own data and lights its place in the panel');

  step('3. Desktop — one panel: the destinations AND the session list');
  // The destinations became an icon row beside «Новый чат» on 25.09.2026
  // (`.side-place`, one link per place, named by aria-label); the labelled
  // `.rail-item` rows this used to read are gone, and with them this step had
  // been failing on main since — the assertion follows the control.
  const navLabels = (await page.evaluate(
    `Array.from(document.querySelectorAll('.sidebar.sidepanel a.side-place')).map((e) => e.getAttribute('aria-label'))`,
  )) as string[];
  assert.deepEqual(navLabels, NAV, 'the panel carries the places row, Доска among them');
  // The regression this guards: the navigation and the session list used to
  // live in two containers, and only the list's could collapse — so the rail
  // was permanent and the list appeared on exactly one screen. One container
  // means both are here, or neither is.
  assert.ok(
    await page.evaluate(VISIBLE('.sidepanel .sidebar-scroll')),
    'the session list is in the same panel as the destinations',
  );
  // No brand mark, in either state. It was drawn at 22px here and 26px in the
  // rail, at different offsets, so collapsing made the one thing that should
  // never move jump 7px down and 9px right — and it was a logo inside an app
  // you are already in, pointing at the list directly beneath it.
  assert.ok(
    !(await page.evaluate(`!!document.querySelector('.side-mark, .rail-mark, .topbar-brand')`)),
    'no brand mark anywhere',
  );
  // The panel toggle and the two history arrows, in the bar — not in the panel.
  assert.equal(
    await page.evaluate(`document.querySelectorAll('.topbar .nav-arrows .icon-btn').length`),
    3,
    'panel toggle + back + forward live in the top bar',
  );
  // The account is ONE control, in the top bar, where the gear used to be.
  assert.ok(
    await page.evaluate(VISIBLE('.topbar .acc-btn')),
    'the account sits in the top bar',
  );
  assert.ok(
    !(await page.evaluate(`!!document.querySelector('.side-foot')`)),
    'and not a second time at the foot of the panel',
  );
  // «Назад» is gone with the reason for it: the list is beside every screen now.
  assert.ok(
    !(await page.evaluate(`!!document.querySelector('.nav-back')`)),
    'no back arrow',
  );
  ok(`panel: ${navLabels.join(' · ')} + the list; account in the bar; no mark, no back`);

  step('3b. Desktop — the toggle does not move, and neither does the session');
  // The control you press to collapse must be under the cursor when you press
  // it again, and the conversation must not shift while you do. Both were true
  // by accident before and are now measured. The toggle lives in the top bar,
  // which spans the WINDOW rather than sitting beside the panel — put it inside
  // the column and collapsing slides the whole row 320px left, moving the
  // control you just pressed out from under the cursor. The session title is
  // the same y in both states and in a split pane too (they used to differ by
  // six pixels — 12+8+2 against 14+10+4).
  const topOf = (sel: string) =>
    page.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(sel)});
      return e ? Math.round(e.getBoundingClientRect().top) : null; })()`);
  const toggleAt = () =>
    page.evaluate(`(() => { const e = document.querySelector('.nav-arrows .icon-btn');
      const r = e.getBoundingClientRect(); return Math.round(r.x) + ',' + Math.round(r.y); })()`);
  const openToggle = await toggleAt();
  const openTitleY = await topOf('.ws-title, .start-composer');
  await page.evaluate(`document.querySelector('.nav-arrows .icon-btn').click()`);
  await page.waitForFunction(`!document.querySelector('.sidepanel')`, { timeout: 10_000 });
  // Collapsed means GONE — no panel and no 68px strip standing in for it.
  assert.ok(
    !(await page.evaluate(`!!document.querySelector('.rail')`)),
    'collapsing leaves no rail behind',
  );
  assert.equal(await toggleAt(), openToggle, 'the toggle keeps its exact place');
  assert.equal(await topOf('.ws-title, .start-composer'), openTitleY, 'and the screen does not shift vertically');
  await page.evaluate(`document.querySelector('.nav-arrows .icon-btn').click()`);
  await page.waitForSelector('.sidepanel', { timeout: 10_000 });
  ok(`toggle at ${openToggle} in both states; panel gone when collapsed`);

  step('4. Desktop — Железо, Память and Профиль open inside Настройки');
  for (const [path, tab] of [
    ['/w/hardware', 'Железо'],
    ['/w/memory', 'Память'],
    ['/w/profile', 'Профиль'],
  ] as const) {
    const landed = await at(path, '.settings-shell .settings-tabs');
    assert.equal(landed, `/w/settings${path.slice(2)}`, `${path} is rewritten, not just rendered`);
    const active = await page.evaluate(
      `document.querySelector('.settings-tabs .tab.active').textContent.trim()`,
    );
    assert.equal(active, tab, `${path} opens the «${tab}» tab`);
    await noSideways(path);
  }
  await page.screenshot({ path: `${SHOTS}/2-desk-settings.png` });
  // Настройки is not one of the panel's destinations — it hangs off the account
  // button in the top bar — so nothing in the panel lights up for it. The old
  // assertion here looked for a lit account row IN the panel; that row is gone.
  assert.ok(
    !(await page.evaluate(`!!document.querySelector('.side-nav a.rail-item[aria-current="page"]')`)),
    'no panel destination claims a settings tab',
  );
  assert.ok(
    await page.evaluate(VISIBLE('.sidepanel .sidebar-scroll')),
    'and the session list is still beside it — it is not a Сессии-only column any more',
  );
  ok('all three legacy addresses land on their tab and correct the address bar');

  step('5. Desktop — every retired lens degrades to the list, and no switcher');
  // All four now: Доска and Таблица went in an earlier cut, Flow and the
  // «Колонки» tab in this one. These addresses are in chat histories and
  // bookmarks, so they must render the list rather than a blank screen.
  for (const gone of ['board', 'table', 'flow']) {
    await at(`/w/sessions?view=${gone}`, '.startscreen');
    const composer = await page.evaluate(VISIBLE('.start-composer textarea'));
    assert.ok(composer, `?view=${gone} falls back to the list, not a blank screen`);
  }
  assert.ok(
    !(await page.evaluate(`!!document.querySelector('.lensbar')`)),
    'and there is no switcher left to offer them',
  );
  await page.screenshot({ path: `${SHOTS}/3-desk-no-lenses.png` });
  await noSideways('no-lenses');
  ok('?view=board, ?view=table and ?view=flow all fall back to the list');

  step('6. Desktop — the limits popover stays inside the viewport and scrolls itself');
  await at('/w/sessions', '.usage-pill');
  await page.click('.usage-pill');
  await page.waitForSelector('.usage-pop', { timeout: 10_000 });
  await page.screenshot({ path: `${SHOTS}/4-desk-limits.png` });
  const pop = (await page.evaluate(`(() => {
    const e = document.querySelector('.usage-pop');
    const r = e.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, right: r.right, left: r.left,
             scrollH: e.scrollHeight, clientH: e.clientHeight,
             overflowY: getComputedStyle(e).overflowY,
             vh: window.innerHeight, vw: window.innerWidth };
  })()`)) as {
    top: number; bottom: number; right: number; left: number;
    scrollH: number; clientH: number; overflowY: string; vh: number; vw: number;
  };
  // THE bug, asserted as a number rather than looked at. `body` is
  // `overflow: hidden`, so a panel past the bottom edge is not off-screen —
  // it is unreachable, because neither the page nor the panel scrolls.
  assert.ok(
    pop.bottom <= pop.vh,
    `the panel ends inside the viewport (bottom ${Math.round(pop.bottom)} vs ${pop.vh})`,
  );
  assert.ok(pop.left >= 0 && pop.right <= pop.vw, 'and inside it horizontally');
  // With this fixture it MUST overflow — that is the point of eight per-model
  // rows on three accounts. If it does not, the cap is not being exercised and
  // the assertion above proves nothing.
  assert.ok(
    pop.scrollH > pop.clientH,
    `the content is taller than the panel, so the cap is real (${pop.scrollH} > ${pop.clientH})`,
  );
  assert.equal(pop.overflowY, 'auto', 'and the panel scrolls its own content');
  ok(`limits panel ${Math.round(pop.clientH)}px tall holding ${pop.scrollH}px, bottom at ${Math.round(pop.bottom)}/${pop.vh}`);

  step('6b. Desktop — a session the snapshot cannot resolve SAYS so');
  // The silent failure this whole branch exists for: the address bar changed,
  // the StartScreen stayed, and nothing said why. That is what «клик по сессии
  // не работает» actually was — a session deleted, past the snapshot cap, or
  // scoped away by a workspace switch looks exactly like a dead control.
  // Both halves are asserted, because showing the message is only half of it:
  // the StartScreen must be GONE, or the composer still invites you to type
  // into a session that is not there.
  await at(`/w/s/${encodeURIComponent(first.machineId)}/bogus-session-id`, '.placeholder');
  const missing = await page.evaluate(
    `document.querySelector('.placeholder .ph-sub')?.textContent?.trim() ?? ''`,
  );
  assert.match(String(missing), /не найдена/i, 'a known machine names the session as missing');
  assert.ok(String(missing).includes(first.name), 'and names the machine it looked on');
  assert.ok(!(await page.evaluate(VISIBLE('.startscreen'))), 'the StartScreen does not stand in for it');
  await page.screenshot({ path: `${SHOTS}/5-desk-session-missing.png` });
  // A machine outside this workspace is a different sentence: nothing is wrong
  // with the session, the whole box is out of scope.
  await at('/w/s/bogus-machine/bogus-session-id', '.placeholder');
  const noMachine = await page.evaluate(
    `document.querySelector('.placeholder .ph-sub')?.textContent?.trim() ?? ''`,
  );
  assert.match(String(noMachine), /машина недоступна/i, 'an unknown machine says so instead');
  // And the ordinary case is untouched: a real session still opens.
  await at(
    `/w/s/${encodeURIComponent(first.machineId)}/${encodeURIComponent(firstSession.sessionId)}`,
    '.chat, .mirror',
  );
  ok('an unresolvable session explains itself; a real one still opens');

  // ========================================================= PHONE
  step('7. Phone 390×844 — one page, and the session list is not one of them');
  await page.setViewport(PHONE);
  await at('/w/sessions', '.startscreen');
  await page.screenshot({ path: `${SHOTS}/5-phone-list.png` });
  // `/w/sessions` on a phone is the COMPOSER, the same screen a desktop shows
  // in the column beside the list. The list used to be this page — rendered
  // full-screen with `.main-col` hidden beside it — which gave the phone two
  // session lists (this one and the drawer's) and made every back gesture land
  // on the one nobody asked for.
  assert.ok(
    await page.evaluate(VISIBLE('.start-composer textarea')),
    '/w/sessions is the composer, not a list',
  );
  assert.ok(
    !(await page.evaluate(`!!document.querySelector('.sidebar.sidepanel')`)),
    'and the context column is not even mounted',
  );
  assert.ok(!(await page.evaluate(`!!document.querySelector('.rail')`)), 'and no rail — that strip is gone everywhere');
  // What replaces it: the ☰ in the top bar, which is this screen's chrome.
  assert.ok(await page.evaluate(VISIBLE('.topbar-menu')), 'the ☰ is on screen');
  await noSideways('phone composer');
  ok('the composer is the page, the column is unmounted, and the ☰ is the way to the list');

  step('8. Phone — the bottom tab bar is gone in all three states that used to toggle it');
  const noBar = async (where: string) => {
    const present = await page.evaluate(`!!document.querySelector('.mobilebar')`);
    assert.ok(!present, `${where}: no bottom bar in the DOM`);
  };
  await noBar('sessions route');
  await at('/w/new', '.start-composer textarea');
  await noBar('composer screen');
  await page.focus('.start-composer textarea');
  await page.keyboard.type('привет');
  await noBar('while typing');
  // And the composer is fully on screen — it is the whole point of this route.
  const box = (await page.evaluate(`(() => {
    const r = document.querySelector('.start-composer').getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, vh: window.innerHeight };
  })()`)) as { top: number; bottom: number; vh: number };
  assert.ok(box.top >= 0 && box.bottom <= box.vh, `the composer is not clipped (${Math.round(box.top)}…${Math.round(box.bottom)} of ${box.vh})`);
  await page.screenshot({ path: `${SHOTS}/6-phone-new.png` });
  await noSideways('phone composer');
  ok('no `.mobilebar` anywhere, and the composer fits the screen');

  step('9. Phone — the ☰ opens the drawer, and it carries the list AND the destinations');
  await at('/w/sessions', '.topbar-menu');
  await page.click('.topbar-menu');
  await page.waitForSelector('.sdrawer', { timeout: 10_000 });
  await page.screenshot({ path: `${SHOTS}/7-phone-drawer-from-topbar.png` });
  // The destinations moved out of a docked strip and behind the ⚙ of the
  // floating «Чат» button (a9b887b): a bar across the drawer took a fixed
  // slice off an already short list. What must NOT change is that every
  // destination is still reachable from here, by name — so the assertion
  // follows the control instead of the class it used to have.
  await page.click('.sdrawer-cog');
  await page.waitForSelector('.sdrawer-menu', { timeout: 10_000 });
  const drawerNav = (await page.evaluate(
    `Array.from(document.querySelectorAll('.sdrawer-menu a.sdm-row')).map((e) => e.textContent.trim())`,
  )) as string[];
  assert.deepEqual(
    drawerNav,
    ['Доска', 'Проекты', 'Файлы', 'Команда', 'Настройки'],
    'the drawer lists every destination by name, none folded away',
  );
  // Real links, not `navigate()` buttons — the same invariant
  // `web/test/shell-invariants.test.ts` enforces in source, checked in the DOM.
  const allLinks = await page.evaluate(
    `Array.from(document.querySelectorAll('.sdrawer-menu a.sdm-row')).every((e) => e.getAttribute('href'))`,
  );
  assert.ok(allLinks, 'every destination row is an <a href>');
  // And the session list is IN here — which is the whole point of the change:
  // one list, in a panel, instead of a page you could arrive at by accident.
  assert.ok(
    await page.evaluate(VISIBLE('.sdrawer .projects-tree, .sdrawer .proj-grid, .sdrawer .sidebar-scroll')),
    'the session list is inside the drawer',
  );
  await Promise.all([
    page.waitForFunction(`location.pathname === '/w/team'`, { timeout: 10_000 }),
    page.evaluate(
      `Array.from(document.querySelectorAll('.sdrawer-menu a.sdm-row')).find((e) => e.textContent.includes('Команда')).click()`,
    ),
  ]);
  ok(`drawer: ${drawerNav.join(' · ')} — and «Команда» really changes the screen`);

  step('10. Phone — the Inbox opens over the page, in the bar that is on screen');
  await at('/w/sessions', '.topbar-menu');
  // The CONTROL is in the drawer's ⚙ sheet now (the phone top bar gave its
  // icon slots to the limits meter, a9b887b); the PANEL still mounts in the
  // top bar, which is the half that used to be broken and the half this step
  // is about. Driving it from the real control is the only way to prove the
  // two halves still meet.
  await page.click('.topbar-menu');
  await page.waitForSelector('.sdrawer', { timeout: 10_000 });
  await page.click('.sdrawer-cog');
  await page.waitForSelector('.sdrawer-menu', { timeout: 10_000 });
  await page.evaluate(
    `Array.from(document.querySelectorAll('.sdrawer-menu .sdm-row')).find((e) => e.textContent.includes('Уведомления')).click()`,
  );
  await page.waitForSelector('.notif-pop', { timeout: 10_000 });
  await page.screenshot({ path: `${SHOTS}/8-phone-inbox.png` });
  assert.ok(await page.evaluate(VISIBLE('.notif-pop')), 'the panel is on screen');
  // The regression this replaces: the bell used to be in the bottom bar while
  // its panel rendered inside the hidden `.main-col`, so the tap showed nothing
  // and `markRead()` still ran. The bar hosting it is now the page's own.
  assert.ok(
    await page.evaluate(VISIBLE('.startscreen')),
    'and the page under it is still the page',
  );
  ok('Inbox opens over the page instead of revealing a hidden half');

  step('11. Phone — a link to the split lands on a session, not a deck');
  const colsUrl = `/w/sessions/columns?s=${encodeURIComponent(first.machineId)}:${encodeURIComponent(firstSession.sessionId)}`;
  await page.goto(`${target.http}${colsUrl}`, { waitUntil: 'networkidle2' });
  await page.waitForFunction(`location.pathname.startsWith('/w/s/')`, { timeout: 15_000 });
  const landed = await page.evaluate('location.pathname');
  assert.equal(
    landed,
    `/w/s/${first.machineId}/${firstSession.sessionId}`,
    'the split opened its first pane as an ordinary session',
  );
  assert.ok(!(await page.evaluate(`!!document.querySelector('.session-columns')`)), 'and no split rendered');
  ok(`${colsUrl} → ${landed}`);

  step('12. Phone — inside a session the drawer still opens by swipe');
  await page.waitForSelector('.workspace', { timeout: 20_000 });
  // Thresholds from useSwipe.ts: DIST 64 horizontal, and |dx| > 2·|dy|. The
  // move is stepped because a single jump from start to end is one event, and
  // a gesture recogniser that never sees the middle is not being exercised.
  const swipe = async (from: number, to: number) => {
    const y = 420;
    // `touchStart` hands back a handle; drive the gesture through it rather
    // than the page-level helpers, so every event belongs to the same touch.
    const touch = await page.touchscreen.touchStart(from, y);
    for (let i = 1; i <= 6; i += 1) {
      await touch.move(from + ((to - from) * i) / 6, y);
      await sleep(20);
    }
    await touch.end();
  };
  await swipe(40, 300);
  await page.waitForSelector('.sdrawer', { timeout: 10_000 });
  assert.ok(await page.evaluate(VISIBLE('.sdrawer')), 'swipe right opens the session drawer');
  await page.screenshot({ path: `${SHOTS}/9-phone-drawer.png` });
  await swipe(300, 40);
  await page.waitForFunction(`!document.querySelector('.sdrawer')`, { timeout: 10_000 });
  await noSideways('phone session');
  ok('drawer opens and closes by swipe');

  await browser.close();
  for (const box of boxes) box.ws.close();
  clearTimeout(timer);
  console.log(`\n[nav-smoke] PASS — screenshots in ${SHOTS}/`);
  process.exit(0);
}

main().catch((err: unknown) => fail(err instanceof Error ? (err.stack ?? err.message) : String(err)));
