/**
 * The split is a division of the SCREEN: whatever is chosen outside the panes
 * opens in the FOCUSED pane (24.09.2026, by request).
 *
 * Before, the split was sessions only, and choosing anything in the side panel —
 * a session, Файлы, Проекты, Команда — left it for a single screen. Now one pane
 * has focus (the last one pressed) and `navigate` routes every single-screen
 * navigation into it (router `intoPane`). What this presses, in order:
 *   1. Файлы from the side panel land in the focused pane; the other pane stays
 *      and its socket is NOT reopened;
 *   2. a session already in a pane only takes focus — the address does not
 *      change and no second pane of it appears (two panes of one transcript are
 *      two writers);
 *   3. another session replaces the focused pane;
 *   4. Back walks the panes' history, inside the split;
 *   5. sockets: ONE for the whole window — session panes are views on the
 *      shell's socket, and screens like Файлы share it too;
 *   6. on a phone the split is not drawn: the address lands on the focused
 *      pane's screen;
 *   7. an old `?s=m:a,m:b` link still draws two panes.
 *
 * Run it like the other browser smokes (deploy/SMOKE-TESTS.md):
 *
 *   CC_REMOTE_SSO_SECRET=<hub's> tsx server/src/cli/split-panes-smoke.ts ws://127.0.0.1:4321
 *
 * Screenshots land in /tmp/split-panes-smoke/.
 */
import { mkdirSync } from 'node:fs';
import { adminLogin, enrollFakeAgent, fail, fakeSession, smokeTarget, sleep, launchBrowser, step } from './_harness.js';
import type { SessionSummary } from '@cc-remote/shared';


const SHOTS = '/tmp/split-panes-smoke';
const SETTLE_MS = 800;

const target = smokeTarget(process.argv);
const timer = setTimeout(() => fail('timed out (180s)'), 180_000);

