/**
 * The only shape of a gateway address the agent accepts. Pure: no env, no
 * policy file, so policy.ts and gateway.ts can both use it without a cycle.
 */
const LOOPBACK = new Set(['127.0.0.1', '[::1]', 'localhost']);

/** `https://host[:port]/path` without trailing slash, or `undefined` when `raw`
 *  is not acceptable: https only (http only for loopback), no credentials,
 *  query or fragment. */
export function normalizeGatewayUrl(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || !raw.trim()) return undefined;
  try {
    const url = new URL(raw.trim());
    if (url.username || url.password || url.search || url.hash || raw.includes('?') || raw.includes('#')) return undefined;
    if (url.protocol === 'http:' ? !LOOPBACK.has(url.hostname) : url.protocol !== 'https:') return undefined;
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    return undefined;
  }
}

/** Same origin and same path (trailing slash insensitive) as the trusted gateway. */
export function isTrustedGateway(value: unknown, trusted: string): boolean {
  if (typeof value !== 'string' || !trusted) return false;
  const want = normalizeGatewayUrl(trusted);
  const got = normalizeGatewayUrl(value);
  return want !== undefined && got === want;
}
