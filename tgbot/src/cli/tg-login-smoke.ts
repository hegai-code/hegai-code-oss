/**
 * «Войти через Telegram», end to end against a REAL hub, with the bot's REAL
 * `LoginFlow` (only Telegram itself is faked). The contract lives in two
 * languages — Rust answers `/api/auth/telegram/*`, TypeScript sends the
 * bot's half — and a mismatch would otherwise only show in production.
 *
 *   1. A stranger: start (a number to show) → the card offers three numbers
 *      → the person presses the one on the screen → the client's poll gets a
 *      cookie → /api/me is a `tg-` account, no email, on the waitlist. Once.
 *   2. The wrong number kills the login (the phishing stop) and locks that
 *      Telegram account out of new logins; «Это не я» kills it too.
 *   3. A second Telegram account on one code kills the login for both.
 *   4. A device label the client made up never reaches the card.
 *   5. Linking: without a session → 401; from a waitlisted account → 403
 *      (the access gate); from an active one → the card names the target account,
 *      the press only PROPOSES, the poll says which @username pressed, and
 *      the link exists only after the account confirms it — then a plain
 *      Telegram sign-in opens that account.
 *   6. A native client gets the session in the body and no cookie.
 *   7. A wrong bot secret → 401.
 *   8. An ADMIN links Telegram (no privileged refusal since 09.10.2026); a
 *      Telegram that opened an empty account of its own moves to the admin,
 *      that account's sign-ins end; «Способы входа» lists both ways in, and
 *      the last one cannot be unlinked.
 *
 * Start a LOCAL hub with SSO and Telegram sign-in and a fresh database. NOT
 * `CC_REMOTE_TOKEN=dev-token`: a dev hub treats every request as the owner, so
 * «link without a session» (step 5) could never be refused.
 *
 *   CC_REMOTE_TOKEN=smoke-fleet-token-0123456789-0123456789 \
 *   CC_REMOTE_SSO_SECRET=smoke-sso-secret-0123456789-0123456789 \
 *   CC_REMOTE_TG_LOGIN_SECRET=smoke-tg-login-secret-0123456789-0123 \
 *   CC_REMOTE_PLATFORM_ADMIN_IDS=smoke-admin \
 *   CC_REMOTE_PUBLIC_URL=http://127.0.0.1:4399 PORT=4399 \
 *   CC_REMOTE_DB_PATH=/tmp/cc-remote-tglogin.sqlite3 \
 *   cargo run --manifest-path server-rs/Cargo.toml
 *
 *   CC_SMOKE_HTTP=http://127.0.0.1:4399 \
 *   CC_REMOTE_SSO_SECRET=… CC_REMOTE_TG_LOGIN_SECRET=… \
 *   npx tsx tgbot/src/cli/tg-login-smoke.ts
 */
import { randomBytes } from 'node:crypto';
import { mintSession } from '../auth.js';
import type { Config } from '../config.js';
import { LoginFlow, type LoginTelegram } from '../login.js';
import type { InlineKeyboard, TgUser } from '../telegram.js';

const HTTP = (process.env['CC_SMOKE_HTTP'] ?? 'http://127.0.0.1:4399').replace(/\/+$/, '');
const SSO_SECRET = process.env['CC_REMOTE_SSO_SECRET'] ?? '';
const LOGIN_SECRET = process.env['CC_REMOTE_TG_LOGIN_SECRET'] ?? '';
/** An https hub sets and reads `__Host-cc-remote-auth`; a plain-http smoke hub the bare name. */
const AUTH_NAME = HTTP.startsWith('https://') ? '__Host-cc-remote-auth' : 'cc-remote-auth';
/** A platform admin on the hub under test (CC_REMOTE_PLATFORM_ADMIN_IDS). */
const ADMIN_ID = process.env['CC_SMOKE_ADMIN_ID'] ?? 'smoke-admin';

function fail(why: string): never {
  console.error(`FAIL: ${why}`);
  process.exit(1);
}
function check(ok: unknown, why: string): void {
  if (!ok) fail(why);
  console.log(`  ok  ${why}`);
}

/** Telegram, as far as the flow can tell: it records what the bot said. */
class FakeTelegram implements LoginTelegram {
  sent: Array<{ text: string; keyboard?: InlineKeyboard }> = [];
  edits: string[] = [];
  alerts: string[] = [];
  async sendMessage(_chat: number, text: string, opts: { keyboard?: InlineKeyboard } = {}) {
    this.sent.push({ text, keyboard: opts.keyboard });
    return [];
  }
  async editMessage(_chat: number, _id: number, text: string) {
    this.edits.push(text);
    return true;
  }
  async answerCallback(_id: string, text?: string, alert?: boolean) {
    if (alert && text) this.alerts.push(text);
  }
  /** The numbers on the last card, as the person sees them. */
  numbers(): string[] {
    return (this.sent.at(-1)?.keyboard?.[0] ?? []).map((b) => b.text);
  }
}

