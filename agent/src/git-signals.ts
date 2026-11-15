import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AgentToCentral } from '@cc-remote/shared';
import { childEnv } from './child-env.js';

/**
 * Source-agnostic "the session did something in git" signals.
 *
 * The on-machine commit-signal hook only fires inside a Claude session (it is a
 * PostToolUse hook), so a Codex session's commits were invisible to the hub —
 * and the community metrics count exactly those. This watches HEAD instead:
 * every time a run goes idle, HEAD is compared with the previous observation
 * (the run's launch, or the last idle). A new HEAD is a commit; a HEAD that is
 * not ahead of its upstream is a push. Best-effort and silent by design — a
 * failed probe costs nothing, and a directory that is not a repo says nothing.
 */

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 5_000;

export interface UpstreamState {
  /** The upstream's remote name (`origin` in `origin/main`). */
  remote: string;
  /** Commits on HEAD that the upstream does not have. 0 = pushed. */
  ahead: number;
}

/** The three git facts the signals need, so tests can inject them. */
export interface GitProbe {
  /** HEAD's sha, or undefined when `cwd` is not a repo / has no commits. */
  head(cwd: string): Promise<string | undefined>;
  /** Upstream of the current branch, or undefined when none is configured. */
  upstream(cwd: string): Promise<UpstreamState | undefined>;
  /** The remote's fetch URL. */
  remoteUrl(cwd: string, remote: string): Promise<string | undefined>;
}

/** Run git with a hard timeout; any failure is an undefined answer, never an
 *  exception — nothing here is worth a stack trace in the run's stream. */
async function git(cwd: string, args: string[]): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
      // Optional locks off: a probe must never contend with the git the
      // session itself is running in the same directory.
      env: childEnv({ GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' }),
    });
    return stdout.trim();
  } catch {
    return undefined;
  }
}

export const execGitProbe: GitProbe = {
  async head(cwd) {
    return (await git(cwd, ['rev-parse', '--verify', '-q', 'HEAD'])) || undefined;
  },
  async upstream(cwd) {
    const ref = await git(cwd, ['rev-parse', '--abbrev-ref', '@{upstream}']);
    if (!ref) return undefined;
    const count = await git(cwd, ['rev-list', '--count', '@{upstream}..HEAD']);
    if (count === undefined) return undefined;
    const ahead = Number(count);
    if (!Number.isInteger(ahead)) return undefined;
    // `origin/feature/x` — remote names with a slash are practically unheard
    // of, branch names with one are everyday, so the first segment is the remote.
    return { remote: ref.split('/')[0] || ref, ahead };
  },
  async remoteUrl(cwd, remote) {
    return (await git(cwd, ['remote', 'get-url', remote])) || undefined;
  },
};

/**
 * The host of a git remote URL — and only the host. The URL itself may embed a
 * token (`https://x-access-token:…@github.com/…`), so it never leaves the
 * machine. Handles `scheme://[user@]host[:port]/…`, scp-like `[user@]host:path`
 * and `ssh://`. Local paths, `file://` and Windows drive letters have no host
 * and yield undefined.
 */
