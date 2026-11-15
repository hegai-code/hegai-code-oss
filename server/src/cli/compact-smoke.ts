/**
 * «Сжать контекст», end to end, in a real browser.
 *
 * This smoke exists because the button was reported broken three times and
 * "fixed" twice from structural evidence alone — the schema was present, the
 * agent handler was present, the service was healthy — while the actual defect
 * sat somewhere nobody had looked. First the hub dropped the message at a
 * `_ => {}`; then the chain worked and the UI said nothing for the ~2 minutes
 * `/compact` spends queued, which reads exactly like a dead button. Neither
 * would have survived one run of this file.
 *
 * What it proves, in the order it proves it:
 *   1. a click in a REAL browser puts a `compact` frame on the wire and the
 *      AGENT receives it (the hub-drop bug);
 *   2. the control then holds its pending state past the point a short timer
 *      would have given up (the silent-button bug);
 *   3. it comes back and is pressable again when — and only when — the run
 *      reports the boundary («context compacted: … → … tokens»).
 *
 * Since 27.09.2026 (5e7a4b7) the control is the context RING beside the model
 * picker: it exists once the run has reported `context_usage`, a press asks
 * «Сжать контекст?», «Сжать» sends; pending is the ring's `busy` class. The
 * smoke used to look for a text button under the composer that is gone.
 *
 * The agent is FAKE on purpose. A real one would need a real CLI, a real model
 * and a real two-minute queue to answer one question about a label; the fake
 * one lets the boundary arrive on command, so step 3 is a fact rather than a
 * hope. What is real: the browser, the production web bundle, the hub binary,
 * and every frame between them.
 *
 * Run it (three terminals, or see deploy/SMOKE-TESTS.md for the copy-paste):
 *
 *   npm run build --workspace shared && npm run build --workspace web
 *   cargo build --manifest-path server-rs/Cargo.toml
 *
 *   CC_REMOTE_TOKEN=dev-token \
 *   CC_REMOTE_SSO_SECRET=smoke-sso-secret-0123456789-0123456789 \
 *   CC_REMOTE_PLATFORM_ADMIN_IDS=legacy-owner \
 *   CC_REMOTE_PUBLIC_URL=http://127.0.0.1:4319 \
 *   CC_REMOTE_DB_PATH=/tmp/cc-remote-compact.sqlite3 \
 *   WEB_DIST=web/dist PORT=4319 \
 *   ./server-rs/target/debug/cc-remote-server
 *
 *   CC_REMOTE_SSO_SECRET=<same> tsx server/src/cli/compact-smoke.ts
 *
 * Screenshots of every step land in /tmp/compact-smoke/ — look at them. The
 * assertions below can only check what I thought to assert.
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

const SHOTS = '/tmp/compact-smoke';
const PENDING_LABEL = 'busy';

/** Longer than the 4-second guard this smoke was written to kill, and longer
 *  than any render settle. Short enough that the smoke stays runnable. */
const HELD_FOR_MS = 8_000;

const target = smokeTarget(process.argv);
const timer = setTimeout(() => fail('timed out (120s)'), 120_000);

/** The context ring (the first on the page — the pane under test). `text` is
 *  its state: 'busy' while a compaction is pending, 'idle' otherwise. */
const BUTTON_JS = `
  (() => {
    const b = document.querySelector('button.ctx-ring');
    return b ? { text: b.classList.contains('busy') ? 'busy' : 'idle', disabled: b.classList.contains('busy') } : null;
  })()
`;
interface Ring {
  text: string;
  disabled: boolean;
}

/** Press the ring and confirm «Сжать» — what a person does. */
const PRESS_COMPACT_JS = `
  (async () => {
    document.querySelector('button.ctx-ring').click();
    for (let i = 0; i < 40 && !document.querySelector('.ctx-ask-yes'); i++) await new Promise((r) => setTimeout(r, 50));
    document.querySelector('.ctx-ask-yes').click();
  })()
`;

