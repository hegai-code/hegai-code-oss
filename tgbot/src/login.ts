/**
 * «Войти через Telegram» — the bot's half (the hub's is
 * server-rs/src/telegram_login.rs).
 *
 * The client opens `t.me/<bot>?start=login_<code>` and shows a two-digit
 * number; Telegram delivers `/start login_<code>` with a `from.id` it vouches
 * for. The bot asks the hub what pressing would do (`peek`, which also binds
 * the login to this Telegram account), shows it with THREE numbers and «Это
 * не я», and reports the press (`choose` / `deny`). The wrong number kills the
 * login on the hub: a person who did not start one has no number to match,
 * which is what stops the phishing a device flow is otherwise open to. The
 * session is minted on the hub, for the client that polls — no session ever
 * passes through here.
 *
 * THIS PATH IS OPEN TO STRANGERS, unlike everything else in the bot, which
 * drives machines as the owner. It is reached before the allow-list check and
 * must never fall through to `onMessage` / `onCommand` / the owner's
 * callbacks. It authenticates to the hub with its own secret
 * (`CC_REMOTE_TG_LOGIN_SECRET`), never with the owner's session.
 */
import { escapeHtml } from './render.js';
import type { InlineKeyboard, TgCallbackQuery, TgMessage, TgUser } from './telegram.js';

/** Callback data: `tl:n:<code>:<two digits>` a number, `tl:d:<code>` «Это не я». */
export const LOGIN_CALLBACK = 'tl';

const START_RE = /^\/start(?:@\w+)?\s+login_([0-9a-f]{32})$/;
const CALLBACK_RE = /^tl:(?:n:([0-9a-f]{32}):(\d{2})|d:([0-9a-f]{32})|r:([0-9a-f]{32}))$/;

/** The code from `/start login_<code>`, or null for anything else. */
export function parseLoginStart(text: string | undefined): string | null {
  const m = START_RE.exec((text ?? '').trim());
  return m ? m[1]! : null;
}

export type LoginPress =
  | { code: string; number: string }
  | { code: string; notMe: true }
  /** «Это был не я — завершить» on a «Новый вход» notice; `code` is the hub's `ref`. */
  | { code: string; revoke: true };

export function parseLoginCallback(data: string | undefined): LoginPress | null {
  const m = CALLBACK_RE.exec(data ?? '');
  if (!m) return null;
  if (m[3]) return { code: m[3], notMe: true };
  if (m[4]) return { code: m[4], revoke: true };
  return { code: m[1]!, number: m[2]! };
}

export interface PeekAccount {
  userId: string;
  displayName: string;
  state?: string;
}

export interface Peek {
  intent: 'login' | 'link';
  client?: string;
  sessionDays?: number;
  device?: string;
  ip?: string;
  choices?: string[];
  account?: PeekAccount;
  /** A link: the account this Telegram is being attached to. */
  linkTo?: { displayName: string };
  /** A link: the account this Telegram opens now, if another one. */
  moveFrom?: { displayName: string };
  /** …and it is empty: the way in moves. */
  willMove?: boolean;
  /** …and Telegram is its last way in: that account will be closed. */
  willClose?: boolean;
  /** …and it holds work: the link will be refused. */
  moveBlocked?: boolean;
}

export interface Decision {
  status: 'approved' | 'denied';
  intent?: 'login' | 'link';
  created?: boolean;
  account?: PeekAccount;
}

/** The card the person decides on. Everything shown comes from the hub;
 *  every value is escaped (names and the device label are not ours). */
