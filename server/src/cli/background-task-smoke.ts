/**
 * A turn that ends on «запустил в фоне, жду» is not a finished job (27.09.2026).
 *
 * An agent older than 26.09 sent the turn's `result` at once: the hub went
 * idle and pushed «готово» 25 minutes early. The agent now withholds it until
 * the background set empties — which left the pane on a bare «работает…» for
 * those 25 minutes, with nothing saying what worked. Now the agent forwards
 * the CLI's live background tasks (`background_tasks`), the hub replays the
 * list to late viewers, and the pane says what runs and for how long.
 * What this presses, with a fake agent, the real hub, the real web bundle:
 *   1. the turn goes quiet with a task alive (`session_state: idle`, no
 *      `result`) → the pane shows «в фоне: …» with the task's own clock instead
 *      of «работает…», and `activity` keeps the run `working`;
 *   2. a viewer who opens the session only now is told what runs;
 *   2b. repeats of one sub-agent's task fold into one row naming the sub-agent,
 *      whose Stop reaches every repeat;
 *   3. the task finishes and the CLI wakes by itself → «работает…» without
 *      anyone having typed, the background line gone;
 *   4. the wake turn ends → `activity` idle, the line stays gone.
 *
 *   CC_REMOTE_SSO_SECRET=<hub's> tsx server/src/cli/background-task-smoke.ts ws://127.0.0.1:4319
 *
 * Screenshots land in /tmp/background-task-smoke/.
 */
import { mkdirSync } from 'node:fs';
import type WebSocket from 'ws';
import { adminLogin, connectUiAs, enrollFakeAgent, fail, fakeSession, nextAgentFrame, smokeTarget, sleep, launchBrowser, step } from './_harness.js';
import type { SessionSummary } from '@cc-remote/shared';

const SHOTS = '/tmp/background-task-smoke';

const target = smokeTarget(process.argv);
const timer = setTimeout(() => fail('timed out (180s)'), 180_000);

/** The last `activity` state the hub broadcast for one run. */
function watchActivity(ws: WebSocket): (runId: string) => string | undefined {
  const last = new Map<string, string>();
  ws.on('message', (raw: Buffer) => {
    const m = JSON.parse(raw.toString()) as { type: string; runs?: { runId: string; state: string }[] };
    if (m.type !== 'activity' || !m.runs) return;
    for (const r of m.runs) last.set(r.runId, r.state);
  });
  return (runId) => last.get(runId);
}

