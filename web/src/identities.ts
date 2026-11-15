/**
 * «Способы входа» — the ways into ONE account (hub: server-rs/src/identity.rs,
 * `/api/me/identities`). Each provider attaches to the signed-in account:
 * Google through `/api/auth/google/start?link=1` (the hub binds this session
 * into the pending login), Telegram through its link dialog, Apple only from
 * the iPhone app (there is no web Apple flow).
 */
import { IdentitiesResponse, type LinkedIdentity, UnlinkIdentityResult } from '@cc-remote/shared';
import { apiRequest } from './api.js';
import { isStandalone } from './lib.js';

export type { IdentitiesResponse, LinkedIdentity };

async function request(path: string, init?: RequestInit): Promise<unknown> {
  const response = await apiRequest(path, { ...init, fallback: (status) => `HTTP ${status}` });
  return response.json().catch(() => ({}));
}

export const identitiesApi = {
  list: async (): Promise<IdentitiesResponse> => IdentitiesResponse.parse(await request('/api/me/identities')),
  unlink: async (provider: string, subject?: string): Promise<UnlinkIdentityResult> =>
    UnlinkIdentityResult.parse(await request('/api/me/identities/unlink', {
      method: 'POST',
      body: JSON.stringify(subject ? { provider, subject } : { provider }),
    })),
};

/** The Google link hop: a same-origin navigation, so the hub can take the
 *  account from this tab's session cookie and bind it into the login. */
export function googleLinkUrl(): string {
  return `/api/auth/google/start?link=1${isStandalone() ? '&pwa=1' : ''}`;
}

export const PROVIDER_NAMES: Record<string, string> = {
  hegai: 'HegAI',
  local: 'Пароль и код',
  google: 'Google',
  telegram: 'Telegram',
  apple: 'Apple',
};

export function providerName(provider: string): string {
  return PROVIDER_NAMES[provider] ?? provider;
}

/** Words for a link or unlink that did not happen, from the hub's codes. */
export function identityError(code: string): string {
  switch (code) {
    case 'identity_owner_has_data':
      return 'Этот способ входа уже открывает другую учётку Hegai Code, и в ней есть машины, сессии или команды — перенести его сюда нельзя. Напишите администратору, чтобы объединить учётки.';
    case 'account_deleting':
      return 'Эта учётка удаляется — новые способы входа к ней не привязываются.';
    case 'access_not_active':
      return 'Привязать способ входа можно после того, как администратор откроет доступ.';
    case 'last_identity':
      return 'Это последний способ входа — без него в учётку будет не войти. Сначала привяжите другой.';
    case 'bootstrap_hegai':
      return 'Это владелец сервера: вход через HegAI у него отвязать нельзя.';
    case 'link_cancelled':
      return 'Привязка отменена.';
    case 'apple_token_changed':
      return 'Вход через Apple только что обновился — нажмите «Отвязать» ещё раз.';
    case 'not_linked':
      return 'Этот способ входа уже отвязан.';
    case 'apple_revoke_failed':
    case 'apple_revoke_unavailable':
      return 'Apple не подтвердил отзыв входа — ничего не отвязано. Попробуйте позже.';
    default:
      return 'Не получилось. Попробуйте ещё раз.';
  }
}

/** What the Google link hop came back with (`/w/settings?linked=google` or
 *  `?link_error=…`), read once and removed from the address bar. */
export function takeLinkResult(): { ok: true; provider: string } | { ok: false; message: string } | null {
  if (typeof location === 'undefined') return null;
  const params = new URLSearchParams(location.search);
  const linked = params.get('linked');
  const error = params.get('link_error');
  if (!linked && !error) return null;
  params.delete('linked');
  params.delete('link_error');
  params.delete('provider');
  const rest = params.toString();
  try {
    history.replaceState(history.state, '', `${location.pathname}${rest ? `?${rest}` : ''}${location.hash}`);
  } catch {
    // nothing to clean
  }
  return linked ? { ok: true, provider: linked } : { ok: false, message: identityError(error ?? '') };
}