async function main(): Promise<void> {
  if (!target.ssoSecret) fail('CC_REMOTE_SSO_SECRET is not set in this shell (must match the hub)');
  const secret = target.ssoSecret;
  mkdirSync(SHOTS, { recursive: true });
  console.log(`[compact-smoke] hub ${target.http}  chrome ${chromePath()}`);

  // ------------------------------------------------- 1. an account + a machine
  step('1. Owner signs in, a fake agent reports one session');
  // The machine is enrolled by the BOOTSTRAP owner (`legacy-owner`) on purpose.
  // On a localhost origin the SPA logs into /ui with the fleet token
  // (`App.tsx`: `localDev` → `cc-token` ?? `dev-token`), which the hub resolves
  // to the bootstrap user — so a machine enrolled by any other account is
  // invisible to the browser even though the cookie is that account's. The
  // first run of this smoke burned twenty minutes on exactly that: the hub's
  // own snapshot had the session, the page showed an empty start screen, and
  // the obvious readings (bad route, filtered list) were both wrong.
  const owner = await adminLogin(target.http, secret);
  // NOT a /tmp path: `isScratchCwd` marks anything under /tmp as a scratch
  // session and the web hides it (`isAutomatedSession`), so the snapshot has it
  // and the screen does not — which is exactly how the second failed run of
  // this smoke looked. Use a cwd a person would have.
  const session = fakeSession('/home/smoke/proj', 'Сжатие контекста');
  // A SECOND session, for step 7. The split is two panes or it is not a split:
  // «Колонки» stopped being a screen you can enter with one thing in it, so a
  // one-ref URL now dissolves into the ordinary session view — which would
  // quietly turn step 7 back into step 6 and prove nothing about a pane's own
  // socket.
  const neighbour = fakeSession('/home/smoke/proj', 'Соседняя панель');
  const agent = await enrollFakeAgent(target, owner, {
    name: 'compact-smoke-box',
    sessions: [session, neighbour],
  });

  // Assert the hub actually publishes the session BEFORE the browser is blamed
  // for not showing it. The first run of this smoke failed here and the
  // screenshot (an empty start screen) read as a routing bug.
  const probe = await connectUiAs(target.ws, owner);
  const snap = await nextBrowserFrame(probe, 'snapshot', (s) => s.machines.length > 0);
  const listed = snap.machines.flatMap((m) => m.sessions.map((x) => x.sessionId));
  assert.ok(listed.includes(session.sessionId), `the hub publishes the session (saw ${listed.length})`);
  probe.close();
  console.log(`  ✓ hub snapshot carries ${snap.machines.length} machine(s), session is in it`);

  // ------------------------------------------------------------- 2. a browser
  step('2. Real Chrome, real cookie, the session route');
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
  const url = `${target.http}/w/s/${agent.machineId}/${session.sessionId}`;
  await page.goto(url, { waitUntil: 'networkidle2' });
  await page.waitForSelector('.composer textarea', { timeout: 20_000 });
  await page.screenshot({ path: `${SHOTS}/1-session.png` });
  console.log(`  ✓ session view rendered at ${url}`);

  // --------------------------------------------------------------- 3. a run
  // The button only exists while the pane is attached to a live run, which is
  // the honest precondition: compaction is something you do TO a run.
  step('3. Send a message so the pane holds a run');
  // The browser says `open`; the AGENT is asked to `resume` — the UI verb and
  // the wire verb are different words for the same act (`web-protocol.ts`
  // 'open' -> `protocol.ts` 'resume'). Waiting for 'open' here just times out.
  const openFrame = nextAgentFrame(agent.ws, 'resume');
  await page.type('.composer textarea', 'привет');
  // Two different send buttons, and which one is on screen is state, not
  // styling: a LIVE pane sends with the round arrow (`.send-round`), a dormant
  // one resumes with «Продолжить ↑» (`.send-btn.resume`). A smoke that knows
  // only the first fails on a session nobody has opened yet — which is every
  // session this smoke creates.
  await page.click('button.send-round:not(.stop), button.send-btn.resume');
  const opened = await openFrame;
  console.log(`  ✓ agent received open run=${opened.runId.slice(0, 8)} session=${opened.sessionId.slice(0, 8)}`);
  // The ring shows what the run reported; a real agent sends this on its
  // context poll.
  const reportUsage = () =>
    agent.ws.send(
      JSON.stringify({
        type: 'context_usage',
        runId: opened.runId,
        sessionId: opened.sessionId,
        totalTokens: 746_000,
        maxTokens: 1_000_000,
        percentage: 74.6,
        autoCompactThreshold: 0.92,
        autoCompactEnabled: true,
      }),
    );
  reportUsage();

  await page.waitForFunction(
    `(${BUTTON_JS}) !== null`,
    { timeout: 20_000 },
  );
  const before = await evalJs<Ring | null>(page, BUTTON_JS);
  assert.equal(before?.text, 'idle', 'the ring starts idle');
  assert.equal(before?.disabled, false);
  await page.screenshot({ path: `${SHOTS}/2-idle.png` });
  console.log('  ✓ the context ring is on screen and idle');

  // ------------------------------------------- 4. THE CLICK reaches the agent
  step('4. Ring -> «Сжать» -> the agent must receive a compact frame');
  const compactFrame = nextAgentFrame(agent.ws, 'compact');
  await page.evaluate(PRESS_COMPACT_JS);
  const got = await compactFrame;
  assert.equal(got.runId, opened.runId, 'the compact frame names the run the pane is attached to');
  console.log(`  ✓ agent received compact for run ${got.runId.slice(0, 8)} — the wire is whole`);

  // --------------------------------------------- 5. the button SAYS something
  step('5. The ring stays busy while the command sits in the queue');
  await page.waitForFunction(
    `(${BUTTON_JS})?.text === '${PENDING_LABEL}'`,
    { timeout: 5_000 },
  );
  await page.screenshot({ path: `${SHOTS}/3-pending.png` });
  console.log('  ✓ busy immediately');

  // The regression this pins down: a 4-second timer used to clear the label
  // long before anything happened, so the wait looked like nothing happening.
  // `/compact` has been measured at 1m52s from press to boundary.
  await sleep(HELD_FOR_MS);
  const held = await evalJs<Ring | null>(page, BUTTON_JS);
  assert.equal(held?.text, PENDING_LABEL, `busy must survive ${HELD_FOR_MS / 1000}s of queue`);
  // A press while busy must not ask again — the second press ended in
  // «Not enough messages to compact.».
  await page.evaluate(`document.querySelector('button.ctx-ring').click()`);
  await sleep(300);
  assert.equal(await page.evaluate(`!!document.querySelector('.ctx-ask')`), false, 'a busy ring does not ask again');
  console.log(`  ✓ still busy after ${HELD_FOR_MS / 1000}s, and a second press asks nothing`);

  // ------------------------------------- 6. and stops saying it when it lands
  step('6. The run reports the boundary -> the ring comes back');
  // The CODE is the contract; the text is for people. The first version of the
  // button matched the English sentence, so this frame carried only text —
  // and the sentence was the one thing a rewording on either side would break.
  agent.ws.send(
    JSON.stringify({
      type: 'stream',
      sessionId: opened.sessionId,
      runId: opened.runId,
      event: { kind: 'status', code: 'compact_done', text: 'context compacted: 746k → 10k tokens' },
    }),
  );
  await page.waitForFunction(
    `(${BUTTON_JS})?.text === 'idle'`,
    { timeout: 15_000 },
  );
  // Idle must mean usable again, not merely that the busy paint disappeared.
  // Open the confirmation once more; the next navigation dismisses it.
  await page.evaluate(`document.querySelector('button.ctx-ring').click()`);
  await page.waitForFunction(`!!document.querySelector('.ctx-ask')`, { timeout: 5_000 });
  assert.equal(
    await page.evaluate(`!!document.querySelector('.ctx-ask-yes')`),
    true,
    'the idle ring is pressable again',
  );
  await page.screenshot({ path: `${SHOTS}/4-done.png` });
  console.log("  ✓ idle and pressable again on the run's own word, not on a clock");

  // --------------------------------------------- 7. the same, in a split pane
  // This is where it was actually reported broken. A pane is NOT the session
  // view with a narrower stylesheet: `SessionColumn` gives every one its own
  // `useCentral` — its own socket, its own focus, its own idea of which run is
  // attached — so «works in the session view» says nothing about it. Both
  // layouts, or the smoke is only half a smoke.
  //
  // TWO refs, and the first is the session under test: a split of one is not a
  // split and the route now says so by dissolving into the session view.
  step('7. The same click inside a split pane (its own socket per pane)');
  const ref = (id: string) => `${encodeURIComponent(agent.machineId)}:${encodeURIComponent(id)}`;
  const colsUrl = `${target.http}/w/sessions/columns?s=${ref(session.sessionId)},${ref(neighbour.sessionId)}`;
  await page.goto(colsUrl, { waitUntil: 'networkidle2' });
  await page.waitForFunction(`document.querySelectorAll('.session-col').length === 2`, { timeout: 20_000 });
  // A freshly loaded page has no usage until the agent's next report — the
  // hub does not re-state `context_usage` on subscribe (28.09.2026).
  await sleep(1500);
  reportUsage();
  await page.waitForFunction(`(${BUTTON_JS}) !== null`, { timeout: 20_000 });
  const colCompact = nextAgentFrame(agent.ws, 'compact');
  // The FIRST pane's button — `BUTTON_JS` finds the first match too, so the
  // assertion below is about the same pane the click landed in.
  await page.evaluate(PRESS_COMPACT_JS);
  const colGot = await colCompact;
  assert.equal(colGot.runId, opened.runId, 'the pane compacts ITS run, not whatever was focused last');
  await page.waitForFunction(`(${BUTTON_JS})?.text === '${PENDING_LABEL}'`, { timeout: 5_000 });
  await page.screenshot({ path: `${SHOTS}/5-column-pending.png` });
  console.log(`  ✓ split pane: compact reached the agent for run ${colGot.runId.slice(0, 8)}, ring busy`);

  clearTimeout(timer);
  await browser.close();
  agent.ws.close();
  console.log(`\nPASS: ring -> «Сжать» -> agent frame -> busy held ${HELD_FOR_MS / 1000}s -> boundary -> idle`);
  console.log(`      screenshots: ${SHOTS}/`);
  process.exit(0);
}

main().catch((e) => fail(e instanceof Error ? e.stack ?? e.message : String(e)));
