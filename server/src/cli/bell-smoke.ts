/**
 * The bell holds what still needs you — and lets go of it by itself.
 *
 * The incident (28.09.2026): a plan approval rang in the desktop app, Owner
 * answered it, and the «ждёт ответа» row stayed in the bell. Nothing ever
 * removed an entry except «Очистить», so every question cost two acts. Now an
 * entry leaves when its cause does (`pruneInbox`, web/src/central-reducers.ts).
 * What this presses, with a fake agent, a second socket playing the phone, and
 * the web in real Chrome:
 *   1. the page shows session B; the phone runs session A; A asks a plan —
 *      the page's bell rings (badge 1, row «ждёт ответа»);
 *   2. the PHONE answers — the page's bell empties on its own, badge gone;
 *   3. A finishes its turn — «готова» rings;
 *   4. the page opens session A — the entry leaves, because it has been seen.
 *
 * Step 2 is the one that sees the bug: before the fix the row stays and the
 * badge still says 1.
 *
 *   CC_REMOTE_SSO_SECRET=<hub's> tsx server/src/cli/bell-smoke.ts ws://127.0.0.1:4319
 *
 * Screenshots land in /tmp/bell-smoke/.
 */
import { mkdirSync } from 'node:fs';
import {
  adminLogin,
  connectUiAs,
  enrollFakeAgent,
  fail,
  fakeSession,
  nextAgentFrame,
  sendUi,
  smokeTarget,
  sleep,
  launchBrowser,
  step,
  evalJs,
} from './_harness.js';
import type { BrowserToCentral } from '@cc-remote/shared';

const SHOTS = '/tmp/bell-smoke';
const REQUEST_ID = 'bell-smoke-plan-1';
const target = smokeTarget(process.argv);
const timer = setTimeout(() => fail('timed out (120s)'), 120_000);

/** Badge number (0 when absent) and the rows of the bell, opening it if asked. */
const BELL_JS = `(() => {
  const badge = document.querySelector('.nbadge');
  return {
    badge: badge ? Number(badge.textContent) || 0 : 0,
    rows: Array.from(document.querySelectorAll('.notif-item')).map((r) => r.textContent.trim()),
  };
})()`;
interface BellState {
  badge: number;
  rows: string[];
}