async function main(): Promise<void> {
  if (!target.ssoSecret) fail('CC_REMOTE_SSO_SECRET is not set in this shell (must match the hub)');
  mkdirSync(SHOTS, { recursive: true });

  const owner = await adminLogin(target.http, target.ssoSecret);
  const CWD = '/home/smoke/background';
  const sessions: SessionSummary[] = [fakeSession(CWD, 'Долгая оценка')];
  const agent = await enrollFakeAgent(target, owner, { name: 'bg-box', sessions });
  const [S] = sessions as [SessionSummary];
  const stopped: string[] = [];
  agent.ws.on('message', (raw: Buffer) => {
    const m = JSON.parse(raw.toString()) as { type: string; requestId?: string; method?: string };
    if (m.type !== 'rpc_request' || !m.requestId) return;
    if (m.method === 'run.stopSubagent') stopped.push(String((m as { params?: { id?: unknown } }).params?.id));
    const result = m.method === 'session.messages' ? { messages: [] } : m.method === 'run.stopSubagent' ? { ok: true } : undefined;
    agent.ws.send(JSON.stringify(result
      ? { type: 'rpc_response', requestId: m.requestId, ok: true, result }
      : { type: 'rpc_response', requestId: m.requestId, ok: false, error: 'not in this smoke' }));
  });
  const watcher = await connectUiAs(target.ws, owner);
  const stateOf = watchActivity(watcher);

  const browser = await launchBrowser();
  const cookie = owner.cookie.split(';')[0] ?? '';
  const [cookieName, ...cookieRest] = cookie.split('=');
  await browser.setCookie({ name: (cookieName ?? '').trim(), value: cookieRest.join('='), domain: '127.0.0.1', path: '/' });
  const url = `${target.http}/w/sessions/columns?s=${encodeURIComponent(agent.machineId)}:${encodeURIComponent(S.sessionId)}`;
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });
  page.on('console', (m: { type: () => string; text: () => string }) => {
    if (m.type() === 'error') console.log(`  [browser error] ${m.text()}`);
  });
  await page.goto(url, { waitUntil: 'networkidle2' });
  await page.waitForSelector('section.session-col .composer textarea', { timeout: 20_000 });
  await sleep(600);

  const ev = (run: { runId: string }, event: Record<string, unknown>) =>
    agent.ws.send(JSON.stringify({ type: 'stream', runId: run.runId, sessionId: S.sessionId, event }));
  const tasks = (list: { id: string; description: string; since: number; owner?: string; ownerId?: string }[]) =>
    ({ kind: 'status', code: 'background_tasks', text: '', data: { tasks: list.map((t) => ({ type: 'local_bash', ...t })) } });
  const bgText = (p = page) =>
    p.evaluate(`(document.querySelector('section.session-col .sa-panel') || {}).innerText || ''`) as Promise<string>;
  const working = (p = page) =>
    p.evaluate(`!!document.querySelector('section.session-col .sa-card.sa-self')`) as Promise<boolean>;
  const waitState = async (runId: string, want: string, why: string) => {
    for (let i = 0; i < 50; i++) {
      if (stateOf(runId) === want) return;
      await sleep(100);
    }
    fail(`${why}: activity says «${stateOf(runId)}», expected «${want}»`);
  };

  step('1. The turn ends with a task alive — «в фоне», not «готово»');
  const resume = nextAgentFrame(agent.ws, 'resume');
  await page.click('section.session-col .composer textarea');
  await page.type('section.session-col .composer textarea', 'Прогони оценку всех сессий');
  await page.click('section.session-col button.send-round:not(.stop), section.session-col button.send-btn.resume');
  const run = await resume;
  agent.ws.send(JSON.stringify({ type: 'run_status', runId: run.runId, sessionId: S.sessionId, state: 'started' }));
  ev(run, { kind: 'tool_use', text: 'Bash {"description":"Оценка 335 сессий","run_in_background":true}' });
  ev(run, tasks([{ id: 'b1', description: 'Оценка 335 сессий', since: Date.now() - 65_000 }]));
  ev(run, { kind: 'status', code: 'session_state', text: '', data: { state: 'running' } });
  ev(run, { kind: 'assistant', text: 'Запустил оценку в фоне, это минут двадцать.' });
  // What the real agent sends here: the CLI's own «idle», and NO `result` —
  // it withholds that until the background set empties (turn-settle.ts).
  ev(run, { kind: 'status', code: 'session_state', text: '', data: { state: 'idle' } });
  await page.waitForFunction(`!!document.querySelector('section.session-col .sa-panel')`, { timeout: 10_000 }).catch(async (e: unknown) => {
    await page.screenshot({ path: `${SHOTS}/1-FAIL.png` });
    const t = (await page.evaluate(`document.querySelector('section.session-col').innerText`)) as string;
    fail(`no background line; the pane reads:\n${t.slice(-600)}\n${String(e)}`);
  });
  await sleep(1500);
  await page.screenshot({ path: `${SHOTS}/1-held.png` });
  const held = await bgText();
  if (!/В фоне · 1[\s\S]*Оценка 335 сессий/.test(held)) fail(`the background line reads «${held}»`);
  if (!/1:0\d/.test(held)) fail(`the clock does not count from the task's own start: «${held}»`);
  if (await working()) fail('«работает…» over a turn that ended — the task is in the background, not the turn');
  await waitState(run.runId, 'working', 'a held run');
  console.log(`  ✓ «${held.replace(/\s+/g, ' ')}», activity: working`);

  step('2. A viewer who arrives now is told what runs');
  const late = await browser.newPage();
  await late.setViewport({ width: 1400, height: 900 });
  await late.goto(url, { waitUntil: 'networkidle2' });
  await late.waitForFunction(`!!document.querySelector('section.session-col .sa-panel')`, { timeout: 15_000 });
  const lateText = await bgText(late);
  if (!/Оценка 335 сессий/.test(lateText)) fail(`the late viewer reads «${lateText}»`);
  await late.screenshot({ path: `${SHOTS}/2-late-viewer.png` });
  await late.close();
  console.log('  ✓ the task list was replayed on subscribe');

  step('2b. A sub-agent re-arming one watcher is one row that names it, and Stop takes them all');
  const REPEAT = { description: 'my shots done', owner: 'Admin responsive layout', ownerId: 'helper-1' };
  ev(run, tasks([
    { id: 'b1', description: 'Оценка 335 сессий', since: Date.now() - 65_000 },
    { id: 'm1', since: Date.now() - 300_000, ...REPEAT },
    { id: 'm2', since: Date.now() - 600_000, ...REPEAT },
    { id: 'm3', since: Date.now() - 100_000, ...REPEAT },
  ]));
  await page.waitForFunction(`(document.querySelector('section.session-col .sa-panel') || {}).innerText?.includes('× 3')`, { timeout: 10_000 });
  const folded = await bgText();
  if (!/В фоне · 4/.test(folded)) fail(`the head must count tasks, not rows: «${folded}»`);
  if (!/Admin responsive layout/.test(folded)) fail(`the row does not name its sub-agent: «${folded}»`);
  if (!/\b(9:5\d|10:0\d)\b/.test(folded)) fail(`the row's clock is not its oldest repeat's: «${folded}»`);
  const rowCount = (await page.evaluate(`document.querySelectorAll('section.session-col .sa-panel .sa-row').length`)) as number;
  if (rowCount !== 2) fail(`expected 2 rows (the task, the folded repeats), got ${rowCount}`);
  await page.screenshot({ path: `${SHOTS}/2b-folded.png` });
  // A phone: the row wraps, and the name must still be readable, not pushed off.
  await page.setViewport({ width: 390, height: 844 });
  await sleep(500);
  await page.screenshot({ path: `${SHOTS}/2b-folded-phone.png` });
  const phone = (await page.evaluate(`(() => {
    const el = document.querySelector('section.session-col .sa-panel .sa-owner');
    return { overflow: document.documentElement.scrollWidth - innerWidth, width: el ? el.getBoundingClientRect().width : 0 };
  })()`)) as { overflow: number; width: number };
  if (phone.overflow > 0) fail(`the page scrolls sideways on a phone by ${phone.overflow}px`);
  if (phone.width < 40) fail(`the sub-agent's name is squeezed out on a phone (${phone.width}px)`);
  await page.setViewport({ width: 1400, height: 900 });
  await sleep(300);
  stopped.length = 0;
  page.once('dialog', (d) => void d.accept());
  const stops = await page.$$('section.session-col .sa-panel .sa-row .sa-link.danger');
  await stops[1]!.click();
  for (let i = 0; i < 50 && stopped.length < 3; i++) await sleep(100);
  if (stopped.sort().join() !== 'm1,m2,m3') fail(`Stop on the folded row reached «${stopped.join()}», expected every repeat`);
  ev(run, tasks([{ id: 'b1', description: 'Оценка 335 сессий', since: Date.now() - 65_000 }]));
  await page.waitForFunction(`!(document.querySelector('section.session-col .sa-panel') || {}).innerText?.includes('× 3')`, { timeout: 10_000 });
  console.log(`  ✓ «${folded.replace(/\s+/g, ' ')}»; Stop reached m1, m2, m3`);

  step('3. The task finishes, the CLI wakes by itself — «работает…» with nobody typing');
  ev(run, tasks([]));
  ev(run, { kind: 'status', code: 'session_state', text: '', data: { state: 'running' } });
  await page.waitForFunction(`!document.querySelector('section.session-col .sa-panel')`, { timeout: 10_000 });
  await page.waitForFunction(`!!document.querySelector('section.session-col .sa-card.sa-self')`, { timeout: 10_000 });
  ev(run, { kind: 'assistant', text: 'Оценка готова: 335 сессий, отчёт опубликован.' });
  await sleep(800);
  await page.screenshot({ path: `${SHOTS}/3-woke.png` });
  await waitState(run.runId, 'working', 'the wake turn');
  console.log('  ✓ «работает…» on the CLI\'s own wake-up');

  step('4. The wake turn ends — idle, and nothing in the background');
  ev(run, { kind: 'result', text: 'done' });
  agent.ws.send(JSON.stringify({ type: 'run_status', runId: run.runId, sessionId: S.sessionId, state: 'idle' }));
  ev(run, { kind: 'status', code: 'turn_settled', text: '' });
  await waitState(run.runId, 'idle', 'the finished job');
  await sleep(800);
  if (await working()) fail('«работает…» stayed after the job ended');
  if (await bgText()) fail('the background line came back');
  const text = (await page.evaluate(`document.querySelector('section.session-col').innerText`)) as string;
  if (/background_tasks/.test(text)) fail('the status drew a raw line in the transcript');
  await page.screenshot({ path: `${SHOTS}/4-done.png` });
  console.log('  ✓ activity: idle');

  clearTimeout(timer);
  await browser.close();
  watcher.close();
  console.log('\nPASS: a background task holds the run, the pane says so, the wake-up is work');
  process.exit(0);
}

main().catch((e) => fail(e instanceof Error ? e.stack ?? e.message : String(e)));
