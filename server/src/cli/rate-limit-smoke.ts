/**
 * The plan limit is a strip over the composer, not a transcript line
 * (29.09.2026, «как в вскоде»).
 *
 * It used to be «approaching the rate limit (seven_day) — resets …» written
 * into the transcript after every request, without the percentage. What this
 * presses, with a fake agent, the real hub, the real web bundle:
 *   1. a `rate_limit` warning (the SDK's `rate_limit_info`, verbatim) → the
 *      strip reads «Использовано 76% недельного лимита · сброс через 2 дн.»
 *      above the field, and NO line lands in the transcript;
 *   2. «×» hides it, and the same warning again keeps it hidden; another view
 *      of the session (which gets the hub's replay) does not show it again;
 *   3. the news gets worse (91%) → it is back;
 *   4. the window is spent → the ember plate, and a line in the transcript too
 *      (that is why the turn stopped);
 *   5. the same strip in dark and on a phone.
 *
 *   CC_REMOTE_SSO_SECRET=<hub's> tsx server/src/cli/rate-limit-smoke.ts ws://127.0.0.1:4319
 *
 * Screenshots land in /tmp/rate-limit-smoke/.
 */
import { mkdirSync } from 'node:fs';
import { adminLogin, enrollFakeAgent, fail, fakeSession, nextAgentFrame, smokeTarget, sleep, launchBrowser, step } from './_harness.js';
import type { SessionSummary } from '@cc-remote/shared';


const SHOTS = '/tmp/rate-limit-smoke';

const target = smokeTarget(process.argv);
const timer = setTimeout(() => fail('timed out (120s)'), 120_000);

