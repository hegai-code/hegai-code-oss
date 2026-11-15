/**
 * «Не вижу исходного сообщения» (27.09.2026): a session started from a
 * composer PANE lost the person's first message for the whole first turn.
 *
 * What happens: the pane becomes the session the moment the agent names it
 * (`session_started`). Its view reads the transcript right then — and the
 * runtime has not flushed the first user record to the .jsonl yet, so the read
 * answers an empty history, successfully. The hub replays the turn's stream on
 * subscribe, so the agent's side is all there; the person's own line lived only
 * in the composer's view and did not come along. Nothing re-read the file until
 * the turn ended, which on a five-minute turn is five minutes without the
 * question the answer is about.
 *
 * This fake agent does exactly that: the FIRST `session.messages` for the new
 * session answers `[]`, every later one answers the file as it now is.
 *
 *   CC_REMOTE_SSO_SECRET=<hub's> tsx server/src/cli/new-session-history-smoke.ts ws://127.0.0.1:4319
 */
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { adminLogin, enrollFakeAgent, fail, fakeSession, nextAgentFrame, smokeTarget, sleep, launchBrowser, step } from './_harness.js';
import type { HistoryMessage, SessionSummary } from '@cc-remote/shared';


const SHOTS = '/tmp/new-session-history-smoke';
const QUESTION = 'Исходный вопрос: почему заголовок непонятный?';

const target = smokeTarget(process.argv);
const timer = setTimeout(() => fail('timed out (120s)'), 120_000);

async function main(): Promise<void> {
  if (!target.ssoSecret) fail('CC_REMOTE_SSO_SECRET is not set in this shell (must match the hub)');
  mkdirSync(SHOTS, { recursive: true });

  step('1. Owner, a fake agent with one session; a split of [that session, composer]');
  const owner = await adminLogin(target.http, target.ssoSecret);
  const CWD = `/home/smoke/nsh-${Math.random().toString(36).slice(2, 6)}`;
  const A: SessionSummary = fakeSession(CWD, 'Старая');
  const agent = await enrollFakeAgent(target, owner, { name: `nsh-box-${CWD.slice(-4)}`, sessions: [A] });

  // The new session's transcript, as the runtime flushes it.
  let newId = '';
  let reads = 0;
  const file: HistoryMessage[] = [];
  agent.ws.on('message', (raw: Buffer) => {
    const m = JSON.parse(raw.toString()) as { type: string; requestId?: string; method?: string; params?: { sessionId?: string } };
    if (m.type !== 'rpc_request' || !m.requestId) return;
    let result: unknown;
    if (m.method === 'session.messages') {
      if (m.params?.sessionId === newId) {
        reads += 1;
        // The race: the first read lands before the first record is on disk.
        result = { messages: reads === 1 ? [] : file };
      } else {
        result = { messages: [] };
      }
    }
    agent.ws.send(JSON.stringify(result !== undefined
      ? { type: 'rpc_response', requestId: m.requestId, ok: true, result }
      : { type: 'rpc_response', requestId: m.requestId, ok: false, error: 'not in this smoke' }));
  });

  const browser = await launchBrowser();
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  const cookie = owner.cookie.split(';')[0] ?? '';
  const [cookieName, ...cookieRest] = cookie.split('=');
  await browser.setCookie({ name: (cookieName ?? '').trim(), value: cookieRest.join('='), domain: '127.0.0.1', path: '/' });
  const ref = `${encodeURIComponent(agent.machineId)}:${encodeURIComponent(A.sessionId)}`;
  // Aim the composer at this project: the pane's composer reads `cc-project`.
  await page.goto(`${target.http}/w/sessions`, { waitUntil: 'networkidle2' });
  await page.evaluate(`localStorage.setItem('cc-project', ${JSON.stringify(`${agent.machineId}::${CWD}`)})`);
  await page.goto(`${target.http}/w/sessions/columns?s=${ref},${encodeURIComponent('/w/new')}`, { waitUntil: 'networkidle2' });
  await page.waitForSelector('section.session-col .start-composer textarea', { timeout: 20_000 });
  console.log('  ✓ split with a composer pane');

  step('2. Send from the composer pane; the agent names the session and starts streaming');
  const startFrame = nextAgentFrame(agent.ws, 'new_session', 20_000);
  await page.type('section.session-col .start-composer textarea', QUESTION);
  await page.click('section.session-col .start-composer button.send-round:not([disabled])');
  const started = await startFrame;
  newId = randomUUID();
  agent.ws.send(JSON.stringify({ type: 'session_started', runId: started.runId, sessionId: newId }));
  agent.ws.send(JSON.stringify({ type: 'run_status', runId: started.runId, sessionId: newId, state: 'started' }));
  // The pane swaps to the session and reads the (still empty) file.
  await page.waitForFunction(`location.search.includes(${JSON.stringify(newId)})`, { timeout: 20_000 });
  // Now the runtime flushes the first record, and the turn goes on.
  file.push({ type: 'user', uuid: randomUUID(), blocks: [{ kind: 'text', text: QUESTION }], ts: Date.now() });
  const say = (text: string) =>
    agent.ws.send(JSON.stringify({ type: 'stream', runId: started.runId, sessionId: newId, event: { kind: 'assistant', text } }));
  say('Смотрю заголовок.');
  await sleep(500);
  say('Тесты и typecheck зелёные.');
  // The inventory catches up, as it does a few seconds in.
  agent.ws.send(JSON.stringify({ type: 'inventory', sessions: [A, { ...fakeSession(CWD, 'Заголовок новости'), sessionId: newId }], complete: true }));

  step('3. Mid-turn, the pane shows the person\'s question — not only the answer');
  try {
    await page.waitForFunction(
      `Array.from(document.querySelectorAll('section.session-col')).some((p) => p.innerText.includes(${JSON.stringify(QUESTION)}) && p.innerText.includes('Тесты и typecheck зелёные.'))`,
      { timeout: 12_000 },
    );
  } catch {
    await page.screenshot({ path: `${SHOTS}/missing-question.png` });
    fail(`the new session's pane never showed the question mid-turn (history reads: ${reads}) — ${SHOTS}/missing-question.png`);
  }
  const count = await page.evaluate(
    `Array.from(document.querySelectorAll('section.session-col')).map((p) => p.innerText.split(${JSON.stringify(QUESTION)}).length - 1).reduce((a, b) => a + b, 0)`,
  );
  await page.screenshot({ path: `${SHOTS}/question-shown.png` });
  if (count !== 1) fail(`the question is on screen ${count} times, expected once`);
  console.log(`  ✓ question shown once, answer streaming under it (history reads: ${reads})`);

  clearTimeout(timer);
  await browser.close();
  agent.ws.close();
  console.log('\nPASS: a session started from a pane keeps the person\'s first message on screen through its first turn');
  process.exit(0);
}

main().catch((e) => fail(e instanceof Error ? e.stack ?? e.message : String(e)));
