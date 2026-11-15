/**
 * Which addresses reach the hub.
 *
 * `CENTRAL_URL` names one. On a network where that one is shut — a corporate
 * proxy or an antivirus «inspecting SSL» that resets every TLS handshake on
 * `:443` to our relay (a member's laptop, 23.09.2026) — the relay also listens
 * on spare doors, `:2096` and `:8443`, same name, same certificate. Until now
 * only a human could point an agent at one, by editing its plist or `.cmd`.
 *
 * So the agent carries the list itself: the configured URL first, then the
 * same URL on each alternate port. A connect that fails before the handshake
 * completes moves to the next door; a door that opens is remembered until it
 * fails. Nothing else changes — the token, the path, the hub behind it are the
 * same on every port.
 */

import { isExternal } from './edition.js';

/** Ports tried after the configured one, in order. Empty string disables.
 *  The spare doors are HegAI's relay; a customer's hub has none. */
export const DEFAULT_ALT_PORTS = '8443,2096';

export function defaultAltPorts(external: boolean = isExternal()): string {
  return external ? '' : DEFAULT_ALT_PORTS;
}

export function hubCandidates(centralUrl: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const base = centralUrl.replace(/\/+$/, '');
  const raw = env['CC_REMOTE_ALT_PORTS'] ?? defaultAltPorts();
  const ports = raw
    .split(',')
    .map((p) => Number(p.trim()))
    .filter((p) => Number.isInteger(p) && p > 0 && p < 65536);
  let parsed: URL;
  try {
    parsed = new URL(base);
  } catch {
    return [base];
  }
  // Loopback is a dev hub on one port; there are no spare doors to a
  // developer's laptop, and probing them only delays the honest error.
  if (/^(127\.0\.0\.1|localhost|\[::1\])$/.test(parsed.hostname) && !env['CC_REMOTE_ALT_PORTS']) return [base];
  const out = [base];
  for (const port of ports) {
    const alt = new URL(base);
    alt.port = String(port);
    const s = alt.toString().replace(/\/+$/, '');
    if (!out.includes(s)) out.push(s);
  }
  return out;
}

/** `wss://host[:port]` → `https://host[:port]`, for the REST calls beside the socket. */
export function httpBaseOf(wsUrl: string): string {
  return wsUrl.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:').replace(/\/+$/, '');
}
