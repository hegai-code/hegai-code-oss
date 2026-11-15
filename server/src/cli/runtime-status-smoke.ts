/**
 * What a machine's Claude and Codex ARE — found, logged in as whom, own login
 * or a gateway — drawn on the «Железо» card and in the limits meter, in a real
 * browser.
 *
 * This smoke exists because of a Mac that showed its Codex sessions and no
 * Codex limits, and nothing on any screen said why (24.09.2026). The agent
 * could not find `codex` (installed under nvm, invisible to a LaunchAgent's
 * PATH), the usage poll resolved to `null`, and the meter simply had no Codex
 * section — an absence that reads as «no Codex», not «Codex needs a hand».
 *
 * What it proves, in order:
 *   1. a `runtime_status` from the agent reaches the browser and the machine
 *      card says «Codex не найден» with the fix under it, and «Claude · … ·
 *      email» beside it;
 *   2. the limits popover carries that problem as a row, not silence;
 *   3. a later reading (Codex found, ChatGPT login) plus a `codex_usage`
 *      carrying the account turns into a Codex section headed by the email
 *      and plan;
 *   4. a gateway-routed Codex is labelled as such on the card, and an empty
 *      `codex_usage` clears the personal bars — the shared pool is not drawn
 *      as anyone's subscription;
 *   5. a Claude whose tokens the CLI blanked (`error: logged_out`) is drawn
 *      as «вход слетел», not as the account name that outlived the login.
 *
 * The agent is FAKE (the readings arrive on command); the browser, the web
 * bundle, the hub binary and every frame between them are real. Run it the
 * same way as compact-smoke.ts (see deploy/SMOKE-TESTS.md); screenshots land
 * in /tmp/runtime-status-smoke/.
 */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import {
  adminLogin,
  connectUiAs,
  enrollFakeAgent,
  fail,
  fakeSession,
  nextBrowserFrame,
  smokeTarget,
  sleep,
  chromePath,
  launchBrowser,
  step,
  evalJs,
} from './_harness.js';


const SHOTS = '/tmp/runtime-status-smoke';

const target = smokeTarget(process.argv);
const timer = setTimeout(() => fail('timed out (120s)'), 120_000);

/** Every runtime chip on the hardware page, as text. */
const CHIPS_JS = `Array.from(document.querySelectorAll('.rt-rows .hw-chip')).map((c) => c.textContent.trim())`;
/** What the card offers beside a chip. The «Железо» card is compact since
 *  0e3bad8: no hint paragraph, so «what to do» is the action button, and
 *  «why» is the chip's title (the detail line). Both are read here. */
const HINTS_JS = `Array.from(document.querySelectorAll('.rt-rows .rt-row')).flatMap((r) => [
  ...Array.from(r.querySelectorAll('.rt-hint, .rt-actions button')).map((e) => e.textContent.trim()),
  ...Array.from(r.querySelectorAll('.hw-chip[title]')).map((e) => e.getAttribute('title') || ''),
]).filter(Boolean)`;
interface PopoverSection {
  title: string;
  heads: string[];
  bars: number;
  status: string[];
}
/** The popover, section by section: title + account heads + status rows. */
const POPOVER_JS = `
  Array.from(document.querySelectorAll('.usage-pop .usage-section')).map((s) => ({
    title: (s.querySelector('.usage-section-title') || {}).textContent || '',
    heads: Array.from(s.querySelectorAll('.uacct:not(.ustatus) .uacct-head')).map((h) => h.textContent.trim()),
    bars: s.querySelectorAll('.uacct:not(.ustatus) .uwin').length,
    status: Array.from(s.querySelectorAll('.ustatus')).map((r) => r.textContent.trim()),
  }))
`;

const NOT_FOUND = {
  claude: { present: true, version: '0.3.220', auth: 'oauth', account: 'smoke@example.com', plan: 'max 5x', checkedAt: 1 },
  codex: {
    present: false,
    auth: 'none',
    provider: 'own',
    error: 'not_found',
    detail: 'искал: /opt/homebrew/bin, /usr/local/bin, /Users/smoke/.npm-global/bin',
    checkedAt: 1,
  },
};
const CHATGPT = {
  claude: NOT_FOUND.claude,
  codex: { present: true, path: '/Users/smoke/.nvm/versions/node/v22.11.0/bin/codex', version: '0.154.0', auth: 'chatgpt', account: 'ilya@example.com', plan: 'plus', provider: 'own', checkedAt: 2 },
};
/** Claude «logged in» by name with a blanked token — vps-box-1 for six weeks,
 *  found 28.09.2026. The chip must stop saying the account is fine. */
const CLAUDE_DEAD = {
  claude: { ...NOT_FOUND.claude, error: 'logged_out', checkedAt: 4 },
  codex: { present: true, path: '/usr/local/bin/codex', version: '0.154.0', auth: 'none', provider: 'gateway', providerName: 'hegai', checkedAt: 4 },
};
const GATEWAY = {
  claude: NOT_FOUND.claude,
  codex: { present: true, path: '/usr/local/bin/codex', version: '0.154.0', auth: 'none', provider: 'gateway', providerName: 'hegai', checkedAt: 3 },
};

