/**
 * «Новый чат» opens the composer in a column OF ITS OWN beside what is on
 * screen, and takes the focused pane only when the split is already full.
 *
 * History: pressing «Новый чат» on `/w/sessions/columns?s=m:a,m:b` once went to
 * `/w/new` and the session started there replaced the whole layout. The first
 * fix carried the panes through the composer (`/w/new?cols=`) and appended the
 * new session as an extra pane. Since 24.09.2026 the split is a division of the
 * screen: one pane has focus, and «Новый чат» — like any destination — opens in
 * THAT pane (router `intoPane`). Since 25.09.2026 (by request) «Новый чат»
 * is the exception: it ADDS a pane (router `newChatRoute`) — starting a
 * conversation should not take away the one you are reading — and falls back
 * to the focused pane only at COL_MAX. The composer is the pane; the session
 * started from it becomes the pane once the agent names it (App's pendingNew
 * effect).
 *
 * Three ends, because two of them are invisible from the third:
 *   1. the ADDRESS grows by one slot, the composer, focused;
 *   2. the AGENT receives `new_session` and answers `session_started`, which is
 *      what turns the placeholder into a real ref (a smoke that navigated by
 *      hand would prove nothing about the swap);
 *   3. the SCREEN keeps the other panes untouched and draws the new session in
 *      the pane it was started from.
 *
 * A single screen becomes a split of two; a FULL split (COL_MAX = 4) replaces
 * the focused pane, so there is no fifth pane to fall off the address. The
 * icon row beside the button (Настройки · Команда · Файлы) is checked too.
 *
 * Run it (see deploy/SMOKE-TESTS.md for the full copy-paste):
 *
 *   npm run build --workspace shared && npm run build --workspace web
 *   cargo build --manifest-path server-rs/Cargo.toml
 *
 *   CC_REMOTE_TOKEN=dev-token \
 *   CC_REMOTE_SSO_SECRET=smoke-sso-secret-0123456789-0123456789 \
 *   CC_REMOTE_PLATFORM_ADMIN_IDS=legacy-owner \
 *   CC_REMOTE_PUBLIC_URL=http://127.0.0.1:4321 \
 *   CC_REMOTE_DB_PATH=/tmp/cc-remote-cols-new.sqlite3 \
 *   WEB_DIST=web/dist PORT=4321 \
 *   ./server-rs/target/debug/cc-remote-server
 *
 *   CC_REMOTE_SSO_SECRET=<same> tsx server/src/cli/columns-new-chat-smoke.ts ws://127.0.0.1:4321
 *
 * Screenshots land in /tmp/columns-new-chat-smoke/ — look at them. «Three
 * panes» is also what the DOM says when the third is drawn 900px off-screen.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import {
  adminLogin,
  connectUiAs,
  enrollFakeAgent,
  fail,
  fakeSession,
  nextAgentFrame,
  nextBrowserFrame,
  smokeTarget,
  sleep,
  chromePath,
  launchBrowser,
  step,
  evalJs,
} from './_harness.js';
import type { SessionSummary } from '@cc-remote/shared';

const SHOTS = '/tmp/columns-new-chat-smoke';
/** The router's own cap. Four panes is a FULL split — the guard case. */
const COL_MAX = 4;
/** Long enough for a stray navigation to land if one is coming. The failure
 *  mode being tested is "the route changes to something else a tick later". */
const SETTLE_MS = 800;

const target = smokeTarget(process.argv);
const timer = setTimeout(() => fail('timed out (180s)'), 180_000);

/**
 * What is on screen, as a person would count it.
 *
 * `visible` rather than a bare `querySelectorAll` length: a pane with no client
 * rects is a pane nobody is looking at, and the bug reported was visual — the
 * layout disappearing, not a ref going missing from a string.
 */
const PANES_JS = `
  (() => {
    const cols = Array.from(document.querySelectorAll('section.session-col'));
    return {
      url: location.pathname + location.search,
      panes: cols.length,
      visible: cols.filter((c) => c.getClientRects().length > 0).length,
      composer: !!document.querySelector('.start-composer textarea'),
    };
  })()
`;
interface Panes {
  url: string;
  panes: number;
  visible: number;
  composer: boolean;
}

/** `?s=`/`?cols=` back into the pairs it encodes. */
function refsOf(url: string, param: 's' | 'cols'): string[] {
  const q = new URLSearchParams(url.slice(url.indexOf('?') + 1));
  const raw = q.get(param);
  return raw ? raw.split(',').filter(Boolean) : [];
}

