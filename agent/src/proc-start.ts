import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';

/**
 * «When did the process that has this pid START» — the one fact that tells a
 * pid apart from the pid's next owner.
 *
 * A pid is a number the kernel hands out again. `~/.claude/sessions/<pid>.json`
 * outlives the process that wrote it, and `process.kill(pid, 0)` only says that
 * SOME process answers to the number now. Without a start time the agent reads
 * a stranger as the session's writer: the session cannot be opened, and a
 * takeover would SIGTERM/SIGKILL somebody else's process.
 *
 * The CLI writes the same fact into its record as an opaque `procStart`
 * string, and compares it by plain equality. This file produces that string
 * the way the CLI does, so a record can be checked against the live pid:
 *   - Linux: `/proc/<pid>/stat` field 22, start time in clock ticks since boot.
 *   - macOS: `LC_ALL=C TZ=UTC ps -o lstart= -p <pid>`, e.g. `Thu Oct 16 10:11:12 2026`.
 *   - anything else (Windows included): not known — `undefined`. Callers read
 *     «not known» as «cannot tell», never as «different».
 */

/**
 * USER_HZ, the unit of `/proc/<pid>/stat` field 22. It is 100 on every Linux
 * port the agent runs on (x86, arm); the kernel exports it to userspace at that
 * value regardless of CONFIG_HZ. `getconf CLK_TCK` would only confirm it at the
 * price of a fork per read.
 */
export const CLK_TCK = 100;

/** Positive cache for the `ps` path: a process that exists does not un-start. */
export const HIT_TTL_MS = 60_000;
/** Negative cache: short, so a pid that appears a moment later is noticed. */
export const MISS_TTL_MS = 5_000;

/**
 * Field 22 of one `/proc/<pid>/stat` line, as the decimal string.
 *
 * `comm` (field 2) is the executable name in parentheses and may itself hold
 * spaces and parentheses — «(my (odd) proc)» — so a plain split on spaces
 * miscounts. The kernel closes it with the LAST `)` on the line; everything
 * after that is plain space-separated fields starting at field 3 (state), which
 * puts field 22 at index 19.
 */
export function parseStatStartTicks(statLine: string): string | undefined {
  const close = statLine.lastIndexOf(')');
  if (close < 0) return undefined;
  const fields = statLine
    .slice(close + 1)
    .trim()
    .split(/\s+/);
  const ticks = fields[19];
  return ticks !== undefined && /^\d+$/.test(ticks) ? ticks : undefined;
}

/**
 * Two start tokens name the same process iff they are equal — the CLI's own
 * rule. Whitespace is normalised first, because the macOS token is the raw
 * text of `ps` and a trailing newline or a padded day must not read as a
 * different process: that mistake would let a live editor look like a
 * stranger and be skipped, which is the failure this whole check must not have.
 */
export function sameStartToken(a: string, b: string): boolean {
  const norm = (s: string) => s.trim().replace(/\s+/g, ' ');
  return norm(a) === norm(b);
}

/** One `ps -o lstart=` call. Resolves undefined for any failure (no such pid, no ps). */
function runPsLstart(pid: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      'ps',
      ['-o', 'lstart=', '-p', String(pid)],
      {
        encoding: 'utf8',
        timeout: 3_000,
        env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
      },
      (error, stdout) => {
        const text = error ? '' : String(stdout).trim();
        resolve(text || undefined);
      },
    );
  });
}

/**
 * A per-pid cache around a start-time reader: a hit is kept 60 s, a miss 5 s.
 * It exists for the macOS path, where every read forks `ps` and an inventory
 * build asks about every record in the directory; Linux reads `/proc`, which
 * costs one syscall, and is not cached.
 *
 * `fresh` bypasses the cache and refreshes it — a kill decision must look at
 * the process as it is this instant, not as it was a minute ago.
 */
export function cachedReader(
  read: (pid: number) => Promise<string | undefined>,
  now: () => number = Date.now,
): (pid: number, fresh?: boolean) => Promise<string | undefined> {
  const cache = new Map<number, { at: number; value: string | undefined }>();
  return async (pid, fresh = false) => {
    const t = now();
    const hit = cache.get(pid);
    if (!fresh && hit && t - hit.at < (hit.value === undefined ? MISS_TTL_MS : HIT_TTL_MS)) {
      return hit.value;
    }
    const value = await read(pid);
    if (cache.size >= 512) {
      for (const [key, entry] of cache) {
        if (t - entry.at >= HIT_TTL_MS) cache.delete(key);
      }
      if (cache.size >= 512) cache.clear();
    }
    cache.set(pid, { at: now(), value });
    return value;
  };
}

const lstartOf = cachedReader(runPsLstart);

async function readStat(pid: number): Promise<string | undefined> {
  try {
    return await readFile(`/proc/${pid}/stat`, 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * The CLI-compatible `procStart` of the process now at `pid`, or `undefined`
 * when it cannot be read (no such process, an unsupported OS, any error).
 * Never throws.
 */
export async function processStartToken(
  pid: number,
  options: { fresh?: boolean } = {},
): Promise<string | undefined> {
  try {
    if (!Number.isInteger(pid) || pid <= 0) return undefined;
    if (process.platform === 'linux') {
      const line = await readStat(pid);
      return line === undefined ? undefined : parseStatStartTicks(line);
    }
    if (process.platform === 'darwin') return await lstartOf(pid, options.fresh === true);
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * When the process now at `pid` started, ms since epoch, or `undefined` when
 * that cannot be worked out. Resolution is one second on both platforms
 * (`btime`, `lstart`); callers compare with slack.
 */
