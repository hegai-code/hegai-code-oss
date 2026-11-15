/**
 * «Начало»: the button that logs a machine into Codex, pressed in a real
 * browser, and what the row does while the login runs.
 *
 * What it proves, in order:
 *   1. a machine whose agent says «Codex · нет входа» draws a «Войти» button
 *      on «Настройки → Начало» (the fake agent registers with `runtimes`);
 *   2. the click puts a `runtime.login.start` RPC on the wire and the AGENT
 *      receives it — the hub let the device owner through;
 *   3. the agent's answer (a device code and a page) is drawn in the row:
 *      the code, «Открыть страницу», «Скопировать код», «Отмена»;
 *   4. the row polls `runtime.job.status`; when the agent says `done` and
 *      pushes a `runtime_status` with the login, the chip turns
 *      «Codex · Plus · email» and the button is gone.
 *
 * The agent is FAKE (the code arrives on command, nobody logs into ChatGPT);
 * the browser, the web bundle, the hub binary and every frame between them
 * are real. Run it the same way as compact-smoke.ts (deploy/SMOKE-TESTS.md);
 * screenshots land in /tmp/first-run-smoke/.
 */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { adminLogin, enrollFakeAgent, fail, fakeSession, nextAgentFrame, smokeTarget, sleep, chromePath, launchBrowser, step, evalJs } from './_harness.js';


const SHOTS = '/tmp/first-run-smoke';
const target = smokeTarget(process.argv);
const timer = setTimeout(() => fail('timed out (120s)'), 120_000);

const ROW = `document.querySelector('.onb .rt-row[data-runtime="codex"]')`;
const ROW_TEXT = `(${ROW} || {}).textContent || ''`;
const ROW_BUTTONS = `Array.from((${ROW} || document.createElement('div')).querySelectorAll('.rt-actions .btn')).map((b) => b.textContent.trim())`;

