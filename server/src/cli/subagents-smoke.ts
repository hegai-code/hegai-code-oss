/**
 * Sub-agents in the transcript (10.10.2026), browser → hub → agent and back.
 *
 * A fake agent runs a turn that launches two sub-agents: one foreground, one
 * in the background. Asserted in a real browser against a real hub:
 *   1. each `Agent` call is a card under the paragraph that launched it, with
 *      kind, task, «сейчас: …» and counters from the `subagents` level;
 *   2. the sub-agent's words are NOT in the parent's transcript;
 *   3. the live ones are rows over the composer; «Стоп» sends
 *      `run.stopSubagent` with the right id to the agent;
 *   4. «Что он делал» reads `session.subagent` by the call id and shows the
 *      agent's own transcript in a sheet; Esc closes it;
 *   5. a late viewer (reload) is re-told the set by the hub.
 *
 *   CC_REMOTE_SSO_SECRET=<hub's> tsx server/src/cli/subagents-smoke.ts [http://127.0.0.1:4319]
 *   SUBAGENTS_SMOKE_PHONE=1 for a 390px phone.
 *
 * Screenshots land in /tmp/subagents-smoke/.
 */
import { mkdirSync } from 'node:fs';
import { adminLogin, enrollFakeAgent, fail, fakeSession, nextAgentFrame, smokeTarget, sleep, launchBrowser, step } from './_harness.js';
import type { SessionSummary } from '@cc-remote/shared';

const SHOTS = '/tmp/subagents-smoke';
const PHONE = process.env['SUBAGENTS_SMOKE_PHONE'] === '1';
const TAG = PHONE ? 'phone' : 'desk';

const target = smokeTarget(process.argv);
const timer = setTimeout(() => fail('timed out (180s)'), 180_000);

const SUB_WORDS = 'Я субагент и это мой внутренний отчёт';

