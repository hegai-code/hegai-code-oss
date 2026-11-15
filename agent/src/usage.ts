import type { UsageInfo, UsageLimit } from '@cc-remote/shared';
import { AGENT_VERSION } from './config.js';
import { readClaudeIdentity, readClaudeOauthToken } from './claude-creds.js';

/**
 * Best-effort Claude subscription usage reader. Takes the account's OAuth token
 * from wherever Claude Code keeps it (`claude-creds.ts`: the credentials file,
 * or the Keychain on a Mac — the file-only read is why Mac users had no Claude
 * section for months) and queries the authoritative usage endpoint — the exact
 * source Claude Code's `/usage` renders from. Everything here is best-effort:
 * no token, an expired token, or a 429 all resolve to null. Usage is a nicety,
 * never load-bearing; WHETHER there is a login is `runtime-status.ts`'s job.
 */

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile';

// The profile (account email) never changes for a process; fetch it once.
let cachedEmail: string | undefined;
let profileTried = false;

function usageHeaders(token: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    'anthropic-beta': 'oauth-2025-04-20',
    // A `claude-code/*` UA is required — without it Anthropic rate-limits this
    // endpoint aggressively (persistent 429s). We still poll only every ~180s.
    'user-agent': `claude-code/${AGENT_VERSION}`,
  };
}

interface RawLimit {
  kind?: string;
  group?: string;
  percent?: number;
  resets_at?: string;
  is_active?: boolean;
  scope?: { model?: { display_name?: string } } | null;
}

// Map a raw `limits[]` entry to our display row, matching Claude's own labels.
function toLimit(e: RawLimit): UsageLimit | null {
  if (typeof e.percent !== 'number') return null;
  const model = e.scope?.model?.display_name;
  let key: string;
  let label: string;
  let group = e.group;
  if (e.kind === 'session') {
    key = 'session';
    label = 'Session (5hr)';
    group = 'session';
  } else if (e.kind === 'weekly_all') {
    key = 'weekly_all';
    label = 'Weekly (7 day)';
    group = 'weekly';
  } else if (e.kind === 'weekly_scoped' && model) {
    key = `weekly:${model}`;
    label = `Weekly ${model}`; // e.g. "Weekly Fable"
    group = 'weekly';
  } else {
    key = String(e.kind ?? (model ? `weekly:${model}` : 'limit'));
    label = model ? `Weekly ${model}` : String(e.kind ?? 'Limit');
  }
  const resetsAt = typeof e.resets_at === 'string' ? Date.parse(e.resets_at) : NaN;
  return {
    key,
    label,
    ...(group ? { group } : {}),
    percent: e.percent,
    ...(Number.isFinite(resetsAt) ? { resetsAt } : {}),
    ...(typeof e.is_active === 'boolean' ? { active: e.is_active } : {}),
  };
}

async function fetchEmail(token: string, signal?: AbortSignal): Promise<void> {
  if (profileTried || signal?.aborted) return;
  // The login state file already names the account; the profile call is only
  // needed when it does not (an older Claude Code, a custom config dir).
  if (!cachedEmail) {
    const identity = await readClaudeIdentity();
    if (identity?.email) {
      cachedEmail = identity.email;
      profileTried = true;
      return;
    }
  }
  if (signal?.aborted) return;
  try {
    const r = await fetch(PROFILE_URL, { headers: usageHeaders(token), signal: requestSignal(signal) });
    profileTried = true; // got a response — don't refetch the (stable) email
    if (!r.ok) return;
    const j = (await r.json()) as { account?: { email?: string } };
    if (typeof j.account?.email === 'string') cachedEmail = j.account.email;
  } catch {
    /* network/timeout — leave profileTried false so the email is retried next poll */
  }
}

/** HTTP status of the last usage call, or undefined when none was made (no
 *  token) or it never got an answer. Read by the runtime status: a 401 here is
 *  the one network-level sign that the stored login is dead. Only the FILE /
 *  Keychain token is ever sent here — never `CLAUDE_CODE_OAUTH_TOKEN`, whose
 *  inference-only scope this endpoint does not accept. */
let lastHttp: { status: number; tokenExpiresAt?: number } | undefined;
/** Also the `expiresAt` of the token that was SENT: the file can be refreshed
 *  by a Claude turn between this call and the verdict's own read of it, and a
 *  401 for the old token must not be pinned on the new one. */
export function lastUsageHttp(): { status: number; tokenExpiresAt?: number } | undefined {
  return lastHttp;
}

function requestSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(10_000);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export async function fetchUsage(signal?: AbortSignal): Promise<UsageInfo | null> {
  if (signal?.aborted) return null;
  const creds = await readClaudeOauthToken();
  lastHttp = undefined;
  if (!creds || signal?.aborted) return null;
  try {
    const r = await fetch(USAGE_URL, { headers: usageHeaders(creds.token), signal: requestSignal(signal) });
    lastHttp = { status: r.status, ...(creds.expiresAt !== undefined ? { tokenExpiresAt: creds.expiresAt } : {}) };
    if (!r.ok) return null;
    const j = (await r.json()) as {
      limits?: RawLimit[];
      five_hour?: { utilization?: number; resets_at?: string };
      seven_day?: { utilization?: number; resets_at?: string };
    };
    // Prefer the endpoint's `limits[]` (session / weekly / per-model weekly) —
    // it is exactly what Claude Code's /usage renders. Fall back to the
    // five_hour/seven_day summary only if the array is absent.
    let limits: UsageLimit[] = Array.isArray(j.limits)
      ? j.limits.map(toLimit).filter((x): x is UsageLimit => x !== null)
      : [];
    if (limits.length === 0) {
      const fh = j.five_hour;
      const sd = j.seven_day;
      const parse = (s?: string) => (typeof s === 'string' && Number.isFinite(Date.parse(s)) ? Date.parse(s) : undefined);
      if (typeof fh?.utilization === 'number')
        limits.push({ key: 'session', label: 'Session (5hr)', group: 'session', percent: fh.utilization, ...(parse(fh.resets_at) ? { resetsAt: parse(fh.resets_at) } : {}) });
      if (typeof sd?.utilization === 'number')
        limits.push({ key: 'weekly_all', label: 'Weekly (7 day)', group: 'weekly', percent: sd.utilization, ...(parse(sd.resets_at) ? { resetsAt: parse(sd.resets_at) } : {}) });
    }
    if (limits.length === 0) return null;
    await fetchEmail(creds.token, signal);
    return {
      limits,
      ...(cachedEmail ? { account: cachedEmail } : {}),
      ...(creds.subscription ? { subscription: creds.subscription } : {}),
      updatedAt: Date.now(),
    };
  } catch {
    return null;
  }
}
