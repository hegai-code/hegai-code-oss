/**
 * A session opens at once and never pretends its machine is gone (24.09.2026).
 *
 * The complaint: every new column and every reload «loads the session from
 * scratch» — first «Машина офлайн — только чтение» (or «Эта машина недоступна в
 * текущем воркспейсе»), then everything arrives. What this presses, with a
 * fake agent that answers the history read only after a realistic delay:
 *   1. a split of two sessions: from the first frame to both transcripts
 *      drawn, no «offline» / «недоступна» / «не найдена» text ever appears;
 *   2. the same after a reload;
 *   3. the whole window holds ONE /ui socket, however many panes;
 *   4. with the hub unreachable, a reload still draws both transcripts — from
 *      this device's cache — and the session list.
 *
 *   CC_REMOTE_SSO_SECRET=<hub's> tsx server/src/cli/instant-open-smoke.ts ws://127.0.0.1:4321
 *
 * Screenshots land in /tmp/instant-open-smoke/.
 */
import { mkdirSync } from 'node:fs';
import { adminLogin, enrollFakeAgent, fail, fakeSession, smokeTarget, sleep, launchBrowser, step } from './_harness.js';
import type { SessionSummary } from '@cc-remote/shared';


const SHOTS = '/tmp/instant-open-smoke';
/** How long the fake agent sits on a history read — a real one over a real
 *  network is in this range, and it is what makes a flash visible at all. */
const HISTORY_DELAY_MS = 1_500;
const ONE_SOCKET = process.env['CC_SMOKE_ONE_SOCKET'] !== '0';
const OFFLINE_CACHE = process.env['CC_SMOKE_OFFLINE_CACHE'] !== '0';

const target = smokeTarget(process.argv);
const timer = setTimeout(() => fail('timed out (180s)'), 180_000);

/** Watches the page from before its first script for text that says the
 *  machine or the session is not there. Kept in sessionStorage so a reload
 *  does not wipe the evidence. */
const WATCH = `(() => {
  const BAD = [/Machine offline/, /Машина офлайн/, /недоступна в текущем воркспейсе/, /Сессия не найдена/];
  const tick = () => {
    const t = document.body ? document.body.innerText : '';
    for (const re of BAD) {
      if (re.test(t)) {
        const seen = JSON.parse(sessionStorage.getItem('__flashes') || '[]');
        if (!seen.includes(re.source)) { seen.push(re.source); sessionStorage.setItem('__flashes', JSON.stringify(seen)); }
      }
    }
  };
  setInterval(tick, 20);
})();`;

