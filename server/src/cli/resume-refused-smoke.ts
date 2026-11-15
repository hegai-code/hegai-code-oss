/**
 * A refused resume gives the message — and its picture — back.
 *
 * The bug this pins down read as «картинка не принимается, потому что сессия
 * больше N мегабайт». It was never about the picture. A cold `open` carries
 * the text and the screenshots; the hub sends the agent `resume` and, right
 * behind it, the `input`; the agent parks the input until the liveness check
 * settles, and if it then refuses to launch (transcript over the cap, an
 * editor holding the session) it answers `run_status: error` and drops the
 * parked input. The browser used to restore the composer only on a `yielded`
 * refusal — the over-the-cap one was an `error`, so it ate the text and the
 * screenshots with it and showed one grey line.
 *
 * Now every refusal that means "nothing was delivered" carries
 * `code: resume_refused`, and the browser hands everything back. This smoke
 * proves it the only way that counts: a real browser, a real image attached,
 * a fake agent that refuses, and the composer holding both again.
 *
 * Run it like compact-smoke (see deploy/SMOKE-TESTS.md):
 *
 *   CC_REMOTE_SSO_SECRET=<hub's> tsx server/src/cli/resume-refused-smoke.ts
 */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import {
  adminLogin,
  connectUiAs,
  enrollFakeAgent,
  fail,
  fakeSession,
  nextAgentFrame,
  nextBrowserFrame,
  smokeTarget,
  sleep,
  chromePath,
  launchBrowser,
  step,
  evalJs,
} from './_harness.js';


const SHOTS = '/tmp/resume-refused-smoke';
/** A dormant pane's send: it resumes the session (`Chat.tsx`, the round button
 *  titled «Отправить и продолжить сессию»). */
const RESUME_BUTTON = 'button.send-round[title="Отправить и продолжить сессию"]';
const TEXT = 'посмотри на скриншот и скажи, что не так';

const target = smokeTarget(process.argv);
const timer = setTimeout(() => fail('timed out (120s)'), 120_000);

/** What the composer holds right now: the text and how many image chips. */
const COMPOSER_JS = `
  (() => {
    const ta = document.querySelector('.composer textarea');
    const chips = document.querySelectorAll('.composer .attach-chip').length;
    const echoes = document.querySelectorAll('.log .msg.user').length;
    return { text: ta ? ta.value : null, chips, echoes };
  })()
`;
interface Composer {
  text: string | null;
  chips: number;
  echoes: number;
}

/** Drop a tiny PNG onto the composer, the way a person drags a screenshot in. */
const DROP_PNG_JS = `
  (async () => {
    // 2x2 PNG, base64. Small on purpose: what matters is that an image is
    // staged, not what it shows.
    const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR4AWP4z8DwHwyBNAMDACzAA/+8k4z2AAAAAElFTkSuQmCC';
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const file = new File([bytes], 'shot.png', { type: 'image/png' });
    const dt = new DataTransfer();
    dt.items.add(file);
    const box = document.querySelector('.composer-box');
    box.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
    box.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    return true;
  })()
`;