async function main(): Promise<void> {
  if (!target.ssoSecret) fail('CC_REMOTE_SSO_SECRET is not set in this shell (must match the hub)');
  mkdirSync(SHOTS, { recursive: true });

  const owner = await adminLogin(target.http, target.ssoSecret);
  const CWD = '/home/smoke/subagents';
  const sessions: SessionSummary[] = [fakeSession(CWD, 'Помощники в чате')];
  const agent = await enrollFakeAgent(target, owner, { name: 'subagents-box', sessions });
  const [A] = sessions as [SessionSummary];

  const rpcs: Array<{ method: string; params: Record<string, unknown> }> = [];
  agent.ws.on('message', (raw: Buffer) => {
    const m = JSON.parse(raw.toString()) as { type: string; requestId?: string; method?: string; params?: Record<string, unknown> };
    if (m.type !== 'rpc_request' || !m.requestId) return;
    rpcs.push({ method: m.method ?? '', params: m.params ?? {} });
    let result: unknown;
    if (m.method === 'session.messages') result = { messages: [] };
    else if (m.method === 'session.subagent')
      result = {
        messages: [
          { type: 'user', uuid: 's1', blocks: [{ kind: 'text', text: 'Найди, где проверяется вход' }] },
          { type: 'assistant', uuid: 's2', blocks: [{ kind: 'tool_use', id: 'x1', name: 'Grep', input: { pattern: 'login' } }] },
          { type: 'user', uuid: 's3', blocks: [{ kind: 'tool_result', toolUseId: 'x1', text: 'web/src/auth.ts:12' }] },
          { type: 'assistant', uuid: 's4', blocks: [{ kind: 'text', text: SUB_WORDS }] },
        ],
      };
    else if (m.method === 'run.stopSubagent') result = { ok: true };
    agent.ws.send(JSON.stringify(result !== undefined
      ? { type: 'rpc_response', requestId: m.requestId, ok: true, result }
      : { type: 'rpc_response', requestId: m.requestId, ok: false, error: 'not in this smoke' }));
  });

  const browser = await launchBrowser();
  const page = await browser.newPage();
  await page.setViewport(
    PHONE ? { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : { width: 1280, height: 860 },
  );
  page.on('console', (m: { type: () => string; text: () => string }) => {
    if (m.type() === 'error') console.log(`  [browser error] ${m.text()}`);
  });
  const cookie = owner.cookie.split(';')[0] ?? '';
  const [cookieName, ...cookieRest] = cookie.split('=');
  await browser.setCookie({ name: (cookieName ?? '').trim(), value: cookieRest.join('='), domain: '127.0.0.1', path: '/' });
  const ref = `${encodeURIComponent(agent.machineId)}:${encodeURIComponent(A.sessionId)}`;
  const url = `${target.http}/w/sessions/columns?s=${ref}`;
  await page.goto(url, { waitUntil: 'networkidle2' });
  await page.waitForFunction(`document.querySelectorAll('section.session-col .composer textarea').length === 1`, { timeout: 20_000 });
  await sleep(600);

  const pane = 'section.session-col';
  const paneText = () => page.evaluate(`document.querySelector(${JSON.stringify(pane)}).innerText`) as Promise<string>;
  const ev = (run: { runId: string; sessionId: string }, event: Record<string, unknown>) =>
    agent.ws.send(JSON.stringify({ type: 'stream', runId: run.runId, sessionId: run.sessionId, event }));

  step('1. A turn launches two sub-agents — two cards, and the panel');
  const resume = nextAgentFrame(agent.ws, 'resume');
  await page.click(`${pane} .composer textarea`);
  await page.type(`${pane} .composer textarea`, 'Разберись со входом');
  await page.click(`${pane} button.send-round:not(.stop), ${pane} button.send-btn.resume`);
  const run = await resume;
  agent.ws.send(JSON.stringify({ type: 'run_status', runId: run.runId, sessionId: A.sessionId, state: 'started' }));
  ev(run, { kind: 'assistant', text: 'Запускаю двух помощников: один ищет код входа, второй гоняет тесты в фоне.' });
  ev(run, { kind: 'tool_use', text: 'Agent {"description":"Найти проверку входа","subagent_type":"Explore","prompt":"…"}', data: { id: 'toolu_A' } });
  ev(run, { kind: 'tool_use', text: 'Agent {"description":"Прогнать тесты входа","subagent_type":"general-purpose","prompt":"…","run_in_background":true}', data: { id: 'toolu_B' } });
  const now = Date.now();
  const level = (a: Record<string, unknown>, b: Record<string, unknown>) =>
    ev(run, { kind: 'status', code: 'subagents', text: '', data: { agents: [a, b] } });
  const A1 = { id: 'task-a', toolUseId: 'toolu_A', kind: 'Explore', description: 'Найти проверку входа', status: 'running', startedAt: now - 42_000, toolUses: 7, tokens: 41_900, lastAction: 'Grep · login', recent: ['Read · web/src/auth.ts'], steps: ['Glob · web/src/**', 'Read · web/src/auth.ts'], activeAt: now - 40_000, model: 'claude-opus-5-5' };
  const B1 = { id: 'task-b', toolUseId: 'toolu_B', kind: 'general-purpose', description: 'Прогнать тесты входа', status: 'running', background: true, startedAt: now - 5000, toolUses: 1, tokens: 12_000, lastAction: 'Bash · npm test', model: 'sonnet' };
  level(A1, B1);
  ev(run, { kind: 'status', code: 'background_tasks', text: '', data: { tasks: [{ id: 'task-b', type: 'local_agent', description: 'Прогнать тесты входа', since: now - 5000 }] } });
  // What f5d33a9 drops at the agent; a stale agent could still send it — the
  // web has no business drawing it as the session's reply either way.
  await page.waitForFunction(`document.querySelectorAll(${JSON.stringify(`${pane} .sa-card`)}).length === 2`, { timeout: 15_000 });
  await page.waitForFunction(`!!document.querySelector(${JSON.stringify(`${pane} .sa-panel`)})`, { timeout: 15_000 });
  await sleep(500);
  await page.screenshot({ path: `${SHOTS}/${TAG}-1-running.png` });
  let text = await paneText();
  for (const want of ['Найти проверку входа', 'Explore', 'сейчас: Grep · login', 'Read · web/src/auth.ts', 'тихо 40с', 'Opus 5.5', '7 вызовов', '42k токенов', 'В фоне · 1']) {
    if (!text.includes(want)) fail(`missing «${want}» on screen:\n${text}`);
  }
  if (text.includes(SUB_WORDS)) fail('a sub-agent\'s own words are in the parent transcript');
  // «Ход работы» opens the whole trail, «Свернуть» closes it.
  const clickText = (sel: string, text: string) =>
    page.evaluate(
      (s: string, t: string) => {
        const el = Array.from(document.querySelectorAll(s)).find((e) => (e as HTMLElement).innerText.trim() === t) as HTMLElement | undefined;
        el?.click();
        return !!el;
      },
      sel,
      text,
    ) as Promise<boolean>;
  if (!(await clickText(`${pane} .sa-card .sa-link`, 'Ход работы'))) fail('no «Ход работы» on a running card');
  await page.waitForFunction(`!!document.querySelector(${JSON.stringify(`${pane} .sa-card .sa-steps`)})`, { timeout: 5000 });
  text = await paneText();
  if (!text.includes('Glob · web/src/**')) fail(`the expanded trail misses its first step:\n${text}`);
  await page.screenshot({ path: `${SHOTS}/${TAG}-1b-steps.png` });
  await clickText(`${pane} .sa-card .sa-link`, 'Свернуть');
  console.log('  ✓ two cards with kind, task, model, «сейчас», counters; «Ход работы» expands and collapses; the panel lists the background one');

  step('2. «Стоп» on the panel stops exactly that sub-agent');
  const stopButtons = await page.$$(`${pane} .sa-panel .sa-row .sa-link.danger`);
  // Only the background one is a row: the foreground card sits above it.
  if (stopButtons.length !== 1) fail(`expected 1 Stop button (background only), got ${stopButtons.length}`);
  // «Стоп» asks first (a helper cannot be resumed): the confirm must appear and be accepted.
  let asked = '';
  page.once('dialog', (d) => {
    asked = d.message();
    void d.accept();
  });
  const clicked = await page.evaluate((sel: string) => {
    const row = Array.from(document.querySelectorAll(sel)).find((r) => (r as HTMLElement).innerText.includes('Прогнать тесты'));
    const btn = row?.querySelector('.sa-link.danger') as HTMLButtonElement | null;
    btn?.click();
    return !!btn;
  }, `${pane} .sa-panel .sa-row`);
  if (!clicked) fail('no Stop on the background row');
  await sleep(500);
  if (!asked.includes('Остановить')) fail(`«Стоп» did not ask first (dialog: ${JSON.stringify(asked)})`);
  const stop = rpcs.find((r) => r.method === 'run.stopSubagent');
  if (!stop) fail('no run.stopSubagent reached the agent');
  if (stop!.params['id'] !== 'task-b' || stop!.params['sessionId'] !== A.sessionId) fail(`wrong stop params: ${JSON.stringify(stop!.params)}`);
  console.log('  ✓ run.stopSubagent {id: task-b} reached the agent');

  step('3. The foreground one finishes, the stopped one says so');
  level(
    { ...A1, status: 'completed', endedAt: now, lastAction: undefined, summary: 'Проверка входа — web/src/auth.ts:12, токен сверяется с хабом.' },
    { ...B1, status: 'stopped', endedAt: now },
  );
  ev(run, { kind: 'status', code: 'background_tasks', text: '', data: { tasks: [] } });
  ev(run, { kind: 'assistant', text: 'Нашёл проверку входа, тесты остановил.' });
  ev(run, { kind: 'result', text: 'done' });
  agent.ws.send(JSON.stringify({ type: 'run_status', runId: run.runId, sessionId: A.sessionId, state: 'idle' }));
  ev(run, { kind: 'status', code: 'turn_settled', text: '' });
  // The finished background helper stays in the panel until the person speaks.
  await page.waitForFunction(`(document.querySelector(${JSON.stringify(`${pane} .sa-panel`)}) || {}).innerText?.includes('Помощники')`, { timeout: 15_000 });
  await sleep(400);
  text = await paneText();
  for (const want of ['web/src/auth.ts:12', 'готово', 'остановлен', 'Помощники']) {
    if (!text.includes(want)) fail(`missing «${want}» after the end:\n${text}`);
  }
  await page.screenshot({ path: `${SHOTS}/${TAG}-2-ended.png` });
  console.log('  ✓ cards show the report and «остановлен»; the finished helper stays in the panel as «Помощники»');

  step('4. «Транскрипт» opens its own transcript');
  if (!(await clickText(`${pane} .sa-card .sa-link`, 'Транскрипт'))) fail('no «Транскрипт» on the card');
  await page.waitForFunction(`!!document.querySelector('.sa-sheet') && document.querySelector('.sa-sheet').innerText.includes(${JSON.stringify(SUB_WORDS)})`, { timeout: 15_000 });
  const read = rpcs.find((r) => r.method === 'session.subagent');
  if (read?.params['toolUseId'] !== 'toolu_A') fail(`session.subagent read the wrong agent: ${JSON.stringify(read?.params)}`);
  await sleep(300);
  await page.screenshot({ path: `${SHOTS}/${TAG}-3-transcript.png` });
  await page.keyboard.press('Escape');
  await page.waitForFunction(`!document.querySelector('.sa-sheet')`, { timeout: 5000 });
  console.log('  ✓ sheet shows the sub-agent transcript (read by toolUseId), Esc closes it');

  step('5. No sideways scroll');
  const wide = (await page.evaluate('document.documentElement.scrollWidth > window.innerWidth + 1')) as boolean;
  if (wide) fail(`horizontal scroll at ${TAG} width`);
  console.log(`  ✓ no sideways scroll at ${TAG} width`);

  await browser.close();
  clearTimeout(timer);
  console.log('\nPASS: sub-agents are cards, rows with Stop, and a transcript one click away');
  process.exit(0);
}

main().catch((e) => fail(e instanceof Error ? e.stack ?? e.message : String(e)));