async function main(): Promise<void> {
  if (!target.ssoSecret) fail('CC_REMOTE_SSO_SECRET is not set in this shell (must match the hub)');
  mkdirSync(SHOTS, { recursive: true });

  step('1. Owner, a machine with two sessions; the page shows B');
  const owner = await adminLogin(target.http, target.ssoSecret);
  const asker = fakeSession('/home/smoke/bell', 'Спросит план');
  const shown = fakeSession('/home/smoke/bell', 'Открыта на экране');
  const agent = await enrollFakeAgent(target, owner, { name: 'bell-box', sessions: [asker, shown] });

  const browser = await launchBrowser();
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  page.on('console', (m: { type: () => string; text: () => string }) => {
    if (m.type() === 'error') console.log(`  [browser error] ${m.text()}`);
  });
  const cookie = owner.cookie.split(';')[0] ?? '';
  const [cookieName, ...cookieRest] = cookie.split('=');
  await browser.setCookie({ name: (cookieName ?? '').trim(), value: cookieRest.join('='), domain: '127.0.0.1', path: '/' });
  await page.goto(`${target.http}/w/s/${agent.machineId}/${shown.sessionId}`, { waitUntil: 'networkidle2' });
  await page.waitForSelector('.composer textarea', { timeout: 20_000 });
  console.log('  ✓ page on session B');

  step('2. The phone runs session A, and A asks a plan');
  const phone = await connectUiAs(target.ws, owner);
  // The bell rings for YOUR runs only, and a run's owner is its session's
  // owner. A session the hub merely discovered has none; a person touching it
  // through the hub (here: the stage menu, with no stage) makes it theirs.
  sendUi(phone, { type: 'set_stage', machineId: agent.machineId, sessionId: asker.sessionId } as BrowserToCentral);
  await sleep(300);
  const resumed = nextAgentFrame(agent.ws, 'resume');
  sendUi(phone, { type: 'open', ref: 'phone', machineId: agent.machineId, sessionId: asker.sessionId, message: 'составь план' } as BrowserToCentral);
  const run = await resumed;
  agent.ws.send(JSON.stringify({ type: 'run_status', sessionId: asker.sessionId, runId: run.runId, state: 'started' }));
  await sleep(500);
  agent.ws.send(
    JSON.stringify({
      type: 'tool_request',
      sessionId: asker.sessionId,
      runId: run.runId,
      requestId: REQUEST_ID,
      tool: 'ExitPlanMode',
      input: { plan: 'Шаг 1. Шаг 2.' },
      title: 'Ready to code?',
    }),
  );
  await page.waitForFunction(`(${BELL_JS}).badge === 1`, { timeout: 15_000 });
  await page.click('button[aria-label="Уведомления"]');
  await page.waitForSelector('.notif-item', { timeout: 5_000 });
  const rang = await evalJs<BellState>(page, BELL_JS);
  await page.screenshot({ path: `${SHOTS}/1-asked.png` });
  if (rang.rows.length !== 1 || !rang.rows[0]?.includes('Спросит план')) fail(`expected one row for A, saw ${JSON.stringify(rang.rows)}`);
  console.log(`  ✓ bell rang: ${JSON.stringify(rang.rows)}`);

  step('3. The PHONE answers -> the page\'s bell lets go by itself');
  const decided = nextAgentFrame(agent.ws, 'tool_decision');
  sendUi(phone, { type: 'tool_decision', ref: 'phone', runId: run.runId, requestId: REQUEST_ID, allow: true } as BrowserToCentral);
  await decided;
  // What the real agent does next: the CLI goes on working.
  agent.ws.send(JSON.stringify({ type: 'run_status', sessionId: asker.sessionId, runId: run.runId, state: 'started' }));
  await page.waitForFunction(`(${BELL_JS}).rows.length === 0`, { timeout: 10_000 }).catch(() => undefined);
  const answered = await evalJs<BellState>(page, BELL_JS);
  await page.screenshot({ path: `${SHOTS}/2-answered-elsewhere.png` });
  if (answered.rows.length !== 0) fail(`the answered plan is still in the bell: ${JSON.stringify(answered.rows)} (${SHOTS}/2-answered-elsewhere.png)`);
  if (answered.badge !== 0) fail(`the badge still says ${answered.badge}`);
  console.log('  ✓ row gone, badge gone');
  await page.keyboard.press('Escape');
  await page.evaluate(`document.querySelector('.notif-scrim')?.click()`);

  step('4. A finishes its turn -> «готова» rings');
  agent.ws.send(JSON.stringify({ type: 'run_status', sessionId: asker.sessionId, runId: run.runId, state: 'idle' }));
  await page.waitForFunction(`(${BELL_JS}).badge === 1`, { timeout: 10_000 });
  console.log('  ✓ badge 1 for the finished turn');

  step('5. The page opens A -> the entry leaves (it has been seen)');
  // Through the side panel, the way a person opens it — a reload would start
  // the bell empty and prove nothing.
  const opened = await page.evaluate(`(() => {
    const row = Array.from(document.querySelectorAll('a.pc-sess')).find((a) => (a.getAttribute('href') || '').includes(${JSON.stringify(asker.sessionId)}));
    if (!row) return false;
    row.click();
    return true;
  })()`);
  if (!opened) fail('session A has no row in the side panel');
  await page.waitForFunction(`location.pathname.includes(${JSON.stringify(asker.sessionId)})`, { timeout: 10_000 }).catch(async () => {
    await page.screenshot({ path: `${SHOTS}/x-not-opened.png` });
    fail(`clicking A's row did not open it: at ${await page.evaluate('location.pathname')}`);
  });
  await page.waitForFunction(`(${BELL_JS}).badge === 0`, { timeout: 10_000 }).catch(() => undefined);
  await page.click('button[aria-label="Уведомления"]');
  await sleep(400);
  const seen = await evalJs<BellState>(page, BELL_JS);
  await page.screenshot({ path: `${SHOTS}/3-opened.png` });
  if (seen.rows.length !== 0) fail(`the finished turn is still in the bell after opening it: ${JSON.stringify(seen.rows)}`);
  console.log('  ✓ opened -> bell empty');

  clearTimeout(timer);
  phone.close();
  await browser.close();
  agent.ws.close();
  console.log(`\nPASS: asked -> rang; answered on another device -> gone; finished -> rang; opened -> gone`);
  console.log(`      screenshots: ${SHOTS}/`);
  process.exit(0);
}

main().catch((e) => fail(e instanceof Error ? e.stack ?? e.message : String(e)));
