import { createInterface } from 'node:readline';
import { readdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { UsageInfo, UsageLimit } from '@cc-remote/shared';
import { CodexNotFound, describeSearch, spawnCodex } from './runtime-locate.js';

const TIMEOUT_MS = 12_000;

interface RateLimitWindow {
  usedPercent?: unknown;
  resetsAt?: unknown;
  windowDurationMins?: unknown;
}

interface RateLimitSnapshot {
  primary?: RateLimitWindow | null;
  secondary?: RateLimitWindow | null;
  planType?: unknown;
  limitId?: unknown;
  limitName?: unknown;
}

interface RateLimitsResponse {
  rateLimits?: RateLimitSnapshot;
  rateLimitsByLimitId?: Record<string, RateLimitSnapshot> | null;
}

function durationLabel(mins: number | undefined, fallback: string): string {
  if (!mins || mins <= 0) return fallback;
  if (mins % (60 * 24 * 7) === 0) return `${mins / (60 * 24 * 7)} week`;
  if (mins % (60 * 24) === 0) return `${mins / (60 * 24)} day`;
  if (mins % 60 === 0) return `${mins / 60}hr`;
  return `${mins}min`;
}

function toLimit(
  key: string,
  group: 'session' | 'weekly',
  window: RateLimitWindow | null | undefined,
  fallback: string,
): UsageLimit | null {
  if (!window || typeof window.usedPercent !== 'number' || !Number.isFinite(window.usedPercent)) return null;
  const mins = typeof window.windowDurationMins === 'number' && Number.isFinite(window.windowDurationMins)
    ? window.windowDurationMins
    : undefined;
  const resetSeconds = typeof window.resetsAt === 'number' && Number.isFinite(window.resetsAt)
    ? window.resetsAt
    : undefined;
  return {
    key,
    label: `${group === 'session' ? 'Session' : 'Weekly'} (${durationLabel(mins, fallback)})`,
    group,
    percent: window.usedPercent,
    ...(resetSeconds ? { resetsAt: resetSeconds * 1000 } : {}),
  };
}

/** Normalize the official app-server response into the provider-neutral wire type. */
export function mapCodexRateLimits(result: unknown): UsageInfo | null {
  if (!result || typeof result !== 'object') return null;
  const response = result as RateLimitsResponse;
  const buckets = response.rateLimitsByLimitId;
  const snapshot = buckets?.['codex']
    ?? (buckets ? Object.values(buckets).find((item) => item?.primary || item?.secondary) : undefined)
    ?? response.rateLimits;
  if (!snapshot) return null;

  const limits = [
    toLimit('session', 'session', snapshot.primary, '5hr'),
    toLimit('weekly_all', 'weekly', snapshot.secondary, '7 day'),
  ].filter((limit): limit is UsageLimit => limit !== null);
  if (!limits.length) return null;

  return {
    limits,
    ...(typeof snapshot.planType === 'string' ? { subscription: snapshot.planType } : {}),
    updatedAt: Date.now(),
  };
}

/**
 * What one probe of the app-server learned. `usage` is the limits when the
 * server gave them; `account` is who it says is logged in; `error` is the one
 * word the machine card shows when there is nothing to show — this used to be
 * a bare `null` for every one of these cases, which is how a Mac with Codex
 * sessions in the list and no Codex limits became a mystery (24.09.2026).
 */
export interface CodexProbe {
  usage: UsageInfo | null;
  account?: { email?: string; plan?: string };
  error?: 'not_found' | 'not_logged_in' | 'timeout' | 'app_server_error';
  detail?: string;
}

const ID_INIT = 1;
const ID_ACCOUNT = 2;
const ID_LIMITS = 3;

interface AccountReadResult {
  account?: { email?: unknown; planType?: unknown; type?: unknown } | null;
}

function accountFrom(result: unknown): CodexProbe['account'] {
  const r = result && typeof result === 'object' ? (result as AccountReadResult) : undefined;
  const a = r?.account;
  if (!a || typeof a !== 'object') return undefined;
  const email = typeof a.email === 'string' ? a.email : undefined;
  const plan = typeof a.planType === 'string' ? a.planType.toLowerCase() : undefined;
  if (!email && !plan) return undefined;
  return { ...(email ? { email } : {}), ...(plan ? { plan } : {}) };
}

function errorText(frame: Record<string, unknown>): string | undefined {
  const e = frame['error'];
  if (!e || typeof e !== 'object') return undefined;
  const m = (e as { message?: unknown }).message;
  return typeof m === 'string' ? m : JSON.stringify(e);
}

/**
 * Fold the frames one probe received into a reading. Pure, so the mapping
 * from «what the server said» to «what the card says» is testable without a
 * server: an `authentication required` on the limits call is «нет входа»,
 * not silence.
 */
export function reduceCodexFrames(frames: Record<string, unknown>[]): Omit<CodexProbe, 'detail'> & { detail?: string } {
  let usage: UsageInfo | null = null;
  let account: CodexProbe['account'];
  let notLoggedIn = false;
  let otherError: string | undefined;
  for (const frame of frames) {
    if (frame['id'] === ID_ACCOUNT && 'result' in frame) account = accountFrom(frame['result']);
    if (frame['id'] === ID_LIMITS) {
      if ('result' in frame) {
        const mapped = mapCodexRateLimits(frame['result']);
        if (mapped) usage = mapped;
      } else {
        const text = errorText(frame) ?? 'error';
        if (/authentication required|not logged in|login required/i.test(text)) notLoggedIn = true;
        else otherError = text;
      }
    }
  }
  if (usage && account) {
    usage = {
      ...usage,
      ...(account.email ? { account: account.email } : {}),
      ...(account.plan && !usage.subscription ? { subscription: account.plan } : {}),
    };
  }
  if (notLoggedIn) return { usage: null, ...(account ? { account } : {}), error: 'not_logged_in' };
  if (!usage && otherError) return { usage: null, ...(account ? { account } : {}), error: 'app_server_error', detail: otherError.slice(0, 300) };
  return { usage, ...(account ? { account } : {}) };
}

/**
 * Ask the local Codex app-server who is logged in and how much is left. Never
 * throws and never blocks the agent; every failure is a reading, not a gap.
 */
export async function fetchCodexUsage(): Promise<CodexProbe> {
  let spawned: Awaited<ReturnType<typeof spawnCodex>>;
  try {
    spawned = await spawnCodex(['app-server'], { stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (error) {
    if (error instanceof CodexNotFound) {
      return { usage: null, error: 'not_found', detail: describeSearch({ searched: error.searched, ...(error.envHint ? { envHint: error.envHint } : {}) }) };
    }
    return { usage: null, error: 'app_server_error', detail: String((error as Error)?.message ?? error).slice(0, 300) };
  }
  const { child } = spawned;

  return new Promise((resolve) => {
    let settled = false;
    let initialized = false;
    let stderrTail = '';
    const frames: Record<string, unknown>[] = [];
    const finish = (value: CodexProbe) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      resolve(value);
    };
    const fromFrames = () => finish(reduceCodexFrames(frames));

    const timer = setTimeout(() => {
      if (frames.some((f) => f['id'] === ID_LIMITS)) fromFrames();
      else finish({ usage: null, error: 'timeout', detail: `app-server не ответил за ${TIMEOUT_MS / 1000} с` });
    }, TIMEOUT_MS);
    timer.unref?.();

    child.stderr.on('data', (d: Buffer) => {
      stderrTail = (stderrTail + d.toString()).slice(-600);
    });
    child.on('error', (error) => finish({ usage: null, error: 'app_server_error', detail: String(error.message).slice(0, 300) }));
    child.on('close', (code) => {
      if (frames.some((f) => f['id'] === ID_LIMITS)) {
        fromFrames();
        return;
      }
      const tail = stderrTail.trim().split('\n').slice(-2).join(' ').slice(0, 260);
      finish({ usage: null, error: 'app_server_error', detail: `app-server завершился (${code ?? '?'})${tail ? `: ${tail}` : ''}` });
    });

    const send = (frame: unknown) => {
      if (!settled && child.stdin.writable) child.stdin.write(`${JSON.stringify(frame)}\n`);
    };
    const rl = createInterface({ input: child.stdout });
    rl.on('line', (line) => {
      let frame: Record<string, unknown>;
      try {
        frame = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return;
      }
      if (frame['id'] === ID_INIT && !initialized) {
        initialized = true;
        send({ method: 'initialized' });
        send({ id: ID_ACCOUNT, method: 'account/read' });
        send({ id: ID_LIMITS, method: 'account/rateLimits/read' });
        return;
      }
      if (frame['id'] === ID_ACCOUNT || frame['id'] === ID_LIMITS) {
        frames.push(frame);
        if (frame['id'] === ID_LIMITS) fromFrames();
      }
    });
    send({
      id: ID_INIT,
      method: 'initialize',
      params: { clientInfo: { name: 'cc-remote-agent', version: '1.0.0' }, capabilities: {} },
    });
  });
}

/** A temp clone younger than this may belong to a sync still running. */
const TMP_GIT_STALE_MS = 10 * 60_000;

/**
 * Remove the `~/.codex/.tmp/git-*` clones the probe above leaves behind.
 *
 * Every `codex app-server` start syncs its plugin marketplace into a fresh
 * `.tmp/git-XXXXXX` and deletes it when the sync finishes. The limits probe
 * lives a second or two — shorter than that sync — so the clone outlives the
 * process that owned it. One per poll, every ~2 min, on every machine: 14 792
 * of them on the hub box, 4 876 on cloud (whose 38 GB disk is the one that
 * fills) when this was found, 25.09.2026. Reproduced: an app-server stopped
 * 1 s after start leaks the dir (either SIGTERM or closing stdin — no clean
 * way out); one left for 8 s does not.
 *
 * Only `git-*`, only older than ten minutes: a live session's own sync is
 * fresh and untouched. Never throws.
 */
export async function sweepCodexTmp(home = process.env['CODEX_HOME'] || path.join(os.homedir(), '.codex'), now = Date.now()): Promise<number> {
  const dir = path.join(home, '.tmp');
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    if (!/^git-[A-Za-z0-9]+$/.test(name)) continue;
    const full = path.join(dir, name);
    try {
      const st = await stat(full);
      if (!st.isDirectory() || now - st.mtimeMs < TMP_GIT_STALE_MS) continue;
      await rm(full, { recursive: true, force: true });
      removed++;
    } catch {
      /* raced with codex itself, or not ours to remove */
    }
  }
  return removed;
}