export function renderPeek(peek: Peek): string {
  const lines = [peek.intent === 'link' ? '🔗 <b>Привязка Telegram к Hegai Code</b>' : '🔐 <b>Вход в Hegai Code</b>'];
  // No address, even if a hub sent one: whoever opens a code seen on
  // someone else's screen would learn that person's IP from the card.
  const device = peek.device ? escapeHtml(peek.device) : 'неизвестное устройство';
  lines.push(`Устройство: ${device}`);
  if (peek.intent === 'link') {
    const target = peek.linkTo ? `<b>${escapeHtml(peek.linkTo.displayName)}</b>` : 'из которой начали привязку';
    lines.push(`Этот Telegram станет способом входа в учётку ${target}. `
      + 'Её владелец подтвердит это ещё раз у себя.');
    if (peek.moveFrom && peek.willMove) {
      lines.push(`⚠️ Сейчас этот Telegram открывает учётку <b>${escapeHtml(peek.moveFrom.displayName)}</b> — `
        + `${peek.willClose ? 'она будет закрыта, ' : ''}вход переедет в ${target}.`);
    } else if (peek.moveFrom && peek.moveBlocked) {
      lines.push(`⚠️ Сейчас этот Telegram открывает учётку <b>${escapeHtml(peek.moveFrom.displayName)}</b>, `
        + 'и в ней есть машины, сессии или команды — перенести вход не получится.');
    }
  } else {
    if (peek.account) lines.push(`Учётка: <b>${escapeHtml(peek.account.displayName)}</b>`);
    else lines.push('Учётки ещё нет — будет создана новая. Доступ к ней откроет администратор.');
    if (peek.sessionDays) lines.push(`Вход на ${peek.sessionDays} ${days(peek.sessionDays)}.`);
  }
  lines.push('');
  lines.push('<b>Нажмите число, которое видно на экране входа.</b> '
    + 'Вы ничего не начинали и числа не видите — нажмите «Это не я».');
  if (peek.intent !== 'link') lines.push('⚠️ ' + PHISHING_WARNING);
  return lines.join('\n');
}

function days(n: number): string {
  const tail = n % 100;
  if (tail >= 11 && tail <= 14) return 'дней';
  if (n % 10 === 1) return 'день';
  if (n % 10 >= 2 && n % 10 <= 4) return 'дня';
  return 'дней';
}

export function loginKeyboard(code: string, choices: string[]): InlineKeyboard {
  return [
    choices.map((n) => ({ text: n, callback_data: `${LOGIN_CALLBACK}:n:${code}:${n}` })),
    [{ text: 'Это не я', callback_data: `${LOGIN_CALLBACK}:d:${code}` }],
  ];
}

/** On every login card: the usual way this is abused is someone sending the
 *  victim the link AND the number. */
export const PHISHING_WARNING = 'Если ссылку и число вам прислали — это мошенники. Нажмите «Это не я».';

/** One announced sign-in, as the hub reports it (`notices`). */
export interface LoginNotice {
  ref: string;
  telegramId: string;
  /** Absent when unknown (the hub omits it, never `null`). */
  device?: string;
  at: number;
  ip?: string;
}

/** «Новый вход в Hegai Code: <устройство>, <время МСК>, <сеть>». The device is
 *  one of the hub's fixed labels; everything is escaped anyway. */
export function renderNotice(n: LoginNotice): string {
  const when = new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  }).format(new Date(n.at));
  const parts = [n.device ? escapeHtml(n.device) : 'неизвестное устройство', `${when} МСК`];
  if (n.ip) parts.push(escapeHtml(n.ip));
  return `🔔 <b>Новый вход в Hegai Code:</b> ${parts.join(', ')}.\nЭто были вы — ничего делать не нужно.`;
}

/** What the hub reports for «Это был не я» that it did NOT revert. */
export interface ReviewItem {
  kind: 'joined' | 'role_changed' | 'ownership_transferred' | 'removed';
  workspace: string;
  member: string;
  role?: string;
}

/** What the hub undid for «Это был не я» (`undone` in its answer). */
export interface Undone {
  undone?: {
    sessions?: number;
    identities?: string[];
    machines?: string[];
    authenticator?: boolean;
    enrollmentCodes?: number;
    invitations?: number;
    /** Members the stolen session's invitations had added, now removed. */
    removedMembers?: Array<{ workspace: string; member: string }>;
  };
  /** Changes the hub did NOT revert (an automatic revert could delete legitimate team data). */
  review?: ReviewItem[];
  /** How many more such changes did not fit in `review`. */
  truncated?: number;
}