async function main(): Promise<void> {
  if (!target.ssoSecret) fail('CC_REMOTE_SSO_SECRET is not set in this shell (must match the hub)');
  const secret = target.ssoSecret;
  mkdirSync(SHOTS, { recursive: true });
  console.log(`[columns-new-chat-smoke] hub ${target.http}  chrome ${chromePath()}`);

  // ------------------------------------------------- 1. an account + a machine
  step('1. Owner signs in, a fake agent reports four sessions');
  // The BOOTSTRAP owner on purpose: on a localhost origin the SPA logs into /ui
  // with the fleet token, which the hub resolves to that user, so a machine
  // enrolled by anyone else is invisible to the page (SMOKE-TESTS.md trap 1).
  const owner = await adminLogin(target.http, secret);
  // Not a /tmp cwd — `isScratchCwd` hides those from every list (trap 2). One
  // cwd for all four, so the start screen has exactly one project to aim at and
  // «куда» is not a second thing this smoke is testing.
  const CWD = '/home/smoke/proj';
  const sessions: SessionSummary[] = [
    fakeSession(CWD, 'Панель 1'),
    fakeSession(CWD, 'Панель 2'),
    fakeSession(CWD, 'Панель 3'),
    fakeSession(CWD, 'Панель 4'),
  ];
  const agent = await enrollFakeAgent(target, owner, {
    name: 'cols-new-chat-box',
    sessions,
  });
  const inventory = [...sessions];
  /** Republish what this machine has, the way a real agent's next scan does.
   *  A brand-new session is not in `refs`-land until the inventory carries it:
   *  `SessionColumns` skips a pane it cannot resolve. */
  const publish = (extra: SessionSummary) => {
    inventory.push(extra);
    agent.ws.send(JSON.stringify({ type: 'inventory', sessions: inventory, complete: true }));
  };

  const probe = await connectUiAs(target.ws, owner);
  const snap = await nextBrowserFrame(probe, 'snapshot', (s) => s.machines.length > 0);
  const listed = snap.machines.flatMap((m) => m.sessions.map((x) => x.sessionId));
  for (const s of sessions) {
    if (!listed.includes(s.sessionId)) fail(`the hub does not publish ${s.sessionId} (saw ${listed.length})`);
  }
  probe.close();
  console.log(`  ✓ hub snapshot carries all four sessions`);

  // ------------------------------------------------------------- 2. a browser
  step('2. Real Chrome, real cookie, a split of TWO');
  const browser = await launchBrowser();
  const page = await browser.newPage();
  // Desk width: «Колонки» is desk-only (below 861px App redirects a split to its
  // first session) and the side panel — which holds «Новый чат» — is not mounted
  // on a phone at all. Wide enough for four panes, which floor at 340px.
  await page.setViewport({ width: 1600, height: 900 });
  page.on('console', (m: { type: () => string; text: () => string }) => {
    if (m.type() === 'error') console.log(`  [browser error] ${m.text()}`);
  });
  const cookie = owner.cookie.split(';')[0] ?? '';
  const [cookieName, ...cookieRest] = cookie.split('=');
  await browser.setCookie({
    name: (cookieName ?? '').trim(),
    value: cookieRest.join('='),
    domain: '127.0.0.1',
    path: '/',
  });

  const ref = (id: string) => `${encodeURIComponent(agent.machineId)}:${encodeURIComponent(id)}`;
  const twoRefs = [ref(sessions[0]!.sessionId), ref(sessions[1]!.sessionId)];
  await page.goto(`${target.http}/w/sessions/columns?s=${twoRefs.join(',')}`, { waitUntil: 'networkidle2' });
  await page.waitForFunction(`document.querySelectorAll('section.session-col').length === 2`, { timeout: 20_000 });
  await page.waitForSelector('button.side-new', { timeout: 20_000 });
  const split = await evalJs<Panes>(page, PANES_JS);
  await page.screenshot({ path: `${SHOTS}/1-split-of-two.png` });
  if (split.visible !== 2) fail(`the split shows ${split.visible} pane(s) on screen, expected 2 (${SHOTS}/1-split-of-two.png)`);
  console.log(`  ✓ two panes at ${split.url}`);

  /** The pane at `i` (0-based): what it shows, as a person would read it. */
  const paneAt = (i: number) =>
    page.evaluate(`(() => {
      const p = document.querySelectorAll('section.session-col')[${i}];
      if (!p) return null;
      return {
        title: p.querySelector('.sc-col-title')?.textContent ?? '',
        composer: !!p.querySelector('.start-composer textarea'),
        focused: p.classList.contains('focused'),
      };
    })()`) as Promise<{ title: string; composer: boolean; focused: boolean } | null>;

  /** Press inside pane `i`, the way a person moves focus there. */
  const focusPane = async (i: number) => {
    await page.click(`section.session-col:nth-of-type(${i + 1}) .sc-col-sub`);
    await page.waitForFunction(
      `document.querySelectorAll('section.session-col')[${i}]?.classList.contains('focused')`,
      { timeout: 5_000 },
    );
  };

  /** Start a session from the composer pane and let the agent name it. */
  const startFromPane = async (text: string) => {
    const startFrame = nextAgentFrame(agent.ws, 'new_session', 20_000);
    await page.type('section.session-col .start-composer textarea', text);
    await page.click('section.session-col .start-composer button.send-round:not([disabled])');
    const started = await startFrame;
    if (started.cwd !== CWD) fail(`new_session aims at ${started.cwd}, expected ${CWD}`);
    const id = randomUUID();
    agent.ws.send(JSON.stringify({ type: 'session_started', runId: started.runId, sessionId: id }));
    return { id, runId: started.runId };
  };

  // ------------------------------------ 3. the icon row beside «Новый чат»
  step('3. Настройки · Команда · Файлы sit on the «Новый чат» row as links');
  const places = (await page.evaluate(`
    Array.from(document.querySelectorAll('.side-new-row a.side-place')).map((a) => a.getAttribute('aria-label') + ' ' + new URL(a.href).pathname)
  `)) as string[];
  if (places.join('|') !== 'Настройки /w/settings|Команда /w/team|Файлы /w/files') fail(`icon row is ${JSON.stringify(places)}`);
  console.log(`  ✓ ${places.join(' · ')}`);

  // ------------------------------- 4. «Новый чат» ADDS a pane beside the split
  step('4. Focus pane 1, press «Новый чат» -> a THIRD pane, the composer, focused; panes 1–2 untouched');
  await focusPane(0);
  await page.click('button.side-new');
  await page.waitForFunction(
    `!!document.querySelectorAll('section.session-col')[2]?.querySelector('.start-composer textarea')`,
    { timeout: 20_000 },
  );
  await sleep(SETTLE_MS);
  const composing = await evalJs<Panes>(page, PANES_JS);
  await page.screenshot({ path: `${SHOTS}/2-composer-beside.png` });
  if (!composing.url.includes('/w/sessions/columns')) fail(`«Новый чат» left the split for ${composing.url}`);
  if (composing.visible !== 3) fail(`${composing.visible} panes on screen after «Новый чат», expected 3 — it must add, not replace`);
  const slots = refsOf(composing.url as string, 's');
  if (slots[0] !== twoRefs[0] || slots[1] !== twoRefs[1]) fail(`panes 1–2 changed: ${composing.url}`);
  if (decodeURIComponent(slots[2] ?? '') !== '/w/new') fail(`pane 3 is ${slots[2]}, expected the composer (/w/new)`);
  if (!(await paneAt(2))?.focused) fail('the composer pane is not the focused one');
  // Pressing it again while a composer is on screen only focuses that one.
  await focusPane(0);
  await page.click('button.side-new');
  await sleep(SETTLE_MS);
  const again = await evalJs<Panes>(page, PANES_JS);
  if (again.url !== composing.url) fail(`a second «Новый чат» changed the split: ${again.url}`);
  if (!(await paneAt(2))?.focused) fail('a second «Новый чат» did not focus the composer');
  console.log(`  ✓ ${composing.url}`);

  // ------------------------------- 5. start a session; the agent mints the id
  step('5. Send from the pane composer -> new_session -> session_started -> pane 3 IS the new session');
  const first = await startFromPane('третья панель');
  console.log(`  ✓ agent received new_session run=${first.runId.slice(0, 8)}`);
  try {
    await page.waitForFunction(
      `location.search.includes(${JSON.stringify(ref(first.id))})`,
      { timeout: 20_000 },
    );
  } catch {
    const now = await evalJs<Panes>(page, PANES_JS);
    await page.screenshot({ path: `${SHOTS}/3-wrong-landing.png` });
    fail(`the new session never took pane 3: ${now.url} (${SHOTS}/3-wrong-landing.png)`);
  }
  // The pane must draw BEFORE the inventory carries the session — its whole
  // first turn is spent there.
  await page.waitForFunction(`document.querySelectorAll('section.session-col').length === 3`, { timeout: 10_000 });
  // …and the next scan finds it.
  publish({ ...fakeSession(CWD, 'третья панель'), sessionId: first.id });
  await sleep(SETTLE_MS);
  const after = await evalJs<Panes>(page, PANES_JS);
  await page.screenshot({ path: `${SHOTS}/3-new-session-in-pane.png` });
  const landed = refsOf(after.url as string, 's');
  if (landed.join(',') !== [twoRefs[0], twoRefs[1], ref(first.id)].join(',')) fail(`expected [pane 1, pane 2, new session], got ${after.url}`);
  if (after.visible !== 3) fail(`${after.visible} panes on screen, expected 3`);
  if (!(await paneAt(2))?.focused) fail('the new session pane is not the focused one');
  console.log(`  ✓ ${after.url} — the new session in the pane it was started from`);

  // ------------------------------------- 6. a single screen becomes a split
  step('6. One session on screen, «Новый чат» -> a split of two: [that session, composer]');
  await page.goto(`${target.http}/w/s/${encodeURIComponent(agent.machineId)}/${encodeURIComponent(sessions[2]!.sessionId)}`, { waitUntil: 'networkidle2' });
  await page.waitForSelector('button.side-new', { timeout: 20_000 });
  await page.click('button.side-new');
  await page.waitForFunction(
    `document.querySelectorAll('section.session-col').length === 2 && !!document.querySelectorAll('section.session-col')[1]?.querySelector('.start-composer textarea')`,
    { timeout: 20_000 },
  );
  const single = await evalJs<Panes>(page, PANES_JS);
  await page.screenshot({ path: `${SHOTS}/4-single-to-split.png` });
  const singleSlots = refsOf(single.url as string, 's');
  if (singleSlots[0] !== ref(sessions[2]!.sessionId) || decodeURIComponent(singleSlots[1] ?? '') !== '/w/new') fail(`expected [session 3, composer], got ${single.url}`);
  // Back returns to the single session: splitting a screen is travel.
  await page.goBack();
  await page.waitForFunction(`location.pathname.startsWith('/w/s/')`, { timeout: 10_000 });
  console.log(`  ✓ ${single.url}, Back → the single session`);

  // ------------------------------------------ 7. a FULL split: the focused pane
  step('7. A FULL split (4 panes): «Новый чат» replaces the focused pane, still 4');
  const fourRefs = sessions.map((s) => ref(s.sessionId));
  if (fourRefs.length !== COL_MAX) fail(`this smoke needs exactly ${COL_MAX} seeded sessions`);
  await page.goto(`${target.http}/w/sessions/columns?s=${fourRefs.join(',')}`, { waitUntil: 'networkidle2' });
  await page.waitForFunction(
    `document.querySelectorAll('section.session-col').length === ${COL_MAX}`,
    { timeout: 20_000 },
  );
  await focusPane(2);
  await page.click('button.side-new');
  await page.waitForFunction(
    `!!document.querySelectorAll('section.session-col')[2]?.querySelector('.start-composer textarea')`,
    { timeout: 20_000 },
  );
  await page.screenshot({ path: `${SHOTS}/5-full-split-composer.png` });
  const second = await startFromPane('третья в полном');
  publish({ ...fakeSession(CWD, 'третья в полном'), sessionId: second.id });
  await page.waitForFunction(`location.search.includes(${JSON.stringify(ref(second.id))})`, { timeout: 20_000 });
  await sleep(SETTLE_MS);
  const full = await evalJs<Panes>(page, PANES_JS);
  await page.screenshot({ path: `${SHOTS}/6-full-split-after.png` });
  const fullSlots = refsOf(full.url as string, 's');
  const expected = [fourRefs[0], fourRefs[1], ref(second.id), fourRefs[3]];
  if (fullSlots.join(',') !== expected.join(',')) fail(`expected ${expected.join(',')}, got ${full.url}`);
  if (full.panes !== COL_MAX) fail(`${full.panes} panes, expected ${COL_MAX}`);
  console.log(`  ✓ ${full.url} — pane 3 replaced, nothing else moved`);

  clearTimeout(timer);
  await browser.close();
  agent.ws.close();
  console.log(`\nPASS: «Новый чат» opens in a pane of its own (the focused one only in a full split); the session started there takes that pane; the rest never move`);
  console.log(`      screenshots: ${SHOTS}/`);
  process.exit(0);
}

main().catch((e) => fail(e instanceof Error ? e.stack ?? e.message : String(e)));
