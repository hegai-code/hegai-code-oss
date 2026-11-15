/** Pure, so a test can run it without a browser (`origin.ts` reads `location`). */
export function resolveFullOrigin(
  configured: string | undefined,
  loc: { origin: string; hostname: string },
): string {
  const fallback = /(^|\.)acme\.test$/i.test(loc.hostname) ? 'https://code.acme.test' : loc.origin;
  return (configured || fallback).replace(/\/+$/, '');
}
