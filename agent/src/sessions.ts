import os from 'node:os';
import path from 'node:path';
import { isProbePrompt } from './probe-prompt.js';
import { readdir, readFile } from 'node:fs/promises';
import { listSessions } from '@anthropic-ai/claude-agent-sdk';
import type { SessionSummary } from '@cc-remote/shared';
import { scanCodexSessions } from './codex.js';
import { readFileHead } from './file-range.js';
import { claudeActivityMs } from './claude-activity.js';
import { sessionTitle } from './session-titles.js';
import { claudeTitleIsDerived } from './claude-title.js';
import { processStartToken, sameStartToken } from './proc-start.js';

/**
 * Session discovery for one machine.
 *
 * Inventory comes from the SDK's `listSessions()` (which reads
 * ~/.claude/projects/**\/*.jsonl — the only reliable index, since the VSCode
 * extension does not register sessions in history.jsonl). We overlay a
 * *liveness* layer from ~/.claude/sessions/<pid>.json so we know which
 * sessions are currently held by a live process (typically the VSCode
 * extension). A live session must NOT be resumed — two writers corrupt the
 * .jsonl.
 */

const SESSIONS_DIR = path.join(os.homedir(), '.claude', 'sessions');
const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const CWD_FALLBACK_POOL_SIZE = 12;

interface LiveSession {
  pid: number;
  sessionId: string;
  cwd?: string;
  version?: string;
  entrypoint?: string;
  /** `bg` for a native background session (`claude --bg`), see `HeadFacts.background`. */
  kind?: unknown;
  /** The CLI's own `busy`/`idle`, rewritten on every turn edge. */
  status?: unknown;
}

/**
 * One `~/.claude/sessions/<pid>.json` as it sits on disk — parsed, not yet
 * judged. Every field is `unknown` because the file is written by another
 * program and an older CLI omits half of them; the readers below decide what a
 * missing field means, each for its own question.
 */
export interface LivenessRecord {
  pid?: unknown;
  sessionId?: unknown;
  cwd?: unknown;
  version?: unknown;
  entrypoint?: unknown;
  startedAt?: unknown;
  status?: unknown;
  /**
   * The CLI's opaque fingerprint of its own process, written at registration:
   * `/proc/<pid>/stat` field 22 on Linux, `ps -o lstart=` on macOS. Absent on an
   * older CLI. See `sameProcess` for how it tells a writer from a reused pid.
   */
  procStart?: unknown;
}

/**
 * What a live session's process says it is doing, as the wire's `liveStatus`.
 *
 * The CLI rewrites `status` in its pid file on every turn edge: `busy` while a
 * turn runs, `waiting` while it is blocked on a person's answer (it then also
 * writes `waitingFor`), `idle` when the turn is over. A `livePid` alone only says a
 * writer is ATTACHED — an editor window or a Claude Desktop session left open
 * for days carries one just the same — so without this the web had to call
 * every held session «идёт работа». Anything else (an older CLI with no field,
 * a value we do not know) is left out rather than guessed: absent reads as «not
 * known to be working», which is the honest default for a bolt.
 */
export function liveStatusOf(status: unknown): 'busy' | 'waiting' | 'idle' | undefined {
  return status === 'busy' || status === 'waiting' || status === 'idle' ? status : undefined;
}

/**
 * The `CLAUDE_CODE_ENTRYPOINT` we stamp on every `claude` child we spawn.
 *
 * The SDK's default (`sdk-ts`) is what an IDE / CLI `/resume` picker treats as
 * *programmatic* and hides — so a session created from the web was written to
 * disk and then invisible in VS Code, even though its .jsonl sits in the very
 * same `~/.claude/projects/<cwd>/` as every other session. The filter rejects
 * exactly `sdk-cli|sdk-ts|sdk-py`, so any other value clears it: we stamp our
 * own name and teach the liveness guard below to recognise it.
 *
 * The guard's meaning is unchanged — it still exempts precisely "the child we
 * spawned ourselves". Only the token changed. Do NOT stamp `claude-vscode`:
 * that lies to telemetry and makes our own runs indistinguishable from a real
 * editor.
 */
export const OWN_ENTRYPOINT = 'cc-remote';

/** When THIS agent process started, ms since epoch. A child we spawned cannot
 *  have started before it. */