function renderReview(item: ReviewItem): string {
  const team = `«${escapeHtml(item.workspace)}»`;
  const who = escapeHtml(item.member);
  const role = item.role ? ` (${escapeHtml(item.role)})` : '';
  switch (item.kind) {
    case 'joined':
      return `в команду ${team} вошёл ${who}${role} по приглашению с того входа`;
    case 'ownership_transferred':
      return `команда ${team}: владение передано ${who}`;
    case 'role_changed':
      return `команда ${team}: роль ${who} изменена${item.role ? ` на ${escapeHtml(item.role)}` : ''}`;
    default:
      return `команда ${team}: участник ${who} удалён`;
  }
}

/** Telegram's message limit, with margin. */
const TG_BUDGET = 3900;
/** At most this many entries of a long list are named. */
const LIST_MAX = 10;

function listed(items: string[]): string {
  const shown = items.slice(0, LIST_MAX).map(escapeHtml).join(', ');
  return items.length > LIST_MAX ? `${shown} и ещё ${items.length - LIST_MAX}` : shown;
}

/** The reply to «Это был не я». Built inside Telegram's size limit: the lines
 *  that matter most (what was done, and the closing warnings about machines)
 *  are reserved first; the «Проверьте» list gets what is left, whole lines only,
 *  then «… ещё N». */
export function renderUndone(r: Undone): string {
  const u = r.undone ?? {};
  const head = ['✅ <b>Вход отменён.</b> Что сделано:'];
  head.push(`• вы вышли на всех устройствах${u.sessions ? ` (сессий: ${u.sessions})` : ''} — войдите заново, когда будет нужно;`);
  if (u.identities?.length) head.push(`• отвязаны способы входа, добавленные после того входа: ${listed(u.identities)};`);
  if (u.machines?.length) head.push(`• отключены машины, подключённые после того входа: ${listed(u.machines)};`);
  if (u.authenticator) head.push('• сброшен аутентификатор, настроенный после того входа — настройте свой заново в Настройках;');
  if (u.invitations) head.push(`• отозваны неиспользованные приглашения в команды: ${u.invitations};`);
  if (u.removedMembers?.length) {
    head.push(`• убраны из команд те, кого пригласили с того входа: ${listed(u.removedMembers.map((m) => `${m.member} («${m.workspace}»)`))};`);
  }
  if (u.enrollmentCodes) head.push('• удалены неиспользованные коды подключения компьютеров;');
  const tail = [
    'Всё, что делалось на ваших машинах через терминал, этой кнопкой не отменить — проверьте их.',
    'Если это были не вы, смените пароли там, где используете один и тот же Telegram.',
  ];
  const lines = [...head];
  const review = r.review ?? [];
  const hidden = r.truncated ?? 0;
  if (review.length || hidden) {
    const intro = '⚠️ <b>Проверьте:</b> это не откатывалось автоматически — решите сами, оставить или убрать:';
    // Reserve room for the intro, the «… ещё N» line and the closing warnings.
    const reserved = [...tail, intro, '… ещё 999 изменений — смотрите журнал команды'].reduce((n, l) => n + l.length + 1, 0);
    let used = head.reduce((n, l) => n + l.length + 1, 0) + reserved;
    const shown: string[] = [];
    for (const item of review) {
      const line = `  – ${renderReview(item)}`;
      if (used + line.length + 1 > TG_BUDGET) break;
      shown.push(line);
      used += line.length + 1;
    }
    const more = review.length - shown.length + hidden;
    lines.push(intro, ...shown);
    if (more > 0) lines.push(`… ещё ${more} ${more === 1 ? 'изменение' : 'изменений'} — смотрите журнал команды`);
  }
  lines.push(...tail);
  return lines.join('\n');
}

export function noticeKeyboard(ref: string): InlineKeyboard {
  return [[{ text: 'Это был не я — завершить', callback_data: `${LOGIN_CALLBACK}:r:${ref}` }]];
}

export function renderDecision(d: Decision): string {
  if (d.status === 'denied') return '✖️ Вход отменён. Если это были не вы — ничего делать не нужно.';
  if (d.intent === 'link') {
    return '✅ Вернитесь в Hegai Code и подтвердите там привязку — без этого она не сработает.';
  }
  const lines = ['✅ <b>Готово.</b> Вернитесь в браузер или приложение — вход завершится сам.'];
  if (d.created || d.account?.state === 'waitlist') {
    lines.push('Учётка ждёт, пока администратор откроет доступ; вы увидите это на экране входа.');
  }
  return lines.join('\n');
}

