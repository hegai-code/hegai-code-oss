/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/**
 * «Войти через Telegram» on the WEB, in a real Chrome against a real hub
 * serving a real web build; the bot is its real `LoginFlow` (only Telegram
 * itself is faked). What it presses, and what must happen:
 *
 *   A. landing → «Войти через Telegram» → the dialog shows the number → the
 *      bot offers it among five → pressing it reloads the page signed in, a
 *      new account on the waiting screen with «Вы вошли через Telegram как
 *      @x» over it; «Понятно» dismisses it for good.
 *   B. the wrong number → the dialog says the login was cancelled.
 *   C. Настройки → «Привязать Telegram» → «@x — это ваш аккаунт?» → linked,
 *      and /api/me says so.
 *   E. /link with a machine waiting: signing in through Telegram right there
 *      keeps «Подключить этот компьютер» shut until the person confirms who
 *      they are (a stranger who pressed first must not get the machine).
 *   D. a 390px phone: nothing scrolls sideways, dialog and banner fit.
 *
 * Needs a hub with CC_REMOTE_TG_LOGIN_SECRET, CC_REMOTE_PLATFORM_ADMIN_IDS=
 * smoke-admin, WEB_DIST=web/dist (`npm run build --workspace web` first) and a
 * fleet token that is NOT dev-token — see tg-login-smoke.ts for the command.
 *
 *   CC_SMOKE_HTTP=http://127.0.0.1:4399 CHROME_PATH=… \
 *   CC_REMOTE_SSO_SECRET=… CC_REMOTE_TG_LOGIN_SECRET=… \
 *   npx tsx tgbot/src/cli/tg-web-smoke.ts        # screenshots in /tmp/tg-web-smoke/
 */
import puppeteer, { type Page } from 'puppeteer-core';
import { mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { LoginFlow } from '../login.js';
import { mintSession } from '../auth.js';

const OUT = '/tmp/tg-web-smoke';
mkdirSync(OUT, { recursive: true });
const HUB = (process.env['CC_SMOKE_HTTP'] ?? 'http://127.0.0.1:4399').replace(/\/+$/, '');
const SSO = process.env['CC_REMOTE_SSO_SECRET'] ?? '';
const SECRET = process.env['CC_REMOTE_TG_LOGIN_SECRET'] ?? '';
// Not shared with server/src/cli/_harness.ts: tgbot's rootDir cannot reach it.
const CHROME = process.env['CHROME_PATH'] ?? '/root/.cache/puppeteer/chrome/linux-144.0.7559.96/chrome-linux64/chrome';
const results: string[] = [];
const ok = (cond: unknown, what: string) => { results.push(`${cond ? 'ok  ' : 'FAIL'} ${what}`); if (!cond) process.exitCode = 1; };

class FakeTg {
  sent: Array<{ text: string; keyboard?: Array<Array<{ text: string }>> }> = [];
  edits: string[] = [];
  async sendMessage(_c: number, text: string, o: { keyboard?: Array<Array<{ text: string }>> } = {}) { this.sent.push({ text, keyboard: o.keyboard }); return []; }
  async editMessage(_c: number, _m: number, text: string) { this.edits.push(text); return true; }
  async answerCallback() {}
}
const tg = new FakeTg();
const bot = new LoginFlow(tg as never, HUB, SECRET);
const person = (first: string) => ({ id: 1_000_000_000 + randomBytes(3).readUIntBE(0, 3), first_name: first, username: `web_${randomBytes(3).toString('hex')}` });
const msg = (from: ReturnType<typeof person>, code: string) => ({ message_id: 1, date: 0, chat: { id: from.id, type: 'private' }, from, text: `/start login_${code}` });
const tap = (from: ReturnType<typeof person>) => ({ id: 'cb', from, message: { message_id: 2, date: 0, chat: { id: from.id, type: 'private' } } });

let linkedPerson: ReturnType<typeof person> | undefined;
const browser = await puppeteer.launch({ executablePath: CHROME, args: ['--no-sandbox'] });

async function newPage(width: number, height: number, cookie?: string) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width, height });
  const errors: string[] = [];
  page.on('pageerror', (e: unknown) => errors.push(e instanceof Error ? e.message : String(e)));
  page.on('console', (m: { type(): string; text(): string }) => { if (m.type() === 'error' && !/401|Failed to load resource/.test(m.text())) errors.push(m.text()); });
  if (cookie) await page.setCookie({ name: HUB.startsWith('https://') ? '__Host-cc-remote-auth' : 'cc-remote-auth', value: cookie, url: HUB });
  return { page, errors };
}

async function clickText(page: Page, selector: string, text: string) {
  const done = await page.evaluate((sel: string, t: string) => {
    const el = [...document.querySelectorAll(sel)].find((e) => (e.textContent ?? '').includes(t) && (e as HTMLElement).offsetParent !== null) as HTMLElement | undefined;
    el?.click();
    return !!el;
  }, selector, text);
  if (!done) throw new Error(`no visible ${selector} «${text}»`);
}

