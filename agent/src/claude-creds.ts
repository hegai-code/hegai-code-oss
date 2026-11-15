import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * Who is logged into Claude Code on this machine, and with what token.
 *
 * Two files, two questions. `~/.claude.json` carries `oauthAccount` — the
 * email, the plan, the billing type — and is written on every OS by the login
 * flow, so it answers «logged in as whom» without touching a secret. The
 * TOKEN lives in `~/.claude/.credentials.json` on Linux and Windows, but on
 * macOS Claude Code keeps it in the Keychain and only falls back to the file
 * when the Keychain is locked — so a Mac has an identity on disk and no token
 * file, and the usage poll that read only the file found nothing there. That
 * is why Mac users had no «Claude» section in the limits meter.
 *
 * Reading the Keychain from a background process can raise a consent dialog
 * the first time; the identity read never does. So presence and account come
 * from `~/.claude.json`, and the Keychain is asked only for the usage token.
 */

function configDir(): string {
  return process.env['CLAUDE_CONFIG_DIR'] || path.join(os.homedir(), '.claude');
}

/** `~/.claude.json` sits beside `~/.claude/`, not inside it; with
 *  CLAUDE_CONFIG_DIR it moves into that directory. */
function stateFile(): string {
  const custom = process.env['CLAUDE_CONFIG_DIR'];
  return custom ? path.join(custom, '.claude.json') : path.join(os.homedir(), '.claude.json');
}

export interface ClaudeIdentity {
  email?: string;
  /** Lowercased plan word: `max`, `pro`, `team`, `enterprise`, or the raw
   *  organizationType when it is not one of those. */
  plan?: string;
  billingType?: string;
}

interface OauthAccount {
  emailAddress?: unknown;
  billingType?: unknown;
  organizationType?: unknown;
  organizationRateLimitTier?: unknown;
}

/** `claude_max` → `max`, `claude_pro` → `pro`, `claude_team` → `team`. The
 *  rate-limit tier (`default_claude_max_20x`) refines it with the multiplier
 *  when present, because «Max 20x» and «Max 5x» are different limits. */
export function planFromAccount(a: OauthAccount): string | undefined {
  const org = typeof a.organizationType === 'string' ? a.organizationType : '';
  const tier = typeof a.organizationRateLimitTier === 'string' ? a.organizationRateLimitTier : '';
  const base = /claude_(max|pro|team|enterprise)/.exec(org)?.[1] ?? (org || undefined);
  if (!base) return undefined;
  const mult = /_(\d+x)$/.exec(tier)?.[1];
  return mult ? `${base} ${mult}` : base;
}

export async function readClaudeIdentity(): Promise<ClaudeIdentity | null> {
  let raw: string;
  try {
    raw = await readFile(stateFile(), 'utf8');
  } catch {
    return null;
  }
  let account: OauthAccount | undefined;
  try {
    account = (JSON.parse(raw) as { oauthAccount?: OauthAccount }).oauthAccount;
  } catch {
    return null;
  }
  if (!account || typeof account !== 'object') return null;
  const email = typeof account.emailAddress === 'string' ? account.emailAddress : undefined;
  const plan = planFromAccount(account);
  const billingType = typeof account.billingType === 'string' ? account.billingType : undefined;
  if (!email && !plan) return null;
  return { ...(email ? { email } : {}), ...(plan ? { plan } : {}), ...(billingType ? { billingType } : {}) };
}

interface Creds {
  claudeAiOauth?: { accessToken?: string; subscriptionType?: string; expiresAt?: number };
}

function parseCreds(raw: string): { token: string; subscription?: string; expiresAt?: number } | null {
  try {
    const c = JSON.parse(raw) as Creds;
    const token = c.claudeAiOauth?.accessToken;
    if (!token) return null;
    const subscription = c.claudeAiOauth?.subscriptionType;
    const expiresAt = c.claudeAiOauth?.expiresAt;
    return { token, ...(subscription ? { subscription } : {}), ...(typeof expiresAt === 'number' ? { expiresAt } : {}) };
  } catch {
    return null;
  }
}

/** The Keychain item Claude Code writes on macOS. */
const KEYCHAIN_SERVICE = 'Claude Code-credentials';

function readKeychain(timeoutMs = 5_000): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      '/usr/bin/security',
      ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'],
      { timeout: timeoutMs, maxBuffer: 1 << 20 },
      (err, stdout) => resolve(err ? null : stdout.trim()),
    );
  });
}

/**
 * The OAuth token the usage endpoint wants. File first (every OS, and the
 * Keychain-locked fallback on a Mac), then the Keychain on macOS. Null when
 * neither has one — an API-key login, or no login at all.
 */
export async function readClaudeOauthToken(): Promise<{ token: string; subscription?: string; expiresAt?: number } | null> {
  try {
    const parsed = parseCreds(await readFile(path.join(configDir(), '.credentials.json'), 'utf8'));
    if (parsed) return parsed;
  } catch {
    /* no file — the normal case on a Mac */
  }
  if (process.platform !== 'darwin') return null;
  const raw = await readKeychain();
  return raw ? parseCreds(raw) : null;
}

/**
 * What the credentials FILE says about the login's health — never the token.
 *
 * Why this exists (28.09.2026): four servers had run for 1½–2½ months with
 * `accessToken: ""` and `refreshToken: ""` — Claude Code blanks both when a
 * refresh is refused — while «Железо» showed «Claude · owner@x.test», because
 * the identity comes from `~/.claude.json`, which a failed refresh leaves
 * alone. The file is the only place the difference is visible without a
 * network call. Null when there is no file (a Mac keeps it in the Keychain,
 * which this deliberately does not open — see the header).
 */
export interface ClaudeCredsShape {
  hasAccess: boolean;
  hasRefresh: boolean;
  expiresAt?: number;
}

export async function readClaudeCredsShape(): Promise<ClaudeCredsShape | null> {
  let raw: string;
  try {
    raw = await readFile(path.join(configDir(), '.credentials.json'), 'utf8');
  } catch {
    return null;
  }
  try {
    const o = (JSON.parse(raw) as { claudeAiOauth?: { accessToken?: unknown; refreshToken?: unknown; expiresAt?: unknown } }).claudeAiOauth;
    if (!o || typeof o !== 'object') return null;
    return {
      hasAccess: typeof o.accessToken === 'string' && o.accessToken.length > 0,
      hasRefresh: typeof o.refreshToken === 'string' && o.refreshToken.length > 0,
      ...(typeof o.expiresAt === 'number' && o.expiresAt > 0 ? { expiresAt: o.expiresAt } : {}),
    };
  } catch {
    return null;
  }
}

/** `CC_REMOTE_CLAUDE_TOKEN_EXPIRES_AT` — when the long-lived token in
 *  `CLAUDE_CODE_OAUTH_TOKEN` runs out. The token itself is opaque, so whoever
 *  installs it writes the date beside it (epoch ms or an ISO date). */
export function envTokenExpiry(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const raw = env['CC_REMOTE_CLAUDE_TOKEN_EXPIRES_AT']?.trim();
  if (!raw) return undefined;
  const n = /^\d+$/.test(raw) ? Number(raw) : Date.parse(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}
