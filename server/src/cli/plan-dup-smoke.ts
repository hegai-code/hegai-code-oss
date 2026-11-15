/**
 * One plan, one modal — in «Колонки», where it was two.
 *
 * The incident: an ExitPlanMode plan appeared TWICE on one screen. Not two
 * requests — one request, drawn by two surfaces of the same tab. The shell's
 * `useCentral` stays attached to the session it last focused and NOTHING
 * detaches it on the way to /w/sessions/columns; every `SessionColumn` then
 * opens its OWN /ui socket and focuses the same session. The hub fans a
 * `tool_request` out to every viewer that may drive the run (`to_run_deciders`
 * — deliberately, so a second device is not left out of a decision), so both
 * hooks held the same question and both drew it: App's `ModalHost` and the
 * pane's own `QuestionModal`. Answering one left the other standing, and
 * pressing the leftover sent a decision the agent has already forgotten.
 *
 * What this proves, in the order it proves it:
 *   1. the plan is on screen EXACTLY ONCE while the split shows the session the
 *      shell is still attached to — and the copy that survives is the PANE's,
 *      the one sitting under the transcript the plan is about;
 *   2. answering it reaches the agent exactly ONCE — the count matters, because
 *      the failure mode of "two modals" is also "two decisions";
 *   3. nothing is left on screen afterwards;
 *   4. walking back into the session view raises no stale plan. That last one
 *      is the hub's half: `tool_decision` now fans a `tool_resolved` back out
 *      over the same `to_run_deciders`, so the hook that did not answer drops
 *      its copy instead of keeping it for the next time it is rendered.
 *
 * Step 1 is the one that can see the bug: with the pre-fix `App.tsx` +
 * `ModalHost.tsx` it counts 2 backdrops and 2 `.q-plan`s. Verified by
 * rebuilding the bundle from HEAD for those two files — a smoke that has never
 * failed against the defect is a smoke that proves nothing.
 *
 * Run it like compact-smoke (see deploy/SMOKE-TESTS.md):
 *
 *   npm run build --workspace shared && npm run build --workspace web
 *   cargo build --manifest-path server-rs/Cargo.toml
 *
 *   CC_REMOTE_TOKEN=dev-token \
 *   CC_REMOTE_SSO_SECRET=smoke-sso-secret-0123456789-0123456789 \
 *   CC_REMOTE_PLATFORM_ADMIN_IDS=legacy-owner \
 *   CC_REMOTE_PUBLIC_URL=http://127.0.0.1:4319 \
 *   CC_REMOTE_DB_PATH=/tmp/cc-remote-smoke.sqlite3 \
 *   WEB_DIST=web/dist PORT=4319 \
 *   ./server-rs/target/debug/cc-remote-server
 *
 *   CC_REMOTE_SSO_SECRET=<same> tsx server/src/cli/plan-dup-smoke.ts
 *
 * Screenshots land in /tmp/plan-dup-smoke/ — look at them. A count of 1 is also
 * what you get when the modal is drawn off-screen, and only the PNG says which.
 */
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

const SHOTS = '/tmp/plan-dup-smoke';
const PLAN = 'Шаг 1. Прочитать роутер.\nШаг 2. Починить дубль.\nШаг 3. Доказать смоуком.';
const REQUEST_ID = 'plan-dup-req-1';

/** Long enough for a SECOND modal to mount if one is coming. React renders both
 *  copies in the same commit, so this is paranoia rather than a real race — but
 *  a smoke that counts too early reports the bug fixed for free. */
const SETTLE_MS = 800;

const target = smokeTarget(process.argv);
const timer = setTimeout(() => fail('timed out (120s)'), 120_000);

/**
 * What approval surfaces are on screen, and where they live.
 *
 * `inColumn` is the load-bearing half: both copies are `.modal-backdrop` with a
 * `.q-plan` inside, and the only thing that tells them apart is their ancestor —
 * the pane renders its `QuestionModal` INSIDE `section.session-col`, the shell's
 * `ModalHost` renders at the root of the app. Counting backdrops alone would
 * pass a build that kept the wrong one.
 */
const MODALS_JS = `
  (() => {
    const plans = Array.from(document.querySelectorAll('.q-plan'));
    return {
      backdrops: document.querySelectorAll('.modal-backdrop').length,
      plans: plans.length,
      inColumn: plans.filter((p) => p.closest('section.session-col')).length,
      // "On screen", not "in the DOM": a modal with no client rects is a modal
      // nobody is looking at, and the bug reported was visual.
      visible: plans.filter((p) => p.getClientRects().length > 0).length,
    };
  })()
`;
interface Modals {
  backdrops: number;
  plans: number;
  inColumn: number;
  visible: number;
}