async function openDialog(page: Page) {
  await page.waitForSelector('.tg-login-match', { timeout: 10_000 });
  const number = await page.$eval('.tg-login-match', (e: Element) => e.textContent!.trim());
  const url = await page.$eval('.tg-login a.btn.primary', (e: Element) => (e as HTMLAnchorElement).href);
  return { number, code: new URL(url).searchParams.get('start')!.replace('login_', '') };
}

async function overflow(page: Page) {
  return page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
}

// ---- A. a stranger signs in from the landing (desktop)
{
  const { page, errors } = await newPage(1280, 860);
  await page.goto(HUB + '/', { waitUntil: 'networkidle2' });
  await clickText(page, '.lp-final button', 'Войти через Telegram');
  const { number, code } = await openDialog(page);
  ok(/^\d{2}$/.test(number), `A: the dialog shows the number (${number})`);
  await page.screenshot({ path: `${OUT}/A1-dialog-desktop.png` });
  const danis = person('Данис');
  await bot.onStart(msg(danis, code), code);
  const numbers = tg.sent.at(-1)!.keyboard![0]!.map((b) => b.text);
  ok(numbers.includes(number), `A: the bot offers the page's number among ${numbers}`);
  await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20_000 }), bot.onCallback(tap(danis), { code, number })]);
  await page.waitForSelector('.tg-signed-in', { timeout: 10_000 });
  const banner = await page.$eval('.tg-signed-in', (e: Element) => e.textContent ?? '');
  ok(banner.includes(`@${danis.username}`) && banner.includes('Данис'), `A: «Вы вошли через Telegram как @${danis.username} · Данис»`);
  const gate = await page.evaluate(() => document.body.innerText.includes('Ты в списке'));
  ok(gate, 'A: a new account lands on the waiting screen, banner over it');
  await page.screenshot({ path: `${OUT}/A2-signed-in-desktop.png` });
  await clickText(page, '.tg-signed-in button', 'Понятно');
  ok(!(await page.$('.tg-signed-in')), 'A: «Понятно» dismisses it');
  await page.reload({ waitUntil: 'networkidle2' });
  ok(!(await page.$('.tg-signed-in')), 'A: and it stays gone after a reload');
  ok(errors.length === 0, `A: no page errors ${JSON.stringify(errors)}`);
}

// ---- B. the wrong number
{
  const { page, errors } = await newPage(1280, 860);
  await page.goto(HUB + '/', { waitUntil: 'networkidle2' });
  await clickText(page, '.lp-final button', 'Войти через Telegram');
  const { number, code } = await openDialog(page);
  const someone = person('Кто-то');
  await bot.onStart(msg(someone, code), code);
  const wrong = tg.sent.at(-1)!.keyboard![0]!.map((b) => b.text).find((n) => n !== number)!;
  await bot.onCallback(tap(someone), { code, number: wrong });
  await page.waitForFunction(() => document.querySelector('.tg-login [role="alert"]'), { timeout: 10_000 });
  const text = await page.$eval('.tg-login [role="alert"]', (e: Element) => e.textContent ?? '');
  ok(/Вход отменён/.test(text), `B: the page says the login was cancelled («${text.slice(0, 60)}…»)`);
  ok(!!(await page.evaluate(() => [...document.querySelectorAll('.tg-login button')].some((b) => b.textContent?.includes('Начать заново')))), 'B: «Начать заново» is offered');
  await page.screenshot({ path: `${OUT}/B-wrong-number.png` });
  ok(errors.length === 0, `B: no page errors ${JSON.stringify(errors)}`);
}

