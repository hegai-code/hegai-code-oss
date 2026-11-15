/**
 * Two live sessions side by side on ONE socket (24.09.2026).
 *
 * Since the window holds a single /ui socket, every pane of the split is a
 * VIEW on it (web/src/sessionChannel.ts) and the hub names the view it answers
 * (`ref`, `reply_ref` in server-rs). What this presses, with a fake agent:
 *   1. a split of two sessions holds one /ui socket;
 *   2. a message sent in each pane resumes that pane's session, and the agent
 *      gets both, each on its own run;
 *   3. each run streams, and each pane shows ITS stream and never the other's;
 *   4. the hub refuses a send from pane B (its machine is between sockets):
 *      the text goes back into B's composer, and A's composer stays empty.
 *
 *   CC_REMOTE_SSO_SECRET=<hub's> tsx server/src/cli/two-panes-smoke.ts ws://127.0.0.1:4321
 *
 * Screenshots land in /tmp/two-panes-smoke/.
 */
import { mkdirSync } from 'node:fs';
import { adminLogin, enrollFakeAgent, fail, fakeSession, nextAgentFrame, smokeTarget, sleep, launchBrowser, step } from './_harness.js';
import type { SessionSummary } from '@cc-remote/shared';


const SHOTS = '/tmp/two-panes-smoke';

const target = smokeTarget(process.argv);
const timer = setTimeout(() => fail('timed out (180s)'), 180_000);

