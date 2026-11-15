/**
 * The web's half of the hub's second factor (server-rs/src/mfa.rs): what a
 * sign-in still wants, the code check, and the authenticator's lifecycle. The
 * hub words every refusal in Russian; `apiRequest` carries it up as `ApiError`.
 */
import { apiJson } from './api.js';

/** `none`: nothing owed. `verify`: the person has an authenticator, type a
 *  code. `blocked`: an admin who owes one and has none — a pending session may
 *  not attach one; the operator enrols it from an open session. */
export interface MfaState {
  mfa: 'none' | 'verify' | 'blocked';
  enrolled: boolean;
  /** An admin the hub holds to a second factor: it cannot be turned off. */
  adminRequired: boolean;
  canDisable: boolean;
  /** This session came from an enrolment link (a reload keeps the form). */
  canEnrol?: boolean;
  recoveryLeft?: number;
}

export interface MfaEnrolment {
  secret: string;
  otpauthUri: string;
  qrSvg?: string;
}

const post = <T>(path: string, body: unknown) => apiJson<T>(path, { method: 'POST', body: JSON.stringify(body) });

export const mfaApi = {
  state: () => apiJson<MfaState>('/api/auth/mfa/state'),
  /** `next` is the app hand-off a native sign-in was holding back. */
  verify: (code: string) => post<{ ok: boolean; next?: string }>('/api/auth/mfa/verify', { code }),
  /** Spend the one-time link an operator printed: opens a 10-minute enrolment session. */
  openEnrollLink: (token: string) => post<{ ok: boolean }>('/api/auth/mfa/enroll-link/open', { token }),
  begin: () => post<MfaEnrolment>('/api/auth/totp/begin', {}),
  confirm: (code: string) => post<{ recoveryCodes: string[]; next?: string }>('/api/auth/totp/confirm', { code }),
  disable: (code: string) => post<{ ok: boolean }>('/api/auth/totp/disable', { code }),
  newRecoveryCodes: (code: string) => post<{ recoveryCodes: string[] }>('/api/auth/totp/recovery', { code }),
};

/** A 401 may mean «signed in, second factor still owed»: the pending state
 *  when it is (both shells ask this after a refused `/api/me`), else null. */
export async function pendingMfa(): Promise<MfaState | null> {
  const owed = await mfaApi.state().catch(() => null);
  return owed && owed.mfa !== 'none' ? owed : null;
}

/** «fresh_signin_required: words» → «words»: the hub prefixes a machine code. */
export function mfaWords(error: unknown): string {
  const text = error instanceof Error ? error.message : '';
  if (!text) return 'Нет связи с сервером. Проверьте сеть и попробуйте ещё раз.';
  return text.replace(/^[a-z_]+: /, '');
}