async function main(): Promise<void> {
  if (!target.ssoSecret) fail('CC_REMOTE_SSO_SECRET is not set in this shell (must match the hub)');
  const secret = target.ssoSecret;
  mkdirSync(SHOTS, { recursive: true });
  console.log(`[runtime-status-smoke] hub ${target.http}  chrome ${chromePath()}`);

  step('1. Owner signs in, a fake agent registers and reports «codex not found»');
  const owner = await adminLogin(target.http, secret);
  const agent = await enrollFakeAgent(target, owner, {
    name: 'smoke-macbook',
    os: 'mac',
    sessions: [fakeSession('/home/smoke/proj', 'Проект')],
  });
  const probe = await connectUiAs(target.ws, owner);
  await nextBrowserFrame(probe, 'snapshot', (s) => s.machines.some((m) => m.machine.machineId === agent.machineId));
  const fanned = nextBrowserFrame(probe, 'runtime_status', (m) => m.machineId === agent.machineId);
  agent.ws.send(JSON.stringify({ type: 'runtime_status', runtimes: NOT_FOUND }));
  const got = await fanned;
  assert.equal(got.runtimes.codex?.error, 'not_found', 'the hub fans the reading to a controlling UI');
  probe.close();
  console.log('  ✓ hub relayed runtime_status (codex: not_found)');

  step('2. Real Chrome on «Железо»: the card says what is wrong and what to do');
  const browser = await launchBrowser();
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  page.on('console', (m: { type: () => string; text: () => string }) => {
    if (m.type() === 'error') console.log(`  [browser error] ${m.text()}`);
  });
  const cookie = owner.cookie.split(';')[0] ?? '';
  const [cookieName, ...cookieRest] = cookie.split('=');
  await browser.setCookie({ name: (cookieName ?? '').trim(), value: cookieRest.join('='), domain: '127.0.0.1', path: '/' });
  await page.goto(`${target.http}/w/hardware`, { waitUntil: 'networkidle2' });
  await page.waitForSelector('.rt-rows .hw-chip', { timeout: 20_000 });
  let chips = await evalJs<string[]>(page, CHIPS_JS);
  let hints = await evalJs<string[]>(page, HINTS_JS);
  await page.screenshot({ path: `${SHOTS}/1-not-found.png` });
  assert.ok(chips.some((c) => /^Claude · Max 5x · smoke@example\.com$/.test(c)), `Claude chip names plan and account (got ${JSON.stringify(chips)})`);
  assert.ok(chips.includes('Codex не найден'), `Codex chip says not found (got ${JSON.stringify(chips)})`);
  assert.ok(hints.includes('Установить'), `the card offers the fix (got ${JSON.stringify(hints)})`);
  assert.ok(hints.some((h) => /\/Users\/smoke\/\.npm-global\/bin/.test(h)), 'and the dirs the agent searched');
  console.log(`  ✓ chips: ${chips.join(' | ')}`);

  step('2b. Claude\'s token blanked while the account name survives → a red chip, not the name');
  agent.ws.send(JSON.stringify({ type: 'runtime_status', runtimes: CLAUDE_DEAD }));
  await page.waitForFunction(`(${CHIPS_JS}).some((c) => c === 'Claude · вход слетел')`, { timeout: 15_000 });
  chips = await evalJs<string[]>(page, CHIPS_JS);
  hints = await evalJs<string[]>(page, HINTS_JS);
  assert.ok(hints.includes('Войти'), `the card offers to sign in again (hints: ${JSON.stringify(hints)})`);
  await page.screenshot({ path: `${SHOTS}/7-claude-dead.png` });
  console.log(`  ✓ chips: ${chips.join(' | ')}`);

  // Put the healthy reading back: the steps below assume it, and the hub
  // answers the recovery with its «снова в порядке» line.
  agent.ws.send(JSON.stringify({ type: 'runtime_status', runtimes: NOT_FOUND }));
  await page.waitForFunction(`(${CHIPS_JS}).some((c) => /^Claude · Max 5x/.test(c))`, { timeout: 15_000 });
  console.log('  ✓ back to healthy');

  step('3. The limits popover carries the problem as a row, not silence');
  await page.waitForSelector('.usage-pill', { timeout: 20_000 });
  await page.click('.usage-pill');
  await page.waitForSelector('.usage-pop', { timeout: 10_000 });
  let sections = await evalJs<PopoverSection[]>(page, POPOVER_JS);
  await page.screenshot({ path: `${SHOTS}/2-popover-not-found.png` });
  const codexSec = sections.find((s) => s.title === 'Codex');
  assert.ok(codexSec, `a Codex section exists although no limits arrived (sections: ${sections.map((s) => s.title).join(', ')})`);
  assert.ok(codexSec.status.some((s) => /smoke-macbook/.test(s) && /Codex не найден/.test(s)), `its row names the machine and the problem (${JSON.stringify(codexSec.status)})`);
  assert.equal(codexSec.bars, 0, 'and draws no bars for it');
  console.log(`  ✓ popover: ${codexSec.status.join(' | ')}`);
  await page.keyboard.press('Escape');
  await page.click('body');

  step('4. Codex found + ChatGPT login + limits → a section headed by the email and plan');
  agent.ws.send(JSON.stringify({ type: 'runtime_status', runtimes: CHATGPT }));
  agent.ws.send(
    JSON.stringify({
      type: 'codex_usage',
      usage: {
        limits: [
          { key: 'session', label: 'Session (5hr)', group: 'session', percent: 23 },
          { key: 'weekly_all', label: 'Weekly (1 week)', group: 'weekly', percent: 41 },
        ],
        account: 'ilya@example.com',
        subscription: 'plus',
        updatedAt: Date.now(),
      },
    }),
  );
  await page.waitForFunction(`(${CHIPS_JS}).some((c) => /Codex · Plus · ilya@example\\.com/.test(c))`, { timeout: 15_000 });
  chips = await evalJs<string[]>(page, CHIPS_JS);
  hints = await evalJs<string[]>(page, HINTS_JS);
  assert.ok(!hints.includes('Установить'), 'the fix is gone with the problem');
  await page.screenshot({ path: `${SHOTS}/3-chatgpt.png` });
  console.log(`  ✓ chips: ${chips.join(' | ')}`);
  await page.click('.usage-pill');
  await page.waitForSelector('.usage-pop', { timeout: 10_000 });
  await page.waitForFunction(`(${POPOVER_JS}).some((s) => s.title === 'Codex' && s.bars > 0)`, { timeout: 15_000 });
  sections = await evalJs<PopoverSection[]>(page, POPOVER_JS);
  await page.screenshot({ path: `${SHOTS}/4-popover-chatgpt.png` });
  const codexLimits = sections.find((s) => s.title === 'Codex');
  assert.ok(codexLimits && codexLimits.bars === 2, `two Codex bars (${JSON.stringify(codexLimits)})`);
  assert.ok(codexLimits.heads.some((h) => /ilya@example\.com/.test(h) && /plus/i.test(h)), `the head names the account and plan (${JSON.stringify(codexLimits.heads)})`);
  assert.equal(codexLimits.status.length, 0, 'no status row once the numbers are there');
  console.log(`  ✓ Codex section: ${codexLimits.heads.join(' | ')} · ${codexLimits.bars} bars`);
  await page.keyboard.press('Escape');
  await page.click('body');

  step('5. Gateway-routed Codex: labelled on the card, personal bars cleared');
  agent.ws.send(JSON.stringify({ type: 'runtime_status', runtimes: GATEWAY }));
  agent.ws.send(JSON.stringify({ type: 'codex_usage', usage: { updatedAt: Date.now() } }));
  await page.waitForFunction(`(${CHIPS_JS}).some((c) => c === 'Codex · шлюз a.test')`, { timeout: 15_000 });
  chips = await evalJs<string[]>(page, CHIPS_JS);
  hints = await evalJs<string[]>(page, HINTS_JS);
  assert.ok(!hints.includes('Войти') && !hints.includes('Установить'), `a gateway machine with no login is not a problem (hints: ${JSON.stringify(hints)})`);
  await page.screenshot({ path: `${SHOTS}/5-gateway.png` });
  // On this stand the Codex bars were the only figure the pill had: no Claude
  // usage was ever sent and no gateway quota file exists. So once they are
  // cleared the pill has nothing to say and is not drawn at all — which is the
  // assertion, not an obstacle. On a real fleet the same machine would sit
  // under «Codex · шлюз a.test» beside the shared bars.
  await page.waitForFunction(
    `!document.querySelector('.usage-pill') || !/Codex/.test(document.querySelector('.usage-pill').textContent)`,
    { timeout: 15_000 },
  );
  const pillLeft = await evalJs<string | null>(page, `(document.querySelector('.usage-pill') || {}).textContent || null`);
  if (pillLeft) {
    await page.click('.usage-pill');
    await page.waitForSelector('.usage-pop', { timeout: 10_000 });
    await sleep(500);
    sections = await evalJs<PopoverSection[]>(page, POPOVER_JS);
    await page.screenshot({ path: `${SHOTS}/6-popover-gateway.png` });
    const codexAfter = sections.find((s) => s.title === 'Codex');
    assert.ok(!codexAfter || codexAfter.bars === 0, `no personal Codex bars remain (${JSON.stringify(codexAfter)})`);
  }
  console.log(`  ✓ chips: ${chips.join(' | ')}; pill: ${pillLeft ?? 'gone — nothing personal left to draw'}`);

  await browser.close();
  agent.ws.close();
  clearTimeout(timer);
  console.log(`\n[runtime-status-smoke] PASS — screenshots in ${SHOTS}/`);
}

main().catch((e) => fail(e instanceof Error ? (e.stack ?? e.message) : String(e)));