async function main(): Promise<void> {
  if (!target.ssoSecret) fail('CC_REMOTE_SSO_SECRET is not set in this shell (must match the hub)');
  mkdirSync(SHOTS, { recursive: true });

  step('1. Owner, a fake agent with two sessions, a split of both');
  const owner = await adminLogin(target.http, target.ssoSecret);
  const CWD = '/home/smoke/two';
  const sessions: SessionSummary[] = [fakeSession(CWD, 'Левая'), fakeSession(CWD, 'Правая')];
  const agent = await enrollFakeAgent(target, owner, { name: 'two-panes-box', sessions });
  const [A, B] = sessions as [SessionSummary, SessionSummary];
  agent.ws.on('message', (raw: Buffer) => {
    const m = JSON.parse(raw.toString()) as { type: string; requestId?: string; method?: string };
    if (m.type !== 'rpc_request' || !m.requestId) return;
    const result = m.method === 'session.messages' ? { messages: [] } : undefined;
    agent.ws.send(JSON.stringify(result
      ? { type: 'rpc_response', requestId: m.requestId, ok: true, result }
      : { type: 'rpc_response', requestId: m.requestId, ok: false, error: 'not in this smoke' }));
  });

  const browser = await launchBrowser();
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 900 });
  page.on('console', (m: { type: () => string; text: () => string }) => {
    if (m.type() === 'error') console.log(`  [browser error] ${m.text()}`);
  });
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
  await page.goto(`${target.http}/w/sessions/columns?s=${ref(A)},${ref(B)}`, { waitUntil: 'networkidle2' });
  await page.waitForFunction(`document.querySelectorAll('section.session-col .composer textarea').length === 2`, { timeout: 20_000 });
  await sleep(600);
  if (live.size !== 1) fail(`${live.size} live /ui sockets, expected ONE`);
  console.log('  ✓ two panes, one socket');

  const pane = (i: number) => `section.session-col:nth-of-type(${i + 1})`;
  const typeIn = async (i: number, text: string) => {
    await page.click(`${pane(i)} .composer textarea`);
    await page.type(`${pane(i)} .composer textarea`, text);
  };
  const sendIn = (i: number) =>
    page.click(`${pane(i)} button.send-round:not(.stop), ${pane(i)} button.send-btn.resume`);
  const paneText = (i: number) => page.evaluate(`document.querySelector(${JSON.stringify(pane(i))}).innerText`) as Promise<string>;
  const composer = (i: number) =>
    page.evaluate(`document.querySelector(${JSON.stringify(`${pane(i)} .composer textarea`)}).value`) as Promise<string>;

  step('2. A message in each pane resumes that pane\'s own session');
  const resumeA = nextAgentFrame(agent.ws, 'resume');
  await typeIn(0, 'Сообщение слева');
  await sendIn(0);
  const runA = await resumeA;
  if (runA.sessionId !== A.sessionId) fail(`the left pane resumed ${runA.sessionId}, expected ${A.sessionId}`);
  const resumeB = nextAgentFrame(agent.ws, 'resume');
  await typeIn(1, 'Сообщение справа');
  await sendIn(1);
  const runB = await resumeB;
  if (runB.sessionId !== B.sessionId) fail(`the right pane resumed ${runB.sessionId}, expected ${B.sessionId}`);
  console.log(`  ✓ left -> run ${runA.runId.slice(0, 8)}, right -> run ${runB.runId.slice(0, 8)}`);

  step('3. Both runs stream at once; each pane shows its own and only its own');
  const say = (run: { runId: string; sessionId: string }, text: string) =>
    agent.ws.send(JSON.stringify({ type: 'stream', runId: run.runId, sessionId: run.sessionId, event: { kind: 'assistant', text } }));
  agent.ws.send(JSON.stringify({ type: 'run_status', runId: runA.runId, sessionId: A.sessionId, state: 'started' }));
  agent.ws.send(JSON.stringify({ type: 'run_status', runId: runB.runId, sessionId: B.sessionId, state: 'started' }));
  say(runA, 'Поток левой сессии');
  say(runB, 'Поток правой сессии');
  await page.waitForFunction(
    `document.querySelector(${JSON.stringify(pane(0))}).innerText.includes('Поток левой сессии') && document.querySelector(${JSON.stringify(pane(1))}).innerText.includes('Поток правой сессии')`,
    { timeout: 10_000 },
  );
  const [left, right] = [await paneText(0), await paneText(1)];
  await page.screenshot({ path: `${SHOTS}/1-two-streams.png` });
  if (left.includes('Поток правой сессии')) fail('the right run streamed into the left pane');
  if (right.includes('Поток левой сессии')) fail('the left run streamed into the right pane');
  console.log('  ✓ each stream in its own pane');

  step('4. The hub refuses a send from the right pane: the text goes back THERE');
  // Both turns end; then the agent's socket drops. Its runs are held for
  // re-adoption, so the hub refuses the next input with `machine_offline`.
  for (const [run, s] of [[runA, A], [runB, B]] as const) {
    agent.ws.send(JSON.stringify({ type: 'stream', runId: run.runId, sessionId: s.sessionId, event: { kind: 'result', text: '' } }));
    agent.ws.send(JSON.stringify({ type: 'run_status', runId: run.runId, sessionId: s.sessionId, state: 'idle' }));
  }
  await sleep(500);
  agent.ws.close();
  await sleep(400);
  await typeIn(1, 'Не дойдёт');
  await sendIn(1);
  await page.waitForFunction(
    `document.querySelector(${JSON.stringify(`${pane(1)} .composer textarea`)}).value === 'Не дойдёт'`,
    { timeout: 10_000 },
  );
  await sleep(300);
  const [leftBox, rightBox] = [await composer(0), await composer(1)];
  await page.screenshot({ path: `${SHOTS}/2-refused-right.png` });
  if (leftBox !== '') fail(`the left composer got «${leftBox}» — the refusal went to the wrong pane`);
  if (rightBox !== 'Не дойдёт') fail(`the right composer holds «${rightBox}»`);
  console.log('  ✓ the right composer holds its text again; the left one is empty');

  clearTimeout(timer);
  await browser.close();
  console.log('\nPASS: two panes, one socket — each pane streams its own run, and a refusal goes back to the pane that sent');
  process.exit(0);
}

main().catch((e) => fail(e instanceof Error ? e.stack ?? e.message : String(e)));
