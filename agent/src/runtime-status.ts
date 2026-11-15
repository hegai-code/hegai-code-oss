import { claudeDisabled } from './runtimes-allowed.js';
import { access, constants, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import type { ClaudeRuntimeStatus, CodexRuntimeStatus } from '@cc-remote/shared';
import { envTokenExpiry, readClaudeCredsShape, readClaudeIdentity, type ClaudeCredsShape } from './claude-creds.js';
import { bundledClaudeBin, codexVersion, describeSearch, isResolved, resolveClaudeBin, resolveCodexBin } from './runtime-locate.js';

/**
 * What the runtimes on this machine ARE: found, logged in as whom, own login
 * or a gateway. Cheap by design — file reads and one cached `--version` —
 * because it runs at start and on every usage poll. The app-server probe in
 * `codex-usage.ts` refines the Codex reading with what the server itself says
 * (account, plan, «authentication required»); this module is the part that
 * works even when the app-server cannot be spawned, which is precisely the
 * case it exists to describe.
 */

// --------------------------------------------------------------- Codex

/**
 * The provider Codex will actually talk to. Only a TOP-LEVEL `model_provider`
 * counts: TOML keys after the first `[table]` belong to that table, which is
 * exactly the trap the gateway installer avoids by writing its keys at the
 * head of the file. Absent, or the built-in `openai`, means the person's own
 * login.
 */
export function codexProviderFromToml(text: string): { provider: 'own' | 'gateway'; providerName?: string } {
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('[')) break; // first table: top level is over
    const m = /^model_provider\s*=\s*"([^"]*)"/.exec(line) ?? /^model_provider\s*=\s*'([^']*)'/.exec(line);
    if (m) {
      const name = m[1]!.trim();
      if (!name || name === 'openai') return { provider: 'own' };
      return { provider: 'gateway', providerName: name };
    }
  }
  return { provider: 'own' };
}

function tomlStr(raw: string): string | undefined {
  const v = raw.trim();
  if (v.startsWith('"')) {
    const m = /^"((?:[^"\\]|\\.)*)"/.exec(v);
    if (!m) return undefined;
    try {
      return JSON.parse(`"${m[1]}"`) as string;
    } catch {
      return m[1];
    }
  }
  const m = /^'([^']*)'/.exec(v);
  return m ? m[1] : undefined;
}

/**
 * Where the active gateway provider points and with which key: `base_url` and
 * `experimental_bearer_token` (or the env var named by `env_key`) from the
 * `[model_providers.<name>]` table of the provider chosen at the top level.
 * Pure — the caller reads the file and supplies the environment.
 */
export function codexGatewayConnection(
  text: string,
  env: NodeJS.ProcessEnv = {},
): { baseUrl?: string; bearer?: string } {
  const { provider, providerName } = codexProviderFromToml(text);
  if (provider !== 'gateway' || !providerName) return {};
  let inTable = false;
  let baseUrl: string | undefined;
  let token: string | undefined;
  let envKey: string | undefined;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('[')) {
      const h = /^\[\s*model_providers\s*\.\s*(?:"([^"]*)"|'([^']*)'|([A-Za-z0-9_-]+))\s*\]/.exec(line);
      inTable = Boolean(h && (h[1] ?? h[2] ?? h[3]) === providerName);
      continue;
    }
    if (!inTable) continue;
    const kv = /^([A-Za-z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!kv) continue;
    const val = tomlStr(kv[2]!);
    if (val === undefined) continue;
    if (kv[1] === 'base_url') baseUrl = val;
    else if (kv[1] === 'experimental_bearer_token') token = val;
    else if (kv[1] === 'env_key') envKey = val;
  }
  const bearer = token || (envKey ? env[envKey] : undefined) || undefined;
  return { ...(baseUrl ? { baseUrl } : {}), ...(bearer ? { bearer } : {}) };
}

/** Reads the connection of the active gateway provider from the Codex home. */
export async function readCodexGatewayConnection(): Promise<{ baseUrl?: string; bearer?: string }> {
  try {
    return codexGatewayConnection(await readFile(path.join(codexHome(), 'config.toml'), 'utf8'), process.env);
  } catch {
    return {};
  }
}

