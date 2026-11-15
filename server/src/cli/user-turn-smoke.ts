/**
 * A person's turn shows on EVERY screen on the run (28.09.2026).
 *
 * Owner typed «1-4 гоу» on the phone while the desktop followed the same run:
 * the desktop streamed «Беру 1–4…» straight under the previous answer and the
 * question was nowhere. A human turn existed only as the sending composer's
 * local echo. Now the hub announces it (`user_turn`). What this presses, with
 * a fake agent and three real browser pages:
 *   1. the desktop follows the run; the phone sends into it;
 *   2. the desktop shows the question, ONCE, above the answer;
 *   3. the phone shows its own message ONCE (echo and frame fold together);
 *   4. a third screen opened mid-turn shows the question once — whether the
 *      file already has the turn or not — and no copy of the answer twice;
 *   5. compaction said three times is one Russian line.
 *
 *   CC_REMOTE_SSO_SECRET=<hub's> tsx server/src/cli/user-turn-smoke.ts ws://127.0.0.1:4319
 *
 * Screenshots land in /tmp/user-turn-smoke/.
 */
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { adminLogin, enrollFakeAgent, fail, fakeSession, nextAgentFrame, smokeTarget, sleep, launchBrowser, step } from './_harness.js';
import type { Browser, Page } from 'puppeteer-core';
import type { SessionSummary } from '@cc-remote/shared';

const SHOTS = '/tmp/user-turn-smoke';
const target = smokeTarget(process.argv);
const timer = setTimeout(() => fail('timed out (180s)'), 180_000);

type Msg = { type: 'user' | 'assistant'; uuid: string; blocks: unknown[]; ts: number };
const said = (type: 'user' | 'assistant', text: string): Msg => ({
  type,
  uuid: randomUUID(),
  blocks: [{ kind: 'text', text }],
  ts: Date.now(),
});

/** How many times `needle` occurs in the transcript area of a page. */
const count = (hay: string, needle: string) => hay.split(needle).length - 1;