async function main(): Promise<void> {
  if (!target.ssoSecret) fail('CC_REMOTE_SSO_SECRET is not set in this shell (must match the hub)');
  const secret = target.ssoSecret;
  mkdirSync(SHOTS, { recursive: true });
  console.log(`[plan-dup-smoke] hub ${target.http}  chrome ${chromePath()}`);

  // ------------------------------------------------- 1. an account + a machine
  step('1. Owner signs in, a fake agent reports one session');
  // Enrolled by the BOOTSTRAP owner on purpose: on a localhost origin the SPA
  // logs into /ui with the fleet token, which the hub resolves to that user, so
  // a machine enrolled by anyone else is invisible to the page (SMOKE-TESTS.md
  // trap 1).
  const owner = await adminLogin(target.http, secret);
  // Not a /tmp cwd — `isScratchCwd` hides those from every list in the web
  // (trap 2), and this smoke needs the session both addressable AND pickable.
  const session = fakeSession('/home/smoke/proj', 'План в две колонки');
  // The split needs a second pane, and a pane is added the way a person adds
  // one: right-click another session's row → «Добавить в колонку».
  const neighbour = fakeSession('/home/smoke/proj', 'Соседняя колонка');
  const agent = await enrollFakeAgent(target, owner, {
    name: 'plan-dup-smoke-box',
    sessions: [session, neighbour],
  });

  // Count decisions at the far end from the first moment, not from the click:
  // a duplicated modal answered twice is the same defect wearing the other
  // face, and it would show up here as a second frame.
  let decisions = 0;
  agent.ws.on('message', (raw: Buffer) => {
    try {
      const msg = JSON.parse(raw.toString()) as { type?: string };
      if (msg.type === 'tool_decision') decisions += 1;
    } catch {
      /* not JSON — not ours */
    }
  });

  const probe = await connectUiAs(target.ws, owner);
  const snap = await nextBrowserFrame(probe, 'snapshot', (s) => s.machines.length > 0);
  const listed = snap.machines.flatMap((m) => m.sessions.map((x) => x.sessionId));
  if (!listed.includes(session.sessionId)) fail(`the hub does not publish the session (saw ${listed.length})`);
  probe.close();
  console.log(`  ✓ hub snapshot carries the session`);

  // ------------------------------------------------------------- 2. a browser
  step('2. Real Chrome, real cookie, the session route');
  const browser = await launchBrowser();
  const page = await browser.newPage();
  // Desk width on purpose: «Колонки» is desk-only, and below 861px App redirects
  // a split to its first session — where there is no second surface and no bug.
  await page.setViewport({ width: 1440, height: 900 });
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
  console.log(`  ✓ session view rendered`);

  // --------------------------------------------------------------- 3. a run
  step('3. Send a message so the SHELL hook is attached to a live run');
  // This is the precondition the bug needs and the reason it was never seen in
  // the session view alone: the shell's hook only raises a modal for the run it
  // considers active (`msg.runId !== activeRef.current?.runId` -> break), and
  // nothing in the router clears that when you leave for the split.
  const resumeFrame = nextAgentFrame(agent.ws, 'resume');
  await page.type('.composer textarea', 'составь план');
  // Two send buttons, chosen by state: a live pane sends with the round arrow,
  // a dormant one resumes with «Продолжить ↑». A fresh fake session is always
  // the second (trap 4).
  await page.click('button.send-round:not(.stop), button.send-btn.resume');
  const opened = await resumeFrame;
  console.log(`  ✓ agent received resume run=${opened.runId.slice(0, 8)}`);

  // ----------------------------------------- 4. into the split, the human way
  step('4. Right-click a neighbour -> «Добавить в колонку» -> a split with this session in a pane');
  // Navigated by pressing the button a person presses, not by page.goto: a full
  // load would mount a FRESH shell hook with no attached run, which is exactly
  // the state in which this bug does not happen. The defect lives in the
  // carry-over, so the smoke has to carry over.
  const rowFound = await page.evaluate(`(() => {
    const row = Array.from(document.querySelectorAll('a.pc-sess')).find((a) => a.title === ${JSON.stringify(neighbour.title)});
    if (!row) return false;
    const r = row.getBoundingClientRect();
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.x + 10, clientY: r.y + 5 }));
    return true;
  })()`);
  if (!rowFound) fail('the neighbour session has no row in the side panel to right-click');
  await page.waitForSelector('[role="menuitem"]', { timeout: 5_000 });
  const added = await page.evaluate(`(() => {
    const item = Array.from(document.querySelectorAll('[role="menuitem"]')).find((b) => b.textContent.includes('Добавить в колонку'));
    if (!item) return false;
    item.click();
    return true;
  })()`);
  if (!added) fail('the row menu has no «Добавить в колонку»');
  await page.waitForFunction(`document.querySelectorAll('section.session-col').length === 2`, { timeout: 20_000 });
  // The pane is attached to the run only once ITS socket has subscribed, and
  // «Сжать контекст» is the cheapest honest proof of that: `Chat` renders it
  // under `isActive`. Without this wait the tool_request can land while only
  // the shell holds the run — one modal, green smoke, nothing proven.
  await page.waitForSelector('section.session-col button.foot-btn', { timeout: 20_000 });
  const url = await page.evaluate('location.pathname + location.search');
  await page.screenshot({ path: `${SHOTS}/1-split.png` });
  console.log(`  ✓ pane attached at ${url}`);

  // ------------------------------------------------- 5. THE PLAN, exactly once
  step('5. The agent raises ExitPlanMode -> the plan must be on screen ONCE');
  agent.ws.send(
    JSON.stringify({
      type: 'tool_request',
      sessionId: opened.sessionId,
      runId: opened.runId,
      requestId: REQUEST_ID,
      tool: 'ExitPlanMode',
      input: { plan: PLAN },
      title: 'Ready to code?',
    }),
  );
  // Wait for the PANE's copy specifically. If the surviving modal were the
  // shell's, this wait would time out — which is the right failure, because a
  // plan floating over a four-pane split with no transcript under it is the
  // wrong copy even when there is only one of it.
  await page.waitForFunction(`(${MODALS_JS}).inColumn > 0`, { timeout: 20_000 });
  await sleep(SETTLE_MS);
  const shown = await evalJs<Modals>(page, MODALS_JS);
  await page.screenshot({ path: `${SHOTS}/2-plan.png` });
  console.log(`  counts: backdrops=${shown.backdrops} plans=${shown.plans} inColumn=${shown.inColumn} visible=${shown.visible}`);
  if (shown.plans !== 1) {
    fail(
      `the plan is on screen ${shown.plans} time(s), expected 1 — ` +
        `${shown.inColumn} of them inside a column pane, ${shown.plans - shown.inColumn} from the shell's ModalHost. ` +
        `This is the duplicate: ModalHost must yield to the pane while the split shows the session the shell is still attached to. ` +
        `See ${SHOTS}/2-plan.png`,
    );
  }
  if (shown.backdrops !== 1) {
    fail(`${shown.backdrops} modal backdrops on screen, expected 1 — something else is stacked over the split (${SHOTS}/2-plan.png)`);
  }
  if (shown.inColumn !== 1) fail('the one surviving plan is not the pane\'s — the wrong copy won');
  if (shown.visible !== 1) fail(`the plan is in the DOM but ${shown.visible} copies have client rects — it is not actually on screen`);
  console.log(`  ✓ one plan, and it belongs to the pane`);

  // ------------------------------------------- 6. answer it, once, and it goes
  step('6. Approve the plan -> exactly one decision, and nothing left on screen');
  // The first choice of `PlanModal`: «Approve and review edits». Dispatched on
  // the element rather than clicked by coordinates — this screen stacks a modal
  // over a split, and a coordinate click lands on whatever is on top (trap 6).
  const decisionFrame = nextAgentFrame(agent.ws, 'tool_decision');
  await page.evaluate(`
    document.querySelector('section.session-col .q-plan-choices .q-option').click()
  `);
  const decided = await decisionFrame;
  if (decided.requestId !== REQUEST_ID) fail(`the decision names ${decided.requestId}, expected ${REQUEST_ID}`);
  if (decided.allow !== true) fail('the approve button sent a denial');
  await page.waitForFunction(`(${MODALS_JS}).plans === 0`, { timeout: 15_000 });
  await sleep(SETTLE_MS);
  const after = await evalJs<Modals>(page, MODALS_JS);
  await page.screenshot({ path: `${SHOTS}/3-answered.png` });
  if (after.plans !== 0 || after.backdrops !== 0) {
    fail(
      `after answering, ${after.plans} plan(s) and ${after.backdrops} backdrop(s) are still up — ` +
        `the copy nobody pressed stayed behind (${SHOTS}/3-answered.png)`,
    );
  }
  // One question, one answer. Two modals mean two buttons, and the second press
  // sends a decision for a requestId the agent has already settled — harmless
  // to the agent, and a lie to whoever pressed it.
  if (decisions !== 1) fail(`the agent received ${decisions} tool_decision frames for one question, expected 1`);
  console.log(`  ✓ one decision reached the agent, screen is clear`);

  // ------------------------------------------ 6b. the title renames in place
  step('6b. Click a pane\'s title -> it renames the session (Enter saves, Esc does not)');
  const PANE_TITLE = `Array.from(document.querySelectorAll('section.session-col')).find((p) => p.querySelector('.sc-col-title')?.textContent.includes(${JSON.stringify(session.title)}))?.querySelector('.sc-col-title')`;
  const RENAMED = 'Переименовано из колонки';
  await page.evaluate(`(${PANE_TITLE}).click()`);
  await page.waitForSelector('section.session-col input.sc-col-title-input', { timeout: 5_000 });
  if (!(await page.evaluate(`location.pathname.endsWith('/w/sessions/columns')`))) {
    fail('clicking the pane title left the split — it must rename, not navigate');
  }
  const renameFrame = nextAgentFrame(agent.ws, 'rpc_request');
  // The field opens with the whole title selected, so typing replaces it.
  await page.keyboard.type(RENAMED);
  await page.keyboard.press('Enter');
  const rpc = await renameFrame;
  if (rpc.method !== 'session.rename') fail(`the title sent ${rpc.method}, expected session.rename`);
  if (rpc.params['title'] !== RENAMED) fail(`session.rename carried ${JSON.stringify(rpc.params['title'])}, expected ${JSON.stringify(RENAMED)}`);
  if (rpc.params['sessionId'] !== session.sessionId) fail('session.rename named the wrong session');
  agent.ws.send(JSON.stringify({ type: 'rpc_response', requestId: rpc.requestId, ok: true, result: { ok: true } }));
  await page.waitForFunction(
    `Array.from(document.querySelectorAll('section.session-col .sc-col-title')).some((t) => t.textContent === ${JSON.stringify(RENAMED)})`,
    { timeout: 5_000 },
  );
  console.log(`  ✓ Enter sent session.rename("${RENAMED}") and the heading shows it`);
  // Esc: the edit is dropped and nothing reaches the agent.
  let stray = 0;
  const countRpc = (raw: Buffer) => {
    if (raw.toString().includes('"rpc_request"') && raw.toString().includes('session.rename')) stray += 1;
  };
  agent.ws.on('message', countRpc);
  await page.evaluate(`Array.from(document.querySelectorAll('section.session-col .sc-col-title')).find((t) => t.textContent === ${JSON.stringify(RENAMED)}).click()`);
  await page.waitForSelector('section.session-col input.sc-col-title-input', { timeout: 5_000 });
  await page.keyboard.type('не сохранять');
  await page.keyboard.press('Escape');
  await sleep(1_500);
  agent.ws.off('message', countRpc);
  if (stray !== 0) fail(`Esc still sent ${stray} session.rename request(s)`);
  if (await page.$('section.session-col input.sc-col-title-input')) fail('Esc left the title editor open');
  await page.screenshot({ path: `${SHOTS}/3b-renamed.png` });
  console.log(`  ✓ Esc cancelled without a request`);

  // ----------------------------- 7. and nothing stale waiting in the shell
  step('7. Back into the session view -> no leftover plan (the hub\'s tool_resolved)');
  // The shell's hook still HELD that request all through step 5 — it was only
  // suppressed, not dropped. Without the hub's `tool_resolved` fan-out it would
  // still hold it here, where nothing suppresses it any more, and an answered
  // plan would pop up again the moment you walked back in. Navigated by closing
  // the neighbour's pane — a split of one dissolves into the session view, and
  // (the title renames now) that is the door a person uses. Crucially it is an
  // in-app navigation: a reload would mint a fresh hook and prove nothing.
  await page.evaluate(`Array.from(document.querySelectorAll('section.session-col')).find((p) => p.querySelector('.sc-col-title')?.textContent.includes(${JSON.stringify(neighbour.title)})).querySelector('.sc-col-close').click()`);
  await page.waitForFunction(`!document.querySelector('section.session-col')`, { timeout: 20_000 });
  await page.waitForSelector('.composer textarea', { timeout: 20_000 });
  await sleep(SETTLE_MS * 2);
  const back = await evalJs<Modals>(page, MODALS_JS);
  await page.screenshot({ path: `${SHOTS}/4-back-in-session.png` });
  if (back.plans !== 0 || back.backdrops !== 0) {
    fail(
      `the session view raises ${back.plans} plan(s) that were already answered — ` +
        `the shell's hook never heard tool_resolved (${SHOTS}/4-back-in-session.png)`,
    );
  }
  console.log(`  ✓ session view is clean — the answered request was cleared everywhere`);

  clearTimeout(timer);
  await browser.close();
  agent.ws.close();
  console.log(`\nPASS: one ExitPlanMode -> one modal (the pane's) -> one decision -> nothing stale anywhere`);
  console.log(`      screenshots: ${SHOTS}/`);
  process.exit(0);
}

main().catch((e) => fail(e instanceof Error ? e.stack ?? e.message : String(e)));
