/**
 * The hub's same-origin REST API, asked one way. Every screen that talks to it
 * used to carry its own copy of «same-origin cookie, parse the body, turn a
 * refusal into an `ApiError`»; the copies drifted only in their fallback words.
 */

/** A failed same-origin request. `status` lets a caller tell "this endpoint
 *  does not exist on this hub yet" (404) from "the hub refused" (403). */
export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'ApiError';
  }
}

export type ApiInit = RequestInit & {
  /** Words for a refusal whose body carries no `error` of its own. */
  fallback?: (status: number) => string;
};

const requestFailed = (status: number): string => `Запрос не удался (${status})`;

/**
 * `fetch` with the session cookie. A request that has a body is JSON unless the
 * caller says otherwise. A refusal throws `ApiError(body.error ?? fallback)`;
 * a transport failure stays the browser's own `TypeError`, so a caller can tell
 * «the hub said no» from «no hub».
 */
export async function apiRequest(path: string, init: ApiInit = {}): Promise<Response> {
  const { fallback = requestFailed, headers, ...rest } = init;
  const merged = new Headers(headers);
  if (rest.body != null && !merged.has('content-type')) merged.set('content-type', 'application/json');
  const response = await fetch(path, { ...rest, credentials: 'same-origin', headers: merged });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(body.error ?? fallback(response.status), response.status);
  }
  return response;
}

/** `apiRequest`, then the JSON body (`undefined` for a 204). */
export async function apiJson<T>(path: string, init?: ApiInit): Promise<T> {
  const response = await apiRequest(path, init);
  return response.status === 204 ? (undefined as T) : (response.json() as Promise<T>);
}

/**
 * A best-effort read for a poller: the body when the hub says 200, `null` for
 * any refusal. A transport failure still rejects — the caller's `.catch` is
 * where a poll that cannot reach the hub goes quiet.
 */
export async function apiJsonOrNull<T>(path: string, init?: RequestInit): Promise<T | null> {
  const response = await fetch(path, { ...init, credentials: 'same-origin' });
  return response.ok ? (response.json() as Promise<T>) : null;
}