async function main(): Promise<void> {
  if (!target.ssoSecret) fail('CC_REMOTE_SSO_SECRET is not set in this shell (must match the hub)');
  const secret = target.ssoSecret;
  mkdirSync(SHOTS, { recursive: true });
  console.log(`[resume-refused-smoke] hub ${target.http}  chrome ${chromePath()}`);

  step('1. Owner signs in, a fake agent reports one dormant session');
  const owner = await adminLogin(target.http, secret);
  const session = fakeSession('/home/smoke/bigproj', 'Большая сессия');
  const agent = await enrollFakeAgent(target, owner, { name: 'refused-smoke-box', sessions: [session] });
  const probe = await connectUiAs(target.ws, owner);
  const snap = await nextBrowserFrame(probe, 'snapshot', (s) => s.machines.length > 0);
  assert.ok(
    snap.machines.flatMap((m) => m.sessions.map((x) => x.sessionId)).includes(session.sessionId),
    'the hub publishes the session',
  );
  probe.close();

  step('2. Real Chrome on the session route');
  const browser = await launchBrowser();
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  page.on('console', (m: { type: () => string; text: () => string }) => {
    if (m.type() === 'error') console.log(`  [browser error] ${m.text()}`);
  });
  const cookie = owner.cookie.split(';')[0] ?? '';
  const [cookieName, ...cookieRest] = cookie.split('=');
  await browser.setCookie({
    name: (cookieName ?? '').trim(),
    value: cookieRest.join('='),
    domain: '127.0.0.1',
    path: '/',
  });
  await page.goto(`${target.http}/w/s/${agent.machineId}/${session.sessionId}`, { waitUntil: 'networkidle2' });
  await page.waitForSelector('.composer textarea', { timeout: 20_000 });

  step('3. Type a message and drop a screenshot onto the composer');
  await page.type('.composer textarea', TEXT);
  await page.evaluate(DROP_PNG_JS);
  await page.waitForFunction(`(${COMPOSER_JS}).chips > 0`, { timeout: 10_000 });
  const staged = await evalJs<Composer>(page, COMPOSER_JS);
  assert.equal(staged.text, TEXT);
  await page.screenshot({ path: `${SHOTS}/1-staged.png` });
  console.log(`  ✓ staged: «${staged.text}» + ${staged.chips} image chip(s)`);

  step('4. Send -> the agent is asked to resume, then the input rides behind it');
  const resumeFrame = nextAgentFrame(agent.ws, 'resume');
  const inputFrame = nextAgentFrame(agent.ws, 'input');
  await page.click('button.send-round:not(.stop), button.send-btn.resume');
  const opened = await resumeFrame;
  const input = await inputFrame;
  assert.equal(input.runId, opened.runId);
  assert.equal(input.text, TEXT);
  assert.equal(input.images?.length, 1, 'the image reached the agent with the text');
  const sent = await evalJs<Composer>(page, COMPOSER_JS);
  assert.equal(sent.text, '', 'the composer clears on send, as it should');
  assert.equal(sent.echoes, 1, 'the optimistic echo is on screen');
  await page.screenshot({ path: `${SHOTS}/2-sent.png` });
  console.log(`  ✓ agent got resume ${opened.runId.slice(0, 8)} and the input (${input.images?.length} image)`);

  step('5. The agent REFUSES the resume (transcript over the cap) with resume_refused');
  agent.ws.send(
    JSON.stringify({
      type: 'run_status',
      sessionId: opened.sessionId,
      runId: opened.runId,
      state: 'error',
      code: 'resume_refused',
      error: 'transcript is 2000MB (limit 1024MB) — too large to resume. Its history stays readable here, but this session can no longer be continued: start a new one and paste in what matters.',
    }),
  );
  await page.waitForFunction(`(${COMPOSER_JS}).text === ${JSON.stringify(TEXT)}`, { timeout: 10_000 });
  await sleep(300);
  const restored = await evalJs<Composer>(page, COMPOSER_JS);
  assert.equal(restored.text, TEXT, 'the text is back in the composer');
  assert.ok(restored.chips > 0, 'and so is the screenshot');
  assert.equal(restored.echoes, 0, 'the echo of a message that was never sent is gone');
  await page.screenshot({ path: `${SHOTS}/3-restored.png` });
  console.log(`  ✓ composer holds «${restored.text}» and ${restored.chips} chip(s) again; ${restored.echoes} stray echo(es)`);

  step('6. The same when the session is held by an editor (yielded)');
  // The pane is dormant again — the refusal released the run — so the send
  // button is the resume one. Wait for it: the state flips a tick after the
  // text comes back. Since 27.09.2026 (ac9ea1c) a dormant pane resumes with
  // the same round button as a live one; only its title says «продолжить».
  await page.waitForSelector(RESUME_BUTTON + ':not([disabled])', { timeout: 10_000 });
  // Log every frame the page sends from here on (as console errors, which the
  // hook above prints) — the cheapest way to see whether a click reached the wire.
  await page.evaluate(`
    (() => {
      const orig = WebSocket.prototype.send;
      WebSocket.prototype.send = function (d) { console.error('[ws→] ' + String(d).slice(0, 120)); return orig.call(this, d); };
    })()
  `);
  const resume2 = nextAgentFrame(agent.ws, 'resume', 15_000);
  // The refusal toast sits over the composer for nine seconds, and a real
  // click lands on whatever is on top — so this one is dispatched on the
  // element, the way a keyboard would reach it.
  await page.evaluate(`document.querySelector(${JSON.stringify(RESUME_BUTTON)}).click()`);
  const opened2 = await resume2.catch(async (e: Error) => {
    const text = await page.evaluate('document.body.innerText');
    console.log(`  [page text] ${String(text).slice(0, 1200)}`);
    throw e;
  });
  agent.ws.send(
    JSON.stringify({
      type: 'run_status',
      sessionId: opened2.sessionId,
      runId: opened2.runId,
      state: 'yielded',
      code: 'resume_refused',
      error: 'session is live in claude-vscode (pid 4242) — refused to start a second writer',
    }),
  );
  await page.waitForFunction(`(${COMPOSER_JS}).text === ${JSON.stringify(TEXT)}`, { timeout: 10_000 });
  const restored2 = await evalJs<Composer>(page, COMPOSER_JS);
  assert.ok(restored2.chips > 0, 'the screenshot survives a yielded refusal too');
  await page.screenshot({ path: `${SHOTS}/4-yielded.png` });
  console.log(`  ✓ yielded: text and ${restored2.chips} chip(s) restored`);

  clearTimeout(timer);
  await browser.close();
  agent.ws.close();
  console.log(`\nPASS: send with image -> agent refuses (resume_refused) -> composer holds text + image again`);
  console.log(`      screenshots: ${SHOTS}/`);
  process.exit(0);
}

main().catch((e) => fail(e instanceof Error ? e.stack ?? e.message : String(e)));
