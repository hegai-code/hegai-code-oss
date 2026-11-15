// «Войти через Telegram» — the bot's half. The one property that matters most:
// a stranger's `/start login_…` and button presses reach ONLY the login flow,
// never the owner's paths (onMessage / onCommand / onCallback), which drive
// real machines as the owner.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  LoginFlow,
  loginKeyboard,
  parseLoginCallback,
  parseLoginStart,
  renderDecision,
  renderLoginError,
  renderNotice,
  renderUndone,
  renderPeek,
  noticeKeyboard,
  PHISHING_WARNING,
  STRANGER_HINT,
} from '../src/login.js';
import { Bot } from '../src/bot.js';
import { Store } from '../src/state.js';
import type { Config } from '../src/config.js';
import type { TgUpdate } from '../src/telegram.js';

const CODE = '0123456789abcdef0123456789abcdef';
const STRANGER = { id: 555, first_name: 'Данис', username: 'danis_latypov' };

test('only an exact /start login_<32 hex> is a login; callbacks carry a verdict', () => {
  assert.equal(parseLoginStart(`/start login_${CODE}`), CODE);
  assert.equal(parseLoginStart(`/start@Hegaicodebot login_${CODE}`), CODE);
  assert.equal(parseLoginStart(`/start login_${CODE}x`), null);
  assert.equal(parseLoginStart(`/start login_${CODE.toUpperCase()}`), null);
  assert.equal(parseLoginStart('/start'), null);
  assert.equal(parseLoginStart(`/new login_${CODE}`), null);
  assert.deepEqual(parseLoginCallback(`tl:n:${CODE}:47`), { code: CODE, number: '47' });
  assert.deepEqual(parseLoginCallback(`tl:d:${CODE}`), { code: CODE, notMe: true });
  assert.equal(parseLoginCallback(`tl:n:${CODE}:7`), null);
  assert.equal(parseLoginCallback(`tl:a:${CODE}`), null);
  assert.equal(parseLoginCallback('wla:abc'), null);
  for (const row of loginKeyboard(CODE, ['12', '47', '93'])) for (const b of row) assert.ok(Buffer.byteLength(b.callback_data!) <= 64);
});

test('the card says what pressing does, escapes what users typed, and asks for the number', () => {
  const fresh = renderPeek({ intent: 'login', device: '<b>Chrome</b> · macOS', ip: '203.0.113.7', sessionDays: 7 });
  assert.match(fresh, /Устройство: &lt;b&gt;Chrome&lt;\/b&gt; · macOS\n/);
  assert.doesNotMatch(fresh, /203\.0\.113\.7/, 'never an address on the card');
  assert.match(fresh, /будет создана новая/);
  assert.match(fresh, /Вход на 7 дней/);
  assert.match(fresh, /Нажмите число, которое видно на экране/);
  assert.match(renderPeek({ intent: 'login', sessionDays: 90 }), /на 90 дней/);
  const known = renderPeek({ intent: 'login', account: { userId: 'u', displayName: 'Владелец <script>' } });
  assert.match(known, /Учётка: <b>Владелец &lt;script&gt;<\/b>/);
  const link = renderPeek({ intent: 'link', account: { userId: 'u', displayName: 'Мария' }, linkTo: { displayName: 'Владелец <b>' } });
  assert.match(link, /Привязка Telegram/);
  assert.doesNotMatch(link, /Мария/, 'a link card never shows a sign-in account');
  assert.match(link, /в учётку <b>Владелец &lt;b&gt;<\/b>/, 'it names the target, escaped');
  const move = renderPeek({ intent: 'link', linkTo: { displayName: 'Владелец' }, moveFrom: { displayName: 'tg-дубль' }, willMove: true, willClose: true });
  assert.doesNotMatch(renderPeek({ intent: 'link', linkTo: { displayName: 'П' }, moveFrom: { displayName: 'Д' }, willMove: true }), /будет закрыта/);
  assert.match(move, /Сейчас этот Telegram открывает учётку <b>tg-дубль<\/b> — она будет закрыта, вход переедет в <b>Владелец<\/b>/);
  const blocked = renderPeek({ intent: 'link', linkTo: { displayName: 'Владелец' }, moveFrom: { displayName: 'Рабочая' }, moveBlocked: true });
  assert.match(blocked, /перенести вход не получится/);
  assert.match(renderDecision({ status: 'approved', intent: 'link' }), /подтвердите там привязку/);
  assert.match(renderDecision({ status: 'approved', created: true }), /ждёт, пока администратор/);
  assert.match(renderLoginError('wrong_match'), /Число не совпало/);
  assert.match(renderDecision({ status: 'denied' }), /отменён/);
  assert.match(renderLoginError('expired'), /10 минут/);
  assert.match(renderLoginError('something-new'), /Попробуйте ещё раз/);
});

