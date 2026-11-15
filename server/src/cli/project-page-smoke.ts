/**
 * Four things asked for on 27.09.2026, pressed in a real browser:
 *
 *   1. a project in the side panel opens onto ITS SESSIONS in the main column
 *      (`/w/p/:project` → ProjectSessions), not onto the composer;
 *   2. the new-chat screen says WHERE with two buttons on a tray above the
 *      field — server ▾ and project ▾ — and each dropdown actually re-aims it;
 *   3. the panes of a split can be resized by dragging the gap between them,
 *      the widths survive a reload, and a double-click evens them out;
 *   4. «Открыть в новом окне» is withheld inside a desktop shell that cannot
 *      build that window without freezing (every shell up to 0.1.17), and
 *      offered in one that says it can (`__HEGAI_OWN_WINDOWS__`) and in a
 *      browser.
 *
 * Run it like the other browser smokes (deploy/SMOKE-TESTS.md):
 *
 *   CC_REMOTE_SSO_SECRET=<hub's> tsx server/src/cli/project-page-smoke.ts ws://127.0.0.1:4319
 *
 * Screenshots land in /tmp/project-page-smoke/.
 */
import { mkdirSync } from 'node:fs';
import { adminLogin, enrollFakeAgent, fail, fakeSession, smokeTarget, sleep, launchBrowser, step, evalJs } from './_harness.js';
import type { SessionSummary } from '@cc-remote/shared';


const SHOTS = '/tmp/project-page-smoke';
const SETTLE_MS = 600;

const target = smokeTarget(process.argv);
const timer = setTimeout(() => fail('timed out (180s)'), 180_000);

/** A session some minutes old, so the order on screen is deterministic. */
function aged(cwd: string, title: string, minutesAgo: number): SessionSummary {
  const s = fakeSession(cwd, title);
  s.lastModified = Date.now() - minutesAgo * 60_000;
  return s;
}