async function main(): Promise<void> {
  if (!target.ssoSecret) fail('CC_REMOTE_SSO_SECRET is not set in this shell (must match the hub)');
  mkdirSync(SHOTS, { recursive: true });

  const owner = await adminLogin(target.http, target.ssoSecret);
  const sessions: SessionSummary[] = [fakeSession('/home/smoke/limits', 'Лимиты')];
  const agent = await enrollFakeAgent(target, owner, { name: 'limit-box', sessions });
  const [S] = sessions as [SessionSummary];
  agent.ws.on('message', (raw: Buffer) => {
    const m = JSON.parse(raw.toString()) as { type: string; requestId?: string; method?: string };
    if (m.type !== 'rpc_request' || !m.requestId) return;
    const result = m.method === 'session.messages' ? { messages: [] } : undefined;
    agent.ws.send(JSON.stringify(result
      ? { type: 'rpc_response', requestId: m.requestId, ok: true, result }
      : { type: 'rpc_response', requestId: m.requestId, ok: false, error: 'not in this smoke' }));
  });

  const browser = await launchBrowser();
  const cookie = owner.cookie.split(';')[0] ?? '';
  const [cookieName, ...cookieRest] = cookie.split('=');
  await browser.setCookie({ name: (cookieName ?? '').trim(), value: cookieRest.join('='), domain: '127.0.0.1', path: '/' });
  const url = `${target.http}/w/sessions/columns?s=${encodeURIComponent(agent.machineId)}:${encodeURIComponent(S.sessionId)}`;
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 800 });
  page.on('console', (m: { type: () => string; text: () => string }) => {
    if (m.type() === 'error') console.log(`  [browser error] ${m.text()}`);
  });
  await page.goto(url, { waitUntil: 'networkidle2' });
  await page.waitForSelector('section.session-col .composer textarea', { timeout: 20_000 });
  await sleep(600);

  const resume = nextAgentFrame(agent.ws, 'resume');
  await page.click('section.session-col .composer textarea');
  await page.type('section.session-col .composer textarea', 'Сделай ещё один проход');
  await page.click('section.session-col button.send-round:not(.stop), section.session-col button.send-btn.resume');
  const run = await resume;
  agent.ws.send(JSON.stringify({ type: 'run_status', runId: run.runId, sessionId: S.sessionId, state: 'started' }));
  const ev = (event: Record<string, unknown>) =>
    agent.ws.send(JSON.stringify({ type: 'stream', runId: run.runId, sessionId: S.sessionId, event }));
  const resetsAt = Math.floor((Date.now() + 2 * 86_400_000 + 3 * 3_600_000) / 1000);
  // Exactly what agent/src/claude-session.ts forwards for a `rate_limit_event`.
  const limit = (status: string, utilization?: number, rateLimitType = 'seven_day') =>
    ev({
      kind: 'status',
      code: 'rate_limit',
      text: utilization === undefined ? "исчерпан недельный лимит" : `использовано ${Math.floor(utilization * 100)}% — недельный лимит`,
      data: { status, rateLimitType, resetsAt, ...(utilization !== undefined ? { utilization } : {}) },
    });
  const strip = (p = page) =>
    p.evaluate(`(document.querySelector('section.session-col .composer .rl-banner') || {}).innerText || ''`) as Promise<string>;
  const transcript = (p = page) =>
    p.evaluate(`(document.querySelector('section.session-col .log') || document.querySelector('section.session-col')).innerText`) as Promise<string>;

  step('1. A warning is the strip over the field, with the percentage');
  ev({ kind: 'assistant', text: 'Прошёл по всем файлам, осталось два.' });
  limit('allowed_warning', 0.768);
  ev({ kind: 'result', text: 'done' });
  await page.waitForFunction(`!!document.querySelector('section.session-col .composer .rl-banner')`, { timeout: 10_000 }).catch(async () => {
    await page.screenshot({ path: `${SHOTS}/1-FAIL.png` });
    fail(`no strip; the pane reads:\n${(await transcript()).slice(-600)}`);
  });
  await sleep(500);
  await page.screenshot({ path: `${SHOTS}/1-warning-light.png` });
  const s1 = await strip();
  if (!/^Использовано 76% недельного лимита · сброс через 2 дн\.$/.test(s1.trim())) fail(`the strip reads «${s1}»`);
  if (/недельный лимит|rate limit/i.test(await transcript())) fail('the warning also landed in the transcript');
  console.log(`  ✓ «${s1.trim()}», transcript clean`);

  step('2. «×» hides it; the same warning again stays hidden');
  await page.click('section.session-col .rl-banner-x');
  await page.waitForFunction(`!document.querySelector('section.session-col .rl-banner')`, { timeout: 5_000 });
  limit('allowed_warning', 0.772);
  await sleep(800);
  if (await strip()) fail('a dismissed warning came back at the same level');
  console.log('  ✓ dismissed, and stays dismissed at 77%');

  step('2b. Once is enough: another view of the session does not show it again');
  const other = await browser.newPage();
  await other.setViewport({ width: 1200, height: 800 });
  await other.goto(url, { waitUntil: 'networkidle2' });
  await other.waitForSelector('section.session-col .composer textarea', { timeout: 20_000 });
  limit('allowed_warning', 0.78);
  await sleep(1500);
  if (await strip(other)) fail('a warning already shown came back in another view');
  await other.close();
  console.log('  ✓ a second view (and the replay it gets) stays quiet');

  step('3. The news gets worse — it is back');
  limit('allowed_warning', 0.91);
  await page.waitForFunction(`!!document.querySelector('section.session-col .rl-banner')`, { timeout: 5_000 });
  const s3 = await strip();
  if (!/91%/.test(s3)) fail(`the strip reads «${s3}»`);
  console.log(`  ✓ «${s3.trim()}»`);

  step('4. Spent — the ember plate, and a line in the transcript');
  limit('rejected');
  await page.waitForFunction(`!!document.querySelector('section.session-col .rl-banner.spent')`, { timeout: 5_000 });
  await sleep(400);
  const s4 = await strip();
  if (!/^Недельный лимит исчерпан · сброс через 2 дн\.$/.test(s4.trim())) fail(`the spent strip reads «${s4}»`);
  await page.screenshot({ path: `${SHOTS}/4-spent-light.png` });
  console.log(`  ✓ «${s4.trim()}»`);
  // The refused turn's own `result` keeps it; a turn that goes through clears it.
  ev({ kind: 'result', text: 'limit' });
  await sleep(600);
  if (!/исчерпан/.test(await strip())) fail('the refused turn\'s own result cleared the plate');
  ev({ kind: 'assistant', text: 'Докредитовались, продолжаю.' });
  ev({ kind: 'result', text: 'done' });
  await page.waitForFunction(`!document.querySelector('section.session-col .rl-banner')`, { timeout: 5_000 }).catch(() =>
    fail('a turn that went through left the spent plate up'));
  if (!/Недельный лимит|недельный лимит/.test(await transcript())) fail('the spent window left no line in the transcript');
  console.log('  ✓ held through its own result, gone after a turn that went through; the line stays in the transcript');

  step('5. Dark theme and a phone');
  limit('allowed_warning', 0.93, 'five_hour');
  await page.waitForFunction(`!!document.querySelector('section.session-col .rl-banner:not(.spent)')`, { timeout: 5_000 });
  await page.evaluate(`document.documentElement.setAttribute('data-theme', 'dark')`);
  await sleep(300);
  await page.screenshot({ path: `${SHOTS}/5-warning-dark.png` });
  await page.setViewport({ width: 390, height: 780, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await page.evaluate(`document.documentElement.setAttribute('data-theme', 'light')`);
  await sleep(800);
  await page.screenshot({ path: `${SHOTS}/6-phone.png` });
  const wide = (await page.evaluate(`document.documentElement.scrollWidth > window.innerWidth`)) as boolean;
  if (wide) fail('the strip pushes the page sideways on a phone');
  console.log('  ✓ shots taken, no sideways scroll at 390px');

  clearTimeout(timer);
  await browser.close();
  console.log('\nPASS: the plan limit is a strip over the composer, with the percentage');
  process.exit(0);
}

main().catch((e) => fail(e instanceof Error ? e.stack ?? e.message : String(e)));
