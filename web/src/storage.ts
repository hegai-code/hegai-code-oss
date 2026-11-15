/**
 * `localStorage`, without the exceptions.
 *
 * A browser that blocks site data throws `SecurityError` on the first touch of
 * `window.localStorage` (not only on `getItem`), and private modes and a full
 * quota throw on `setItem`. Called bare from a render or an event handler, that
 * is a blank page or a handler that dies half way — the sign-in error path
 * included. Everything here swallows the failure: a read answers `null` (what
 * a missing key answers), a write or a remove does nothing. The page works
 * without the store; it only forgets between visits.
 *
 * Reach the store at CALL time, not module load: it may be absent (tests, a
 * blocked context) and a throw at import would take the whole bundle with it.
 */

export function storageGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function storageSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* blocked or full: the value just is not remembered */
  }
}

export function storageRemove(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* blocked: nothing to forget */
  }
}