async function main(): Promise<void> {
  if (!target.ssoSecret) fail('CC_REMOTE_SSO_SECRET is not set in this shell (must match the hub)');
  mkdirSync(SHOTS, { recursive: true });

  step('1. A session whose last answer asks a question; desktop and phone open it');
  const owner = await adminLogin(target.http, target.ssoSecret);
  const s: SessionSummary = fakeSession('/home/smoke/turns', 'Реплики');
  const agent = await enrollFakeAgent(target, owner, { name: 'turns-box', sessions: [s] });
  // The ".jsonl": what the agent has on disk right now.
  const disk: Msg[] = [said('user', 'Как тебе?'), said('assistant', 'Делаю пункты 1–4, а 5-й откладываем?')];
  agent.ws.on('message', (raw: Buffer) => {
    const m = JSON.parse(raw.toString()) as { type: string; requestId?: string; method?: string; params?: { limit?: number } };
    if (m.type !== 'rpc_request' || !m.requestId) return;
    const result = m.method === 'session.messages' ? { messages: disk.slice(-(m.params?.limit ?? 300)) } : undefined;
    agent.ws.send(JSON.stringify(result
      ? { type: 'rpc_response', requestId: m.requestId, ok: true, result }
      : { type: 'rpc_response', requestId: m.requestId, ok: false, error: 'not in this smoke' }));
  });

  const cookie = owner.cookie.split(';')[0] ?? '';
  const [cookieName, ...cookieRest] = cookie.split('=');
  const url = `${target.http}/w/s/${encodeURIComponent(agent.machineId)}/${encodeURIComponent(s.sessionId)}`;
  // One BROWSER per screen, not one tab each: they are different devices, and
  // headless tabs of one browser share a window — only the front one is
  // visible, a hidden narrow page hushes its socket, a hidden page never paints.
  const browsers: Browser[] = [];
  const screen = async (width: number, height: number) => {
    const browser = await launchBrowser();
    browsers.push(browser);
    await browser.setCookie({ name: (cookieName ?? '').trim(), value: cookieRest.join('='), domain: '127.0.0.1', path: '/' });
    const page = await browser.newPage();
    await page.setViewport({ width, height });
    page.on('console', (m: { type: () => string; text: () => string }) => {
      if (m.type() === 'error') console.log(`  [browser error] ${m.text()}`);
    });
    await page.goto(url, { waitUntil: 'networkidle2' });
    await page.waitForFunction(`document.body.innerText.includes('5-й откладываем')`, { timeout: 20_000 });
    return page;
  };
  const text = (page: { evaluate: (s: string) => Promise<unknown> }) =>
    page.evaluate(`(document.querySelector('.log') || document.body).innerText`) as Promise<string>;
  const send = async (page: Page, t: string) => {
    await page.click('.composer textarea');
    await page.type('.composer textarea', t);
    await page.click('button.send-round:not(.stop), button.send-btn.resume');
  };
  const stream = (run: { runId: string }, event: Record<string, unknown>) =>
    agent.ws.send(JSON.stringify({ type: 'stream', runId: run.runId, sessionId: s.sessionId, event }));
  const status = (run: { runId: string }, state: string) =>
    agent.ws.send(JSON.stringify({ type: 'run_status', runId: run.runId, sessionId: s.sessionId, state }));

  const phone = await screen(390, 844);
  // The phone starts the run (a resume with no words) — then the desktop
  // attaches to it the way it does in life: by seeing it in `activity`.
  const resume = nextAgentFrame(agent.ws, 'resume');
  await send(phone, 'Пересобери отчёт');
  const run = await resume;
  status(run, 'started');
  disk.push(said('user', 'Пересобери отчёт'));
  stream(run, { kind: 'assistant', text: 'Пересобрал. Делаю пункты 1–4, а 5-й откладываем?' });
  disk.push(said('assistant', 'Пересобрал. Делаю пункты 1–4, а 5-й откладываем?'));
  stream(run, { kind: 'result', text: '' });
  status(run, 'idle');
  const desk = await screen(1280, 900);
  await desk.waitForFunction(`document.body.innerText.includes('Пересобрал.')`, { timeout: 15_000 });
  await sleep(1500);
  console.log('  ✓ both screens show the session, the desktop is attached to the idle run');

  step('2. The phone answers «1-4 гоу» into the idle run');
  const input = nextAgentFrame(agent.ws, 'input');
  await send(phone, '1-4 гоу');
  await input;
  status(run, 'started');
  disk.push(said('user', '1-4 гоу'));
  await sleep(600);
  stream(run, { kind: 'partial', text: 'Беру 1–4. ' });
  stream(run, { kind: 'assistant', text: 'Беру 1–4. Начинаю со схемы.' });
  disk.push(said('assistant', 'Беру 1–4. Начинаю со схемы.'));
  stream(run, { kind: 'tool_use', text: 'Bash ls', data: {} });
  await desk.waitForFunction(`document.body.innerText.includes('Начинаю со схемы')`, { timeout: 10_000 });
  await sleep(500);
  const deskText = await text(desk);
  await desk.screenshot({ path: `${SHOTS}/1-desktop.png` });
  if (count(deskText, '1-4 гоу') !== 1) fail(`the desktop shows «1-4 гоу» ${count(deskText, '1-4 гоу')} times, expected 1`);
  if (deskText.indexOf('1-4 гоу') > deskText.indexOf('Начинаю со схемы')) fail('the question is below its answer on the desktop');
  console.log('  ✓ the desktop shows the question once, above the answer');

  step('3. The phone shows its own message once');
  const phoneText = await text(phone);
  await phone.screenshot({ path: `${SHOTS}/2-phone.png` });
  if (count(phoneText, '1-4 гоу') !== 1) fail(`the phone shows «1-4 гоу» ${count(phoneText, '1-4 гоу')} times, expected 1`);
  console.log('  ✓ echo and the hub\'s frame are one bubble');

  step('4. A third screen opened mid-turn');
  const late = await screen(390, 844);
  await late.waitForFunction(`document.body.innerText.includes('Начинаю со схемы')`, { timeout: 10_000 });
  await sleep(1500);
  const lateText = await text(late);
  await late.screenshot({ path: `${SHOTS}/3-late.png` });
  if (count(lateText, '1-4 гоу') !== 1) fail(`the late screen shows «1-4 гоу» ${count(lateText, '1-4 гоу')} times, expected 1`);
  if (count(lateText, 'Начинаю со схемы') !== 1) fail(`the late screen shows the answer ${count(lateText, 'Начинаю со схемы')} times`);
  console.log('  ✓ question once, answer once');

  step('5. Compaction announced three times is one Russian line');
  stream(run, { kind: 'status', code: 'compact_started', text: 'compacting context… (queued behind the current turn)' });
  stream(run, { kind: 'status', code: 'compact_started', text: 'compacting context…' });
  stream(run, { kind: 'status', code: 'compact_started', text: 'compacting context…' });
  await desk.waitForFunction(`document.body.innerText.includes('Сжимаю контекст')`, { timeout: 10_000 });
  await sleep(300);
  const compact = await text(desk);
  await desk.screenshot({ path: `${SHOTS}/4-compacting.png` });
  if (count(compact, 'Сжимаю контекст') !== 1) fail(`«Сжимаю контекст» ${count(compact, 'Сжимаю контекст')} times`);
  if (compact.includes('compacting context')) fail('the English line is still shown');
  console.log('  ✓ one line, «Сжимаю контекст…»');

  stream(run, { kind: 'result', text: '' });
  status(run, 'idle');
  for (const b of browsers) await b.close();
  clearTimeout(timer);
  console.log('\n[user-turn-smoke] PASS');
  process.exit(0);
}

main().catch((e) => fail(String(e instanceof Error ? e.stack : e)));