function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  const parts = token.split('.');
  if (parts.length < 2) return undefined;
  try {
    const json = Buffer.from(parts[1]!.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const v = JSON.parse(json) as unknown;
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Which login `~/.codex/auth.json` holds. A ChatGPT login carries an
 * `id_token` whose claims name the email and `chatgpt_plan_type` — at the top
 * level in some versions, under the `https://api.openai.com/auth` namespace
 * in others, so both are read. An API-key login has `OPENAI_API_KEY` in the
 * file (or in the environment, which Codex honours too).
 */
export function codexAuthFromAuthJson(
  json: unknown,
  env: NodeJS.ProcessEnv = {},
): { auth: 'chatgpt' | 'apikey' | 'none'; account?: string; plan?: string } {
  const obj = json && typeof json === 'object' ? (json as Record<string, unknown>) : {};
  const tokens = obj['tokens'] && typeof obj['tokens'] === 'object' ? (obj['tokens'] as Record<string, unknown>) : undefined;
  const idToken = tokens && typeof tokens['id_token'] === 'string' ? (tokens['id_token'] as string) : undefined;
  if (idToken) {
    const claims = decodeJwtPayload(idToken) ?? {};
    const ns = claims['https://api.openai.com/auth'];
    const nsObj = ns && typeof ns === 'object' ? (ns as Record<string, unknown>) : {};
    const email = [claims['email'], nsObj['email']].find((v): v is string => typeof v === 'string');
    const plan = [claims['chatgpt_plan_type'], nsObj['chatgpt_plan_type']].find(
      (v): v is string => typeof v === 'string',
    );
    return { auth: 'chatgpt', ...(email ? { account: email } : {}), ...(plan ? { plan: plan.toLowerCase() } : {}) };
  }
  if ((typeof obj['OPENAI_API_KEY'] === 'string' && obj['OPENAI_API_KEY']) || env['OPENAI_API_KEY']) {
    return { auth: 'apikey' };
  }
  return { auth: 'none' };
}

function codexHome(): string {
  return process.env['CODEX_HOME'] || path.join(os.homedir(), '.codex');
}

export async function codexRuntimeStatus(): Promise<CodexRuntimeStatus> {
  const checkedAt = Date.now();
  const bin = await resolveCodexBin();

  let provider: { provider: 'own' | 'gateway'; providerName?: string } = { provider: 'own' };
  try {
    provider = codexProviderFromToml(await readFile(path.join(codexHome(), 'config.toml'), 'utf8'));
  } catch {
    /* no config — Codex defaults: own login */
  }

  let auth: ReturnType<typeof codexAuthFromAuthJson> = { auth: 'none' };
  try {
    auth = codexAuthFromAuthJson(JSON.parse(await readFile(path.join(codexHome(), 'auth.json'), 'utf8')), process.env);
  } catch {
    auth = codexAuthFromAuthJson(undefined, process.env);
  }

  if (!isResolved(bin)) {
    return {
      present: false,
      auth: auth.auth,
      ...(auth.account ? { account: auth.account } : {}),
      ...(auth.plan ? { plan: auth.plan } : {}),
      provider: provider.provider,
      ...(provider.providerName ? { providerName: provider.providerName } : {}),
      error: 'not_found',
      detail: describeSearch(bin),
      checkedAt,
    };
  }

  const version = await codexVersion(bin.path);
  return {
    present: true,
    path: bin.path,
    ...(version ? { version } : {}),
    auth: auth.auth,
    ...(auth.account ? { account: auth.account } : {}),
    ...(auth.plan ? { plan: auth.plan } : {}),
    provider: provider.provider,
    ...(provider.providerName ? { providerName: provider.providerName } : {}),
    ...(bin.source === 'app-bundle' ? { detail: 'codex из ChatGPT.app — своей установки CLI нет' } : {}),
    checkedAt,
  };
}

// --------------------------------------------------------------- Claude

let sdkVersion: string | undefined | null = null;

/** The Claude that sessions actually run: the binary inside the agent's own
 *  `@anthropic-ai/claude-agent-sdk`, not whatever `claude` is on PATH. */
function claudeSdkVersion(): string | undefined {
  if (sdkVersion !== null) return sdkVersion;
  try {
    const require = createRequire(import.meta.url);
    const pkg = require('@anthropic-ai/claude-agent-sdk/package.json') as { version?: string };
    sdkVersion = typeof pkg.version === 'string' ? pkg.version : undefined;
  } catch {
    sdkVersion = undefined;
  }
  return sdkVersion;
}

/** Warn this long before a long-lived token runs out. */
export const TOKEN_WARN_MS = 30 * 24 * 60 * 60 * 1000;

export interface ClaudeAuthInput {
  apiKey: boolean;
  /** `CLAUDE_CODE_OAUTH_TOKEN` is set — it beats the file in Claude Code. */
  envToken: boolean;
  envTokenExpiresAt?: number;
  file: ClaudeCredsShape | null;
  /** `~/.claude.json` names an account. */
  identity: boolean;
  /** HTTP status of the last usage call made with the FILE token, if any. */
  usageHttp?: number;
  /** `expiresAt` of the token that call sent — a 401 counts only if the file
   *  still holds that same token (a turn may have refreshed it meanwhile). */
  usageTokenExpiresAt?: number;
  now: number;
}

export interface ClaudeAuthVerdict {
  /** 'oauth' | 'token' | 'apikey' | 'none' */
  auth: string;
  /** 'logged_out' | 'token_expired' | 'token_rejected' | 'token_expiring' */
  error?: string;
  expiresAt?: number;
}

/**
 * Is Claude on this machine able to run a turn — decided from facts that cost
 * nothing, in Claude Code's own order of precedence (API key, then the env
 * token, then the stored login).
 *
 * The one case it must NOT call broken: an access token past its `expiresAt`
 * with a refresh token beside it. That is every idle server after eight hours;
 * Claude Code refreshes on the next turn. So a usage 401 counts only when the
 * token was supposed to be valid, or when nothing could refresh it — and a
 * refresh token that is secretly dead shows up anyway, one turn later, as the
 * blanked file Claude Code leaves behind.
 */
export function claudeAuthVerdict(i: ClaudeAuthInput): ClaudeAuthVerdict {
  if (i.apiKey) return { auth: 'apikey' };
  if (i.envToken) {
    const exp = i.envTokenExpiresAt;
    const base = { auth: 'token', ...(exp ? { expiresAt: exp } : {}) };
    if (exp !== undefined && exp <= i.now) return { ...base, error: 'token_expired' };
    if (exp !== undefined && exp - i.now < TOKEN_WARN_MS) return { ...base, error: 'token_expiring' };
    return base;
  }
  const f = i.file;
  if (f) {
    if (!f.hasAccess) return { auth: 'none', error: 'logged_out' };
    const expired = f.expiresAt !== undefined && f.expiresAt <= i.now;
    if (expired && !f.hasRefresh) return { auth: 'none', error: 'token_expired' };
    const sameToken = i.usageTokenExpiresAt === f.expiresAt;
    if ((i.usageHttp === 401 || i.usageHttp === 403) && sameToken && (!expired || !f.hasRefresh)) return { auth: 'oauth', error: 'token_rejected' };
    return { auth: 'oauth' };
  }
  return { auth: i.identity ? 'oauth' : 'none' };
}

/**
 * Is the binary sessions exec actually on disk? Found 28.09.2026 on the Mac
 * mini: `claude-agent-sdk-darwin-arm64/` held package.json and README but no
 * `claude` — npm had dropped the ~200 MB file on a slow link — and every card
 * still said «Claude · Max», because `present` was hard-wired to true. Any new
 * Claude session there would have failed at spawn. `undefined` = the SDK
 * cannot even be resolved here (a dev tree): unknown, not an alarm.
 */
async function sdkBinaryPresent(): Promise<boolean | undefined> {
  const bin = bundledClaudeBin();
  if (!bin) return undefined;
  // The SDK itself looks in `linux-<arch>` AND `linux-<arch>-musl`; a musl
  // host may carry only the second, and its sessions start fine.
  const candidates =
    process.platform === 'linux' ? [bin, bin.replace(/claude-agent-sdk-linux-([^/\\]+)([/\\])claude$/, 'claude-agent-sdk-linux-$1-musl$2claude')] : [bin];
  for (const c of candidates) {
    try {
      await access(c, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
      return true;
    } catch {
      /* next */
    }
  }
  return false;
}

/** Two misses in a row before «missing»: the nightly updater's `npm install`
 *  replaces the platform package in place, and a poll landing in that window
 *  must not wake the ops chat for a file that is back a minute later. */
let sdkMissStreak = 0;

export async function claudeRuntimeStatus(opts: { usageHttp?: number; usageTokenExpiresAt?: number; resolveBin?: () => Promise<string | undefined>; sdkProbe?: () => Promise<boolean | undefined> } = {}): Promise<ClaudeRuntimeStatus> {
  const checkedAt = Date.now();
  // Switched off for this agent: say so, and nothing else — not the account
  // in ~/.claude.json, which on a shared box may be somebody else's.
  if (claudeDisabled()) return { present: true, auth: 'none', error: 'disabled', checkedAt };
  const sdkPresent = await (opts.sdkProbe ?? sdkBinaryPresent)();
  sdkMissStreak = sdkPresent === false ? sdkMissStreak + 1 : 0;
  if (sdkMissStreak >= 2) {
    return {
      present: false,
      auth: 'unknown',
      error: 'sdk_binary_missing',
      detail: `нет ${bundledClaudeBin() ?? 'claude'} — переустановить @anthropic-ai/claude-agent-sdk в каталоге агента`.slice(0, 300),
      checkedAt,
    };
  }
  const version = claudeSdkVersion();
  const [identity, file] = await Promise.all([readClaudeIdentity(), readClaudeCredsShape()]);
  const envToken = Boolean(process.env['CLAUDE_CODE_OAUTH_TOKEN']);
  const envExp = envTokenExpiry();
  const v = claudeAuthVerdict({
    apiKey: Boolean(process.env['ANTHROPIC_API_KEY']),
    envToken,
    ...(envExp ? { envTokenExpiresAt: envExp } : {}),
    file,
    identity: Boolean(identity),
    ...(opts.usageHttp !== undefined ? { usageHttp: opts.usageHttp } : {}),
    ...(opts.usageTokenExpiresAt !== undefined ? { usageTokenExpiresAt: opts.usageTokenExpiresAt } : {}),
    now: checkedAt,
  });
  // Sessions run on the SDK's own binary, but SIGNING IN needs a `claude` CLI.
  // Not signed in and no CLI to sign in with: say so (the web offers
  // «Установить»). `present` stays as it was — sessions of a machine that
  // authenticates some other way (gateway, helper) are not affected.
  const loginCliMissing = v.auth === 'none' && !(await (opts.resolveBin ?? resolveClaudeBin)());
  return {
    present: true,
    ...(version ? { version } : {}),
    auth: v.auth,
    ...(identity?.email ? { account: identity.email } : {}),
    ...(identity?.plan ? { plan: identity.plan } : {}),
    ...(loginCliMissing ? { error: 'login_cli_missing' } : v.error ? { error: v.error } : {}),
    ...(v.expiresAt ? { expiresAt: v.expiresAt } : {}),
    checkedAt,
  };
}

/** One log line per runtime, for `agent.log` — the answer to «why» has to
 *  exist on the machine too, not only on the hub. */
export function describeCodex(s: CodexRuntimeStatus): string {
  if (!s.present) return `codex: not found (${s.detail ?? 'no search'})`;
  const who = s.auth === 'chatgpt' ? `chatgpt ${s.account ?? '?'}${s.plan ? ` (${s.plan})` : ''}` : s.auth;
  const via = s.provider === 'gateway' ? `gateway ${s.providerName ?? ''}`.trim() : 'own';
  return `codex: ${s.path} ${s.version ?? '?'} · ${who} · ${via}${s.error ? ` · ${s.error}` : ''}`;
}

export function describeClaude(s: ClaudeRuntimeStatus): string {
  const who = s.auth === 'oauth' ? `oauth ${s.account ?? '?'}${s.plan ? ` (${s.plan})` : ''}` : s.auth;
  const exp = s.expiresAt ? ` · до ${new Date(s.expiresAt).toISOString().slice(0, 10)}` : '';
  return `claude: sdk ${s.version ?? '?'} · ${who}${exp}${s.error ? ` · ${s.error}` : ''}`;
}