// ---- C. linking Telegram in Настройки (an active member)
{
  const memberId = `web-member-${randomBytes(3).toString('hex')}`;
  const member = await mintSession({ http: HUB, sso: { secret: SSO, userId: memberId, email: `${memberId}@smoke.invalid` } } as never);
  const admin = await mintSession({ http: HUB, sso: { secret: SSO, userId: 'smoke-admin', email: 'smoke-admin@smoke.invalid' } } as never);
  const act = await fetch(`${HUB}/api/admin/access/activate`, { method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', cookie: `${HUB.startsWith('https://') ? '__Host-cc-remote-auth' : 'cc-remote-auth'}=${admin}` }, body: JSON.stringify({ userIds: [memberId] }) });
  ok(act.ok, 'C: member activated');
  const { page, errors } = await newPage(1280, 860, member);
  await page.goto(HUB + '/w/settings', { waitUntil: 'networkidle2' });
  await page.waitForFunction(() => document.body.innerText.includes('Привязать Telegram'), { timeout: 15_000 });
  await page.screenshot({ path: `${OUT}/C1-settings-before.png` });
  await clickText(page, 'button', 'Привязать Telegram');
  const { number, code } = await openDialog(page);
  const owner = person('Владелец');
  linkedPerson = owner;
  await bot.onStart(msg(owner, code), code);
  ok(/Привязка Telegram/.test(tg.sent.at(-1)!.text), 'C: the bot shows a link card');
  await bot.onCallback(tap(owner), { code, number });
  await page.waitForFunction(() => document.body.innerText.includes('Это ваш аккаунт?'), { timeout: 10_000 });
  const ask = await page.evaluate(() => document.querySelector('.tg-login')?.textContent ?? '');
  ok(ask.includes(`@${owner.username}`), `C: the page asks «@${owner.username} — это ваш аккаунт?»`);
  await page.screenshot({ path: `${OUT}/C2-confirm-link.png` });
  await clickText(page, '.tg-login button', 'Да, привязать');
  await page.waitForFunction((u: string) => document.body.innerText.includes(`Telegram: ${u}`), { timeout: 10_000 }, `@${owner.username}`);
  ok(true, `C: Настройки show «Telegram: @${owner.username}»`);
  await page.screenshot({ path: `${OUT}/C3-linked.png` });
  const me = await (await fetch(`${HUB}/api/me`, { headers: { authorization: `Bearer ${member}` } })).json() as { telegram?: string };
  ok(me.telegram === `@${owner.username}`, `C: /api/me says telegram=${me.telegram}`);
  ok(errors.length === 0, `C: no page errors ${JSON.stringify(errors)}`);
}

// ---- E. /link: a machine is waiting; the person signs in through Telegram
// right there — «Подключить» stays shut until they confirm who they are.
{
  const req = await (await fetch(`${HUB}/api/enrollments/request`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ machine: { machineId: `m-${randomBytes(3).toString('hex')}`, name: 'Ноутбук', os: 'linux', agentVersion: '0.1' } }) })).json() as { userCode: string };
  const { page, errors } = await newPage(1280, 860);
  await page.goto(`${HUB}/link?c=${req.userCode}`, { waitUntil: 'networkidle2' });
  await clickText(page, '.link-signin button', 'Войти через Telegram');
  const { number, code } = await openDialog(page);
  await bot.onStart(msg(linkedPerson!, code), code);
  await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20_000 }), bot.onCallback(tap(linkedPerson!), { code, number })]);
  await page.waitForFunction(() => document.body.innerText.includes('Эта машина просит подключения'), { timeout: 15_000 });
  const disabled = await page.evaluate(() => [...document.querySelectorAll('.link-actions button')].find((b) => b.textContent?.includes('Подключить'))?.hasAttribute('disabled'));
  ok(disabled === true, 'E: «Подключить этот компьютер» is shut right after a Telegram sign-in');
  ok(await page.evaluate(() => document.body.innerText.includes('Подтвердите вверху')), 'E: the page says why');
  await page.screenshot({ path: `${OUT}/E1-link-held.png` });
  await clickText(page, '.tg-signed-in button', 'Понятно');
  await page.waitForFunction(() => ![...document.querySelectorAll('.link-actions button')].find((b) => b.textContent?.includes('Подключить'))?.hasAttribute('disabled'), { timeout: 5_000 });
  ok(true, 'E: after «Понятно» it opens');
  ok(errors.length === 0, `E: no page errors ${JSON.stringify(errors)}`);
}

// ---- D. a phone
{
  const { page, errors } = await newPage(390, 844);
  await page.goto(HUB + '/', { waitUntil: 'networkidle2' });
  ok((await overflow(page)) <= 0, 'D: the landing does not scroll sideways at 390px');
  await clickText(page, '.lp-final button', 'Войти через Telegram');
  const { number, code } = await openDialog(page);
  ok((await overflow(page)) <= 0, 'D: the dialog fits 390px');
  await page.screenshot({ path: `${OUT}/D1-dialog-phone.png` });
  const phone = person('Мария');
  await bot.onStart(msg(phone, code), code);
  await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20_000 }), bot.onCallback(tap(phone), { code, number })]);
  await page.waitForSelector('.tg-signed-in', { timeout: 10_000 });
  const box = await page.$eval('.tg-signed-in', (e: Element) => { const r = e.getBoundingClientRect(); return { left: r.left, right: r.right }; });
  ok(box.left >= 0 && box.right <= 390, `D: the banner fits the phone (${Math.round(box.left)}..${Math.round(box.right)})`);
  await page.screenshot({ path: `${OUT}/D2-signed-in-phone.png` });
  ok(errors.length === 0, `D: no page errors ${JSON.stringify(errors)}`);
}

await browser.close();
console.log(results.join('\n'));
console.log(process.exitCode ? 'FAIL tg-web-smoke' : `PASS tg-web-smoke — screenshots in ${OUT}`);