const AGENT_STARTED_AT = Date.now() - Math.round(process.uptime() * 1000);

/**
 * True for a liveness file written by a `claude` child WE spawned — the SDK
 * default (other agents, our own older builds) plus our own stamp. Anything
 * else is an EXTERNAL interactive writer (the editor `claude-vscode`, a
 * terminal `/resume`) that the single-writer guard must honour.
 *
 * "We" means THIS process. A child with our stamp that started before this
 * agent did was spawned by a previous incarnation — one that died without
 * taking its children (OOM, SIGKILL, a crash outside systemd's cgroup stop).
 * Such a child is still appending to its transcript, and skipping it here is
 * exactly how a resume opens a second writer into the same file. So the stamp
 * alone is not enough: the file's `startedAt` has to be after ours.
 */
export function isOwnChild(
  entrypoint: unknown,
  startedAt?: unknown,
  agentStartedAt: number = AGENT_STARTED_AT,
): boolean {
  if (typeof entrypoint !== 'string') return false;
  if (!(entrypoint.startsWith('sdk-') || entrypoint === OWN_ENTRYPOINT)) return false;
  // No `startedAt` (an older CLI) — keep the old reading; a guess in the
  // strict direction would make every resume yield against its own child.
  if (typeof startedAt !== 'number') return true;
  // A little slack for a child the SDK spawned a moment before our clock read.
  return startedAt >= agentStartedAt - 2_000;
}

/** True if a process with this pid currently exists (signal 0 probe). */
/**
 * A pid a liveness record may name. `kill(-1, sig)` is every process of the
 * user and `kill(0, sig)` is our own process group — a record saying `"pid":-1`
 * (any process of the user can write one; a model under injection can write a
 * file) must never reach `process.kill`, `isPidAlive` (which would say «alive»)
 * or a `/proc` read. 1 is init.
 */
export function isValidPid(pid: unknown): pid is number {
  return Number.isInteger(pid) && (pid as number) > 1;
}

