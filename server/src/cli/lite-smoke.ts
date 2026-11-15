/**
 * The light shell (remote.acme.test), end to end, in a real browser.
 *
 * The shell is a second bundle the hub serves by `Host`, over the same socket
 * and the same sessions as the full client. What it adds is decisions made for
 * the person — which bundle a name gets, what a new project's folder is
 * called, which pile a task is in — and every one of those is the kind of
 * thing that is wrong quietly: the page still renders, the task still starts,
 * just in the wrong folder or under the wrong heading. So this presses the
 * whole path once:
 *
 *   1. the HOST picks the bundle — the light name gets the light document, the
 *      hub's own name still gets the full one;
 *   2. a first message with no project makes the folder (`projects.create`,
 *      named from the sentence) and starts the task in it (`new_session`);
 *   3. the agent asks something → the task is under «Ждут вас»; opening it
 *      shows the question, and an answer reaches the agent (`tool_decision`);
 *   4. the turn ends while the person is elsewhere → «Готово», with the dot;
 *      opening it clears the dot;
 *   5. a second message goes into the SAME project (no second folder), and
 *      «План» rides on it as `permissionMode: 'plan'`;
 *   6. «Полная версия» is the same address on the full client.
 *
 * The agent is fake (as in compact-smoke): the browser, both production
 * bundles, the hub binary and every frame between them are real.
 *
 * Run it:
 *
 *   npm run build --workspace shared && npm run build --workspace web
 *   cargo build --manifest-path server-rs/Cargo.toml
 *
 *   CC_REMOTE_TOKEN=dev-token \
 *   CC_REMOTE_SSO_SECRET=smoke-sso-secret-0123456789-0123456789 \
 *   CC_REMOTE_PLATFORM_ADMIN_IDS=legacy-owner \
 *   CC_REMOTE_PUBLIC_URL=http://127.0.0.1:4319 \
 *   CC_REMOTE_DB_PATH=/tmp/cc-remote-lite.sqlite3 \
 *   WEB_DIST=web/dist WEB_LITE_DIST=web/lite/dist CC_REMOTE_LITE_HOSTS=lite.localhost \
 *   PORT=4319 ./server-rs/target/debug/cc-remote-server
 *
 *   CC_REMOTE_SSO_SECRET=<same> tsx server/src/cli/lite-smoke.ts
 *
 * Screenshots of every step land in /tmp/lite-smoke/ — look at them.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import http from 'node:http';
import type { HistoryMessage, SessionSummary } from '@cc-remote/shared';
import { adminLogin, enrollFakeAgent, fail, fakeSession, nextAgentFrame, sleep, smokeTarget, chromePath, launchBrowser, step } from './_harness.js';


const SHOTS = '/tmp/lite-smoke';
/** The name the hub was started with in `CC_REMOTE_LITE_HOSTS`. */
const LITE_HOST = process.env['CC_SMOKE_LITE_HOST'] ?? 'lite.localhost';
const ROOT = '/home/smoke/work';
const PROMPT = 'Сделай лендинг для школы танцев';
const SLUG = 'lending-shkoly-tantsev';
const TITLE = 'Лендинг школы танцев';

const target = smokeTarget(process.argv);
const timer = setTimeout(() => fail('timed out (150s)'), 150_000);

/** GET `/` as a given `Host` — Node's fetch will not let a caller set it. */
function documentFor(host: string): Promise<{ status: number; body: string }> {
  const url = new URL(target.http);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: url.hostname, port: url.port, path: '/', method: 'GET', headers: { host } },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

const LITE_MARK = 'name="hegai-shell" content="lite"';

/** The titles under one pile, as the screen lists them. */
const pileJs = (id: string) => `
  (() => {
    const h = document.getElementById(${JSON.stringify(id)});
    if (!h) return [];
    return Array.from(h.closest('section').querySelectorAll('.lt-row')).map((r) => ({
      title: r.querySelector('.lt-row-title').textContent,
      unread: r.classList.contains('unread'),
      sub: r.querySelector('.lt-row-sub')?.textContent ?? '',
    }));
  })()
`;