/** Hub error codes (`login_error` in telegram_login_api.rs) -> words. */
export function renderLoginError(code: string): string {
  switch (code) {
    case 'unknown':
      return 'Такой ссылки для входа нет. Начните вход заново на code.acme.test.';
    case 'expired':
      return 'Ссылка для входа устарела — она живёт 10 минут. Начните вход заново.';
    case 'decided':
      return 'Этот вход уже подтверждён или отменён.';
    case 'claimed_by_other':
      return 'Эту ссылку открыли с двух аккаунтов Telegram — вход отменён. Начните заново.';
    case 'locked':
      return 'Недавно здесь нажали не то число — вход через Telegram приостановлен на полчаса. '
        + 'Если это были не вы, ничего делать не нужно.';
    case 'not_peeked':
      return 'Откройте ссылку для входа ещё раз.';
    case 'wrong_match':
      return 'Число не совпало с экраном — вход отменён. Если вход начинали вы, начните заново и нажмите число с экрана.';
    case 'identity_owner_has_data':
      return 'Этот Telegram уже открывает другую учётку Hegai Code, и в ней есть машины, сессии или команды — '
        + 'перенести его сюда нельзя. Напишите администратору, чтобы объединить учётки.';
    case 'account_deleting':
      return 'Эта учётка удаляется — привязать к ней Telegram нельзя.';
    // From a hub before 09.10.2026.
    case 'telegram_linked_elsewhere':
      return 'Этот Telegram уже привязан к другой учётке Hegai Code.';
    case 'admin_link_refused':
      return 'Эта учётка входит только через HegAI — Telegram к ней не привязывается.';
    case 'not_configured':
      return 'Вход через Telegram сейчас выключен.';
    default:
      return 'Не получилось. Попробуйте ещё раз через минуту.';
  }
}

/** Hub answers after which the card's buttons can never work again. A
 *  transient failure (hub restarting, a 5xx) keeps them so the person can
 *  press again, and a double tap (`decided`) must not overwrite the result. */
const DEAD_LOGIN = new Set([
  'unknown', 'expired', 'not_peeked', 'wrong_match', 'claimed_by_other', 'locked',
  'identity_owner_has_data', 'account_deleting',
  'telegram_linked_elsewhere', 'admin_link_refused',
]);

/** What the bot says to a stranger who wrote anything else. */
export const STRANGER_HINT =
  'Это бот Hegai Code. Чтобы войти, откройте code.acme.test и нажмите «Войти через Telegram».';

/** Just what the flow needs from `Telegram` — a seam for tests. */
export interface LoginTelegram {
  sendMessage(chatId: number, text: string, opts?: { keyboard?: InlineKeyboard }): Promise<unknown>;
  editMessage(chatId: number, messageId: number, text: string, opts?: { keyboard?: InlineKeyboard }): Promise<boolean>;
  answerCallback(id: string, text?: string, alert?: boolean): Promise<void>;
}

type Fetch = typeof fetch;

export class LoginFlow {
  constructor(
    private readonly tg: LoginTelegram,
    private readonly http: string,
    private readonly secret: string,
    private readonly fetchImpl: Fetch = fetch,
  ) {}

  /** `/start login_<code>` in a private chat. */
  async onStart(message: TgMessage, code: string): Promise<void> {
    const from = message.from;
    if (!from || message.chat.type !== 'private') {
      // A login is personal; a group would show the card to everyone in it.
      await this.tg.sendMessage(message.chat.id, 'Вход работает только в личном чате с ботом.');
      return;
    }
    const res = await this.confirm({ action: 'peek' }, code, from);
    if (!res.ok) {
      await this.tg.sendMessage(message.chat.id, escapeHtml(renderLoginError(res.error)));
      return;
    }
    const peek = res.body as Peek;
    const choices = (peek.choices ?? []).filter((n) => /^\d{2}$/.test(n));
    if (choices.length === 0) {
      await this.tg.sendMessage(message.chat.id, escapeHtml(renderLoginError('hub_contract')));
      return;
    }
    await this.tg.sendMessage(message.chat.id, renderPeek(peek), { keyboard: loginKeyboard(code, choices) });
  }

