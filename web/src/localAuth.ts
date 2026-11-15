/**
 * The web's half of local sign-in (server-rs/src/local_login.rs): email +
 * password + a code from the authenticator app. The hub words every refusal in
 * Russian and `apiRequest` carries it up as the `ApiError` message.
 */
import { LocalSetupBegin, LocalSetupFinish, NativeHandoff } from '@cc-remote/shared';
import { apiRequest } from './api.js';
import { isAppRedirect, nativeHandoffFields, type NativeSignIn } from './nativeSignIn.js';

async function post(path: string, body: unknown): Promise<unknown> {
  const response = await apiRequest(path, { method: 'POST', body: JSON.stringify(body) });
  return response.json().catch(() => ({}));
}

/** Throws `ApiError` on any refusal; resolves when the session cookie is set. */
export async function localLogin(email: string, password: string, code: string): Promise<void> {
  await post('/api/auth/local/login', { email, password, code });
}

/**
 * The local sign-in of a mobile app's auth browser: the same checks, but the
 * hub answers with the app's redirect (`ccremote://auth?session=…` or the
 * Android one-use code) instead of a cookie. Resolves with that address.
 */
export async function localNativeLogin(email: string, password: string, code: string, native: NativeSignIn): Promise<string> {
  const parsed = NativeHandoff.safeParse(await post('/api/auth/local/native-handoff', { email, password, code, ...nativeHandoffFields(native) }));
  if (!parsed.success || !isAppRedirect(parsed.data.redirect)) throw new Error('Сервер вернул неожиданный ответ.');
  return parsed.data.redirect;
}

export async function beginSetup(token: string): Promise<LocalSetupBegin> {
  return LocalSetupBegin.parse(await post('/api/auth/local/setup/begin', { token }));
}

/** Sets the password, confirms the authenticator and opens the session. */
export async function finishSetup(token: string, password: string, code: string): Promise<LocalSetupFinish> {
  return LocalSetupFinish.parse(await post('/api/auth/local/setup/finish', { token, password, code }));
}