async function main(): Promise<void> {
  if (!target.ssoSecret) fail('CC_REMOTE_SSO_SECRET is not set in this shell (must match the hub)');
  mkdirSync(SHOTS, { recursive: true });

  step('0. Owner, two fake machines: alpha + beta on one, gamma on the other');
  const owner = await adminLogin(target.http, target.ssoSecret);
  // Names unique to this run: the hub's database outlives a run, and another
  // run's `alpha` on another machine would be merged into this card by label.
  const tag = Math.random().toString(36).slice(2, 6);
  const [ALPHA, BETA, GAMMA] = [`alpha-${tag}`, `beta-${tag}`, `gamma-${tag}`];
  const [BOX, OTHER] = [`smoke-box-${tag}`, `second-box-${tag}`];
  const A1 = aged(`/home/smoke/${ALPHA}`, 'Альфа — первая', 1);
  const A2 = aged(`/home/smoke/${ALPHA}`, 'Альфа — вторая', 5);
  const A3 = aged(`/home/smoke/${ALPHA}`, 'Альфа — третья', 9);
  const B1 = aged(`/home/smoke/${BETA}`, 'Бета — одна', 30);
  const G1 = aged(`/srv/${GAMMA}`, 'Гамма — одна', 60);
  const box = await enrollFakeAgent(target, owner, { name: BOX, sessions: [A1, A2, A3, B1] });
  const other = await enrollFakeAgent(target, owner, { name: OTHER, sessions: [G1] });

  const browser = await launchBrowser();
  const cookie = owner.cookie.split(';')[0] ?? '';
  const [cookieName, ...cookieRest] = cookie.split('=');
  await browser.setCookie({ name: (cookieName ?? '').trim(), value: cookieRest.join('='), domain: '127.0.0.1', path: '/' });
  const errors: string[] = [];
  const open = async (shell?: 'old' | 'new') => {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    page.on('console', (m: { type: () => string; text: () => string }) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    page.on('pageerror', (e: unknown) => errors.push(e instanceof Error ? e.message : String(e)));
    if (shell) {
      await page.evaluateOnNewDocument(
        `window.__HEGAI_SHELL__ = 'windows';${shell === 'new' ? ' window.__HEGAI_OWN_WINDOWS__ = 1;' : ''}`,
      );
    }
    return page;
  };
  const page = await open();
  const text = (sel: string) =>
    page.evaluate(`Array.from(document.querySelectorAll(${JSON.stringify(sel)})).map((e) => e.textContent.trim())`) as Promise<string[]>;

  step('1. Side panel: pressing the «alpha» card opens its sessions in the main column');
  await page.goto(`${target.http}/w/sessions`, { waitUntil: 'networkidle2' });
  await page.waitForFunction(`Array.from(document.querySelectorAll('a.pc-head .pc-name')).some((e) => e.textContent === ${JSON.stringify(ALPHA)})`, { timeout: 20_000 });
  await page.evaluate(`Array.from(document.querySelectorAll('a.pc-head')).find((a) => a.querySelector('.pc-name')?.textContent === ${JSON.stringify(ALPHA)}).click()`);
  await page.waitForFunction(`location.pathname === ${JSON.stringify(`/w/p/${ALPHA}`)}`, { timeout: 5_000 });
  await page.waitForSelector('.proj-sessions .pjd-row', { timeout: 10_000 });
  await sleep(SETTLE_MS);
  const rows = await text('.proj-sessions .pjd-title');
  await page.screenshot({ path: `${SHOTS}/1-project-page.png` });
  if (rows.join('|') !== [A1, A2, A3].map((s) => s.title).join('|')) fail(`project page rows: ${rows.join(' | ')}`);
  if (await page.$('.startscreen')) fail('the project route still draws the composer');
  const here = await page.evaluate(`Array.from(document.querySelectorAll('.proj-card.here .pc-name')).map((e) => e.textContent)`);
  if (JSON.stringify(here) !== JSON.stringify([ALPHA])) fail(`the panel marks ${JSON.stringify(here)} as open, expected ${ALPHA}`);
  // The panel no longer drills in: the other project is still listed there.
  if (!(await text('a.pc-head .pc-name')).includes(BETA)) fail('the side panel lost the other projects');
  console.log(`  ✓ ${rows.length} sessions on /w/p/${ALPHA}, the card is marked, ${BETA} still in the panel`);

  step('1b. The panel\'s search field filters the cards in place — no palette');
  await page.type('.side-find input', BETA);
  await page.waitForFunction(`Array.from(document.querySelectorAll('a.pc-head .pc-name')).map((e) => e.textContent).join('|') === ${JSON.stringify(BETA)}`, { timeout: 5_000 });
  if (await page.$('.cmdk')) fail('typing in the side search opened the palette');
  await page.screenshot({ path: `${SHOTS}/1b-side-search.png` });
  await page.click('.side-find-x');
  await page.waitForFunction(`Array.from(document.querySelectorAll('a.pc-head .pc-name')).some((e) => e.textContent === ${JSON.stringify(ALPHA)})`, { timeout: 5_000 });
  if (!(await page.$('.side-top button[aria-label="Новый чат в новом окне"]'))) fail('no «new chat in a new window» icon in a browser');
  console.log('  ✓ search filters to one card, ✕ brings them back; new-window icon present');

  await page.evaluate(`document.querySelector('.proj-sessions .pjd-row').click()`);
  await page.waitForFunction(`location.pathname === ${JSON.stringify(`/w/s/${box.machineId}/${A1.sessionId}`)}`, { timeout: 5_000 });
  console.log('  ✓ a row opens its session');

  step('2. New chat: server ▾ and project ▾ above the field');
  // Start from a clean aim so the default (most recent, mine) is what shows.
  await page.evaluate(`localStorage.removeItem('cc-project')`);
  await page.goto(`${target.http}/w/new`, { waitUntil: 'networkidle2' });
  await page.waitForSelector('.start-target .tgt-chip', { timeout: 20_000 });
  await sleep(SETTLE_MS);
  let chips = await text('.start-target .tgt-chip .tgt-label');
  if (chips.join('|') !== `${BOX}|${ALPHA}`) fail(`chips read ${chips.join(' | ')}, expected ${BOX} | ${ALPHA}`);
  if (await page.$('.proj-cards')) fail('the old card shelf is still under the composer');
  // The tray sits ABOVE the capsule.
  const order = await page.evaluate(
    `document.querySelector('.start-target').getBoundingClientRect().top < document.querySelector('.start-composer .composer-box').getBoundingClientRect().top`,
  );
  if (!order) fail('the server/project tray is not above the composer');
  await page.screenshot({ path: `${SHOTS}/2-new-chat.png` });
  console.log(`  ✓ ${chips.join(' · ')}`);

  await page.click('.start-target .tgt-chip:nth-of-type(1)');
  await page.waitForSelector('.tgt-pop', { timeout: 5_000 });
  const servers = await text('.tgt-pop .pc-name');
  await page.screenshot({ path: `${SHOTS}/3-server-dropdown.png` });
  if (!servers.includes(BOX) || !servers.includes(OTHER)) fail(`server list: ${servers.join(' | ')}`);
  await page.evaluate(`Array.from(document.querySelectorAll('.tgt-pop .pc-pick')).find((b) => b.querySelector('.pc-name')?.textContent === ${JSON.stringify(OTHER)}).click()`);
  await page.waitForFunction(`!document.querySelector('.tgt-pop')`, { timeout: 5_000 });
  chips = await text('.start-target .tgt-chip .tgt-label');
  if (chips.join('|') !== `${OTHER}|${GAMMA}`) fail(`after picking ${OTHER} the chips read ${chips.join(' | ')}`);
  console.log(`  ✓ server switch → ${chips.join(' · ')}`);

  await page.click('.start-target .tgt-chip:nth-of-type(2)');
  await page.waitForSelector('.tgt-pop .proj-pop-search', { timeout: 5_000 });
  const onGamma = await text('.tgt-pop .pc-name');
  if (onGamma.join('|') !== GAMMA) fail(`the project list of ${OTHER} is ${onGamma.join(' | ')}`);
  await page.type('.tgt-pop .proj-pop-search', BETA);
  await page.waitForFunction(`Array.from(document.querySelectorAll('.tgt-pop .pc-name')).map((e) => e.textContent).join('|') === ${JSON.stringify(BETA)}`, { timeout: 5_000 });
  await page.screenshot({ path: `${SHOTS}/4-project-search.png` });
  await page.keyboard.press('Enter');
  await page.waitForFunction(`!document.querySelector('.tgt-pop')`, { timeout: 5_000 });
  chips = await text('.start-target .tgt-chip .tgt-label');
  if (chips.join('|') !== `${BOX}|${BETA}`) fail(`search + Enter left the chips at ${chips.join(' | ')}`);
  console.log(`  ✓ search across servers → ${chips.join(' · ')}`);
  // Outside press closes it.
  await page.click('.start-target .tgt-chip:nth-of-type(2)');
  await page.waitForSelector('.tgt-pop', { timeout: 5_000 });
  await page.mouse.click(1400, 880);
  await page.waitForFunction(`!document.querySelector('.tgt-pop')`, { timeout: 5_000 });
  console.log('  ✓ a press outside closes the dropdown');

  step('3. Split: drag the gap between two panes');
  const ref = (s: SessionSummary) => `${encodeURIComponent(box.machineId)}:${encodeURIComponent(s.sessionId)}`;
  await page.evaluate(`localStorage.removeItem('cc-col-grow::2')`);
  await page.goto(`${target.http}/w/sessions/columns?s=${ref(A1)},${ref(A2)}`, { waitUntil: 'networkidle2' });
  await page.waitForFunction(`document.querySelectorAll('section.session-col').length === 2`, { timeout: 20_000 });
  await sleep(SETTLE_MS);
  const widths = () =>
    page.evaluate(`Array.from(document.querySelectorAll('section.session-col')).map((p) => Math.round(p.getBoundingClientRect().width))`) as Promise<number[]>;
  const w0 = await widths();
  if (Math.abs((w0[0] ?? 0) - (w0[1] ?? 0)) > 2) fail(`panes start unequal: ${w0.join(' / ')}`);
  const h = await page.$('.col-resize');
  if (!h) fail('no resize handle between the panes');
  const box0 = await h.boundingBox();
  if (!box0) fail('the resize handle has no box');
  const x = box0.x + box0.width / 2;
  const y = box0.y + box0.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(x + 20 * i, y);
  await page.mouse.up();
  await sleep(SETTLE_MS);
  const w1 = await widths();
  await page.screenshot({ path: `${SHOTS}/5-resized.png` });
  if (Math.abs((w1[0] ?? 0) - (w0[0] ?? 0) - 200) > 6) fail(`left pane ${w0[0]} → ${w1[0]}, expected +200`);
  if (Math.abs((w0[0] ?? 0) + (w0[1] ?? 0) - (w1[0] ?? 0) - (w1[1] ?? 0)) > 3) fail(`the row changed width: ${w0.join('+')} → ${w1.join('+')}`);
  console.log(`  ✓ ${w0.join(' / ')} → ${w1.join(' / ')}`);

  await page.reload({ waitUntil: 'networkidle2' });
  await page.waitForFunction(`document.querySelectorAll('section.session-col').length === 2`, { timeout: 20_000 });
  await sleep(SETTLE_MS);
  const w2 = await widths();
  if (Math.abs((w2[0] ?? 0) - (w1[0] ?? 0)) > 3) fail(`after a reload the widths are ${w2.join(' / ')}, expected ${w1.join(' / ')}`);
  console.log(`  ✓ survives a reload: ${w2.join(' / ')}`);

  // Past the floor: a pane never goes below 300px.
  const h2 = await page.$('.col-resize');
  if (!h2) fail('no resize handle between the panes after the reload');
  const b2 = await h2.boundingBox();
  if (!b2) fail('the resize handle has no box');
  await page.mouse.move(b2.x + 6, b2.y + 100);
  await page.mouse.down();
  await page.mouse.move(b2.x + 6 + 2000, b2.y + 100, { steps: 5 });
  await page.mouse.up();
  await sleep(SETTLE_MS);
  const w3 = await widths();
  if ((w3[1] ?? 0) < 298) fail(`the right pane went to ${w3[1]}px, below the 300px floor`);
  console.log(`  ✓ clamped at the floor: ${w3.join(' / ')}`);

  await page.click('.col-resize', { count: 2 });
  await sleep(SETTLE_MS);
  const w4 = await widths();
  if (Math.abs((w4[0] ?? 0) - (w4[1] ?? 0)) > 2) fail(`a double-click left ${w4.join(' / ')}`);
  console.log(`  ✓ double-click evens them: ${w4.join(' / ')}`);

  step('4. «Открыть в новом окне»: browser yes, old shell no, fixed shell yes');
  const menuItems = async (p: typeof page) => {
    await p.goto(`${target.http}/w/sessions`, { waitUntil: 'networkidle2' });
    await p.waitForSelector('a.pc-sess', { timeout: 20_000 });
    const r = await evalJs<{ x: number; y: number }>(p, `(() => { const b = document.querySelector('a.pc-sess').getBoundingClientRect(); return { x: b.x + 20, y: b.y + b.height / 2 }; })()`);
    await p.mouse.click(r.x, r.y, { button: 'right' });
    await p.waitForSelector('.ctxmenu', { timeout: 5_000 });
    return (await p.evaluate(`Array.from(document.querySelectorAll('.ctxmenu [role=menuitem]')).map((e) => e.textContent)`)) as string[];
  };
  const inBrowser = await menuItems(page);
  if (!inBrowser.includes('Открыть в новом окне')) fail(`browser menu: ${inBrowser.join(' | ')}`);
  const oldShell = await open('old');
  const inOld = await menuItems(oldShell);
  if (inOld.includes('Открыть в новом окне')) fail('an old shell (no __HEGAI_OWN_WINDOWS__) still offers the item that freezes it');
  const newShell = await open('new');
  const inNew = await menuItems(newShell);
  if (!inNew.includes('Открыть в новом окне')) fail(`a fixed shell does not offer it: ${inNew.join(' | ')}`);
  console.log('  ✓ browser: offered · shell ≤0.1.17: withheld · fixed shell: offered');

  if (errors.length) fail(`browser console errors:\n  ${errors.join('\n  ')}`);

  clearTimeout(timer);
  await browser.close();
  box.ws.close();
  other.ws.close();
  console.log('\nPASS: project opens its sessions; server/project chips re-aim the composer; panes resize and remember; the new-window item is safe per shell');
  process.exit(0);
}

main().catch((e) => fail(e instanceof Error ? e.stack ?? e.message : String(e)));