async function main(): Promise<void> {
  if (!target.ssoSecret) fail('CC_REMOTE_SSO_SECRET is not set in this shell (must match the hub)');
  const secret = target.ssoSecret;
  mkdirSync(SHOTS, { recursive: true });
  const port = new URL(target.http).port;
  const liteOrigin = `http://${LITE_HOST}:${port}`;
  console.log(`[lite-smoke] hub ${target.http}  light shell ${liteOrigin}  chrome ${chromePath()}`);

  // ---------------------------------------------------- 1. the Host picks it
  step('1. The Host picks the bundle');
  const lite = await documentFor(`${LITE_HOST}:${port}`);
  const full = await documentFor(`127.0.0.1:${port}`);
  if (lite.status === 503) {
    fail(`${LITE_HOST} answers 503: the hub has CC_REMOTE_LITE_HOSTS but no WEB_LITE_DIST (build web, start the hub with both)`);
  }
  assert.equal(lite.status, 200, `the light host answers (${lite.status})`);
  if (!lite.body.includes(LITE_MARK)) {
    fail(`${LITE_HOST} was served a document without the light marker — is CC_REMOTE_LITE_HOSTS=${LITE_HOST} set on the hub?`);
  }
  assert.equal(full.status, 200);
  assert.ok(!full.body.includes(LITE_MARK), "the hub's own name still gets the full client");
  console.log(`  ✓ ${LITE_HOST} → light document; 127.0.0.1 → full client`);

  // ------------------------------------------------ an account and a machine
  step('2. Owner signs in; a fake agent with no sessions and no projects');
  const owner = await adminLogin(target.http, secret);
  const agent = await enrollFakeAgent(target, owner, { name: 'lite-smoke-box', sessions: [] });
  const projects: { cwd: string; label: string }[] = [];
  const creates: string[] = [];
  const file: HistoryMessage[] = [];
  agent.ws.on('message', (raw: Buffer) => {
    const m = JSON.parse(raw.toString()) as {
      type: string;
      requestId?: string;
      method?: string;
      params?: Record<string, unknown>;
    };
    if (m.type !== 'rpc_request' || !m.requestId) return;
    let result: unknown;
    if (m.method === 'projects.list') {
      result = {
        roots: [ROOT],
        projects: projects.map((p) => ({ ...p, origin: 'root', lastModified: Date.now(), count: 0 })),
      };
    } else if (m.method === 'projects.create') {
      const name = String(m.params?.['name'] ?? '');
      creates.push(name);
      const made = { cwd: `${ROOT}/${name}`, label: name };
      projects.push(made);
      result = { ...made, created: true, git: 'init' };
    } else if (m.method === 'session.messages') {
      result = { messages: file };
    } else if (m.method === 'git.status') {
      result = { isRepo: true, branch: 'main', ahead: 0, behind: 0, files: [{ path: 'index.html', code: '??', staged: false }] };
    }
    const reply = () =>
      agent.ws.send(
        JSON.stringify(
          result !== undefined
            ? { type: 'rpc_response', requestId: m.requestId, ok: true, result }
            : { type: 'rpc_response', requestId: m.requestId, ok: false, error: 'not in this smoke' },
        ),
      );
    // A real `git init` + first commit takes a moment, and that moment is the
    // window a second press falls into: the folder is asked for, not yet made.
    if (m.method === 'projects.create') setTimeout(reply, 500);
    else reply();
  });
  let starts = 0;
  agent.ws.on('message', (raw: Buffer) => {
    if ((JSON.parse(raw.toString()) as { type?: string }).type === 'new_session') starts += 1;
  });

  const browser = await launchBrowser({ args: [`--host-resolver-rules=MAP ${LITE_HOST} 127.0.0.1`] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  page.on('console', (m: { type: () => string; text: () => string }) => {
    if (m.type() === 'error') console.log(`  [browser error] ${m.text()}`);
  });
  page.on('pageerror', (e: unknown) => console.log(`  [page error] ${e instanceof Error ? e.message : String(e)}`));
  const cookie = owner.cookie.split(';')[0] ?? '';
  const [cookieName, ...cookieRest] = cookie.split('=');
  // The cookie is host-only on the hub, and so it is here: this is the light
  // name's own session, not one borrowed from 127.0.0.1.
  await browser.setCookie({ name: (cookieName ?? '').trim(), value: cookieRest.join('='), domain: LITE_HOST, path: '/' });

  await page.goto(`${liteOrigin}/`, { waitUntil: 'networkidle2' });
  await page.waitForSelector('.lt-home textarea', { timeout: 20_000 });
  assert.equal(await page.evaluate('location.pathname'), '/w/sessions', '`/` lands on the home address');
  // No project anywhere: the chip offers to make one, on the only machine.
  await page.waitForFunction(`document.querySelector('.lt-where .tgt-label')?.textContent === 'Новый проект'`, { timeout: 20_000 });
  await page.screenshot({ path: `${SHOTS}/1-home-empty.png` });
  console.log('  ✓ home: a prompt box, and «Новый проект» because there is nothing yet');

  // ------------------------------------- 2. the first message makes a project
  step('3. A first message makes the folder and starts the task in it');
  const startFrame = nextAgentFrame(agent.ws, 'new_session', 20_000);
  await page.type('.lt-home textarea', PROMPT);
  // Pressed TWICE: once, and again while the folder is still being made. On
  // production the first real task was started twice by exactly this — a
  // second press reaching a screen that had not rendered since the first, so
  // every guard that read component state saw nothing in flight. One folder
  // and one task, or the guards are not guards.
  await page.evaluate(`(() => {
    const b = document.querySelector('.lt-home button.send-round:not([disabled])');
    b.click();
    b.click();
    setTimeout(() => document.querySelector('.lt-home button.send-round')?.click(), 150);
  })()`);
  const started = await startFrame;
  await sleep(1200);
  assert.deepEqual(creates, [SLUG], 'one folder, named from the sentence — not one per press');
  assert.equal(starts, 1, `one task started, not ${starts}`);
  assert.equal(started.cwd, `${ROOT}/${SLUG}`, 'the task starts in the folder just made');
  assert.equal(started.message, PROMPT);
  assert.equal(started.permissionMode, undefined, 'no mode asked for: the machine default runs');
  assert.equal(started.model, undefined, 'no model asked for');
  console.log(`  ✓ projects.create «${creates[0]}» → new_session in ${started.cwd}; three presses made one folder and one task`);

  const sessionId = randomUUID();
  const run = { runId: started.runId, sessionId };
  const ev = (event: Record<string, unknown>) => agent.ws.send(JSON.stringify({ type: 'stream', ...run, event }));
  const status = (state: string) => agent.ws.send(JSON.stringify({ type: 'run_status', ...run, state }));
  const inventory = (extra: Partial<SessionSummary> = {}) =>
    agent.ws.send(
      JSON.stringify({
        type: 'inventory',
        sessions: [{ ...fakeSession(`${ROOT}/${SLUG}`, TITLE), sessionId, entrypoint: 'cc-remote', lastModified: Date.now(), ...extra }],
        complete: true,
      }),
    );
  agent.ws.send(JSON.stringify({ type: 'session_started', ...run }));
  status('started');
  await page.waitForFunction(`location.pathname.endsWith(${JSON.stringify(`/${sessionId}`)})`, { timeout: 20_000 });
  file.push({ type: 'user', uuid: randomUUID(), blocks: [{ kind: 'text', text: PROMPT }], ts: Date.now() });
  ev({ kind: 'assistant', text: 'Сделаю одностраничник. Один вопрос, прежде чем начать.' });
  inventory();
  await page.waitForFunction(`document.querySelector('.lt-task')?.innerText.includes('Один вопрос, прежде чем начать')`, { timeout: 20_000 });
  await page.waitForFunction(`document.querySelector('.lt-task-title')?.textContent === ${JSON.stringify(TITLE)}`, { timeout: 20_000 });
  // The machinery the full client offers here is absent, not hidden by CSS.
  assert.equal(await page.evaluate(`!!document.querySelector('.lt-task .run-pick, .lt-task .ctx-ring')`), false, 'no model picker, no context ring');
  await page.screenshot({ path: `${SHOTS}/2-task.png` });
  console.log('  ✓ the task view: the answer streaming, no model picker');

  // --------------------------------------------------- 6. the door to the full
  const fullHref = await page.evaluate(`document.querySelector('.lt-task-head a.lt-head-btn')?.href`);
  const expected = `/w/s/${encodeURIComponent(agent.machineId)}/${sessionId}`;
  assert.ok(typeof fullHref === 'string' && new URL(fullHref).pathname === expected, `«Полная версия» is the same address (${String(fullHref)})`);
  assert.notEqual(new URL(fullHref as string).origin, liteOrigin, 'on the other origin');
  console.log(`  ✓ «Полная версия» → ${String(fullHref)}`);

  // ----------------------------------------------------- 3. the agent asks
  step('4. The agent asks → «Ждут вас» → the answer reaches the agent');
  await page.click('.lt-task-head a.icon-btn');
  await page.waitForSelector('.lt-home textarea', { timeout: 10_000 });
  const requestId = randomUUID();
  agent.ws.send(
    JSON.stringify({
      type: 'tool_request',
      ...run,
      requestId,
      tool: 'AskUserQuestion',
      input: {
        questions: [
          {
            header: 'Стиль',
            question: 'Какой тон у страницы?',
            multiSelect: false,
            options: [
              { label: 'Строгий', description: 'Чёрно-белый, много воздуха' },
              { label: 'Яркий', description: 'Цвет и крупные фото' },
            ],
          },
        ],
      },
    }),
  );
  await page.waitForFunction(`(${pileJs('lt-attn')}).some((r) => r.title === ${JSON.stringify(TITLE)})`, { timeout: 20_000 });
  const waiting = (await page.evaluate(pileJs('lt-attn'))) as { title: string; sub: string }[];
  assert.match(waiting[0]!.sub, /ждёт ответа/, 'the row says what it is waiting for');
  assert.deepEqual(await page.evaluate(pileJs('lt-work')), [], 'and it is not also listed as working');
  // The question waits with its task: the socket is still attached to that
  // run, and raising the modal here would ask it over the home, with no
  // conversation under it.
  assert.equal(await page.evaluate(`!!document.querySelector('.modal-backdrop')`), false, 'no question over the home');
  await page.screenshot({ path: `${SHOTS}/3-home-waiting.png` });
  console.log(`  ✓ home: «${waiting[0]!.title}» under «Ждут вас» — ${waiting[0]!.sub}`);

  await page.click('#lt-attn ~ .lt-rows .lt-row');
  await page.waitForFunction(`document.querySelector('.question-modal')?.innerText.includes('Какой тон у страницы?')`, { timeout: 20_000 });
  await page.screenshot({ path: `${SHOTS}/4-question.png` });
  const decision = nextAgentFrame(agent.ws, 'tool_decision', 20_000);
  await page.evaluate(`Array.from(document.querySelectorAll('.q-option')).find((b) => b.innerText.includes('Яркий')).click()`);
  await page.click('.question-modal .modal-actions .btn.primary:not([disabled])');
  const decided = await decision;
  assert.equal(decided.requestId, requestId);
  assert.equal(decided.allow, true);
  assert.deepEqual((decided.updatedInput as { answers?: Record<string, string> } | undefined)?.answers, { 'Какой тон у страницы?': 'Яркий' });
  console.log('  ✓ the question is buttons; «Яркий» reached the agent as tool_decision');

  // ------------------------------------------ 4. it finishes while we are away
  step('5. The turn ends while the person is on the home → «Готово», with the dot');
  status('started');
  await page.click('.lt-task-head a.icon-btn');
  await page.waitForSelector('.lt-home textarea', { timeout: 10_000 });
  await page.waitForFunction(`(${pileJs('lt-work')}).some((r) => r.title === ${JSON.stringify(TITLE)})`, { timeout: 20_000 });
  console.log('  ✓ home: under «В работе» while it runs');
  // Past the instant the task was last on screen: «new» is strictly later.
  await sleep(1200);
  ev({ kind: 'assistant', text: 'Готово: index.html в папке проекта.' });
  ev({ kind: 'result', text: 'done' });
  status('idle');
  ev({ kind: 'status', code: 'turn_settled', text: '' });
  inventory();
  await page.waitForFunction(`(${pileJs('lt-done')}).some((r) => r.title === ${JSON.stringify(TITLE)})`, { timeout: 20_000 });
  const done = (await page.evaluate(pileJs('lt-done'))) as { title: string; unread: boolean }[];
  assert.equal(done[0]!.unread, true, 'a result nobody has opened carries the dot');
  assert.deepEqual(await page.evaluate(pileJs('lt-work')), []);
  await page.screenshot({ path: `${SHOTS}/5-home-done.png` });
  console.log('  ✓ home: under «Готово», unread');

  await page.click('#lt-done ~ .lt-rows .lt-row');
  await page.waitForSelector('.lt-task .composer textarea', { timeout: 20_000 });
  // «Изменения» comes from the project's own `git status`.
  await page.waitForFunction(`Array.from(document.querySelectorAll('.lt-head-btn')).some((b) => b.textContent.includes('Изменения'))`, { timeout: 20_000 });
  await page.evaluate(`Array.from(document.querySelectorAll('.lt-head-btn')).find((b) => b.textContent.includes('Изменения')).click()`);
  await page.waitForFunction(`document.querySelector('.lt-changes')?.innerText.includes('index.html')`, { timeout: 10_000 });
  await page.screenshot({ path: `${SHOTS}/6-task-changes.png` });
  await page.click('.lt-task-head a.icon-btn');
  await page.waitForSelector('.lt-home textarea', { timeout: 10_000 });
  await page.waitForFunction(`(${pileJs('lt-done')}).some((r) => r.title === ${JSON.stringify(TITLE)} && !r.unread)`, { timeout: 10_000 });
  console.log('  ✓ opened → the dot is gone, the row keeps its place; «Изменения» lists index.html');

  // ---------------------------------------- 5. the second message, with «План»
  step('6. A second message goes into the same project, with «План»');
  await page.waitForFunction(`document.querySelector('.lt-where .tgt-label')?.textContent === ${JSON.stringify(SLUG)}`, { timeout: 10_000 });
  await page.click('.lt-home .plan-toggle');
  assert.equal(await page.evaluate(`document.querySelector('.lt-home .plan-toggle').getAttribute('aria-pressed')`), 'true');
  const second = nextAgentFrame(agent.ws, 'new_session', 20_000);
  await page.type('.lt-home textarea', 'Добавь форму записи на пробное занятие');
  await page.screenshot({ path: `${SHOTS}/7-home-plan.png` });
  // Twice again, in an existing project — no folder to make this time.
  await page.evaluate(`(() => { const b = document.querySelector('.lt-home button.send-round:not([disabled])'); b.click(); b.click(); })()`);
  const next = await second;
  await sleep(1200);
  assert.equal(starts, 2, `the second task started once (${starts - 1} new starts)`);
  assert.equal(next.cwd, `${ROOT}/${SLUG}`, 'the same folder');
  assert.equal(next.permissionMode, 'plan', '«План» rides on the start');
  assert.deepEqual(creates, [SLUG], 'and no second folder was made');
  console.log('  ✓ new_session in the same folder, permissionMode=plan, no second projects.create; a double press started one task');

  // ------------------------------------------------------------- a phone
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  await page.goto(`${liteOrigin}/w/sessions`, { waitUntil: 'networkidle2' });
  await page.waitForSelector('.lt-home textarea', { timeout: 20_000 });
  await sleep(400);
  // `scrollWidth` cannot be the test: the shell is a fixed box that clips, so
  // a control hanging off the right edge overflows nothing — it is just cut.
  // Measure the controls themselves. (The first phone screenshot of this smoke
  // had «Выйти» half off-screen and the composer's buttons on three rows, and
  // a scrollWidth check passed over both.)
  const PHONE_FIT_JS = `
    (() => {
      const w = window.innerWidth;
      const cut = Array.from(document.querySelectorAll('.lt-top a, .lt-top button, .lt-home .composer-actions button, .lt-row'))
        .filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && (r.right > w + 0.5 || r.left < -0.5); })
        .map((el) => el.textContent.trim().slice(0, 24) || el.className);
      const tops = Array.from(document.querySelectorAll('.lt-home .composer-actions button'))
        .map((el) => el.getBoundingClientRect()).filter((r) => r.width > 0).map((r) => Math.round(r.top + r.height / 2));
      return { cut, rows: Math.max(...tops) - Math.min(...tops), brand: document.querySelector('.lt-brand').getBoundingClientRect().height };
    })()
  `;
  const fit = (await page.evaluate(PHONE_FIT_JS)) as { cut: string[]; rows: number; brand: number };
  await page.screenshot({ path: `${SHOTS}/8-home-phone.png` });
  assert.deepEqual(fit.cut, [], `nothing hangs off a 390px screen (${fit.cut.join(', ')})`);
  assert.ok(fit.rows <= 8, `the composer's buttons are one row (centres ${fit.rows}px apart)`);
  assert.ok(fit.brand <= 30, `the brand is one line (${fit.brand}px tall)`);
  console.log('  ✓ 390px: the bar and the composer row fit, nothing is cut');

  await page.click('#lt-done ~ .lt-rows .lt-row, #lt-work ~ .lt-rows .lt-row');
  await page.waitForSelector('.lt-task .composer textarea', { timeout: 20_000 });
  await sleep(400);
  const headCut = await page.evaluate(`
    Array.from(document.querySelectorAll('.lt-task-head > *'))
      .filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.right > window.innerWidth + 0.5; }).length
  `);
  await page.screenshot({ path: `${SHOTS}/9-task-phone.png` });
  assert.equal(headCut, 0, "the task's head fits a 390px screen");
  // The same two screens in the dark theme — a token missed there is white on white.
  await page.evaluate(`localStorage.setItem('cc-theme', 'dark')`);
  await page.setViewport({ width: 1280, height: 900 });
  await page.goto(`${liteOrigin}/w/sessions`, { waitUntil: 'networkidle2' });
  await page.waitForSelector('.lt-home textarea', { timeout: 20_000 });
  await sleep(400);
  assert.equal(await page.evaluate('document.documentElement.dataset.theme'), 'dark');
  await page.screenshot({ path: `${SHOTS}/10-home-dark.png` });
  console.log('  ✓ 390px task view fits; dark theme rendered');

  clearTimeout(timer);
  await browser.close();
  agent.ws.close();
  console.log('\nPASS: Host → light bundle; message → project → task; question → answer; done → dot; same project + plan');
  console.log(`      screenshots: ${SHOTS}/`);
  process.exit(0);
}

main().catch((e) => fail(e instanceof Error ? (e.stack ?? e.message) : String(e)));
