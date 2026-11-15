/**
 * `/native-signin` — the page the mobile apps open in the system auth browser
 * (ASWebAuthenticationSession / a Custom Tab) on a hub that has no Google or
 * Apple button: the customer's own hub.
 *
 * The apps open it with the SAME query they already give `/api/auth/google/start`:
 * `native=1` (iOS) or `android=1&code_challenge=…&client_state=…` (Android).
 * This module is the pure half: read that query, carry it on to the provider
 * links and the local hand-off, and refuse any redirect that is not one of the
 * two app schemes.
 */

export type NativeSignIn =
  | { mode: 'ios' }
  | { mode: 'android'; codeChallenge: string; clientState: string };

/** What the hub's `begin_login` accepts for Android (server-rs/src/android_auth.rs). */
const URL_SAFE = /^[A-Za-z0-9_-]+$/;

/** The app's request, or `null` when the page was opened by hand. */
export function parseNativeSignIn(search: string): NativeSignIn | null {
  const q = new URLSearchParams(search);
  if (q.get('android') === '1') {
    if (q.get('native') === '1' || q.get('native') === 'true') return null;
    const codeChallenge = q.get('code_challenge') ?? '';
    const clientState = q.get('client_state') ?? '';
    if (codeChallenge.length !== 43 || !URL_SAFE.test(codeChallenge)) return null;
    if (clientState.length < 32 || clientState.length > 128 || !URL_SAFE.test(clientState)) return null;
    return { mode: 'android', codeChallenge, clientState };
  }
  if (q.get('native') === '1' || q.get('native') === 'true') return { mode: 'ios' };
  return null;
}

/** The query a provider start link carries: exactly what the app sent. */
export function nativeQuery(n: NativeSignIn): string {
  if (n.mode === 'ios') return 'native=1';
  const q = new URLSearchParams({ android: '1', code_challenge: n.codeChallenge, client_state: n.clientState });
  return q.toString();
}

export function nativeStartHref(provider: 'oidc' | 'google' | 'github', n: NativeSignIn): string {
  return `/api/auth/${provider}/start?${nativeQuery(n)}`;
}

/** The hand-off fields `POST /api/auth/local/native-handoff` takes. */
export function nativeHandoffFields(n: NativeSignIn): Record<string, unknown> {
  return n.mode === 'ios'
    ? { native: true }
    : { android: true, code_challenge: n.codeChallenge, client_state: n.clientState };
}

/** Only the apps' own schemes are ever navigated to. */
export function isAppRedirect(url: unknown): url is string {
  return typeof url === 'string' && (url.startsWith('ccremote://auth?') || url.startsWith('hegai-code://auth?'));
}
