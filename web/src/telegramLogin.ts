/**
 * «Войти через Telegram» — the web's half. The hub's is
 * server-rs/src/telegram_login{,_api}.rs, the bot's tgbot/src/login.ts.
 *
 * The page starts a login, SHOWS the two-digit number the hub returns, opens
 * `t.me/<bot>?start=login_<code>`, and polls. The person presses that number
 * in Telegram; a wrong one kills the login on the hub. When the poll says
 * `approved` the hub has already set the session cookie on this origin — the
 * page only has to reload. A link (Telegram as a second way into THIS
 * account) answers `confirm_link` with the `@username` that pressed, and is
 * made only by the account's own «yes» (`finishTelegramLink`).
 */
import { TelegramLinkResult, TelegramLoginPoll, TelegramLoginStart } from '@cc-remote/shared';
import { ApiError, apiRequest } from './api.js';
import { isStandalone } from './lib.js';

export type TelegramIntent = 'login' | 'link';

async function post(path: string, body: unknown): Promise<unknown> {
  const response = await apiRequest(path, {
    method: 'POST',
    body: JSON.stringify(body),
    fallback: (status) => `HTTP ${status}`,
  });
  return response.json().catch(() => ({}));
}

export async function startTelegramLogin(intent: TelegramIntent): Promise<TelegramLoginStart> {
  // An installed app keeps its session 90 days, a tab a week — the same split
  // the HegAI sign-in makes (`?pwa=1`).
  const raw = await post('/api/auth/telegram/start', { intent, client: isStandalone() ? 'pwa' : 'web' });
  return TelegramLoginStart.parse(raw);
}

export async function pollTelegramLogin(pollToken: string): Promise<TelegramLoginPoll> {
  return TelegramLoginPoll.parse(await post('/api/auth/telegram/poll', { pollToken }));
}

/** «Да, это мой @username» — makes the link the press only proposed. */
export async function finishTelegramLink(pollToken: string): Promise<{ telegram: string; movedFrom?: string }> {
  // `movedFrom`: this Telegram used to open another, empty account (made by
  // an earlier sign-in); the hub moved it here and closed that account.
  const raw = TelegramLinkResult.parse(await post('/api/auth/telegram/link', { pollToken }));
  return { telegram: raw.telegram, ...(raw.movedFrom ? { movedFrom: raw.movedFrom } : {}) };
}

/** Words for whatever went wrong, from the hub's stable error codes. */
export function telegramLoginError(error: unknown): string {
  if (!(error instanceof ApiError)) return 'Нет связи с сервером. Проверьте сеть и попробуйте ещё раз.';
  if (error.status === 404 && /not configured/.test(error.message)) return 'Вход через Telegram на этом сервере выключен.';
  if (error.status === 429) return 'Слишком много попыток с этого адреса. Подождите немного и начните заново.';
  switch (error.message) {
    case 'access_not_active':
      return 'Привязать Telegram можно после того, как администратор откроет доступ.';
    case 'identity_owner_has_data':
      return 'Этот Telegram уже открывает другую учётку Hegai Code, и в ней есть машины, сессии или команды — перенести его сюда нельзя. Напишите администратору, чтобы объединить учётки.';
    case 'account_deleting':
      return 'Эта учётка удаляется — привязать к ней Telegram нельзя.';
    // From a hub before 09.10.2026.
    case 'telegram_linked_elsewhere':
      return 'Этот Telegram уже привязан к другой учётке Hegai Code.';
    case 'expired':
      return 'Время вышло. Начните заново.';
    case 'decided':
      return 'Этот вход уже завершён. Начните заново.';
    default:
      return 'Не получилось. Попробуйте ещё раз.';
  }
}

/** What a finished poll means for the person, when it is not a success. */
// `mfa` goes only to a native client that asked for it; the web never does.
export function telegramPollEnd(status: 'denied' | 'expired' | 'used' | 'unknown' | 'mfa'): string {
  switch (status) {
    case 'denied':
      return 'Вход отменён в Telegram: там нажали «Это не я», не то число, или ссылку открыли с двух аккаунтов.';
    case 'expired':
      return 'Время вышло — ссылка живёт 10 минут. Начните заново.';
    default:
      return 'Этот вход уже завершён. Начните заново.';
  }
}

// ------------------------------------------------ «Вы вошли как @x»

/** Who just signed in through Telegram — kept across the reload that follows
 *  `approved`, shown once, cleared when the person acknowledges it. */
export interface TelegramSignIn {
  telegram: string;
  name: string;
  /** The account it opened — a banner never shows over a different one. */
  userId: string;
}

const SIGNED_IN_KEY = 'cc-tg-signed-in';
/** Fired on `window` whenever the remembered sign-in changes. */
export const TELEGRAM_SIGN_IN_EVENT = 'cc-tg-signed-in-change';

export function rememberTelegramSignIn(info: TelegramSignIn): void {
  try {
    sessionStorage.setItem(SIGNED_IN_KEY, JSON.stringify(info));
  } catch {
    // Private mode: the banner is lost, the sign-in is not.
  }
}

export function readTelegramSignIn(): TelegramSignIn | null {
  try {
    const raw = sessionStorage.getItem(SIGNED_IN_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<TelegramSignIn>;
    return typeof v.telegram === 'string' && typeof v.name === 'string' && typeof v.userId === 'string'
      ? { telegram: v.telegram, name: v.name, userId: v.userId }
      : null;
  } catch {
    return null;
  }
}

export function forgetTelegramSignIn(): void {
  try {
    sessionStorage.removeItem(SIGNED_IN_KEY);
  } catch {
    // nothing to do
  }
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(TELEGRAM_SIGN_IN_EVENT));
}