async function main(): Promise<void> {
  if (!target.ssoSecret) fail('CC_REMOTE_SSO_SECRET is not set in this shell (must match the hub)');
  mkdirSync(SHOTS, { recursive: true });

  step('1. Owner, a fake agent with two sessions that answer history slowly');
  const owner = await adminLogin(target.http, target.ssoSecret);
  const CWD = '/home/smoke/instant';
  const sessions: SessionSummary[] = [fakeSession(CWD, 'Мгновенно А'), fakeSession(CWD, 'Мгновенно Б')];
  const agent = await enrollFakeAgent(target, owner, { name: 'instant-box', sessions });
  const [A, B] = sessions as [SessionSummary, SessionSummary];
  const said = (s: SessionSummary) => `Ответ из сессии ${s.title}`;
  agent.ws.on('message', (raw: Buffer) => {
    const m = JSON.parse(raw.toString()) as { type: string; requestId?: string; method?: string; params?: Record<string, unknown> };
    if (m.type !== 'rpc_request' || !m.requestId) return;
    if (m.method !== 'session.messages') {
      agent.ws.send(JSON.stringify({ type: 'rpc_response', requestId: m.requestId, ok: false, error: 'not in this smoke' }));
      return;
    }
    const s = sessions.find((x) => x.sessionId === m.params?.['sessionId']);
    const messages = s
      ? [
          { type: 'user', uuid: `${s.sessionId}-u`, blocks: [{ kind: 'text', text: `Вопрос в ${s.title}` }], ts: Date.now() - 60_000 },
          { type: 'assistant', uuid: `${s.sessionId}-a`, blocks: [{ kind: 'text', text: said(s) }], ts: Date.now() - 50_000 },
        ]
      : [];
    setTimeout(
      () => agent.ws.send(JSON.stringify({ type: 'rpc_response', requestId: m.requestId, ok: true, result: { messages } })),
      HISTORY_DELAY_MS,
    );
  });

  const browser = await launchBrowser();
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 900 });
  await page.evaluateOnNewDocument(WATCH);
  const cdp = await page.createCDPSession();
  await cdp.send('Network.enable');
  const live = new Set<string>();
  cdp.on('Network.webSocketCreated', (e: { requestId: string; url: string }) => {
    if (/\/ui(\?|$)/.test(e.url)) live.add(e.requestId);
  });
  cdp.on('Network.webSocketClosed', (e: { requestId: string }) => live.delete(e.requestId));
  const cookie = owner.cookie.split(';')[0] ?? '';
  const [cookieName, ...cookieRest] = cookie.split('=');
  await browser.setCookie({ name: (cookieName ?? '').trim(), value: cookieRest.join('='), domain: '127.0.0.1', path: '/' });
  const ref = (s: SessionSummary) => `${encodeURIComponent(agent.machineId)}:${encodeURIComponent(s.sessionId)}`;
  const splitUrl = `${target.http}/w/sessions/columns?s=${ref(A)},${ref(B)}`;
  const bothSaid = `(() => { const t = document.body.innerText; return t.includes(${JSON.stringify(said(A))}) && t.includes(${JSON.stringify(said(B))}); })()`;
  const flashes = async () => JSON.parse((await page.evaluate(`sessionStorage.getItem('__flashes') || '[]'`)) as string) as string[];

  step('2. A split of two sessions: nothing ever says the machine is gone');
  await page.goto(splitUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(`document.querySelectorAll('section.session-col').length === 2`, { timeout: 20_000 });
  await page.waitForFunction(bothSaid, { timeout: 20_000 });
  await sleep(800);
  await page.screenshot({ path: `${SHOTS}/1-split.png` });
  let seen = await flashes();
  if (seen.length) fail(`the split flashed: ${seen.join(', ')}`);
  console.log(`  ✓ both transcripts, no flash; ${live.size} live /ui socket(s)`);
  if (ONE_SOCKET && live.size !== 1) fail(`${live.size} live /ui sockets for a split of two, expected ONE for the whole window`);

  step('3. Reload: still no flash');
  // The old document's sockets die with it and CDP does not always report
  // their close — count only what the new one opens.
  live.clear();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(`document.querySelectorAll('section.session-col').length === 2`, { timeout: 20_000 });
  await page.waitForFunction(bothSaid, { timeout: 20_000 });
  await sleep(800);
  seen = await flashes();
  if (seen.length) fail(`the reload flashed: ${seen.join(', ')}`);
  console.log(`  ✓ no flash after reload; ${live.size} live /ui socket(s)`);
  if (ONE_SOCKET && live.size !== 1) fail(`${live.size} live /ui sockets after reload, expected ONE`);

  if (OFFLINE_CACHE) {
    step('4. Hub unreachable: a reload draws both transcripts and the list from this device');
    // Refuse every /ui handshake: the page, its scripts and /api/me still load
    // (the service worker and the hub's HTTP side), the live channel does not.
    await page.setRequestInterception(true);
    page.on('request', (r: { url: () => string; abort: () => void; continue: () => void }) => {
      if (/\/ui(\?|$)/.test(r.url())) r.abort();
      else r.continue();
    });
    await cdp.send('Network.setBlockedURLs', { urls: ['*/ui?*', '*/ui'] });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(`document.querySelectorAll('section.session-col').length === 2`, { timeout: 20_000 });
    await page.waitForFunction(bothSaid, { timeout: 10_000 });
    const listed = await page.evaluate(
      `Array.from(document.querySelectorAll('a.pc-sess')).map((a) => a.title)`,
    ) as string[];
    await page.screenshot({ path: `${SHOTS}/2-offline-from-cache.png` });
    if (!listed.includes(A.title) || !listed.includes(B.title)) fail(`the session list is not drawn from cache: ${JSON.stringify(listed)}`);
    console.log(`  ✓ transcripts and the session list, with no socket at all`);
  }

  clearTimeout(timer);
  await browser.close();
  agent.ws.close();
  console.log(`\nPASS: sessions open without an «offline» flash${ONE_SOCKET ? ', on one socket' : ''}${OFFLINE_CACHE ? ', and from cache when the hub is away' : ''}`);
  process.exit(0);
}

main().catch((e) => fail(e instanceof Error ? e.stack ?? e.message : String(e)));