interface Sent { chatId: number; text: string; keyboard?: unknown }

function fakeTelegram() {
  const sent: Sent[] = [];
  const edits: Sent[] = [];
  const answers: Array<{ text?: string; alert?: boolean }> = [];
  return {
    sent, edits, answers,
    async sendMessage(chatId: number, text: string, opts: { keyboard?: unknown } = {}) { sent.push({ chatId, text, keyboard: opts.keyboard }); return []; },
    async editMessage(chatId: number, _id: number, text: string, opts: { keyboard?: unknown } = {}) { edits.push({ chatId, text, keyboard: opts.keyboard }); return true; },
    async answerCallback(_id: string, text?: string, alert?: boolean) { answers.push({ text, alert }); },
    async chatAction() {},
  };
}

/** A hub that records what the bot asked and answers from a script. */
function fakeHub(answer: (action: string) => { status: number; body: unknown }) {
  const calls: Array<{ auth: string | null; body: Record<string, unknown> }> = [];
  const impl = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    calls.push({ auth: new Headers(init.headers).get('authorization'), body });
    const { status, body: out } = answer(String(body['action']));
    return new Response(JSON.stringify(out), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { calls, impl };
}

test('the flow peeks with its own secret, shows the card, and reports the press', async () => {
  const tg = fakeTelegram();
  const hub = fakeHub((action) => action === 'peek'
    ? { status: 200, body: { intent: 'login', device: 'Chrome · macOS', choices: ['12', '47', '93'] } }
    : { status: 200, body: { status: 'approved', intent: 'login', created: true, account: { userId: 'tg-1', displayName: 'Данис', state: 'waitlist' } } });
  const flow = new LoginFlow(tg, 'http://hub', 's'.repeat(40), hub.impl);

  await flow.onStart({ message_id: 1, date: 0, chat: { id: 555, type: 'private' }, from: STRANGER, text: `/start login_${CODE}` }, CODE);
  assert.equal(hub.calls[0]!.auth, `Bearer ${'s'.repeat(40)}`);
  assert.deepEqual(hub.calls[0]!.body['telegram'], { id: 555, username: 'danis_latypov', firstName: 'Данис' });
  assert.equal(tg.sent.length, 1);
  assert.match(tg.sent[0]!.text, /Вход в Hegai Code/);
  assert.deepEqual(tg.sent[0]!.keyboard, loginKeyboard(CODE, ['12', '47', '93']));

  await flow.onCallback({ id: 'cb', from: STRANGER, message: { message_id: 9, date: 0, chat: { id: 555, type: 'private' } }, data: `tl:n:${CODE}:47` }, { code: CODE, number: '47' });
  assert.equal(hub.calls[1]!.body['action'], 'choose');
  assert.equal(hub.calls[1]!.body['choice'], '47');
  assert.match(tg.edits[0]!.text, /Готово/);
  assert.equal(tg.edits[0]!.keyboard, undefined, 'the buttons are gone after a decision');
});

test('a hub refusal becomes words, and a group chat never shows the card', async () => {
  const tg = fakeTelegram();
  const hub = fakeHub(() => ({ status: 410, body: { error: 'expired' } }));
  const flow = new LoginFlow(tg, 'http://hub', 's'.repeat(40), hub.impl);
  await flow.onStart({ message_id: 1, date: 0, chat: { id: 555, type: 'private' }, from: STRANGER }, CODE);
  assert.match(tg.sent[0]!.text, /устарела/);
  await flow.onStart({ message_id: 2, date: 0, chat: { id: -100, type: 'group' }, from: STRANGER }, CODE);
  assert.match(tg.sent[1]!.text, /только в личном чате/);
  assert.equal(hub.calls.length, 1, 'a group start never reaches the hub');
});

test('a transient failure keeps the buttons; a double tap never overwrites «Готово»', async () => {
  const tg = fakeTelegram();
  let answer = { status: 503, body: { error: 'gateway down' } as unknown };
  const hub = fakeHub(() => answer as { status: number; body: unknown });
  const flow = new LoginFlow(tg, 'http://hub', 's'.repeat(40), hub.impl);
  const cb = { id: 'cb', from: STRANGER, message: { message_id: 9, date: 0, chat: { id: 555, type: 'private' } } };
  const press = { code: CODE, number: '47' };
  await flow.onCallback(cb, press);
  assert.equal(tg.edits.length, 0, 'the card and its buttons stay');
  assert.ok(tg.answers.at(-1)!.alert, 'the press gets an alert');
  answer = { status: 409, body: { error: 'decided' } };
  await flow.onCallback(cb, press);
  assert.equal(tg.edits.length, 0, '«decided» leaves the earlier result alone');
  answer = { status: 410, body: { error: 'expired' } };
  await flow.onCallback(cb, press);
  assert.match(tg.edits.at(-1)!.text, /устарела/, 'a dead login loses its buttons');
});

test('a stranger reaches the login flow and NOTHING of the owner’s bot', async () => {
  const tg = fakeTelegram();
  const hub = fakeHub((action) => action === 'peek'
    ? { status: 200, body: { intent: 'login', choices: ['12', '47', '93'] } }
    : { status: 200, body: { status: 'denied' } });
  const realFetch = globalThis.fetch;
  globalThis.fetch = hub.impl;
  try {
    const cfg: Config = {
      botToken: 't', allow: new Set([1]), http: 'http://hub', ws: 'ws://hub',
      statePath: path.join(mkdtempSync(path.join(os.tmpdir(), 'tgbot-login-')), 'state.json'),
      session: 'x', sso: undefined, loginSecret: 's'.repeat(40),
    };
    const bot = new Bot(cfg, tg as never, new Store(cfg.statePath), 'x');
    const reached: string[] = [];
    const spy = bot as unknown as Record<string, unknown>;
    spy['onMessage'] = async () => { reached.push('onMessage'); };
    spy['onCommand'] = async () => { reached.push('onCommand'); return true; };
    spy['onCallback'] = async () => { reached.push('onCallback'); };

    const msg = (text: string): TgUpdate => ({ update_id: 1, message: { message_id: 1, date: 0, chat: { id: 555, type: 'private' }, from: STRANGER, text } });
    await bot.handleUpdate(msg(`/start login_${CODE}`));
    assert.match(tg.sent.at(-1)!.text, /Вход в Hegai Code/);
    await bot.handleUpdate({ update_id: 2, callback_query: { id: 'c', from: STRANGER, message: { message_id: 3, date: 0, chat: { id: 555, type: 'private' } }, data: `tl:d:${CODE}` } });
    assert.match(tg.edits.at(-1)!.text, /отменён/);

    // Everything else from a stranger: a hint, and still nothing reached.
    await bot.handleUpdate(msg('/new запусти что-нибудь на машине'));
    await bot.handleUpdate(msg('привет'));
    assert.equal(tg.sent.at(-1)!.text, STRANGER_HINT);
    await bot.handleUpdate({ update_id: 3, callback_query: { id: 'd', from: STRANGER, data: 'noop:x' } });
    assert.deepEqual(reached, ['onCallback'], 'a non-login callback goes to onCallback, which refuses strangers itself');

    // The owner still reaches the owner's bot.
    await bot.handleUpdate({ update_id: 4, message: { message_id: 5, date: 0, chat: { id: 1, type: 'private' }, from: { id: 1 }, text: 'статус' } });
    assert.deepEqual(reached, ['onCallback', 'onMessage']);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('the login card warns that a link and number someone SENT is a scam', () => {
  const card = renderPeek({ intent: 'login', device: 'iPhone', choices: ['12', '47', '93'] });
  assert.match(card, /Если ссылку и число вам прислали — это мошенники\. Нажмите «Это не я»\./);
  assert.ok(card.includes(PHISHING_WARNING));
  assert.doesNotMatch(renderPeek({ intent: 'link', linkTo: { displayName: 'П' } }), /мошенники/);
});

test('a new sign-in is announced once, with a button that ends exactly that session', async () => {
  const REF = 'f'.repeat(32);
  const notice = { ref: REF, telegramId: '555', device: 'iPhone', at: Date.UTC(2026, 10, 11, 9, 5), ip: '2001:db8:1:2::/64' };
  assert.match(renderNotice(notice), /Новый вход в Hegai Code:<\/b> iPhone, 11\.11, 12:05 МСК, 2001:db8:1:2::\/64/);
  assert.match(renderNotice({ ...notice, device: '<b>x</b>' }), /&lt;b&gt;x&lt;\/b&gt;/);
  assert.deepEqual(parseLoginCallback(`tl:r:${REF}`), { code: REF, revoke: true });
  for (const row of noticeKeyboard(REF)) for (const b of row) assert.ok(Buffer.byteLength(b.callback_data!) <= 64);
  assert.equal(noticeKeyboard(REF)[0]![0]!.text, 'Это был не я — завершить');

  const tg = fakeTelegram();
  const hub = fakeHub((action) => action === 'notices'
    ? { status: 200, body: { notices: [notice] } }
    : { status: 200, body: { status: 'revoked', undone: { sessions: 2, identities: ['google'], machines: ['Чужой <b>'], authenticator: true, invitations: 1, removedMembers: [{ workspace: 'Т', member: 'n1@x' }] }, review: [{ kind: 'ownership_transferred', workspace: 'Команда <i>', member: 'm2@x' }, { kind: 'role_changed', workspace: 'Т', member: 'm3@x', role: 'manager' }, { kind: 'joined', workspace: 'Т', member: 'm1@x', role: 'manager' }], truncated: 0 } });
  const flow = new LoginFlow(tg, 'http://hub', 's'.repeat(40), hub.impl);
  await flow.announceNewSignIns();
  assert.equal(hub.calls[0]!.auth, `Bearer ${'s'.repeat(40)}`);
  assert.equal(tg.sent.length, 1);
  assert.deepEqual(hub.calls[1]!.body['action'], 'ack', 'acknowledged only after the send');
  assert.deepEqual(hub.calls[1]!.body['refs'], [REF]);
  assert.equal(tg.sent[0]!.chatId, 555);
  assert.deepEqual(tg.sent[0]!.keyboard, noticeKeyboard(REF));

  await flow.onCallback({ id: 'cb', from: STRANGER, message: { message_id: 9, date: 0, chat: { id: 555, type: 'private' } }, data: `tl:r:${REF}` }, { code: REF, revoke: true });
  assert.equal(hub.calls[2]!.body['action'], 'revoke');
  assert.equal(hub.calls[2]!.body['ref'], REF);
  assert.equal(hub.calls[2]!.body['code'], undefined);
  assert.match(tg.edits[0]!.text, /вы вышли на всех устройствах \(сессий: 2\)/);
  assert.match(tg.edits[0]!.text, /google/);
  assert.match(tg.edits[0]!.text, /Чужой &lt;b&gt;/);
  assert.match(tg.edits[0]!.text, /аутентификатор/);
  assert.match(tg.edits[0]!.text, /убраны из команд те, кого пригласили с того входа: n1@x/);
  assert.match(tg.edits[0]!.text, /Проверьте:/);
  assert.match(tg.edits[0]!.text, /вошёл m1@x \(manager\)/);
  assert.match(tg.edits[0]!.text, /владение передано m2@x/);
  assert.match(tg.edits[0]!.text, /Команда &lt;i&gt;/);
  assert.match(tg.edits[0]!.text, /роль m3@x изменена на manager/);
  assert.match(tg.edits[0]!.text, /через терминал, этой кнопкой не отменить/);

  // A notice addressed to something that is not a Telegram id is never sent.
  const bad = fakeHub(() => ({ status: 200, body: { notices: [{ ...notice, telegramId: 'abc' }, { ...notice, ref: 'zz' }] } }));
  const tg2 = fakeTelegram();
  await new LoginFlow(tg2, 'http://hub', 's'.repeat(40), bad.impl).announceNewSignIns();
  assert.equal(tg2.sent.length, 0);
});

test('a notice whose Telegram send fails is NOT acknowledged, so the hub offers it again', async () => {
  const REF = 'e'.repeat(32);
  const hub = fakeHub(() => ({ status: 200, body: { notices: [{ ref: REF, telegramId: '555', device: 'iPhone', at: 0 }] } }));
  const tg = fakeTelegram();
  tg.sendMessage = async () => { throw new Error('telegram 502'); };
  await new LoginFlow(tg, 'http://hub', 's'.repeat(40), hub.impl).announceNewSignIns();
  assert.deepEqual(hub.calls.map((c) => c.body['action']), ['notices'], 'no ack after a failed send');
});

test('the undo reply stays inside Telegram\'s limit: whole lines only, closing warnings kept, «ещё N» counted', () => {
  const review = Array.from({ length: 50 }, (_, i) => ({
    kind: 'role_changed' as const,
    workspace: `Команда <b>&${i}</b> ` + 'очень длинное имя '.repeat(4),
    member: `<script>user-${i}@example.com</script>`,
    role: 'manager',
  }));
  const text = renderUndone({ undone: { sessions: 3, machines: Array.from({ length: 30 }, (_, i) => `<m${i}>`) }, review, truncated: 7 });
  assert.ok(text.length <= 4096, `fits Telegram: ${text.length}`);
  assert.match(text, /через терминал, этой кнопкой не отменить/, 'the closing warning is never cut');
  assert.match(text, /смотрите журнал команды/);
  assert.match(text, /и ещё 20/, 'a long list of machines is capped');
  assert.doesNotMatch(text, /<script>|<m1>/, 'everything user-controlled is escaped');
  const shown = text.split('\n').filter((l) => l.startsWith('  – ')).length;
  const more = Number(/… ещё (\d+) /.exec(text)![1]);
  assert.equal(shown + more, 57, 'every change is either shown or counted');
  assert.ok(shown > 0 && shown < 50, 'some shown, the rest counted');
  for (const l of text.split('\n').filter((l) => l.startsWith('  – '))) assert.match(l, /<\/b>|&lt;|роль/, 'a shown line is whole');
});
