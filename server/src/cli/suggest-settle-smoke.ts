/**
 * The suggestion strip speaks only when the work is over (25.09.2026).
 *
 * A turn that ENDS is not a turn that is OVER: «запустил агента в фоне, жду»
 * ends one, and the CLI wakes on the agent's result minutes later. The strip
 * used to appear on the SDK's `result`, i.e. in the middle of work. Now the
 * agent says `turn_settled` once the SDK is idle and no background task is
 * alive (agent/src/turn-settle.ts), and the web waits for it
 * (`turnPhase`, web/src/sessionChannel.ts). What this presses, with a fake
 * agent and a hub WITHOUT a gateway (so the strip is the heuristic Да/Нет —
 * the gate is what is under test, not the model):
 *   1. pane A: a turn ends with a yes/no question — `result` + `idle` — and
 *      for three seconds there is NO strip;
 *   2. the agent says `turn_settled` → the strip appears, in pane A only;
 *   3. pane B: an interrupted turn (`result` with no `turn_settled`, which is
 *      what Codex sends) never gets one.
 *
 *   CC_REMOTE_SSO_SECRET=<hub's> tsx server/src/cli/suggest-settle-smoke.ts ws://127.0.0.1:4321
 *
 * Screenshots land in /tmp/suggest-settle-smoke/.
 */
import { mkdirSync } from 'node:fs';
import { adminLogin, enrollFakeAgent, fail, fakeSession, nextAgentFrame, smokeTarget, sleep, launchBrowser, step } from './_harness.js';
import type { SessionSummary } from '@cc-remote/shared';


const SHOTS = '/tmp/suggest-settle-smoke';

const target = smokeTarget(process.argv);
const timer = setTimeout(() => fail('timed out (180s)'), 180_000);

async function main(): Promise<void> {
  if (!target.ssoSecret) fail('CC_REMOTE_SSO_SECRET is not set in this shell (must match the hub)');
  mkdirSync(SHOTS, { recursive: true });

  const owner = await adminLogin(target.http, target.ssoSecret);
  const CWD = '/home/smoke/settle';
  const sessions: SessionSummary[] = [fakeSession(CWD, 'Фоновый агент'), fakeSession(CWD, 'Прерванный ход')];
  const agent = await enrollFakeAgent(target, owner, { name: 'settle-box', sessions });
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
  const cookie = owner.cookie.split(';')[0] ?? '';
  const [cookieName, ...cookieRest] = cookie.split('=');
  await browser.setCookie({ name: (cookieName ?? '').trim(), value: cookieRest.join('='), domain: '127.0.0.1', path: '/' });
  const ref = (s: SessionSummary) => `${encodeURIComponent(agent.machineId)}:${encodeURIComponent(s.sessionId)}`;
  await page.goto(`${target.http}/w/sessions/columns?s=${ref(A)},${ref(B)}`, { waitUntil: 'networkidle2' });
  await page.waitForFunction(`document.querySelectorAll('section.session-col .composer textarea').length === 2`, { timeout: 20_000 });
  await sleep(600);

  const pane = (i: number) => `section.session-col:nth-of-type(${i + 1})`;
  const typeIn = async (i: number, text: string) => {
    await page.click(`${pane(i)} .composer textarea`);
    await page.type(`${pane(i)} .composer textarea`, text);
  };
  const sendIn = (i: number) =>
    page.click(`${pane(i)} button.send-round:not(.stop), ${pane(i)} button.send-btn.resume`);
  const strip = (i: number) =>
    page.evaluate(`!!document.querySelector(${JSON.stringify(`${pane(i)} .enrich-strip`)})`) as Promise<boolean>;
  const ev = (run: { runId: string; sessionId: string }, event: Record<string, unknown>) =>
    agent.ws.send(JSON.stringify({ type: 'stream', runId: run.runId, sessionId: run.sessionId, event }));
  const idle = (run: { runId: string; sessionId: string }) =>
    agent.ws.send(JSON.stringify({ type: 'run_status', runId: run.runId, sessionId: run.sessionId, state: 'idle' }));

  step('1. Pane A: the turn ends, the work does not — no strip');
  const resumeA = nextAgentFrame(agent.ws, 'resume');
  await typeIn(0, 'Раскатай и проверь');
  await sendIn(0);
  const runA = await resumeA;
  agent.ws.send(JSON.stringify({ type: 'run_status', runId: runA.runId, sessionId: A.sessionId, state: 'started' }));
  ev(runA, { kind: 'tool_use', text: 'Agent {"description":"проверить деплой","run_in_background":true}' });
  ev(runA, { kind: 'assistant', text: 'Запустил проверку в фоне, дождусь результата. Раскатывать дальше?' });
  ev(runA, { kind: 'result', text: 'done' });
  idle(runA);
  await page.waitForFunction(
    `document.querySelector(${JSON.stringify(pane(0))}).innerText.includes('Запустил проверку в фоне')`,
    { timeout: 10_000 },
  );
  await sleep(3000);
  await page.screenshot({ path: `${SHOTS}/1-ended-not-settled.png` });
  if (await strip(0)) fail('the strip appeared on `result` — before the agent said the work was over');
  console.log('  ✓ 3 s after `result` + `idle`: no strip');

  step('2. The agent says `turn_settled` — the strip appears, in A only');
  ev(runA, { kind: 'status', code: 'turn_settled', text: '' });
  await page.waitForFunction(`!!document.querySelector(${JSON.stringify(`${pane(0)} .enrich-strip`)})`, { timeout: 10_000 });
  await page.screenshot({ path: `${SHOTS}/2-settled.png` });
  const shown = (await page.evaluate(
    `document.querySelector(${JSON.stringify(`${pane(0)} .enrich-strip`)}).innerText`,
  )) as string;
  if (!/Да/.test(shown)) fail(`the strip holds «${shown}», expected the heuristic Да/Нет on a hub with no gateway`);
  const settledText = (await page.evaluate(`document.querySelector(${JSON.stringify(pane(0))}).innerText`)) as string;
  if (/turn_settled/.test(settledText)) fail('`turn_settled` drew a line in the transcript');
  if (await strip(1)) fail('pane B got a strip from pane A\'s settle');
  console.log(`  ✓ strip: ${shown.replace(/\s+/g, ' ')}`);

  step('3. Pane B: an interrupted turn (no `turn_settled`) never gets one');
  const resumeB = nextAgentFrame(agent.ws, 'resume');
  await typeIn(1, 'Сделай длинную задачу');
  await sendIn(1);
  const runB = await resumeB;
  agent.ws.send(JSON.stringify({ type: 'run_status', runId: runB.runId, sessionId: B.sessionId, state: 'started' }));
  ev(runB, { kind: 'assistant', text: 'Начинаю. Продолжить с тестами?' });
  ev(runB, { kind: 'result', text: 'interrupted' });
  idle(runB);
  await sleep(3000);
  await page.screenshot({ path: `${SHOTS}/3-interrupted.png` });
  if (await strip(1)) fail('an interrupted turn got a strip');
  if (!(await strip(0))) fail('pane A lost its strip');
  console.log('  ✓ no strip under the interrupted turn; A keeps its own');

  clearTimeout(timer);
  await browser.close();
  console.log('\nPASS: the suggestion strip waits for `turn_settled`, not for `result`');
  process.exit(0);
}

main().catch((e) => fail(e instanceof Error ? e.stack ?? e.message : String(e)));