async function main(): Promise<void> {
  if (!target.ssoSecret) fail('CC_REMOTE_SSO_SECRET is not set in this shell (must match the hub)');
  const secret = target.ssoSecret;
  mkdirSync(SHOTS, { recursive: true });
  console.log(`[first-run-smoke] hub ${target.http}  chrome ${chromePath()}`);

  step('1. Owner signs in; a fake agent registers with «Codex · нет входа»');
  const owner = await adminLogin(target.http, secret);
  const agent = await enrollFakeAgent(target, owner, { name: 'first-run-box', os: 'mac', sessions: [fakeSession('/home/smoke/proj', 'Проект')] });
  agent.ws.send(
    JSON.stringify({
      type: 'runtime_status',
      runtimes: {
        claude: { present: true, version: '0.3.220', auth: 'oauth', account: 'smoke@example.com', plan: 'max 5x', checkedAt: 1 },
        codex: { present: true, path: '/opt/homebrew/bin/codex', version: '0.154.0', auth: 'none', provider: 'own', checkedAt: 1 },
      },
    }),
  );
  await sleep(300);

  step('2. Real Chrome on «Начало»: the Codex row offers «Войти»');
  const browser = await launchBrowser();
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  page.on('console', (m: { type: () => string; text: () => string }) => {
    if (m.type() === 'error') console.log(`  [browser error] ${m.text()}`);
  });
  const cookie = owner.cookie.split(';')[0] ?? '';
  const [cookieName, ...cookieRest] = cookie.split('=');
  await browser.setCookie({ name: (cookieName ?? '').trim(), value: cookieRest.join('='), domain: '127.0.0.1', path: '/' });
  await page.goto(`${target.http}/w/start`, { waitUntil: 'networkidle2' });
  // Step 2 of the first-run screens («Claude и Codex») holds the runtime rows.
  await page.waitForFunction(`Array.from(document.querySelectorAll('.onb-nav .btn')).some((b) => b.textContent.trim() === 'Дальше')`, { timeout: 20_000 });
  await page.evaluate(`Array.from(document.querySelectorAll('.onb-nav .btn')).find((b) => b.textContent.trim() === 'Дальше').click()`);
  await page.waitForFunction(`(${ROW_BUTTONS}).includes('Войти')`, { timeout: 20_000 });
  await page.screenshot({ path: `${SHOTS}/1-login-offered.png` });
  assert.match(await evalJs<string>(page, ROW_TEXT), /Codex\s*нет входа/);
  console.log('  ✓ «Codex · нет входа» with a «Войти» button');

  step('3. Click «Войти» → the agent receives runtime.login.start → the row shows the code');
  // Other RPCs (projects.list from the page) may be on the wire first; take
  // the first runtime.login.start, not the first frame.
  const rpc = (async () => {
    for (;;) {
      const f = await nextAgentFrame(agent.ws, 'rpc_request');
      if (f.method === 'runtime.login.start') return f;
    }
  })();
  await page.evaluate(`Array.from(${ROW}.querySelectorAll('.rt-actions .btn')).find((b) => b.textContent.trim() === 'Войти').click()`);
  const got = await rpc;
  assert.equal(got.method, 'runtime.login.start');
  assert.deepEqual(got.params, { runtime: 'codex' });
  console.log(`  ✓ agent received ${got.method} (${got.requestId.slice(0, 8)})`);
  const loginId = 'login-smoke-1';
  agent.ws.send(
    JSON.stringify({
      type: 'rpc_response',
      requestId: got.requestId,
      ok: true,
      result: { id: loginId, kind: 'login', runtime: 'codex', state: 'running', url: 'https://auth.openai.com/codex/device', userCode: 'VB0T-DS7P2', expiresAt: Date.now() + 15 * 60_000 },
    }),
  );
  await page.waitForFunction(`/VB0T-DS7P2/.test(${ROW_TEXT})`, { timeout: 15_000 });
  const buttons = await evalJs<string[]>(page, ROW_BUTTONS);
  const href = await evalJs<string | null>(page, `((${ROW}.querySelector('a.btn') || {}).getAttribute || (() => null)).call(${ROW}.querySelector('a.btn'), 'href')`);
  await page.screenshot({ path: `${SHOTS}/2-device-code.png` });
  assert.ok(buttons.includes('Открыть страницу') && buttons.includes('Скопировать код') && buttons.includes('Отмена'), `row buttons: ${buttons.join(' | ')}`);
  assert.equal(href, 'https://auth.openai.com/codex/device');
  console.log(`  ✓ code on screen, buttons: ${buttons.join(' | ')}`);

  step('4. The row polls; done + runtime_status → green chip, no button');
  // Answer polls: the first says running, the next says done — then the
  // agent reports the login the way a real one does after pollUsage().
  let polls = 0;
  const answerPolls = async () => {
    for (;;) {
      const f = await nextAgentFrame(agent.ws, 'rpc_request', 30_000).catch(() => undefined);
      if (!f) return;
      if (f.method !== 'runtime.job.status') continue;
      polls += 1;
      const state = polls >= 2 ? 'done' : 'running';
      agent.ws.send(JSON.stringify({ type: 'rpc_response', requestId: f.requestId, ok: true, result: { id: loginId, kind: 'login', runtime: 'codex', state, url: 'https://auth.openai.com/codex/device', userCode: 'VB0T-DS7P2' } }));
      if (state === 'done') {
        agent.ws.send(
          JSON.stringify({
            type: 'runtime_status',
            runtimes: {
              claude: { present: true, auth: 'oauth', account: 'smoke@example.com', plan: 'max 5x', checkedAt: 2 },
              codex: { present: true, path: '/opt/homebrew/bin/codex', version: '0.154.0', auth: 'chatgpt', account: 'ilya@example.com', plan: 'plus', provider: 'own', checkedAt: 2 },
            },
          }),
        );
        return;
      }
    }
  };
  void answerPolls();
  await page.waitForFunction(`/Codex\\s*Plus · ilya@example\\.com/.test(${ROW_TEXT}) && !(${ROW_BUTTONS}).length`, { timeout: 20_000 });
  await page.screenshot({ path: `${SHOTS}/3-logged-in.png` });
  console.log(`  ✓ after ${polls} poll(s): «Codex · Plus · ilya@example.com», no buttons left`);

  await browser.close();
  agent.ws.close();
  clearTimeout(timer);
  console.log(`\n[first-run-smoke] PASS — screenshots in ${SHOTS}/`);
}

main().catch((e) => fail(e instanceof Error ? (e.stack ?? e.message) : String(e)));
