import type { UsageInfo, UsageLimit } from '@cc-remote/shared';

import { gatewayUrl } from './gateway.js';

/**
 * The key's own limits from the gateway (`GET /hegai/limits`), mapped to the
 * usage meter's shape. Lets a machine on the gateway show its limits on ANY
 * hub — a customer's self-hosted one has no gateway config to ask.
 */

export interface GatewayLimitsReply {
  pool?: string;
  limits?: {
    tokens?: number;
    tokensUsed?: number;
    tokensWindow?: string;
    requests?: number;
    requestsUsed?: number;
    requestsWindow?: string;
    resetAt?: number;
    requestsResetAt?: number;
  };
  quota?: Record<string, unknown> | null;
}

/**
 * Where to ask: `/hegai/limits` on the origin of the ONE gateway this machine
 * trusts (`gatewayUrl()`: `CC_REMOTE_GATEWAY_URL` in the agent's service
 * environment, or the internal edition's default) — and only when Codex's own
 * `base_url` points at that same origin. `~/.codex/config.toml` is writable by
 * every session on the machine, so it alone never decides where the key goes.
 */
export function gatewayLimitsUrl(baseUrl: string | undefined, trusted: string = gatewayUrl()): URL | null {
  if (!baseUrl || !trusted) return null;
  let u: URL;
  let t: URL;
  try {
    u = new URL(baseUrl);
    t = new URL(trusted);
  } catch {
    return null;
  }
  if (u.username || u.password || u.origin !== t.origin) return null;
  return new URL('/hegai/limits', t.origin);
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

// Same wording as the web's gateway quota, whose pace reader parses «(5 ч)».
function quotaLimit(
  key: string,
  pct: unknown,
  win: unknown,
  reset: unknown,
): UsageLimit | null {
  const w = num(win);
  if (!w || w <= 0) return null;
  const weekly = w >= 10080;
  const span = w % 1440 === 0 ? `${w / 1440} дн` : w % 60 === 0 ? `${w / 60} ч` : `${w} мин`;
  const r = num(reset);
  return {
    key,
    label: w === 10080 ? 'Неделя (7 дней)' : `${weekly ? 'Окно' : 'Сессия'} (${span})`,
    group: weekly ? 'weekly' : 'session',
    percent: num(pct) ?? 0,
    ...(r ? { resetsAt: r * 1000 } : {}), // quota resets are epoch seconds
  };
}

export function mapGatewayLimits(reply: GatewayLimitsReply, now = Date.now()): UsageInfo | null {
  const limits: UsageLimit[] = [];
  const q = reply.quota && typeof reply.quota === 'object' && reply.quota['ok'] === true ? reply.quota : null;
  if (q) {
    const a = quotaLimit('gw-primary', q['primary_used_percent'], q['primary_window_minutes'], q['primary_reset_at']);
    const b = quotaLimit('gw-secondary', q['secondary_used_percent'], q['secondary_window_minutes'], q['secondary_reset_at']);
    if (a) limits.push(a);
    if (b) limits.push(b);
  }
  // The key's own budget (`reply.limits`) is NOT sent: every consumer groups
  // Codex readings by account, and machines on one pool share an account, so a
  // key's budget would be shown as every same-pool machine's. The account's
  // windows above are the same for all of them.
  if (!limits.length) return null;
  const plan = q && typeof q['plan'] === 'string' ? (q['plan'] as string) : undefined;
  return {
    limits,
    account: reply.pool ? `шлюз · ${reply.pool}` : 'шлюз',
    ...(plan ? { subscription: plan } : {}),
    updatedAt: now,
  };
}

/** One poll of the endpoint. Any failure — network, 401, 404, junk — is «no data». */
export async function fetchGatewayLimits(baseUrl: string | undefined, bearer: string | undefined): Promise<UsageInfo | null> {
  const url = gatewayLimitsUrl(baseUrl);
  if (!url || !bearer) return null;
  try {
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${bearer}`, accept: 'application/json' },
      redirect: 'error', // the key goes to the allow-listed host only, never after a redirect
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status !== 200) return null;
    return mapGatewayLimits((await res.json()) as GatewayLimitsReply);
  } catch {
    return null;
  }
}