async function main(): Promise<void> {
  if (!target.ssoSecret) fail('CC_REMOTE_SSO_SECRET is not set in this shell (must match the hub)');
  mkdirSync(SHOTS, { recursive: true });

  step('1. Owner, a fake agent with three sessions');
  const owner = await adminLogin(target.http, target.ssoSecret);
  const CWD = '/home/smoke/split';
  const sessions: SessionSummary[] = [
    fakeSession(CWD, 'Раздел А'),
    fakeSession(CWD, 'Раздел Б'),
    fakeSession(CWD, 'Раздел В'),
  ];
  const agent = await enrollFakeAgent(target, owner, { name: 'split-panes-box', sessions });
  const ref = (s: SessionSummary) => `${encodeURIComponent(agent.machineId)}:${encodeURIComponent(s.sessionId)}`;
  const [A, B, C] = sessions as [SessionSummary, SessionSummary, SessionSummary];

  const browser = await launchBrowser();
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 900 });
  page.on('console', (m: { type: () => string; text: () => string }) => {
    if (m.type() === 'error') console.log(`  [browser error] ${m.text()}`);
  });
  // LIVE /ui sockets, at the browser's own network layer: created minus closed.
  // Counting only creations would charge the shell's own reconnect on boot (it
  // reopens once the workspace is known) to the split.
  const cdp = await page.createCDPSession();
  await cdp.send('Network.enable');
  const live = new Set<string>();
  let opened = 0;
  cdp.on('Network.webSocketCreated', (e: { requestId: string; url: string }) => {
    if (/\/ui(\?|$)/.test(e.url)) {
      live.add(e.requestId);
      opened += 1;
    }
  });
  cdp.on('Network.webSocketClosed', (e: { requestId: string }) => live.delete(e.requestId));
  const cookie = owner.cookie.split(';')[0] ?? '';
  const [cookieName, ...cookieRest] = cookie.split('=');
  await browser.setCookie({ name: (cookieName ?? '').trim(), value: cookieRest.join('='), domain: '127.0.0.1', path: '/' });

  const state = () =>
    page.evaluate(`(() => ({
      url: location.pathname + location.search,
      panes: Array.from(document.querySelectorAll('section.session-col')).map((p) => ({
        title: p.querySelector('.sc-col-title')?.textContent ?? '',
        focused: p.classList.contains('focused'),
        files: !!p.querySelector('.pane-body'),
      })),
    }))()`) as Promise<{ url: string; panes: { title: string; focused: boolean; files: boolean }[] }>;
  const focusPane = async (i: number) => {
    await page.click(`section.session-col:nth-of-type(${i + 1}) .sc-col-sub`);
    await page.waitForFunction(`document.querySelectorAll('section.session-col')[${i}]?.classList.contains('focused')`, { timeout: 5_000 });
  };
  const clickRow = (title: string) =>
    page.evaluate(`(() => {
      const a = Array.from(document.querySelectorAll('a.pc-sess')).find((x) => x.title === ${JSON.stringify(title)});
      if (!a) return false;
      a.click();
      return true;
    })()`);

  step('2. A split of two sessions');
  await page.goto(`${target.http}/w/sessions/columns?s=${ref(A)},${ref(B)}`, { waitUntil: 'networkidle2' });
  await page.waitForFunction(`document.querySelectorAll('section.session-col').length === 2`, { timeout: 20_000 });
  await sleep(SETTLE_MS);
  const openedAtStart = opened;
  console.log(`  ✓ two panes, ${live.size} live /ui socket(s)`);
  // ONE socket for the whole window since 24.09.2026: a session pane is a view
  // on the shell's socket (sessionChannel.ts), not a socket of its own.
  if (live.size !== 1) fail(`${live.size} live /ui sockets for a split of two sessions, expected ONE for the whole window`);

  step('3. Focus pane 2, choose «Файлы» in the side panel -> pane 2 is Файлы, pane 1 untouched');
  await focusPane(1);
  await page.click('a.side-place[aria-label="Файлы"]');
  await page.waitForFunction(`document.querySelectorAll('section.session-col')[1]?.querySelector('.sc-col-title')?.textContent === 'Файлы'`, { timeout: 10_000 });
  await sleep(SETTLE_MS);
  let st = await state();
  await page.screenshot({ path: `${SHOTS}/1-files-in-pane.png` });
  if (st.panes.length !== 2) fail(`${st.panes.length} panes after «Файлы», expected 2 (${st.url})`);
  if (st.panes[0]?.title !== A.title) fail(`pane 1 changed to «${st.panes[0]?.title}»`);
  if (!st.url.includes(`${ref(A)},%2Fw%2Ffiles`)) fail(`unexpected address ${st.url}`);
  if (opened !== openedAtStart) fail(`opening Файлы in a pane opened ${opened - openedAtStart} new /ui socket(s) — pages must share the shell's`);
  if ((live.size as number) !== 1) fail(`${live.size} live /ui sockets after replacing a pane, expected ONE`);
  console.log(`  ✓ ${st.url}`);

  step('4. Click the row of the session already in pane 1 -> focus moves there, nothing else');
  const before = st.url;
  if (!(await clickRow(A.title))) fail(`no side-panel row for «${A.title}»`);
  await page.waitForFunction(`document.querySelectorAll('section.session-col')[0]?.classList.contains('focused')`, { timeout: 5_000 });
  await sleep(SETTLE_MS);
  st = await state();
  if (st.url !== before) fail(`the address changed to ${st.url} — a session already on screen must only take focus`);
  if (st.panes.length !== 2) fail(`${st.panes.length} panes — a second pane of the same session appeared`);
  console.log(`  ✓ focus on pane 1, address unchanged`);

  step('5. Click another session -> it replaces the focused pane (1)');
  if (!(await clickRow(C.title))) fail(`no side-panel row for «${C.title}»`);
  await page.waitForFunction(`location.search.startsWith(${JSON.stringify(`?s=${ref(C)},`)})`, { timeout: 10_000 });
  await sleep(SETTLE_MS);
  st = await state();
  await page.screenshot({ path: `${SHOTS}/2-session-replaced.png` });
  if (st.panes[0]?.title !== C.title || st.panes[1]?.title !== 'Файлы') fail(`panes are ${st.panes.map((p) => p.title).join(' | ')}`);
  console.log(`  ✓ ${st.panes.map((p) => p.title).join(' | ')}`);

  step('6. Back -> the previous pane content, still a split');
  await page.goBack();
  await page.waitForFunction(`location.search.startsWith(${JSON.stringify(`?s=${ref(A)},`)})`, { timeout: 10_000 });
  await page.waitForFunction(`document.querySelectorAll('section.session-col').length === 2`, { timeout: 10_000 });
  console.log(`  ✓ back to ${(await state()).url}`);

  step('7. Phone width -> the split is not drawn; the focused pane\'s screen is');
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  await page.goto(`${target.http}/w/sessions/columns?s=${ref(A)},${ref(B)}`, { waitUntil: 'networkidle2' });
  await page.waitForFunction(`location.pathname.startsWith('/w/s/')`, { timeout: 10_000 });
  st = await state();
  if (st.panes.length !== 0) fail(`a phone drew ${st.panes.length} panes`);
  if (!st.url.endsWith(`/w/s/${agent.machineId}/${A.sessionId}`)) fail(`the phone landed on ${st.url}`);
  console.log(`  ✓ ${st.url}`);

  clearTimeout(timer);
  await browser.close();
  agent.ws.close();
  console.log(`\nPASS: destinations and sessions open in the focused pane; an open session only takes focus; pages share the shell's socket`);
  process.exit(0);
}

main().catch((e) => fail(e instanceof Error ? e.stack ?? e.message : String(e)));