const person = (first: string): TgUser => ({
  // A fresh id per run: identities outlive a smoke run on a reused database.
  id: 1_000_000_000 + randomBytes(3).readUIntBE(0, 3),
  first_name: first,
  username: `smoke_${randomBytes(3).toString('hex')}`,
});

interface Started { code: string; pollToken: string; match: string; url: string }

async function start(body: Record<string, unknown>, cookie?: string) {
  const res = await fetch(`${HTTP}/api/auth/telegram/start`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/140.0 Safari/537.36',
      'sec-fetch-site': 'same-origin',
      ...(cookie ? { cookie: `${AUTH_NAME}=${cookie}` } : {}),
    },
    body: JSON.stringify(body),
  });
  // One run starts ~13 logins; the hub allows 20 per address per hour. A
  // second run against the same hub process trips it — say so, not «FAIL
  // somewhere later».
  if (res.status === 429) fail('start → 429: the per-address limit (20/hour). Restart the throwaway hub and run again.');
  return { status: res.status, body: (await res.json()) as Started };
}

async function poll(pollToken: string) {
  const res = await fetch(`${HTTP}/api/auth/telegram/poll`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pollToken }),
  });
  const cookie = res.headers
    .getSetCookie()
    .map((l) => l.split(';')[0]!)
    .find((p) => p.startsWith(`${AUTH_NAME}=`))
    ?.slice(AUTH_NAME.length + 1);
  return { status: res.status, body: (await res.json()) as Record<string, unknown>, cookie };
}