export function isPidAlive(pid: number): boolean {
  if (!isValidPid(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH = no such process; EPERM = exists but not ours (still alive).
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** The two things `sameProcess` asks the OS; injectable so tests need no real processes. */
export interface ProcessProbe {
  /** `fresh` bypasses the macOS `ps` cache — used before concluding «reused». */
  token: (pid: number, options?: { fresh?: boolean }) => Promise<string | undefined>;
}

const OS_PROBE: ProcessProbe = {
  token: (pid, options) => processStartToken(pid, options),
};

export type SameProcessCheck = (record: LivenessRecord) => Promise<boolean>;

/**
 * Does the process now at `record.pid` still look like the one that wrote the
 * record? A pid is reused by the kernel; the file is not deleted when its
 * process dies, so `isPidAlive` alone reads a stranger as the session's writer —
 * the session then cannot be opened for as long as the number stays taken, and a
 * takeover would signal an innocent process.
 *
 * The decision, in order. «Cannot tell» always means yes — the old behaviour —
 * because the opposite mistake (a live editor judged a stranger) opens a second
 * writer, which is the worse of the two:
 *   1. the OS gives no start token for this pid (Windows, a read error, the
 *      process just exited) → same;
 *   2. the record has a `procStart` string → same iff it equals the OS token.
 *      That is the CLI's own comparison;
 *   3. otherwise → same. A record without `procStart` (an older CLI) carries
 *      only `startedAt`, a wall-clock stamp; comparing it with the OS's start
 *      time compares two clocks that can disagree (a stepped clock after a VM
 *      pause, WSL2 after the host slept) and the wrong answer there opens a
 *      second writer. No fingerprint in the record — no verdict.
 *
 * Pure of logging and of side effects; the readers below add the warning.
 */
export async function sameProcess(
  record: LivenessRecord,
  probe: ProcessProbe = OS_PROBE,
): Promise<boolean> {
  if (!isValidPid(record.pid)) return true;
  const token = await probe.token(record.pid);
  if (token === undefined) return true;
  if (typeof record.procStart === 'string' && record.procStart.trim() !== '') {
    if (sameStartToken(token, record.procStart)) return true;
    // A cached token (macOS keeps one per pid for a minute) can belong to the
    // PREVIOUS owner of a reused pid while the record is the new owner's — a
    // live editor judged a stranger is the mistake that opens a second writer.
    // Only a fresh read may say «reused».
    const fresh = await probe.token(record.pid, { fresh: true });
    if (fresh === undefined) return true;
    return sameStartToken(fresh, record.procStart);
  }
  return true;
}

const warnedReusedPids = new Set<number>();

/**
 * `check(record)` plus the one log line a skipped record is owed: once per pid
 * per agent lifetime, so an inventory rebuilt every few seconds does not repeat
 * itself. A record that fails is treated like a dead pid by every caller.
 */
export async function stillSameProcess(
  record: LivenessRecord,
  check: SameProcessCheck = sameProcess,
): Promise<boolean> {
  if (await check(record)) return true;
  const pid = record.pid;
  if (typeof pid === 'number' && !warnedReusedPids.has(pid)) {
    warnedReusedPids.add(pid);
    const session = typeof record.sessionId === 'string' ? record.sessionId : '?';
    console.warn(
      `[agent] liveness record for pid ${pid} belongs to another process now (session ${session}) — ignored`,
    );
  }
  return false;
}

/**
 * Read the liveness directory, telling "there is nothing here" apart from
 * "I could not look".
 *
 * They are not the same answer and treating them as one is fail-open on the
 * invariant this whole file exists for: an unreadable directory (permissions, a
 * descriptor ceiling, a mount gone) came back as «no live writer», and a resume
 * read that as permission to start a second one. ENOENT is the honest empty
 * case — the CLI has simply never written a liveness file here.
 */
async function readSessionDir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

/**
 * Every parseable `~/.claude/sessions/<pid>.json`, with no liveness or
 * ownership judgement applied. Two readers ask different questions of the same
 * directory — «who holds this session» (below) and «which of my own children
 * outlived me» (`orphans.ts`) — and they must read the same files the same
 * way, so the walk lives here once.
 *
 * Unreadable/partial files are skipped, but an unreadable DIRECTORY still
 * throws: see `readSessionDir` for why that distinction is load-bearing.
 */
export async function readLivenessRecords(dir: string = SESSIONS_DIR): Promise<LivenessRecord[]> {
  const out: LivenessRecord[] = [];
  for (const file of await readSessionDir(dir)) {
    if (!file.endsWith('.json')) continue;
    try {
      const raw = await readFile(path.join(dir, file), 'utf8');
      const data = JSON.parse(raw) as LivenessRecord;
      if (data && typeof data === 'object') out.push(data);
    } catch {
      // skip unreadable/partial files
    }
  }
  return out;
}

/** Test seams of the two liveness readers; production passes nothing. */
export interface LivenessReadOptions {
  /** The directory of `<pid>.json` records. Defaults to `~/.claude/sessions`. */
  dir?: string;
  /** Replaces the OS-backed `sameProcess` check. */
  sameProcess?: SameProcessCheck;
}

/**
 * Read ~/.claude/sessions/*.json and return live sessions keyed by sessionId.
 * Each file is named <pid>.json and is written by the CLI/extension for a
 * running session.
 */
export async function readLiveSessions(
  options: LivenessReadOptions = {},
): Promise<Map<string, LiveSession>> {
  const live = new Map<string, LiveSession>();
  for (const record of await readLivenessRecords(options.dir)) {
    const data = record as LiveSession & { startedAt?: unknown };
    if (!isValidPid(data.pid) || typeof data.sessionId !== 'string') continue;
    if (!isPidAlive(data.pid)) continue;
    // Skip the children we spawned ourselves (`sdk-*` or OWN_ENTRYPOINT).
    // The `claude` child the Agent SDK spawns registers a sessions/<pid>.json
    // here too (contrary to an earlier assumption). The single-writer guard
    // exists to avoid colliding with an EXTERNAL interactive writer (the
    // editor `claude-vscode`, or a terminal `/resume`), never with our own
    // child. Without this, a resumed run sees its own child's liveness file
    // and yields against itself ("session opened in sdk-ts"). A child from a
    // PREVIOUS agent process is not ours, though — see `isOwnChild`.
    if (isOwnChild(data.entrypoint, data.startedAt)) continue;
    // A pid that is alive may belong to someone else by now — checked only for
    // records that are not our own children, which are never probed.
    if (!(await stillSameProcess(record, options.sameProcess))) continue;
    live.set(data.sessionId, data);
  }
  return live;
}

/**
 * Find the live process currently holding a session — the external writer a
 * force-takeover must displace (typically the VS Code extension,
 * `entrypoint: claude-vscode`). Returns the first pid-alive liveness entry for
 * `sessionId`. Our own children (`isOwnChild`) are skipped — never kill those.
 *
 * A child of a PREVIOUS agent process is deliberately NOT skipped. It is the
 * other thing this returns: an orphan we can no longer talk to (its stdin/
 * stdout belonged to the process that died), still appending to the transcript,
 * and the only sanctioned way to get the session back is exactly the one a
 * live editor gets — force-takeover kills it and confirms death. `startedAt`
 * rides along so the caller can say WHICH of the two it found.
 */
export async function findLivePidForSession(
  sessionId: string,
  options: LivenessReadOptions = {},
): Promise<{ pid: number; entrypoint?: string; startedAt?: number; procStart?: string } | undefined> {
  for (const record of await readLivenessRecords(options.dir)) {
    const data = record as LiveSession & { startedAt?: unknown };
    if (data.sessionId !== sessionId || !isValidPid(data.pid)) continue;
    if (isOwnChild(data.entrypoint, data.startedAt)) continue;
    if (!isPidAlive(data.pid)) continue;
    if (!(await stillSameProcess(record, options.sameProcess))) continue;
    // So a caller that goes on to signal this pid can re-check, before each
    // signal, that it is still the process the record named (`terminatePid`).
    // A record from an older CLI carries no token: capture the OS's own now,
    // so the kill is guarded against a reuse between this lookup and the signal.
    const procStart =
      typeof record.procStart === 'string' && record.procStart.trim() !== ''
        ? record.procStart
        : await processStartToken(data.pid, { fresh: true });
    return {
      pid: data.pid,
      entrypoint: data.entrypoint,
      startedAt: numberOr(data.startedAt),
      ...(procStart !== undefined ? { procStart } : {}),
    };
  }
  return undefined;
}

function numberOr(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function projectLabel(cwd: string | undefined): string | undefined {
  if (!cwd) return undefined;
  // cwd may be a Windows path even when read on another OS; handle both seps.
  const cleaned = cwd.replace(/[\\/]+$/, '');
  const seg = cleaned.split(/[\\/]/).pop();
  return seg || undefined;
}

export interface InventoryOptions {
  /** Limit number of sessions (most-recent first). */
  limit?: number;
  /**
   * Include SDK/headless/daemon sessions. Defaults to false to mirror the
   * IDE/terminal `/resume` picker (only interactive sessions).
   */
  includeProgrammatic?: boolean;
  /**
   * Include Codex's throwaway rollouts — `codex exec` one-shots and threads the
   * model spawned for itself (`isEphemeralRollout`). Off by default: they are a
   * third of the rows on a working machine and nobody navigates to them.
   *
   * Deliberately NOT folded into `includeProgrammatic`, which the daemon sets
   * true so that phone/web-created sessions stay visible — that flag is about
   * who STARTED a session, this one is about whether it is a session at all.
   */
  includeEphemeral?: boolean;
}

/**
 * Recover a Claude session's cwd when the SDK's `listSessions()` returns none
 * (its head record lacks one). A cwd-less session can't be placed inside any
 * shared project root, so the hub hides it from a member — including from its
 * own owner. Scan the transcript head (bounded, OOM-safe) for the first record
 * that carries a cwd. Returns undefined if the session file or a cwd is absent.
 * The head is generous (early records can be large — e.g. a first turn with an
 * inlined image/SVG — pushing the first cwd-bearing record past a few hundred KB)
 * but capped, so a giant transcript is never read in full.
 */
async function listClaudeProjectDirs(): Promise<string[]> {
  try {
    return (await readdir(CLAUDE_PROJECTS_DIR, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
}

/**
 * True when a transcript head belongs to a SUB-AGENT thread (`isSidechain:
 * true` on its records), not a human-driven session. The SDK's `listSessions()`
 * indexes those files like any other, which is how "sessions" nobody ever
 * opened flood the inventory whenever a run fans out Task agents.
 *
 * Exported for tests.
 */
export function headIndicatesSidechain(head: string): boolean {
  for (const line of head.split('\n')) {
    if (!line) continue;
    try {
      const o = JSON.parse(line) as { isSidechain?: unknown };
      return o.isSidechain === true;
    } catch {
      /* partial/non-JSON line — keep looking */
    }
  }
  return false;
}

/** What the head of a transcript tells us about a session. Both facts are
 *  set-once, so verdicts are cached forever and steady-state scans re-read
 *  nothing. */
interface HeadFacts {
  sidechain: boolean;
  /** Who started it: `cli`, `claude-vscode`, `sdk-cli` (headless `claude -p`,
   *  i.e. cron and scripts), or `cc-remote` for our own resumes. The live
   *  session file only has this while a process holds the session, so a
   *  finished cron run would otherwise be indistinguishable from a person's. */
  entrypoint?: string;
  /** Records carry `sessionKind: "bg"`: a native background session
   *  (`claude --bg`). Its entrypoint is a plain `cli`, so without this the
   *  sessions another agent dispatches (Codex's `claude` skill runs
   *  `dispatch.py start` → `claude --bg`) sit in the lists as a person's work.
   *  Nobody types into one — it is started with its whole task in argv. */
  background?: boolean;
}

const headCache = new Map<string, HeadFacts>();

/** sessionId → the transcript file last judged for it. A guess, not a fact:
 *  the same id can sit in two project dirs (a session resumed from another
 *  folder), so `claudeSessionActivity` re-checks it against the SDK's mtime. */
const transcriptPaths = new Map<string, string>();

/**
 * A Claude session's `lastModified`: its last real message, not the last
 * bookkeeping record the CLI appended (`claude-activity.ts`). `mtimeMs` is the
 * SDK's number for the session's file; the copy whose mtime is that number is
 * the one judged. No such copy (it was written since, or vanished): `mtimeMs`
 * itself, and the next walk judges again.
 */
export async function claudeSessionActivity(sessionId: string, mtimeMs: number, dirs?: string[]): Promise<number> {
  const known = transcriptPaths.get(sessionId);
  if (known) {
    const activity = await claudeActivityMs(known, mtimeMs);
    if (activity !== undefined) return activity;
  }
  for (const d of dirs ?? (await listClaudeProjectDirs())) {
    const file = path.join(CLAUDE_PROJECTS_DIR, d, `${sessionId}.jsonl`);
    if (file === known) continue;
    const activity = await claudeActivityMs(file, mtimeMs);
    if (activity === undefined) continue;
    transcriptPaths.set(sessionId, file);
    return activity;
  }
  return mtimeMs;
}

function headEntrypoint(head: string): string | undefined {
  for (const line of head.split('\n')) {
    if (!line) continue;
    try {
      const o = JSON.parse(line) as { entrypoint?: unknown };
      if (typeof o.entrypoint === 'string' && o.entrypoint) return o.entrypoint;
    } catch {
      /* partial/non-JSON line — skip */
    }
  }
  return undefined;
}

export function headIsBackground(head: string): boolean {
  for (const line of head.split('\n')) {
    if (!line) continue;
    try {
      const o = JSON.parse(line) as { sessionKind?: unknown; entrypoint?: unknown };
      if (typeof o.entrypoint === 'string' && o.entrypoint) return o.sessionKind === 'bg';
    } catch {
      /* partial/non-JSON line — skip */
    }
  }
  return false;
}

/** What almost every transcript settles in. */
const HEAD_PROBE_BYTES = 64 * 1024;
/** The furthest a first record's end was seen on a real machine is 1.1 MB. */
const HEAD_PROBE_MAX_BYTES = 2 * 1024 * 1024;

function headFacts(head: string): HeadFacts {
  return {
    sidechain: headIndicatesSidechain(head),
    entrypoint: headEntrypoint(head),
    ...(headIsBackground(head) ? { background: true } : {}),
  };
}

/**
 * `entrypoint` sits at the END of the first conversation record, and the CLI
 * writes a `claude -p` prompt twice before it (`queue-operation`, then that
 * record). A cron prompt of 32 KB cuts the record at 64 KB, the cut line does
 * not parse, and the run reads as a person's session in every list (04.11.2026:
 * hegai.media's tech specialist, 123 cron runs on stage). So a head that has
 * not said who started it gets one longer read. A verdict is cached, so this
 * costs once per such session.
 */
export async function readHeadFacts(file: string): Promise<HeadFacts> {
  const facts = headFacts(await readFileHead(file, HEAD_PROBE_BYTES));
  if (facts.entrypoint !== undefined) return facts;
  return headFacts(await readFileHead(file, HEAD_PROBE_MAX_BYTES));
}

async function probeHead(sessionId: string, dirs: string[], young = false): Promise<HeadFacts> {
  const cached = headCache.get(sessionId);
  if (cached !== undefined) return cached;
  let facts: HeadFacts = { sidechain: false };
  for (const d of dirs) {
    const file = path.join(CLAUDE_PROJECTS_DIR, d, `${sessionId}.jsonl`);
    try {
      facts = await readHeadFacts(file);
    } catch {
      continue; // not in this project dir
    }
    transcriptPaths.set(sessionId, file);
    break;
  }
  // A young head with no conversation record yet (only title/mode bookkeeping,
  // the first milliseconds of a run) has not said who started it — judge again
  // on the next walk instead of caching «a person's session» forever. Old heads
  // without an entrypoint (older CLIs) are cached as before: re-reading them
  // every walk is the cost the cache exists to avoid.
  if (!young || facts.entrypoint !== undefined || facts.sidechain) headCache.set(sessionId, facts);
  return facts;
}

async function claudeCwdFallback(sessionId: string, dirs: string[]): Promise<string | undefined> {
  for (const d of dirs) {
    const file = path.join(CLAUDE_PROJECTS_DIR, d, `${sessionId}.jsonl`);
    let head: string;
    try {
      head = await readFileHead(file, 2 * 1024 * 1024);
    } catch {
      continue; // not in this project dir
    }
    for (const line of head.split('\n')) {
      if (!line) continue;
      try {
        const o = JSON.parse(line) as { cwd?: unknown };
        if (typeof o.cwd === 'string' && o.cwd) return o.cwd;
      } catch {
        /* partial/non-JSON line — skip */
      }
    }
    return undefined; // file located, but no cwd within the head
  }
  return undefined;
}

/** Build the merged inventory for this machine (Claude Code + Codex sessions). */
export async function buildInventory(opts: InventoryOptions = {}): Promise<SessionSummary[]> {
  const [sdkSessions, live, codex, claudeProjectDirs] = await Promise.all([
    listSessions({
      includeProgrammatic: opts.includeProgrammatic ?? false,
      // The SDK cuts by raw mtime; the cut below is by activity. Twice the
      // window keeps sessions a burst of exit bookkeeping (a restart ending a
      // few dozen idle runs) pushed past the raw cut.
      limit: opts.limit === undefined ? undefined : opts.limit * 2,
    }),
    readLiveSessions(),
    scanCodexSessions(opts.limit, opts.includeEphemeral ?? false),
    listClaudeProjectDirs(),
  ]);

  const claude: SessionSummary[] = [];
  // Head reads are bounded to a small pool so a large inventory cannot fan out
  // thousands of open/stat calls at once. The sidechain probe pays one head
  // read per NEW session (verdicts are set-once and cached), the cwd fallback
  // only fires for cwd-less records.
  for (let i = 0; i < sdkSessions.length; i += CWD_FALLBACK_POOL_SIZE) {
    const batch = await Promise.all(
      sdkSessions.slice(i, i + CWD_FALLBACK_POOL_SIZE).map(async (s): Promise<SessionSummary | null> => {
      // Sub-agent transcripts are working material of their parent session,
      // not sessions anyone drives — keep them out of the inventory. (Next
      // build: attach them UNDER the parent instead — see REFACTORING.md
      // «Subagent sessions».)
      const facts = await probeHead(s.sessionId, claudeProjectDirs, Date.now() - s.lastModified < 10 * 60_000);
      if (facts.sidechain) return null;
      const liveHit = live.get(s.sessionId);
      const cwd = s.cwd ?? (await claudeCwdFallback(s.sessionId, claudeProjectDirs));
      const activity = await claudeSessionActivity(s.sessionId, s.lastModified, claudeProjectDirs);
      const derived =
        !sessionTitle(s.sessionId) &&
        (await claudeTitleIsDerived(s.customTitle, transcriptPaths.get(s.sessionId), s.lastModified));
      return {
        sessionId: s.sessionId,
        title: sessionTitleOf(s),
        ...(derived ? { titleDerived: true } : {}),
        source: 'claude',
        cwd,
        project: projectLabel(cwd),
        gitBranch: s.gitBranch,
        lastModified: activity,
        ...(activity !== s.lastModified ? { fileMtime: s.lastModified } : {}),
        createdAt: s.createdAt,
        // Live file first (it is current), transcript second (it survives the
        // process). Without the fallback a finished headless run reports no
        // entrypoint at all, and the fleet cannot tell a cron loop's 72
        // sessions a day from work a person did.
        entrypoint: liveHit?.entrypoint ?? facts.entrypoint,
        ...(isProbePrompt(s.firstPrompt) || facts.background || liveHit?.kind === 'bg' ? { automated: true } : {}),
        cliVersion: liveHit?.version,
        livePid: liveHit?.pid,
        liveStatus: liveHit ? liveStatusOf(liveHit.status) : undefined,
      };
      }),
    );
    for (const s of batch) if (s) claude.push(s);
  }

  // A Codex rollout re-derives its title from the first user message on every
  // parse, so a rename has nowhere to live in the file itself — the agent keeps
  // it (see session-titles.ts) and it is applied here, at the one place the
  // inventory is built. A Claude title needs no overlay: the SDK wrote it into
  // the transcript and `listSessions()` already returned it as `customTitle`.
  const titled = codex.map((s) => {
    const custom = sessionTitle(s.sessionId);
    return custom ? { ...s, title: custom } : { ...s, titleDerived: true };
  });

  const merged = [...claude, ...titled].sort((a, b) => b.lastModified - a.lastModified);
  return typeof opts.limit === 'number' ? merged.slice(0, opts.limit) : merged;
}

const CYRILLIC = /[А-Яа-яЁё]/;
const TITLE_MAX = 80;

/** A first prompt as a title: its first CLAUSE, at most TITLE_MAX characters.
 *
 *  The SDK hands `firstPrompt` over already flattened (newlines → spaces) and
 *  cut to 200, so «the first line» does not exist here. The first clause —
 *  up to the first `.` `?` `!` `:` `;` — is what a person would call the
 *  question; and it stops a title before «вот конфиг: <pasted token>», since a
 *  title travels further than the transcript (push notifications, the board,
 *  every client's cache). The cut never splits a surrogate pair: a lone
 *  surrogate makes the inventory frame unparseable for the hub (serde_json),
 *  which drops the whole frame silently. */
export function promptTitle(prompt: string): string {
  const flat = prompt.replace(/\s+/g, ' ').trim();
  const clause = (flat.split(/(?<=[^.?!:;]{3,})[.?!:;](?:\s|$)/)[0] ?? flat).trim();
  const q = /[?]/.test(flat.slice(clause.length, clause.length + 1)) ? '?' : '';
  const text = clause + q;
  if (text.length <= TITLE_MAX) return text;
  let cut = text.slice(0, TITLE_MAX);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  const space = cut.lastIndexOf(' ');
  return `${(space > TITLE_MAX / 2 ? cut.slice(0, space) : cut).replace(/[\s,.;:—-]+$/, '')}…`;
}

/**
 * The title a Claude session is listed under.
 *
 * A rename (`customTitle`) always wins. Otherwise Claude Code's own `summary` —
 * which it writes in English whatever language the conversation is in, so a
 * Russian team's panel read «Session response times and timeout check» over
 * work that was asked for in Russian (27.09.2026, by request: one language).
 * When the summary has no Cyrillic but the person's first message does, the
 * person's own words are the title instead. A summary already in Russian, or
 * an English conversation, keeps the summary.
 */
export function sessionTitleOf(s: {
  sessionId: string;
  customTitle?: string;
  summary?: string;
  firstPrompt?: string;
}): string {
  if (s.customTitle) return s.customTitle;
  const prompt = s.firstPrompt?.trim() ? promptTitle(s.firstPrompt) : '';
  if (s.summary && !CYRILLIC.test(s.summary) && prompt && CYRILLIC.test(prompt)) return prompt;
  return s.summary || prompt || s.firstPrompt || s.sessionId;
}