export function parseRemoteHost(url: string): string | undefined {
  const s = url.trim();
  if (!s) return undefined;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?(\[[^\]]+\]|[^:/?#]+)(?::\d+)?(?:[/?#]|$)/i.exec(s);
  if (withScheme) return withScheme[1]!.toLowerCase();
  // scp-like: `git@github.com:org/repo.git` or `host:path` — but not `C:\…`
  // and not anything that starts with a path separator.
  const scpLike = /^(?:[^@/:]+@)?([^@/:]+):(?!\/\/)/.exec(s);
  if (scpLike && !/^[a-z]$/i.test(scpLike[1]!)) return scpLike[1]!.toLowerCase();
  return undefined;
}

/** What one run remembers between observations. */
export interface SignalMemory {
  /** HEAD at the previous observation (launch, or the last idle). */
  lastHead?: string;
  /** HEAD the branch was last seen fully pushed at. Seeded at launch so a
   *  fresh clone does not count as "took their code home". */
  pushedHead?: string;
}

export interface GitObservation {
  head?: string;
  upstream?: UpstreamState;
}

export interface SignalVerdict {
  committed: boolean;
  pushed: boolean;
  next: SignalMemory;
}

/** The memory a run starts with: nothing has happened yet. */
export function baselineMemory(now: GitObservation): SignalMemory {
  return {
    ...(now.head ? { lastHead: now.head } : {}),
    ...(now.head && now.upstream?.ahead === 0 ? { pushedHead: now.head } : {}),
  };
}

/**
 * Pure decision: given what the run remembered and what git says now, which
 * signals fire. `hookHead` is the sha the commit-signal hook (or a git.commit
 * RPC) already reported for this session, so the same commit is not announced
 * twice.
 */
export function decideGitSignals(
  memory: SignalMemory,
  now: GitObservation,
  hookHead?: string,
): SignalVerdict {
  const head = now.head;
  const committed = !!head && head !== memory.lastHead && head !== hookHead;
  const atUpstream = !!head && now.upstream?.ahead === 0;
  const pushed = atUpstream && head !== memory.pushedHead;
  const next: SignalMemory = {
    ...(head ?? memory.lastHead ? { lastHead: head ?? memory.lastHead } : {}),
    ...((atUpstream ? head : memory.pushedHead) ? { pushedHead: atUpstream ? head : memory.pushedHead } : {}),
  };
  return { committed, pushed, next };
}

export class TurnGitSignals {
  /** runId -> memory. A promise so an idle that lands before the launch
   *  baseline resolved waits for it instead of treating the baseline as a
   *  commit; consecutive idles chain on it, so they never race each other. */
  private readonly runs = new Map<string, Promise<SignalMemory>>();
  /** sessionId -> the last sha already announced for it (by the hook, the
   *  git.commit RPC, or ourselves). */
  private readonly announced = new Map<string, string>();

  constructor(
    private readonly send: (message: AgentToCentral) => boolean,
    private readonly probe: GitProbe = execGitProbe,
  ) {}

  /** A run launched in `cwd`: remember where HEAD is now. */
  observe(runId: string, cwd: string): void {
    this.runs.set(
      runId,
      this.snapshot(cwd)
        .then(baselineMemory)
        .catch((): SignalMemory => ({})),
    );
  }

  forget(runId: string): void {
    this.runs.delete(runId);
  }

  forgetAll(): void {
    this.runs.clear();
  }

  /** Something else (the hook, the Git panel) already announced a commit in
   *  `cwd` for this session — record its sha so the next idle stays quiet. */
  noteExternalCommit(sessionId: string, cwd?: string): void {
    if (!sessionId || !cwd) return;
    void this.probe
      .head(cwd)
      .then((head) => {
        if (head) this.announced.set(sessionId, head);
      })
      .catch(() => {});
  }

  /** The run went idle: compare with the last observation and send what changed. */
  turnEnded(runId: string, sessionId: string, cwd: string): Promise<void> {
    const pending = this.runs.get(runId);
    if (!pending) return Promise.resolve();
    const next = pending.then((memory) => this.settle(memory, sessionId, cwd));
    this.runs.set(runId, next);
    return next.then(() => undefined);
  }

  /** Never throws: on any failure the memory is returned unchanged. */
  private async settle(memory: SignalMemory, sessionId: string, cwd: string): Promise<SignalMemory> {
    try {
      const now = await this.snapshot(cwd);
      const verdict = decideGitSignals(memory, now, this.announced.get(sessionId));
      if (verdict.committed && sessionId && now.head) {
        this.announced.set(sessionId, now.head);
        this.send({ type: 'session_committed', sessionId, cwd });
        console.log(`[agent] session_committed ${sessionId} (HEAD moved to ${now.head.slice(0, 8)})`);
      }
      if (verdict.pushed && now.upstream) {
        const url = await this.probe.remoteUrl(cwd, now.upstream.remote);
        const remoteHost = url ? parseRemoteHost(url) : undefined;
        if (remoteHost) {
          this.send({
            type: 'project_pushed',
            ...(sessionId ? { sessionId } : {}),
            cwd,
            remoteHost,
          });
          console.log(`[agent] project_pushed ${cwd} -> ${remoteHost}`);
        }
      }
      return verdict.next;
    } catch {
      return memory;
    }
  }

  private async snapshot(cwd: string): Promise<GitObservation> {
    const head = await this.probe.head(cwd);
    if (!head) return {};
    const upstream = await this.probe.upstream(cwd);
    return { head, ...(upstream ? { upstream } : {}) };
  }
}