async function finishLink(pollToken: string, cookie: string) {
  const res = await fetch(`${HTTP}/api/auth/telegram/link`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', cookie: `${AUTH_NAME}=${cookie}` },
    body: JSON.stringify({ pollToken }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function me(session: string) {
  const res = await fetch(`${HTTP}/api/me`, { headers: { authorization: `Bearer ${session}` } });
  return (await res.json()) as { userId: string; email?: string; fullName?: string; access?: { state: string } };
}

const message = (from: TgUser, code: string) => ({
  message_id: 1, date: 0, chat: { id: from.id, type: 'private' }, from, text: `/start login_${code}`,
});
const tap = (from: TgUser) => ({
  id: 'cb', from, message: { message_id: 7, date: 0, chat: { id: from.id, type: 'private' } },
});

async function main(): Promise<void> {
  if (!SSO_SECRET || !LOGIN_SECRET) fail('set CC_REMOTE_SSO_SECRET and CC_REMOTE_TG_LOGIN_SECRET (the hub’s)');
  const tg = new FakeTelegram();
  const flow = new LoginFlow(tg, HTTP, LOGIN_SECRET);

  console.log('1. a stranger signs in with the number on the screen and lands on the waitlist');
  const danis = person('Данис');
  const s1 = await start({ client: 'web' });
  check(s1.status === 201, `start → 201 (got ${s1.status})`);
  check(/^\d{2}$/.test(s1.body.match), `a two-digit number to show (${s1.body.match})`);
  check(new RegExp(`^https://t\\.me/\\w+\\?start=login_${s1.body.code}$`).test(s1.body.url), `deep link ${s1.body.url}`);
  check((await poll(s1.body.pollToken)).body['status'] === 'pending', 'poll before the press → pending');
  await flow.onStart(message(danis, s1.body.code), s1.body.code);
  const card = tg.sent.at(-1)!;
  check(/будет создана новая/.test(card.text) && /Chrome · macOS/.test(card.text) && /на 7 дней/.test(card.text),
    'the card: new account, the device that asked, a 7-day sign-in');
  check(tg.numbers().length === 5 && tg.numbers().includes(s1.body.match), `five numbers, the screen’s among them (${tg.numbers()})`);
  await flow.onCallback(tap(danis), { code: s1.body.code, number: s1.body.match });
  check(/Готово/.test(tg.edits.at(-1)!), 'the card turns into «Готово»');
  const p1 = await poll(s1.body.pollToken);
  check(p1.body['status'] === 'approved' && !!p1.cookie, 'poll → approved + auth cookie');
  check(p1.body['telegram'] === `@${danis.username}`, 'the poll says which Telegram signed in');
  const who = await me(p1.cookie!);
  check(who.userId.startsWith('tg-'), `a hub-owned id (${who.userId})`);
  check(who.email === undefined, 'no email key at all');
  check(who.fullName === 'Данис', 'the Telegram name');
  check(who.access?.state === 'waitlist', 'on the waitlist');
  const again = await poll(s1.body.pollToken);
  check(again.body['status'] === 'used' && !again.cookie, 'a second poll gets nothing');

  console.log('2. the wrong number kills the login and locks; so does «Это не я»');
  const s2 = await start({});
  await flow.onStart(message(danis, s2.body.code), s2.body.code);
  check(/Учётка: <b>Данис<\/b>/.test(tg.sent.at(-1)!.text), 'the card now names the existing account');
  check(tg.numbers().length === 5, 'five numbers: a blind press is right one time in five');
  const victim = person('Жертва');
  const sw = await start({});
  await flow.onStart(message(victim, sw.body.code), sw.body.code);
  const wrong = tg.numbers().find((n) => n !== sw.body.match)!;
  await flow.onCallback(tap(victim), { code: sw.body.code, number: wrong });
  check(/Число не совпало/.test(tg.edits.at(-1)!), 'a wrong number → «Число не совпало», buttons gone');
  check((await poll(sw.body.pollToken)).body['status'] === 'denied', 'poll → denied');
  const retry = await start({});
  await flow.onStart(message(victim, retry.body.code), retry.body.code);
  check(/приостановлен на полчаса/.test(tg.sent.at(-1)!.text), 'the next link does not open for that Telegram account');
  const s2b = await start({});
  await flow.onStart(message(danis, s2b.body.code), s2b.body.code);
  await flow.onCallback(tap(danis), { code: s2b.body.code, notMe: true });
  check((await poll(s2b.body.pollToken)).body['status'] === 'denied', '«Это не я» → denied');

  console.log('3. a second Telegram account on one code kills the login');
  const other = person('Чужой');
  const s3 = await start({});
  await flow.onStart(message(danis, s3.body.code), s3.body.code);
  await flow.onCallback(tap(other), { code: s3.body.code, number: s3.body.match });
  check(/с двух аккаунтов/.test(tg.alerts.at(-1) ?? ''), 'refused with an alert');
  check((await poll(s3.body.pollToken)).body['status'] === 'denied', 'and nobody signs in with that code');

  console.log('4. a device label the client made up never reaches the card');
  const s4 = await start({ device: 'iPhone · проверка безопасности' });
  await flow.onStart(message(person('Тест'), s4.body.code), s4.body.code);
  check(!/проверка безопасности/.test(tg.sent.at(-1)!.text), 'made-up text dropped');

  console.log('5. linking Telegram to a signed-in account takes the account’s own «yes»');
  const noSession = await start({ intent: 'link' });
  check(noSession.status === 401, `link without a session → 401 (got ${noSession.status})`);
  const memberId = `smoke-member-${randomBytes(4).toString('hex')}`;
  const cfg = {
    http: HTTP,
    sso: { secret: SSO_SECRET, userId: memberId, email: `${memberId}@smoke.invalid` },
  } as unknown as Config;
  const member = await mintSession(cfg);
  const waiting = await start({ intent: 'link' }, member);
  check(waiting.status === 403, `link from a waitlisted account → 403 (got ${waiting.status})`);
  const admin = await mintSession({
    http: HTTP,
    sso: { secret: SSO_SECRET, userId: ADMIN_ID, email: `${ADMIN_ID}@smoke.invalid` },
  } as unknown as Config);
  const activated = await fetch(`${HTTP}/api/admin/access/activate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', cookie: `${AUTH_NAME}=${admin}` },
    body: JSON.stringify({ userIds: [memberId] }),
  });
  check(activated.ok, `the admin activates the member (${activated.status})`);
  const owner = person('Владелец');
  const s5 = await start({ intent: 'link' }, member);
  check(s5.status === 201, `link with a session → 201 (got ${s5.status} ${JSON.stringify(s5.body)})`);
  await flow.onStart(message(owner, s5.body.code), s5.body.code);
  const linkCard = tg.sent.at(-1)!.text;
  check(/Привязка Telegram/.test(linkCard) && linkCard.includes(memberId), 'the link card names the target account');
  await flow.onCallback(tap(owner), { code: s5.body.code, number: s5.body.match });
  check(/подтвердите там привязку/.test(tg.edits.at(-1)!), 'the bot sends the person back to confirm');
  const proposal = await poll(s5.body.pollToken);
  check(proposal.body['status'] === 'confirm_link' && proposal.body['telegram'] === `@${owner.username}`,
    `the poll shows who pressed (${JSON.stringify(proposal.body)})`);
  const early = await start({});
  await flow.onStart(message(owner, early.body.code), early.body.code);
  check(/будет создана новая/.test(tg.sent.at(-1)!.text), 'before the «yes» that Telegram opens nothing of the member’s');
  await flow.onCallback(tap(owner), { code: early.body.code, notMe: true });
  const linked = await finishLink(s5.body.pollToken, member);
  check(linked.status === 200 && linked.body['status'] === 'linked', `the account’s «yes» links it (${linked.status})`);
  const s6 = await start({});
  await flow.onStart(message(owner, s6.body.code), s6.body.code);
  await flow.onCallback(tap(owner), { code: s6.body.code, number: s6.body.match });
  const p6 = await poll(s6.body.pollToken);
  check((await me(p6.cookie!)).userId === memberId, 'now a plain Telegram sign-in opens the member’s account');

  console.log('6. a native client');
  const s7 = await start({ client: 'native', device: 'iPhone' });
  await flow.onStart(message(danis, s7.body.code), s7.body.code);
  check(/Устройство: iPhone/.test(tg.sent.at(-1)!.text) && /на 90 дней/.test(tg.sent.at(-1)!.text),
    'the app’s own label from the list, a 90-day sign-in');
  await flow.onCallback(tap(danis), { code: s7.body.code, number: s7.body.match });
  const p7 = await poll(s7.body.pollToken);
  check(typeof p7.body['session'] === 'string' && !p7.cookie, 'session in the body, no cookie');
  check((await me(p7.body['session'] as string)).userId === who.userId, 'and it is the same Telegram account');
  // «Это не я — выйти» on the phone: the app's bearer session must die on the
  // hub, not just be forgotten on the device.
  const out = await fetch(`${HTTP}/api/logout`, { method: 'POST', headers: { authorization: `Bearer ${p7.body['session']}` } });
  check(out.status === 200 && (await out.json() as { revoked?: boolean }).revoked === true,
    `a native session signs out by its bearer, and the hub says so (${out.status})`);
  const after = await fetch(`${HTTP}/api/me`, { headers: { authorization: `Bearer ${p7.body['session']}` } });
  check(after.status === 401, `and is gone on the hub (${after.status})`);
  const outAgain = await fetch(`${HTTP}/api/logout`, { method: 'POST', headers: { authorization: `Bearer ${p7.body['session']}` } });
  check((await outAgain.json() as { revoked?: boolean }).revoked === false, 'a second sign-out says nothing was revoked');

  console.log('7. only the bot may confirm');
  const forged = await fetch(`${HTTP}/api/auth/telegram/confirm`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer not-the-secret' },
    body: JSON.stringify({ code: s3.body.code, action: 'choose', choice: s3.body.match, telegram: { id: 1 } }),
  });
  check(forged.status === 401, `a wrong secret → 401 (got ${forged.status})`);

  console.log('8. an admin links Telegram too, and it moves off the empty account it opened');
  // Danis's Telegram opened the empty `tg-` account from step 1. The admin
  // proving it from the admin's own session moves it there (09.10.2026).
  const s8 = await start({ intent: 'link' }, admin);
  check(s8.status === 201, `an admin may start a link (${s8.status} ${JSON.stringify(s8.body)})`);
  await flow.onStart(message(danis, s8.body.code), s8.body.code);
  check(/она будет закрыта, вход переедет/.test(tg.sent.at(-1)!.text), 'the card says the Telegram moves off its empty account');
  await flow.onCallback(tap(danis), { code: s8.body.code, number: s8.body.match });
  check((await poll(s8.body.pollToken)).body['status'] === 'confirm_link', 'the press proposes the link');
  const moved = await finishLink(s8.body.pollToken, admin);
  check(moved.status === 200 && moved.body['movedFrom'] === who.userId,
    `linked, moved off the empty account (${moved.status} ${JSON.stringify(moved.body)})`);
  const gone = await fetch(`${HTTP}/api/me`, { headers: { authorization: `Bearer ${p1.cookie}` } });
  check(gone.status === 401, `the empty account's sign-ins ended (${gone.status})`);
  const s9 = await start({});
  await flow.onStart(message(danis, s9.body.code), s9.body.code);
  await flow.onCallback(tap(danis), { code: s9.body.code, number: s9.body.match });
  const p9 = await poll(s9.body.pollToken);
  check((await me(p9.cookie!)).userId === ADMIN_ID, 'a plain Telegram sign-in opens the admin’s account now');
  const ids = await fetch(`${HTTP}/api/me/identities`, { headers: { authorization: `Bearer ${admin}` } });
  const listed = (await ids.json()) as { identities: Array<{ provider: string; label?: string }> };
  check(ids.ok && listed.identities.map((i) => i.provider).sort().join(',') === 'hegai,telegram',
    `«Способы входа» lists both (${JSON.stringify(listed)})`);
  const unlink = (provider: string) => fetch(`${HTTP}/api/me/identities/unlink`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', cookie: `${AUTH_NAME}=${admin}` },
    body: JSON.stringify({ provider }),
  });
  check((await unlink('telegram')).status === 200, 'unlinking Telegram');
  const last = await unlink('hegai');
  check(last.status === 409 && (await last.json() as { error?: string }).error === 'last_identity',
    'the last way in cannot be unlinked');

  console.log('PASS tg-login-smoke');
}

main().catch((e) => fail((e as Error).stack ?? String(e)));
