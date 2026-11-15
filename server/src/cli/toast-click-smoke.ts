/**
 * Clicking a desktop toast opens its session INSIDE the SPA (24.09.2026).
 *
 * The shell used to answer a toast click with a full page load onto
 * `/w/s/<machine>/<session>`: the split collapsed to one session and a
 * half-typed message went with it — «уведомления открывают сессии и
 * закрывают колонки». Now the shell evaluates `open_session_js`
 * (`windows/src-tauri/src/hub/mod.rs`), which calls the page's
 * `__HEGAI_OPEN_SESSION__` (`web/src/router.ts`) and only falls back to a
 * page load where that is absent. What this presses, with the page marked as
 * the Windows shell the way `initialization_script` marks it:
 *   1. a toast for a session already in a pane -> that pane takes focus, the
 *      split and the address stay, the page is NOT reloaded;
 *   2. a toast for another session -> it opens in the focused pane, the other
 *      pane stays, still no reload;
 *   3. outside the shell (no hook) the same script falls back to the old full
 *      navigation.
 *
 *   CC_REMOTE_SSO_SECRET=<hub's> tsx server/src/cli/toast-click-smoke.ts ws://127.0.0.1:4321
 *
 * Screenshots land in /tmp/toast-click-smoke/.
 */
import { mkdirSync } from 'node:fs';
import { adminLogin, enrollFakeAgent, fail, fakeSession, smokeTarget, sleep, launchBrowser, step } from './_harness.js';
import type { SessionSummary } from '@cc-remote/shared';


const SHOTS = '/tmp/toast-click-smoke';
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
  // What the shell's `initialization_script` does before any page script.
  await page.evaluateOnNewDocument(`window.__HEGAI_SHELL__ = 'windows';`);
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
  cdp.on('Network.webSocketCreated', (e: { requestId: string; url: string }) => {
    if (/\/ui(\?|$)/.test(e.url)) {
      live.add(e.requestId);
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
  // Byte for byte what `open_session_js` in windows/src-tauri/src/hub/mod.rs
  // produces (its unit test pins the same shape).
  const toastClick = (s: SessionSummary) => {
    const url = `${target.http}/w/s/${agent.machineId}/${s.sessionId}`;
    const q = JSON.stringify;
    return page.evaluate(
      `(function(m,s,u){var o=window.__HEGAI_OPEN_SESSION__;if(typeof o==='function'){try{o(m,s);return;}catch(e){}}location.assign(u);})(${q(agent.machineId)},${q(s.sessionId)},${q(url)});`,
    );
  };

  step('2. A split of two sessions, inside the «shell»');
  await page.goto(`${target.http}/w/sessions/columns?s=${ref(A)},${ref(B)}`, { waitUntil: 'networkidle2' });
  await page.waitForFunction(`document.querySelectorAll('section.session-col').length === 2`, { timeout: 20_000 });
  await sleep(SETTLE_MS);
  if (!(await page.evaluate(`typeof window.__HEGAI_OPEN_SESSION__ === 'function'`))) fail('the page published no __HEGAI_OPEN_SESSION__ inside the shell');
  await page.evaluate(`window.__noReload = 1`);
  await focusPane(1);
  let st = await state();
  const before = st.url;
  console.log(`  ✓ ${st.panes.map((p) => p.title).join(' | ')}, pane 2 focused`);

  step('3. Toast for the session in pane 1 -> focus moves there; split, address and page stay');
  await toastClick(A);
  await page.waitForFunction(`document.querySelectorAll('section.session-col')[0]?.classList.contains('focused')`, { timeout: 5_000 });
  await sleep(SETTLE_MS);
  st = await state();
  await page.screenshot({ path: `${SHOTS}/1-focus-existing.png` });
  if (!(await page.evaluate(`window.__noReload === 1`))) fail('the page reloaded');
  if (st.panes.length !== 2) fail(`${st.panes.length} panes — the split collapsed`);
  if (st.url !== before) fail(`the address changed to ${st.url}`);
  console.log(`  ✓ focus on pane 1, ${st.url}`);

  step('4. Toast for another session -> it opens in the focused pane, pane 2 stays');
  await toastClick(C);
  await page.waitForFunction(`location.search.startsWith(${JSON.stringify(`?s=${ref(C)},${ref(B)}`)})`, { timeout: 10_000 });
  await sleep(SETTLE_MS);
  st = await state();
  await page.screenshot({ path: `${SHOTS}/2-into-focused-pane.png` });
  if (!(await page.evaluate(`window.__noReload === 1`))) fail('the page reloaded');
  if (st.panes.length !== 2 || st.panes[0]?.title !== C.title || st.panes[1]?.title !== B.title) {
    fail(`panes are ${st.panes.map((p) => p.title).join(' | ')}`);
  }
  console.log(`  ✓ ${st.panes.map((p) => p.title).join(' | ')}`);

  step('5. Outside the shell the same script falls back to a full navigation');
  const plain = await browser.newPage();
  await plain.setViewport({ width: 1600, height: 900 });
  await plain.goto(`${target.http}/w/sessions/columns?s=${ref(A)},${ref(B)}`, { waitUntil: 'networkidle2' });
  if (await plain.evaluate(`typeof window.__HEGAI_OPEN_SESSION__ !== 'undefined'`)) fail('a plain browser tab published the shell hook');
  const url = `${target.http}/w/s/${agent.machineId}/${C.sessionId}`;
  await Promise.all([
    plain.waitForNavigation({ waitUntil: 'networkidle2' }),
    plain.evaluate(
      `(function(m,s,u){var o=window.__HEGAI_OPEN_SESSION__;if(typeof o==='function'){try{o(m,s);return;}catch(e){}}location.assign(u);})(${JSON.stringify(agent.machineId)},${JSON.stringify(C.sessionId)},${JSON.stringify(url)});`,
    ),
  ]);
  const landed = await plain.evaluate('location.pathname');
  if (landed !== `/w/s/${agent.machineId}/${C.sessionId}`) fail(`the fallback landed on ${landed}`);
  console.log(`  ✓ ${landed}`);

  clearTimeout(timer);
  await browser.close();
  agent.ws.close();
  console.log(`\nPASS: a toast click routes inside the page — the split survives, an open session only takes focus`);
  process.exit(0);
}

main().catch((e) => fail(e instanceof Error ? e.stack ?? e.message : String(e)));