  /** A press on the card's buttons. */
  async onCallback(cb: TgCallbackQuery, press: LoginPress): Promise<void> {
    const message = cb.message;
    if ('revoke' in press) {
      const ended = await this.confirm({ action: 'revoke' }, press.code, cb.from);
      if (!ended.ok) {
        await this.tg.answerCallback(cb.id, ended.error === 'unknown' ? 'Этот вход не найден.' : renderLoginError(ended.error), true);
        return;
      }
      await this.tg.answerCallback(cb.id, 'Вход завершён');
      if (message) {
        await this.tg.editMessage(message.chat.id, message.message_id, renderUndone(ended.body as Undone));
      }
      return;
    }
    const res = await this.confirm(
      'notMe' in press ? { action: 'deny' } : { action: 'choose', choice: press.number },
      press.code,
      cb.from,
    );
    if (!res.ok) {
      await this.tg.answerCallback(cb.id, renderLoginError(res.error), true);
      if (message && DEAD_LOGIN.has(res.error)) {
        await this.tg.editMessage(message.chat.id, message.message_id, escapeHtml(renderLoginError(res.error)));
      }
      return;
    }
    const decision = res.body as Decision;
    await this.tg.answerCallback(cb.id, decision.status === 'approved' ? 'Принято' : 'Отменено');
    if (message) await this.tg.editMessage(message.chat.id, message.message_id, renderDecision(decision));
  }

  /** Ask the hub which sign-ins to announce and tell each person, once. A
   *  notice whose message fails to send is retried a few times, then dropped
   *  (the hub reports each sign-in once). Called on a timer by the bot. */
  async announceNewSignIns(): Promise<void> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.http}/api/auth/telegram/confirm`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.secret}`, 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'notices' }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      return;
    }
    if (!res.ok) return;
    const body = (await res.json().catch(() => ({}))) as { notices?: LoginNotice[] };
    for (const n of body.notices ?? []) {
      const chatId = Number(n.telegramId);
      if (!Number.isSafeInteger(chatId) || chatId <= 0 || !/^[0-9a-f]{32}$/.test(n.ref)) continue;
      try {
        await this.tg.sendMessage(chatId, renderNotice(n), { keyboard: noticeKeyboard(n.ref) });
      } catch (e) {
        // Not acknowledged: the hub hands it out again when its lease lapses.
        console.error(`[login] notice send failed: ${(e as Error).message}`);
        continue;
      }
      await this.ack(n.ref);
    }
  }

  /** Tell the hub a notice reached Telegram, so it is not offered again. */
  private async ack(ref: string): Promise<void> {
    try {
      await this.fetchImpl(`${this.http}/api/auth/telegram/confirm`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.secret}`, 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'ack', refs: [ref] }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (e) {
      console.error(`[login] notice ack failed: ${(e as Error).message}`);
    }
  }

  private async confirm(
    what: { action: 'peek' } | { action: 'deny' } | { action: 'revoke' } | { action: 'choose'; choice: string },
    code: string,
    from: TgUser,
  ): Promise<{ ok: true; body: unknown } | { ok: false; error: string }> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.http}/api/auth/telegram/confirm`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.secret}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          ...what,
          // `revoke` names the sign-in by the hub's `ref`, not by a login code.
          ...(what.action === 'revoke' ? { ref: code } : { code }),
          telegram: {
            id: from.id,
            username: from.username,
            firstName: from.first_name,
            lastName: from.last_name,
          },
        }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (e) {
      console.error(`[login] hub unreachable: ${(e as Error).message}`);
      return { ok: false, error: 'hub_unreachable' };
    }
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    if (res.ok) return { ok: true, body };
    if (res.status === 404 && body.error?.includes('not configured')) return { ok: false, error: 'not_configured' };
    if (res.status === 401) console.error('[login] hub refused CC_REMOTE_TG_LOGIN_SECRET — check it matches the hub');
    return { ok: false, error: body.error ?? `http_${res.status}` };
  }
}
