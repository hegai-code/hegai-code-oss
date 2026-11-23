import os from 'node:os';
import { AGENT_EPOCH, e2ee, e2eeOpener, setE2eeMachineId } from './e2ee.js';
import { addSyncProject, chatOnlyRefusal, policy, syncsCwd, withinRetention } from './policy.js';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readFile, rm, mkdir } from 'node:fs/promises';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { confinePrefix, unitsRoot, unitsWatchIgnored } from './confine.js';
import { WebSocket } from 'ws';
import chokidar, { type FSWatcher } from 'chokidar';
import {
  decodeCentralToAgent,
  RpcParams,
  RpcResultSchemas,
  type AgentToCentral,
  type CentralToAgent,
  type BuilderProfile,
  type HistoryMessage,
  type MemoryEntry,
  type MemoryScope,
  type RuntimeStatus,
  type SessionSummary,
  type UsageInfo,
} from '@cc-remote/shared';

import { availablePermissionModes, bypassAllowed } from './claude-session.js';
import { availableCodexPermissionModes, codexBypassAllowed } from './codex-run.js';
import { getSessionInfo } from '@anthropic-ai/claude-agent-sdk';
import { buildInventory, claudeSessionActivity } from './sessions.js';
import { reportOrphanedChildren } from './orphans.js';
import { codexRolloutMtime } from './codex.js';
import { TranscriptReplicator, replicaCursor } from './transcript-replicator.js';
import { loadConfig, persistDeviceToken, AGENT_VERSION, type AgentConfig } from './config.js';
import { dispatchRpc, setRuntimeModels, setLiveCwdProvider, setInventoryProvider, setSyncHost, setSubagentStopper } from './rpc-dispatch.js';
import { setSessionCwdProvider } from './fs-roots.js';
import { sweepTrash } from './trash.js';
import { TerminalManager } from './terminal.js';
import { MirrorManager } from './mirror.js';
import { ClaudeUsageMonitor } from './claude-usage-monitor.js';
import { sampleMachineStats } from './machine-stats.js';
import { fetchCodexUsage, sweepCodexTmp } from './codex-usage.js';
import { claudeDisabled } from './runtimes-allowed.js';
import { claudeRuntimeStatus, codexRuntimeStatus, describeClaude, describeCodex, readCodexGatewayConnection } from './runtime-status.js';
import { fetchGatewayLimits } from './gateway-limits.js';
import { isExternal } from './edition.js';
import { setRuntimeChangedHook } from './runtime-jobs.js';
import { setCodexProviderDeps } from './codex-provider.js';
import { computeProfile } from './profile.js';
import { syncBundledSkills, installedSkills } from './skills-sync.js';
import { ensureTranscriptRetention } from './transcript-retention.js';
import {
  appendIndexEntry,
  INDEX_FILE,
  memoryDirFor,
  overwriteMemory,
  projectKeyFor,
  quarantineMemory,
  readLocalMemories,
  readSyncState,
  serialJobRunner,
  sha256Hex,
  syncStateKey,
  writeMemoryIfAbsent,
  writeSyncState,
} from './memory.js';
import { RunManager } from './run-manager.js';
import { PartialCoalescer } from './partial-coalescer.js';
import { ContextCache } from './context-cache.js';
import { SessionOrigins } from './session-origins.js';
import { BUILT_IN_POLICY, SelfUpdater, runningBundle, selfUpdateAllowedFor, selfUpdateEnabled, updateBase } from './self-update.js';
import { sweepRunState } from './run-state.js';
import { hubCandidates, httpBaseOf } from './hub-url.js';
import { redactMessages, redactOutgoing, redactionEnabled } from './redact.js';

const REDACT = redactionEnabled();

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
/** Where the connection code is written while the agent waits for approval,
 *  so an installer (or a person) can read it without grepping the log. */
const LINK_FILE = path.join(os.homedir(), '.cc-remote', 'link.json');

/** Floor between memory reconciles. Notes change on a human timescale, not a
 *  file-watcher one. */
const MEMORY_RECONCILE_MS = 60_000;

/**
 * Memory sync is OFF unless a machine opts in.
 *
 * Memory is keyed on the owning user, but a fleet where every box belongs to
 * one owner gets no isolation from that: notes written on a shared or employee
 * sandbox would travel to the owner's own machines under the same git remote,
 * and back. Poisoned or simply wrong notes then arrive as trusted context on a
 * box that never produced them. Opting in per machine keeps that a decision
 * someone makes about a specific host, not a side effect of shipping a bundle.
 */
const MEMORY_SYNC_ENABLED = /^(1|true|yes|on)$/i.test(process.env['CC_REMOTE_MEMORY_SYNC'] ?? '');
const SESSIONS_DIR = path.join(os.homedir(), '.claude', 'sessions');
const CODEX_SESSIONS_DIR = path.join(process.env['CODEX_HOME'] ?? path.join(os.homedir(), '.codex'), 'sessions');
/** Confined runs keep rollouts below ~/.codex-units/<unit>/sessions (confine.ts). */
const CODEX_UNITS_DIR = unitsRoot();
// Drop dir for the on-machine commit-signal hook. It writes one small JSON marker
// per real commit ({sessionId, cwd, ts}); the agent watches this dir, emits
// `session_committed`, and deletes the marker. No inbound port — the hook and the
// agent share the filesystem.
const COMMITS_DIR = path.join(os.homedir(), '.cc-remote', 'commits');
// Coalesce watcher-driven inventory pushes. Kept high because a machine with
// many live sessions (e.g. ~18 in VSCode) rewrites ~/.claude constantly; a full
// inventory frame per change floods (and over a multi-hop tunnel, resets) the
// connection. Manual `rescan` bypasses this and pushes immediately, so takeover
// stays responsive.
const INVENTORY_DEBOUNCE_MS = 5000;
/**
 * The fast lane, for the ONE event that must not wait out the debounce above:
 * a new pid file in `~/.claude/sessions`, i.e. an editor just opened a session.
 *
 * The inventory watcher cannot see that promptly by construction. It waits for
 * `awaitWriteFinish` (800ms of quiet) on the transcript, and a session that is
 * actively streaming never goes quiet — so a session started in VS Code showed
 * up in the web only after its first turn ENDED, then plus five seconds, then
 * plus a full corpus walk. A pid file is small, atomic and written at start, so
 * `add` on it is the earliest honest signal that a session exists.
 */
const INVENTORY_FAST_MS = 750;
/** Pause between a turn's `result` and stat-ing its transcript (`publishTurnEnd`). */
const TURN_END_SETTLE_MS = 300;
// WS keepalive: send a protocol-level ping this often. Idle agent connections
// carry no application traffic, so any NAT / cloud load-balancer on the route
// silently reaps the TCP flow after its idle timeout (we observed an exact
// ~10-min cadence on remote VPSs, faster on home-NAT'd machines). A ping well
// under those timeouts keeps every hop warm; nginx relays ping/pong frames
// transparently once upgraded, and the hub answers Ping explicitly.
// Halved from 25s: the keepalive interval now also bounds how long a writer can
// outlive the hub's view of it (see WRITER_DEADLINE_MS), so detection has to fit
// inside the hub's run lease with room to spare.
const KEEPALIVE_MS = 10_000;
// Consecutive unanswered pings before we declare the link dead. ONE missed pong
// used to be enough, which tore down every run on the machine 52 times in a
// single log. The hub was almost certainly answering all of them: this process
// also does heavy synchronous transcript work (profile scans walk the whole
// corpus), and an event loop blocked past the interval can't run the `pong`
// callback in time — so a "missed" pong is more often our own stall than a dead
// link. Tolerating a few makes the check measure the link instead of our jitter.
const KEEPALIVE_MAX_MISSES = 3;
// How long live runs are HELD while the hub is unreachable, measured from the
// last moment we KNOW the link was alive (a pong, or any frame from the hub).
//
// This used to be 45s and was described as half of a single-writer lease: the
// hub frees a session's lock 60s after it saw the link die, so our writer had
// to be dead by then or "the hub could hand the session to a second writer".
// That reasoning was wrong about who could be handed the session. A session
// lives on ONE machine; every `open` for it is routed to this agent and to
// nobody else, and the hub refuses an `open` for a machine with no socket. When
// we reconnect, `register` declares our live runs BEFORE any command can reach
// us, and the hub adopts them — rebuilding the lock — or orders closed the ones
// it cannot. There is no moment at which a second writer can start, with or
// without a deadline. What the deadline actually did was kill every live run
// in the fleet whenever the hub was away for longer than 45s: on 2026-09-19 a
// deploy returned 502 from 08:00:07 to ~08:01:10, this agent closed six runs at
// 08:00:44, and reconnected at 08:01:10 — after its own backoff had grown to
// 30s. Six sessions «ended by themselves» for a restart that was almost over.
//
// So the hold is long, and only a safety net against a hub that is never
// coming back: a subprocess nobody can reach any more should not sit there
// for a day. Thirty minutes is longer than any deploy and shorter than a
// person's patience. The keepalive still bounds how quickly a half-open link
// is noticed (KEEPALIVE_MS * KEEPALIVE_MAX_MISSES); it no longer has to fit
// inside anything.
export const WRITER_DEADLINE_MS = 30 * 60_000;

/**
 * How long the runs may still be held, given when the link was last proven
 * alive. Exported so the test can state the property: a hub outage shorter
 * than the hold costs no run, whatever way the link died.
 */
export function writerGraceLeft(lastAliveAt: number, now: number): number {
  return Math.max(0, WRITER_DEADLINE_MS - (now - lastAliveAt));
}

/**
 * Reconnect backoff ceilings. With live runs on the box a reconnect must not
 * dawdle: the hub adopts our runs the moment we register, and every second of
 * backoff is a second the person's session looks dead. Without runs, nothing
 * is waiting on us and hammering a hub that is down helps nobody.
 */
const RECONNECT_MAX_MS = 30_000;
const RECONNECT_MAX_WITH_RUNS_MS = 5_000;
// Poll the account's Claude usage/limits this often. Anthropic rate-limits the
// usage endpoint per-token, so keep this well above the ~180s floor.
const USAGE_POLL_MS = 180_000;
// Hardware/process telemetry cadence. One sample is a few /proc reads plus one
// `ps`/`df` exec — cheap enough for a shared production box at this rate.
const STATS_POLL_MS = 30_000;
// How often to report each live run's context budget. Fast enough that the
// indicator tracks a working session, slow enough that it costs nothing: the
// CLI answers from state it already holds.
const CONTEXT_POLL_MS = 15_000;
// Recompute the local builder profile this often. It scans the whole transcript
// corpus (hundreds of MB), so keep it rare; the result barely changes hour to
// hour. First compute is deferred so it never competes with connect/startup.
const PROFILE_POLL_MS = 6 * 60 * 60_000;
/** How often expired entries leave the agent's trash. */
const TRASH_SWEEP_MS = 12 * 60 * 60_000;
const PROFILE_INITIAL_DELAY_MS = 30_000;

/**
 * The agent daemon: dials out to the central service, registers, keeps the
 * session inventory fresh, and serves resume/input/interrupt/close/tool
 * commands by driving ClaudeSessionRun instances.
 */
/** Folders this machine has sessions in, with counts — what `sync.list`
 *  offers to pick from. Paths only: no title leaves for a folder not chosen. */
function syncCandidates(all: SessionSummary[]): { cwd: string; sessions: number }[] {
  const counts = new Map<string, number>();
  for (const s of all) if (s.cwd) counts.set(s.cwd, (counts.get(s.cwd) ?? 0) + 1);
  return [...counts].map(([cwd, sessions]) => ({ cwd, sessions })).sort((a, b) => b.sessions - a.sessions);
}

/** What a turn-end publish moves: the sort key, and the cursor when they differ. */
interface TurnEndStamp {
  lastModified: number;
  fileMtime?: number;
}

function stamped(s: SessionSummary, stamp: TurnEndStamp): SessionSummary {
  const { fileMtime: _previous, ...rest } = s;
  return stamp.fileMtime === undefined || stamp.fileMtime === stamp.lastModified
    ? { ...rest, lastModified: stamp.lastModified }
    : { ...rest, lastModified: stamp.lastModified, fileMtime: stamp.fileMtime };
}

/** A Claude session's inventory numbers right now — see `publishTurnEnd`. */
async function claudeTurnEnd(sessionId: string, cwd: string): Promise<TurnEndStamp | undefined> {
  const mtime = (await getSessionInfo(sessionId, { dir: cwd }).catch(() => undefined))?.lastModified;
  if (mtime === undefined) return undefined;
  const activity = await claudeSessionActivity(sessionId, mtime).catch(() => mtime);
  return { lastModified: activity, fileMtime: mtime };
}

export class AgentClient {
  private readonly cfg: AgentConfig;
  private ws?: WebSocket;
  private watcher?: FSWatcher;
  private yieldWatcher?: FSWatcher;
  private commitWatcher?: FSWatcher;
  private watcherRestartTimer?: NodeJS.Timeout;
  private inventoryTimer?: NodeJS.Timeout;
  /** When the pending `inventoryTimer` fires, so a sooner request can preempt it. */
  private inventoryDueAt = 0;
  /** A build is walking the corpus right now (see `pushInventory`). */
  private inventoryInFlight = false;
  /** A trigger arrived mid-build and is owed exactly one run afterwards. */
  private inventoryQueued = false;
  private yieldTimer?: NodeJS.Timeout;
  private keepaliveTimer?: NodeJS.Timeout;
  private usageTimer?: NodeJS.Timeout;
  private readonly claudeUsageMonitor = new ClaudeUsageMonitor();
  private statsTimer?: NodeJS.Timeout;
  private contextTimer?: NodeJS.Timeout;
  private contextPollInFlight = false;
  /** What each run's context was when we last told the hub — see `pollContext`. */
  private readonly sentContext = new ContextCache();
  /** Every outbound message passes this: adjacent text deltas of a run become
   *  one `partial` frame, the rest go through in order (partial-coalescer.ts). */
  private readonly partials = new PartialCoalescer((msg) => this.sendRaw(msg));
  /** Models this runtime reports, learned from the first run that can answer.
   *  Beats the built-in list, which went a generation stale unnoticed. */
  private runtimeModels?: { id: string; name?: string }[];
  private profileTimer?: NodeJS.Timeout;
  private trashTimer?: NodeJS.Timeout;
  private lastProfile?: BuilderProfile;
  private missedPongs = 0;
  /** Last moment the link was PROVEN alive — a pong, or any frame the hub sent.
   *  The anchor the writer deadline is measured from (see WRITER_DEADLINE_MS). */
  private lastAliveAt = Date.now();
  /** Reminted every start, so the hub can tell "same daemon reconnecting" from
   *  "daemon restarted" — machineId is durable config and cannot. */
  private readonly agentInstanceId = randomUUID();
  /** Skill slash-commands this machine can run, resolved once at start() after
   *  the bundled ones are installed. Re-read on nothing: a skill appearing
   *  mid-run cannot be invoked by an already-open session anyway, and a rescan
   *  per reconnect would stat the whole directory on every network hiccup. */
  private skills: string[] = [];
  /** What this machine's Claude and Codex ARE (runtime-status.ts). Read once
   *  before the first register, refreshed with every usage poll, sent again
   *  only when it changes. */
  private runtimes?: RuntimeStatus;
  private runGraceTimer?: NodeJS.Timeout;
  private reconnectDelay = 1000;
  /** Every address that reaches the hub (hub-url.ts): the configured one and
   *  the relay's spare doors. `hubIdx` is the door in use; a handshake that
   *  never completes moves it along, a door that opens keeps it. */
  private hubUrls: string[] = [];
  private hubIdx = 0;
  /** Failed device-enrollment exchanges, for the backoff in `enrollAndConnect`. */
  private enrollAttempts = 0;
  private closing = false;

  private readonly runManager: RunManager;
  private readonly terminals = new TerminalManager();
  private selfUpdater?: SelfUpdater;
  /** Set by main: exit so the supervisor starts the freshly installed bundle. */
  onRestartForUpdate?: () => void;
  private readonly mirrors = new MirrorManager();
  /** The hub's offline copy of every listed transcript (transcript-replicator.ts). */
  private readonly replicator = new TranscriptReplicator({
    send: (msg) => this.send(msg),
    connected: () => this.ws?.readyState === WebSocket.OPEN,
    uplinkBackedUp: () => this.uplinkBackedUp,
    inventory: () => this.latestInventory,
  });
  /** What the hub holds, as of the last `memory_catalog`. */
  private memoryCatalog: MemoryEntry[] = [];
  /** Every read-modify-write of the memory sync state runs through this, one at
   *  a time: the hub delivers in batches of 100 and each batch used to read the
   *  file, wait on disk, and write it back over its siblings. */
  private readonly runMemoryJob = serialJobRunner();
  /** projectKey -> a local cwd resolving to it, so a delivered memory knows
   *  which directory to land in. Rebuilt on every reconcile. */
  private memoryProjects = new Map<string, string>();
  /** cwd -> git-remote identity. Cached because resolving it shells out to git
   *  and one inventory can carry dozens of distinct working directories. */
  private readonly projectKeys = new Map<string, string>();
  private lastMemoryReconcile = 0;
  private latestInventory: SessionSummary[] = [];
  /** Every session on disk, before the owner's sync choice (policy.ts) is
   *  applied. Never sent: it only answers «which folders could I pick» and
   *  «which sessions must the hub forget». */
  private fullInventory: SessionSummary[] = [];
  /** `complete` of the last inventory frame sent, so a re-send of the same
   *  list (`publishTurnEnd`) claims exactly what that frame claimed. */
  private lastInventoryComplete = false;
  /** mtimes `publishTurnEnd` published ahead of the corpus walk, by session id.
   *  A walk that started before the turn ended carries the OLDER mtime; letting
   *  it through would tell the hub its stale replica is current again. */
  private readonly turnEndMtimes = new Map<string, TurnEndStamp>();
  private readonly sessionOrigins = new SessionOrigins(path.join(os.homedir(), '.cc-remote', 'session-origins.json'));

  constructor(cfg = loadConfig()) {
    this.cfg = cfg;
    setE2eeMachineId(cfg.machineId);
    this.runManager = new RunManager({
      recordSessionOrigin: (runId, sessionId) => {
        this.sessionOrigins.record(runId, sessionId);
        this.send({ type: 'session_origin', runId, sessionId });
      },
      send: (message) => this.send(message),
      refreshInventory: () => void this.pushInventory(),
      scheduleInventory: () => this.scheduleInventory(),
      turnEnded: (sessionId) => void this.publishTurnEnd(sessionId),
    });
    // `projects.remove` must not move a directory one of our runs is working in.
    setLiveCwdProvider(() => this.runManager.activeCwds());
    setSubagentStopper((sessionId, id) => this.runManager.stopSubagent(sessionId, id));
    setCodexProviderDeps({
      codexBusy: () => this.runManager.hasBusyCodexRun(),
      closeIdleCodexRuns: () => this.runManager.closeIdleCodexRuns(),
    });
    // `projects.list` reads the inventory we already hold instead of rebuilding
    // it from disk — the rebuild is what made the call miss the browser's RPC
    // deadline on a machine with thousands of transcripts.
    setInventoryProvider(() => this.latestInventory);
    // `sync.list` / `sync.set` (policy.ts): the folders a person can pick come
    // from EVERY session on disk; a change re-sends the inventory at once, which
    // is also what tells the hub what to forget.
    setSyncHost({
      candidates: () => syncCandidates(this.fullInventory),
      sessionSynced: (id, source, cwd) => this.sessionSynced(id, source, cwd),
      changed: () => this.scheduleInventory(INVENTORY_FAST_MS),
    });
    // The file RPCs only open a machine's project roots. The inventory is where
    // the agent learns which directories those are, and it is already refreshed
    // on every debounced watcher event — so this costs nothing and never goes
    // stale.
    setSessionCwdProvider(() =>
      this.latestInventory
        .map((s) => s.cwd)
        .filter((c): c is string => typeof c === 'string' && c.length > 0),
    );
  }

  async start(): Promise<void> {
    // Identity files of runs from a previous agent process mean nothing (once, at boot).
    sweepRunState();
    console.log(
      `[agent] ${this.cfg.name} (${this.cfg.machineId}) -> ${this.cfg.centralUrl}`,
    );
    // Before anything dials out: put the bundled skills on disk and learn what
    // this machine can run, so the very first `register` carries the truth. A
    // session category is only meaningful where its skill exists.
    syncBundledSkills();
    this.skills = installedSkills();
    // Claude Code deletes transcripts older than 30 days by default, and a
    // session whose file is gone can never be resumed. See transcript-retention.ts.
    ensureTranscriptRetention();
    // Children of a previous incarnation are still running and still writing.
    // We cannot resume them, so this only names them — but naming them is the
    // half that was missing: the hub already learns the session is taken from
    // the `livePid` the first inventory carries (see orphans.ts).
    void reportOrphanedChildren();
    // Likewise the runtimes: file reads and one `codex --version`, so the first
    // register says «Codex · Plus · ilya@…» or «Codex не найден» rather than
    // nothing. The line goes to agent.log too — the answer to «why» must exist
    // on the machine, not only on the hub.
    this.runtimes = await this.readRuntimes();
    // A login or install that just finished must show on the machine card now,
    // not at the next three-minute poll — the person is looking at the button.
    setRuntimeChangedHook(() => void this.pollUsage());
    if (this.cfg.enrollmentCode && !this.cfg.deviceToken) void this.enrollAndConnect();
    else if (this.cfg.linkMode) void this.linkAndConnect();
    else this.connect();
    this.startWatcher();
    this.startTrashSweep();
    this.startSelfUpdate();
  }

  /** See self-update.ts. Off for a source run and for `CC_REMOTE_AUTO_UPDATE=0`. */
  private startSelfUpdate(): void {
    const bundle = runningBundle();
    if (!selfUpdateEnabled(bundle)) return;
    // Without a signature the hub vouches for the bundle it serves, and a new
    // agent need not read policy.json at all — so on a chat-only machine the
    // hub does not get to replace the agent. The owner updates it by running
    // the installer again (FAQ, ONBOARDING). Security review 28.09.2026.
    if (policy().chatOnly) {
      console.log('[agent] self-update off: chat-only machine — re-run the installer to update');
      return;
    }
    // A private machine holds the content key on its disk. The internal
    // edition's updater trusts whatever bundle the hub serves, and a bundle can
    // read `e2ee.key` - so there the hub does not get to replace the agent. Only
    // the external edition, whose updater verifies a release signature the hub
    // cannot forge, may update itself (docs/E2EE.md, threat model).
    if (!selfUpdateAllowedFor(e2eeOpener() !== null, BUILT_IN_POLICY.external)) {
      console.log('[agent] self-update off: this machine holds a content key (private or was) on the internal edition - the hub is not trusted to replace the agent; re-run the installer to update');
      return;
    }
    // The base is read per check, not once: the door that opened may not be
    // the configured one, and a machine that can only reach `:8443` must be
    // able to update itself through it.
    this.selfUpdater = new SelfUpdater(() => updateBase(this.currentHub()), {
      isQuiet: () => this.runManager.isQuiet() && this.terminals.count === 0,
      restartForUpdate: () => void this.restartForUpdate(),
    }, bundle, undefined, { running: AGENT_VERSION, keyed: () => e2eeOpener() !== null });
    void this.selfUpdater.start();
  }

  /**
   * The new bundle is on disk: end every (idle) run with a proper `ended` so the
   * hub releases its lock at once instead of waiting out a lease, tell the
   * people in them why, and leave. The supervisor starts the new file.
   */
  private async restartForUpdate(): Promise<void> {
    const notice = 'Агент этой машины обновился и перезапускается. Сессия продолжится со следующего сообщения.';
    this.runManager.announceShutdown(notice);
    // Every run is ended now (the hub releases its lock on that); the exit
    // waits — bounded by the kill escalation — for the processes behind them
    // to be confirmed gone, so `writer_released` leaves on this socket and no
    // app-server outlives the agent that owned it.
    await this.runManager.endAllAndAwaitExit();
    this.stop(notice);
    this.onRestartForUpdate?.();
  }

  /**
   * Age things out of the agent's trash.
   *
   * Nothing swept it before, and nothing had to: it only ever held whole
   * projects, deleted rarely and deliberately. The file manager makes deleting
   * an everyday action, and an unswept trash is then just a slow disk-full bug
   * with a delay measured in months.
   */
  private startTrashSweep(): void {
    const run = (): void => {
      void sweepTrash()
        .then((n) => {
          if (n) console.log(`[agent] trash: removed ${n} expired entr${n === 1 ? 'y' : 'ies'}`);
        })
        .catch(() => {
          /* housekeeping must never take the agent down */
        });
    };
    run();
    this.trashTimer = setInterval(run, TRASH_SWEEP_MS);
    this.trashTimer.unref?.();
  }

  private async enrollAndConnect(): Promise<void> {
    try {
      const base = httpBaseOf(this.currentHub());
      const response = await fetch(`${base}/api/enrollments/exchange`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          code: this.cfg.enrollmentCode,
          machine: {
            machineId: this.cfg.machineId,
            name: this.cfg.name,
            os: this.cfg.os,
            agentVersion: AGENT_VERSION,
          },
        }),
        signal: AbortSignal.timeout(12_000),
      });
      const body = await response.json() as { deviceToken?: string; error?: string };
      if (!response.ok || !body.deviceToken) throw new Error(body.error ?? `enrollment failed (${response.status})`);
      this.cfg.deviceToken = body.deviceToken;
      this.cfg.token = body.deviceToken;
      persistDeviceToken(this.cfg, body.deviceToken);
      console.log('[agent] device enrollment complete; credential saved');
      this.connect();
    } catch (error) {
      // Back off instead of hammering. A code that is invalid or expired never
      // becomes valid — the provisioner is what fixes that, by writing a fresh
      // code and restarting this unit — so a flat 10 s retry was six pointless
      // requests a minute, forever, filling the journal and the hub's log. A
      // transient failure (hub restarting, network gone) still recovers,
      // because the delay is capped rather than final.
      this.enrollAttempts += 1;
      const delay = Math.min(10_000 * 2 ** (this.enrollAttempts - 1), 300_000);
      console.error(
        `[agent] enrollment failed: ${(error as Error).message} — retrying in ${Math.round(delay / 1000)}s`,
      );
      // A hub that could not be reached at all is the one case the next door
      // might fix; a refused code is not, and rotating would only add noise.
      if (/fetch failed|ECONNRE|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|timeout/i.test((error as Error).message)) this.nextHub();
      if (!this.closing) setTimeout(() => void this.enrollAndConnect(), delay).unref?.();
    }
  }

  /**
   * No credential and no code: ask the hub for a code INSTEAD, show it, and
   * wait for a signed-in person to approve it on `/link` (hub:
   * `request_enrollment`). The direction every remote-control tool uses —
   * the machine says «open this», the person confirms where they are already
   * logged in — and the one that removes the 15-minute code carried from a
   * website into a terminal, and «ran it on the wrong machine» with it.
   *
   * The code is printed to the log (the installer tails it) and written to
   * `~/.cc-remote/link.json` for anything that wants to show it. A denied or
   * expired request is followed by a fresh one after a pause; the agent never
   * gives up, because the person may simply be slow.
   */
  private async linkAndConnect(): Promise<void> {
    const base = httpBaseOf(this.currentHub());
    let request: { userCode: string; pollToken: string; verifyUrl?: string; expiresAt?: number; interval?: number };
    try {
      const response = await fetch(`${base}/api/enrollments/request`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          machine: { machineId: this.cfg.machineId, name: this.cfg.name, os: this.cfg.os, agentVersion: AGENT_VERSION },
        }),
        signal: AbortSignal.timeout(12_000),
      });
      const body = (await response.json()) as typeof request & { error?: string };
      if (!response.ok || !body.userCode || !body.pollToken) throw new Error(body.error ?? `request failed (${response.status})`);
      request = body;
    } catch (error) {
      const msg = (error as Error).message;
      console.error(`[agent] could not ask the hub for a connection code: ${msg} — retrying in 30s`);
      if (/fetch failed|ECONNRE|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|timeout/i.test(msg)) this.nextHub();
      if (!this.closing) setTimeout(() => void this.linkAndConnect(), 30_000).unref?.();
      return;
    }
    const verifyUrl = request.verifyUrl ?? `${base}/link?c=${encodeURIComponent(request.userCode)}`;
    const minutes = request.expiresAt ? Math.max(1, Math.round((request.expiresAt - Date.now()) / 60_000)) : 10;
    console.log('[agent] ┌─ Подключите этот компьютер ──────────────────────────────');
    console.log(`[agent] │ Откройте  ${verifyUrl}`);
    console.log(`[agent] │ или введите код  ${request.userCode}  на ${base}/link`);
    console.log(`[agent] └─ код действует ${minutes} мин, машина «${this.cfg.name}»`);
    try {
      mkdirSync(path.dirname(LINK_FILE), { recursive: true });
      writeFileSync(LINK_FILE, JSON.stringify({ userCode: request.userCode, verifyUrl, expiresAt: request.expiresAt ?? null, name: this.cfg.name }, null, 2));
    } catch {
      /* the log line is the primary channel */
    }
    const interval = Math.max(2, Math.min(30, request.interval ?? 3)) * 1000;
    const poll = async (): Promise<void> => {
      if (this.closing) return;
      let status: { status: string; deviceToken?: string; error?: string };
      try {
        const response = await fetch(`${base}/api/enrollments/poll`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ pollToken: request.pollToken }),
          signal: AbortSignal.timeout(12_000),
        });
        status = (await response.json()) as typeof status;
        if (response.status === 429) status = { status: 'slow_down' };
      } catch (error) {
        console.error(`[agent] link poll failed: ${(error as Error).message}`);
        setTimeout(() => void poll(), interval * 3).unref?.();
        return;
      }
      switch (status.status) {
        case 'approved': {
          if (!status.deviceToken) break;
          this.cfg.deviceToken = status.deviceToken;
          this.cfg.token = status.deviceToken;
          this.cfg.linkMode = false;
          persistDeviceToken(this.cfg, status.deviceToken);
          try {
            rmSync(LINK_FILE, { force: true });
          } catch {
            /* nothing to clear */
          }
          console.log('[agent] ✅ подключено — код подтверждён, credential saved');
          this.connect();
          return;
        }
        case 'pending':
          setTimeout(() => void poll(), interval).unref?.();
          return;
        case 'slow_down':
          setTimeout(() => void poll(), interval * 2).unref?.();
          return;
        case 'denied':
          console.warn('[agent] запрос отклонён на сайте — новый код через 60 с');
          setTimeout(() => void this.linkAndConnect(), 60_000).unref?.();
          return;
        default:
          // expired, used, unknown: the request is gone; ask for another.
          console.warn(`[agent] код больше не действует (${status.status}) — запрашиваю новый`);
          setTimeout(() => void this.linkAndConnect(), 5_000).unref?.();
          return;
      }
      setTimeout(() => void poll(), interval).unref?.();
    };
    setTimeout(() => void poll(), interval).unref?.();
  }

  // ----------------------------------------------------------- connection
  /** The hub address in use — `CENTRAL_URL`, or the spare door that opened. */
  private currentHub(): string {
    if (!this.hubUrls.length) this.hubUrls = hubCandidates(this.cfg.centralUrl);
    return this.hubUrls[this.hubIdx] ?? this.cfg.centralUrl;
  }

  /** Try the next door on the next attempt. Wraps around: the first one may
   *  simply have been down for a moment. */
  private nextHub(): void {
    if (!this.hubUrls.length) this.hubUrls = hubCandidates(this.cfg.centralUrl);
    if (this.hubUrls.length < 2) return;
    const from = this.currentHub();
    this.hubIdx = (this.hubIdx + 1) % this.hubUrls.length;
    console.warn(`[agent] ${from} did not open — next attempt via ${this.currentHub()}`);
  }

  private connect(): void {
    const hub = this.currentHub();
    const url = `${hub}/agent?token=${encodeURIComponent(this.cfg.token)}`;
    // handshakeTimeout is essential: without it a reconnect whose TCP connect
    // black-holes (no open/error/close — e.g. after a hub restart or a network
    // path change) hangs forever and the agent wedges offline. With it, a stalled
    // connect emits `error` → onDisconnect → retry with backoff.
    const ws = new WebSocket(url, { handshakeTimeout: 12_000 });
    this.ws = ws;
    let opened = false;

    ws.on('open', () => {
      opened = true;
      console.log(hub === this.cfg.centralUrl ? '[agent] connected' : `[agent] connected via ${hub}`);
      this.reconnectDelay = 1000;
      // A completed handshake proves the link. Not the same as the hub agreeing
      // to track our runs — that is `register_ack`, and the grace below keeps
      // running until it arrives — but it does re-anchor the writer deadline, so
      // a reconnect that then waits on a slow hub is not fenced for the time it
      // already spent getting here.
      this.lastAliveAt = Date.now();
      // A new connection starts from nothing: no text buffered for the old
      // one, and the hub knows no run's context yet — the first poll resends all.
      this.partials.clear();
      this.sentContext.clear();
      // The grace deliberately keeps running here. A live TCP socket is not a
      // hub that agreed to track our runs — after a hub restart it holds no run
      // and no lock for them, and standing down now would leave our subprocesses
      // writing transcripts nothing is guarding. `register_ack` is the signal.
      // Private machine: a run's folder is a path, so it is not declared (the
      // hub adopts the run without one; the folder is read from the inventory).
      const liveRuns = this.runManager
        .liveRuns()
        .map((r) => (e2ee() ? ({ runId: r.runId, sessionId: r.sessionId } as typeof r) : r));
      if (liveRuns.length) {
        console.log(`[agent] reclaiming ${liveRuns.length} run(s) after reconnect`);
      }
      this.send({
        type: 'register',
        protocol: 1,
        machine: {
          machineId: this.cfg.machineId,
          name: this.cfg.name,
          os: this.cfg.os,
          agentVersion: AGENT_VERSION,
          hostname: os.hostname(),
          skills: this.skills,
          permissionModes: availablePermissionModes(),
          // Answered separately because one box runs both runtimes and the
          // Claude gate reasons about a hook the Codex path does not have.
          codexPermissionModes: availableCodexPermissionModes(codexBypassAllowed() && bypassAllowed()),
          gatewaySessions: true,
          codexProviderSwitch: true,
          // Private machine: the hub treats this machine as content-blind.
          // From e2ee() (read once), not policy(): the flag and the sealing must agree.
          ...(e2ee() ? { private: true as const } : {}),
          // Whenever a key is held: clients bind what they seal to this process.
          ...(e2eeOpener() ? { e2eEpoch: AGENT_EPOCH } : {}),
          policy: {
            chatOnly: policy().chatOnly,
            sync: policy().sync === 'all' ? 'all' : 'selected',
            // The hub enforces it (hub/retention.rs) but never sets it.
            ...(policy().transcriptRetentionDays !== undefined
              ? { transcriptRetentionDays: policy().transcriptRetentionDays }
              : {}),
          },
        },
        agentInstanceId: this.agentInstanceId,
        approvalTimeoutMs: this.runManager.approvalTimeout,
        ...(liveRuns.length ? { liveRuns } : {}),
        ...(this.runtimes ? { runtimes: this.runtimes } : {}),
      });
      void this.pushInventory();
      this.startKeepalive(ws);
      // Usage waits for register_ack: the first API call must already respect
      // the device owner's monitoring pause, including after reconnect.
      this.startStats();
      this.startContext();
      this.startProfile();
    });

    ws.on('message', (data: Buffer) => {
      // A frame from the hub proves the link at least as well as a pong does,
      // and on a busy agent it arrives far more often — which keeps the writer
      // deadline's anchor fresh and the reconnect budget at its full length.
      this.lastAliveAt = Date.now();
      this.onMessage(data.toString());
    });
    ws.on('pong', () => {
      this.missedPongs = 0;
      this.lastAliveAt = Date.now();
    });
    ws.on('close', (code) => {
      // Closed before the handshake completed: this door is shut (TLS reset by
      // a middlebox, a black-holed connect, a 5xx from a relay). A door that
      // opened and later dropped is a hub restart or a network blip, and the
      // same door is the right one to knock on again.
      if (!opened && code !== 1000) this.nextHub();
      this.onDisconnect();
    });
    ws.on('error', (err) => {
      console.error('[agent] ws error:', (err as Error).message);
    });
  }

  /**
   * Keep the uplink warm and detect a half-open link. Every KEEPALIVE_MS we send
   * a ping; only after KEEPALIVE_MAX_MISSES consecutive unanswered pings do we
   * call the link dead and terminate to reconnect. Tolerating a single miss
   * matters because terminating is destructive: it drops every run on this
   * machine, so a lost frame must not cost the user a coding session.
   */
  private startKeepalive(ws: WebSocket): void {
    this.stopKeepalive();
    this.missedPongs = 0;
    this.keepaliveTimer = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (this.missedPongs >= KEEPALIVE_MAX_MISSES) {
        console.warn(
          `[agent] keepalive: ${this.missedPongs} pings unanswered — terminating to reconnect`,
        );
        ws.terminate();
        return;
      }
      this.missedPongs += 1;
      try {
        ws.ping();
      } catch {
        ws.terminate();
      }
    }, KEEPALIVE_MS);
    this.keepaliveTimer.unref?.();
  }

  private stopKeepalive(): void {
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = undefined;
    }
    this.missedPongs = 0;
  }

  /**
   * Report this account's Claude usage/limits to the hub: once on connect, then
   * every USAGE_POLL_MS. Best-effort — fetchUsage() returns null (and we send
   * nothing) whenever the creds file is absent or the endpoint declines.
   */
  private startUsage(claudeUsageEnabled = true): void {
    this.stopUsage();
    if (claudeDisabled()) {
      // Claude is off here: never ask Anthropic, and clear whatever reading the
      // hub still holds for this machine (a usage without limits is skipped).
      this.claudeUsageMonitor.configure(false);
      console.log('[agent] Claude disabled on this machine (CC_REMOTE_DISABLE_CLAUDE): no usage polling');
      this.send({ type: 'usage', usage: { updatedAt: Date.now() } });
    } else {
      this.claudeUsageMonitor.configure(claudeUsageEnabled);
      console.log(`[agent] Claude background monitoring: ${claudeUsageEnabled ? 'enabled' : 'paused by hub'} (sessions remain available)`);
    }
    void this.pollUsage();
    this.usageTimer = setInterval(() => void this.pollUsage(), USAGE_POLL_MS);
    this.usageTimer.unref?.();
  }

  private stopUsage(): void {
    this.claudeUsageMonitor.stop();
    if (this.usageTimer) {
      clearInterval(this.usageTimer);
      this.usageTimer = undefined;
    }
  }

  /** Presence, login and provider of both runtimes — cheap file reads plus a
   *  cached `codex --version`. Logged so `agent.log` can answer «why». */
  private async readRuntimes(): Promise<RuntimeStatus> {
    const [claude, codex] = await Promise.all([claudeRuntimeStatus(), codexRuntimeStatus()]);
    console.log(`[agent] ${describeClaude(claude)}`);
    console.log(`[agent] ${describeCodex(codex)}`);
    return { claude, codex };
  }

  /** Same reading minus the timestamps — «changed» means a fact changed. */
  private static runtimesKey(r: RuntimeStatus | undefined): string {
    if (!r) return '';
    const strip = (s?: Record<string, unknown>) => (s ? { ...s, checkedAt: 0 } : undefined);
    return JSON.stringify({ claude: strip(r.claude), codex: strip(r.codex) });
  }

  private async pollUsage(): Promise<void> {
    // Usage first: its HTTP status is evidence for the Claude verdict (a 401
    // on a token that should be valid = a dead login, not «no data»).
    const [{ usage, http }, codex] = await Promise.all([this.claudeUsageMonitor.poll(), codexRuntimeStatus()]);
    const claude = await claudeRuntimeStatus(http ? { usageHttp: http.status, ...(http.tokenExpiresAt !== undefined ? { usageTokenExpiresAt: http.tokenExpiresAt } : {}) } : {});
    if (usage) this.send({ type: 'usage', usage });

    // Codex limits come from the machine's own login. A Codex routed through a
    // gateway spends the gateway's allowance, not this account's — so its
    // personal limits are not asked for, and any the hub still holds from an
    // earlier poll are cleared with an empty reading (clients skip a usage
    // with no limits; the hub stores whatever it is given).
    let next: RuntimeStatus = { claude, codex };
    if (codex.present && codex.provider === 'own') {
      const probe = await fetchCodexUsage();
      // The probe's app-server dies before its plugin sync cleans up — see
      // sweepCodexTmp. Swept here, after every probe, so the leak and its
      // cleanup run at the same cadence. The first sweep clears the backlog.
      void sweepCodexTmp().then((n) => {
        if (n > 20) console.log(`[agent] codex: removed ${n} stale .tmp/git-* clones`);
      });
      if (probe.usage) {
        // `account/read` does not always name the account (buildbox-pc, codex
        // 0.154 on Windows: limits and plan came back, the email did not). The
        // login file knows, and the limits section is headed by whoever it
        // names — so a reading without one borrows it from the status.
        const usage = !probe.usage.account && codex.account ? { ...probe.usage, account: codex.account } : probe.usage;
        this.send({ type: 'codex_usage', usage });
      }
      next = {
        claude,
        codex: {
          ...codex,
          ...(probe.account?.email ? { account: probe.account.email } : {}),
          ...(probe.account?.plan ? { plan: probe.account.plan } : {}),
          ...(probe.error ? { error: probe.error } : {}),
          ...(probe.detail ? { detail: probe.detail.slice(0, 300) } : {}),
          // The server's word beats the file's: an auth.json that is there but
          // refused is «нет входа», not «chatgpt».
          ...(probe.error === 'not_logged_in' ? { auth: 'none' } : {}),
        },
      };
    } else if (codex.present) {
      // [external edition] A key on our gateway: its account's windows come from
      // the gateway itself, because a customer's hub has no gateway config to
      // ask. Our own hub serves the same numbers over /api/gateway-quota, so the
      // internal agent keeps sending an empty reading (else the native apps,
      // which add that quota separately, would show it twice).
      let gw: UsageInfo | null = null;
      if (codex.provider === 'gateway' && isExternal()) {
        const conn = await readCodexGatewayConnection();
        gw = await fetchGatewayLimits(conn.baseUrl, conn.bearer);
      }
      this.send({ type: 'codex_usage', usage: gw ?? { updatedAt: Date.now() } });
    }

    if (AgentClient.runtimesKey(next) !== AgentClient.runtimesKey(this.runtimes)) {
      this.runtimes = next;
      console.log(`[agent] ${describeClaude(next.claude!)}`);
      console.log(`[agent] ${describeCodex(next.codex!)}`);
      this.send({ type: 'runtime_status', runtimes: next });
    }
  }

  /** Hardware/process telemetry: once on connect, then every STATS_POLL_MS. */
  private startStats(): void {
    this.stopStats();
    void this.pollStats();
    this.statsTimer = setInterval(() => void this.pollStats(), STATS_POLL_MS);
    this.statsTimer.unref?.();
  }

  private stopStats(): void {
    if (this.statsTimer) {
      clearInterval(this.statsTimer);
      this.statsTimer = undefined;
    }
  }

  /**
   * Report each live run's context budget. Also the moment we learn the
   * runtime's real model list — the CLI can only answer that while a session is
   * up, so the first run that reports doubles as the source for `models.list`.
   */
  private startContext(): void {
    this.stopContext();
    this.contextTimer = setInterval(() => void this.pollContext(), CONTEXT_POLL_MS);
    this.contextTimer.unref?.();
    void this.pollContext();
  }

  private stopContext(): void {
    if (this.contextTimer) {
      clearInterval(this.contextTimer);
      this.contextTimer = undefined;
    }
  }

  private async pollContext(): Promise<void> {
    if (!this.runManager.activeCount) return;
    // One poll at a time. Each control request is bounded now, but a slow CLI
    // could still answer later than the next tick, and stacking polls on top of
    // each other is how a wedged run once queued a request per 15s forever.
    if (this.contextPollInFlight) return;
    this.contextPollInFlight = true;
    try {
      const readings = await this.runManager.contextUsage();
      // Changes only; the cache dies with the connection (open / disconnect).
      this.sentContext.prune(readings.map((r) => r.runId));
      for (const { runId, sessionId, usage } of readings) {
        this.sentContext.sendIfChanged(
          {
            type: 'context_usage',
            runId,
            sessionId,
            totalTokens: usage.totalTokens,
            maxTokens: usage.maxTokens,
            percentage: usage.percentage,
            ...(usage.autoCompactThreshold === undefined
              ? {}
              : { autoCompactThreshold: usage.autoCompactThreshold }),
            autoCompactEnabled: usage.autoCompactEnabled,
          },
          (frame) => this.send(frame),
        );
      }
      if (!this.runtimeModels) {
        const models = await this.runManager.supportedModels();
        if (models?.length) {
          this.runtimeModels = models;
          setRuntimeModels(models);
          console.log(`[agent] runtime reports ${models.length} model(s): ${models.map((m) => m.id).join(', ')}`);
        }
      }
    } catch (err) {
      console.error('[agent] context poll error:', (err as Error).message);
    } finally {
      this.contextPollInFlight = false;
    }
  }

  private async pollStats(): Promise<void> {
    // Rides the stats tick rather than bringing a fifth timer: it is the only
    // poll with no "skip when there is nothing to say" guard, and the case this
    // exists for is precisely the one where we have NOTHING to report — a hub
    // holding a run we do not. A heartbeat that goes quiet when the list is
    // empty would never deliver the empty list. Sent before the await so a slow
    // `sampleMachineStats` cannot delay or swallow the reconciliation.
    this.send({ type: 'run_inventory', runIds: this.runManager.heldRunIds() });
    try {
      this.send({ type: 'machine_stats', stats: await sampleMachineStats() });
    } catch (err) {
      console.error('[agent] stats error:', (err as Error).message);
    }
  }

  /**
   * Report this machine's locally-computed builder profile. Unlike usage, the
   * interval is anchored to process start (not per-connect) so reconnect flaps
   * never trigger a fresh multi-hundred-MB scan: on each (re)connect we just
   * re-send the cached profile, and the periodic timer keeps running across
   * disconnects. All computation is local — nothing but the reduced numbers
   * leaves the machine.
   */
  private startProfile(): void {
    if (this.lastProfile) this.send({ type: 'builder_profile', profile: this.lastProfile });
    if (this.profileTimer) return; // interval already running (survives reconnects)
    setTimeout(() => void this.pollProfile(), PROFILE_INITIAL_DELAY_MS).unref?.();
    this.profileTimer = setInterval(() => void this.pollProfile(), PROFILE_POLL_MS);
    this.profileTimer.unref?.();
  }

  private async pollProfile(): Promise<void> {
    try {
      const profile = await computeProfile({ machine: this.cfg.name, machineId: this.cfg.machineId });
      this.lastProfile = profile;
      this.send({ type: 'builder_profile', profile });
    } catch (err) {
      console.error('[agent] profile error:', (err as Error).message);
    }
  }

  /**
   * Hold the runs until WRITER_DEADLINE_MS after the link was last known alive.
   * If it fires the hub has been unreachable for half an hour: nothing is
   * listening and nothing will be, so tear the subprocesses down rather than
   * keep them for nobody. See WRITER_DEADLINE_MS for why this is a safety net
   * and not a lease.
   */
  private startRunGrace(): void {
    if (this.runGraceTimer) return;
    if (!this.runManager.activeCount) return;
    const left = writerGraceLeft(this.lastAliveAt, Date.now());
    this.runGraceTimer = setTimeout(() => {
      this.runGraceTimer = undefined;
      const stranded = this.runManager.activeCount;
      if (!stranded) return;
      console.warn(`[agent] hub unreachable for ${Math.round(WRITER_DEADLINE_MS / 60_000)} min — closing ${stranded} stranded run(s)`);
      this.runManager.reset('Agent lost its connection before approval was answered.');
    }, left);
    this.runGraceTimer.unref?.();
    console.log(`[agent] holding ${this.runManager.activeCount} run(s) for up to ${Math.round(left / 1000)}s while reconnecting`);
  }

  /**
   * The hub answered our register and named the runs it is tracking. Close
   * everything it did NOT adopt — those hold no single-writer lock there, so
   * letting them keep appending is exactly the corruption the lock prevents —
   * then stand the hold down, because what remains is guarded again.
   */
  private onRegisterAck(adoptedRunIds: string[]): void {
    const adopted = new Set(adoptedRunIds);
    const orphans = this.runManager.liveRuns().filter((r) => !adopted.has(r.runId));
    for (const { runId } of orphans) {
      console.warn(`[agent] hub did not adopt run ${runId} — closing it`);
      this.runManager.end(runId, 'ended');
    }
    if (adopted.size) console.log(`[agent] hub adopted ${adopted.size} run(s)`);
    // The hub is tracking us now, which is the first moment a frame about a
    // carried run has somewhere to land. Two things it has to be told again:
    //
    // - the STATE of each run. Frames sent into a dead socket are dropped, so
    //   a turn that finished during the outage lost its `idle`, and the hub —
    //   which adopts a run as `working` — would show it busy for the rest of
    //   its life. Same for a tool approval raised while we were away: the
    //   prompt has to be re-issued or nobody can ever answer it.
    // - the SETTINGS. `updateSettings` is edge-triggered and the edge fell
    //   where the frame could not land, so without this the run stays
    //   nameless — model and effort blank on every client.
    this.runManager.announceState();
    for (const [runId, sessionId] of this.sessionOrigins.entries()) {
      this.send({ type: 'session_origin', runId, sessionId });
    }
    this.runManager.announceSettings();
    this.cancelRunGrace();
    // Every hub deploy restarts the hub, and every restart lands here — the
    // moment a freshly published bundle is worth looking for.
    this.selfUpdater?.onConnected();
  }

  private cancelRunGrace(): void {
    if (!this.runGraceTimer) return;
    clearTimeout(this.runGraceTimer);
    this.runGraceTimer = undefined;
  }

  private onDisconnect(): void {
    this.partials.clear();
    this.sentContext.clear();
    if (this.closing) return;
    this.stopKeepalive();
    this.stopUsage();
    this.stopStats();
    this.stopContext();
    // Runs are NOT torn down here. A dropped socket is usually a blip (we
    // reconnect in ~1s), and `reset()` force-kills the underlying CLI
    // subprocess — it used to destroy live coding work every time the link
    // flapped. Hold them to the writer deadline instead; `open` re-declares
    // them so the hub re-adopts, and only a grace that actually expires tears
    // them down. Terminals and mirrors have no such grace: each is bound to a
    // specific browser subscriber that the hub already dropped.
    //
    // Starts that have NOT launched yet are cancelled outright: only a running
    // subprocess is worth carrying, and letting a half-done resume launch after
    // the hub released its run would leave a writer with no lock behind it.
    this.runManager.cancelPendingStarts();
    this.startRunGrace();
    this.terminals.closeAll();
    this.mirrors.closeAll();
    this.replicator.onDisconnect();
    // Re-sent on register; a stale catalog would make the agent re-push files
    // the hub already has.
    this.memoryCatalog = [];
    // Cap the backoff by what is at stake. Observed 2026-09-19: a hub away for
    // ~60s had this agent's backoff at 30s, so it came back 25s after the hub
    // did — and had already closed its runs by then.
    const cap = this.runManager.activeCount ? RECONNECT_MAX_WITH_RUNS_MS : RECONNECT_MAX_MS;
    this.reconnectDelay = Math.min(this.reconnectDelay, cap);
    const delay = this.reconnectDelay + Math.floor(Math.random() * 500);
    console.log(`[agent] disconnected; reconnecting in ${delay}ms`);
    setTimeout(() => this.connect(), delay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, cap);
  }

  private send(msg: AgentToCentral): boolean {
    return this.partials.send(msg);
  }

  private sendRaw(msg: AgentToCentral): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    // Session content leaves with secrets masked (redact.ts) — here, at the
    // one door, so a new sender cannot forget it.
    const masked = REDACT ? redactOutgoing(msg) : msg;
    // Private machine: content is sealed at this same door (docs/E2EE.md); a
    // frame that would only leak metadata is dropped here too.
    const sealer = e2ee();
    if (sealer) {
      const sealed = sealer.sealOutgoing(masked as unknown as Record<string, unknown>);
      if (sealed === null) return true;
      this.ws.send(JSON.stringify(sealed));
      return true;
    }
    this.ws.send(JSON.stringify(masked));
    return true;
  }

  /**
   * Bytes already queued on the uplink past which we shed *regenerable* output
   * (terminal data). A multi-hop tunnel that stalls would otherwise let `ws`
   * buffer without bound — turning a stalled link into an OOM instead of a
   * reconnect. Control frames and stream/mirror data are never dropped here.
   */
  private static readonly WS_BACKPRESSURE_BYTES = 8 * 1024 * 1024;
  private get uplinkBackedUp(): boolean {
    return (this.ws?.bufferedAmount ?? 0) > AgentClient.WS_BACKPRESSURE_BYTES;
  }

  // -------------------------------------------------------------- inventory
  private startWatcher(): void {
    const confined = confinePrefix() !== undefined;
    if (confined) mkdirSync(CODEX_UNITS_DIR, { recursive: true, mode: 0o700 });
    this.watcher = chokidar.watch([PROJECTS_DIR, SESSIONS_DIR, CODEX_SESSIONS_DIR, ...(confined ? [CODEX_UNITS_DIR] : [])], {
      ignoreInitial: true,
      // Codex rollouts are nested YYYY/MM/DD below ~/.codex/sessions (and
      // <unit>/sessions/YYYY/MM/DD below ~/.codex-units).
      depth: confined ? 7 : 5,
      // Confined: the unit homes are model-writable. Never follow a symlink out
      // of them, and enter only <unit>/sessions (see unitsWatchIgnored). Left
      // unset otherwise: chokidar's own defaults, exactly as before.
      ...(confined ? { followSymlinks: false, ignored: unitsWatchIgnored() } : {}),
      awaitWriteFinish: { stabilityThreshold: 800, pollInterval: 200 },
    });
    const trigger = () => this.scheduleInventory();
    this.watcher.on('add', trigger).on('change', trigger).on('unlink', trigger);
    this.watcher.on('error', (err) => this.onWatcherError('inventory', err));

    // Second, undebounced watcher on the pid-file dir alone. The inventory
    // watcher waits 800ms for writes to settle, which stretches the reverse
    // single-writer yield; pid files are tiny and atomic, so react to them
    // immediately and keep the two-writer window as short as possible.
    this.yieldWatcher = chokidar.watch(SESSIONS_DIR, { ignoreInitial: true, depth: 1 });
    this.yieldWatcher.on('add', () => {
      this.scheduleYieldCheck();
      // A NEW pid file is a session being born — the fast lane exists for
      // exactly this (see INVENTORY_FAST_MS). `change` is deliberately not in
      // here: an existing session touching its own pid file tells the inventory
      // nothing it does not already know, and on a box with many live sessions
      // that would be a corpus walk per heartbeat.
      this.scheduleInventory(INVENTORY_FAST_MS);
    });
    this.yieldWatcher.on('change', () => this.scheduleYieldCheck());
    this.yieldWatcher.on('error', (err) => this.onWatcherError('yield', err));

    // Third watcher: commit markers dropped by the on-machine commit-signal hook.
    // mkdir first so chokidar has a dir to watch even on a fresh machine.
    void mkdir(COMMITS_DIR, { recursive: true }).catch(() => {});
    this.commitWatcher = chokidar.watch(COMMITS_DIR, { ignoreInitial: true, depth: 0 });
    this.commitWatcher.on('add', (p) => void this.onCommitMarker(p));
    this.commitWatcher.on('error', (err) => this.onWatcherError('commit', err));
  }

  /** A commit-signal marker appeared → emit `session_committed` and remove it. */
  private async onCommitMarker(file: string): Promise<void> {
    try {
      const raw = await readFile(file, 'utf8');
      const data = JSON.parse(raw) as { sessionId?: unknown; cwd?: unknown };
      if (typeof data.sessionId === 'string' && data.sessionId) {
        const cwd = typeof data.cwd === 'string' ? data.cwd : undefined;
        this.send({ type: 'session_committed', sessionId: data.sessionId, cwd });
        // The turn-end observer would otherwise announce this same commit again.
        this.runManager.noteExternalCommit(data.sessionId, cwd);
        console.log(`[agent] session_committed ${data.sessionId} (commit marker)`);
      }
    } catch {
      /* malformed / partially-written marker — ignore */
    } finally {
      await rm(file, { force: true }).catch(() => {});
    }
  }

  /**
   * A dead watcher silently disables both inventory refresh and the yield
   * safety guard, so don't just log — tear both down and rebuild after a
   * pause (bounded to one rebuild per RESTART_MS to avoid an error loop).
   */
  private onWatcherError(which: string, err: unknown): void {
    console.error(`[agent] ${which} watcher error:`, (err as Error).message ?? err);
    if (this.watcherRestartTimer) return;
    this.watcherRestartTimer = setTimeout(() => {
      this.watcherRestartTimer = undefined;
      void this.watcher?.close();
      void this.yieldWatcher?.close();
      void this.commitWatcher?.close();
      this.startWatcher();
      console.log('[agent] watchers restarted after error');
    }, AgentClient.WATCHER_RESTART_MS);
    this.watcherRestartTimer.unref?.();
  }

  private static readonly WATCHER_RESTART_MS = 30_000;

  /**
   * Reverse single-writer guard: if a session we are actively running gets
   * opened in an editor (a live ~/.claude/sessions/<pid>.json appears for it),
   * yield — stop our run so we never write the same .jsonl as the editor.
   * Safe because `readLiveSessions()` excludes our own entrypoints (the `claude`
   * child the SDK spawns DOES register a sessions/<pid>.json — see `isOwnChild`
   * in sessions.ts), so any hit here is an external interactive writer, never
   * our own run.
   */
  private scheduleYieldCheck(): void {
    if (this.yieldTimer || this.runManager.activeCount === 0) return;
    this.yieldTimer = setTimeout(() => {
      this.yieldTimer = undefined;
      void this.runManager.checkYields();
    }, 400);
  }

  /**
   * Coalesce an inventory push. A caller may ask for a SOONER one than the
   * pending timer — a new session must not wait out a debounce sized for
   * transcript churn — and the earliest request wins; a later one never pushes
   * the deadline out.
   */
  private scheduleInventory(delayMs: number = INVENTORY_DEBOUNCE_MS): void {
    const due = Date.now() + delayMs;
    if (this.inventoryTimer) {
      if (due >= this.inventoryDueAt) return; // one is already coming at least this soon
      clearTimeout(this.inventoryTimer);
    }
    this.inventoryDueAt = due;
    this.inventoryTimer = setTimeout(() => {
      this.inventoryTimer = undefined;
      void this.pushInventory();
    }, delayMs);
  }

  /**
   * A turn just ended: tell the hub NOW that this session's file moved.
   *
   * Every client re-reads history the moment a run goes idle, and the hub
   * answers from its replica unless the inventory says the file is newer. The
   * regular path learns that only after `awaitWriteFinish` + the 5 s debounce +
   * a whole-corpus walk — on stage the final answer reached the hub 9 s after
   * it was written (07.10.2026), while the phone's idle re-read gives up after
   * ~3 s. Every read in between came back without the answer, and the iPhone
   * sat on «Пишу страницу. ⚙ 8» until the session was reopened.
   *
   * So: stat this one transcript and re-send the list we already hold with its
   * mtime moved. Same list, same `complete` — the hub sees an mtime-only change
   * (no snapshot broadcast) and from then on forwards history reads to us until
   * the replica catches up; `replicator.queue()` starts that catch-up at once.
   * Claude's numbers are the inventory's own: the SDK's mtime as the replica
   * cursor (`fileMtime`), and the sort key settled past trailing bookkeeping
   * (`claudeSessionActivity`);
   * Codex's from a stat of its rollouts without parsing them. A session not in
   * the list yet, or one whose file has not moved, waits for the rebuild,
   * which is brought forward to the fast lane either way.
   */
  private async publishTurnEnd(sessionId: string): Promise<void> {
    // The regular rebuild runs anyway (the watcher saw the file move); bring it
    // forward so whatever lands after our stat is not 5 s behind either.
    this.scheduleInventory(INVENTORY_FAST_MS);
    const known = this.latestInventory.find((s) => s.sessionId === sessionId);
    const source = known?.source ?? 'claude';
    if (!known || (source === 'claude' && !known.cwd)) return;
    // Stop hooks write their summary right after `result`; let that land so
    // the mtime we publish is the file's last one, not one write short.
    await new Promise((resolve) => setTimeout(resolve, TURN_END_SETTLE_MS));
    let stamp: TurnEndStamp | undefined;
    if (source === 'codex') {
      const mtime = await codexRolloutMtime(sessionId, known.cwd).catch(() => undefined);
      stamp = mtime === undefined ? undefined : { lastModified: mtime };
    } else {
      stamp = await claudeTurnEnd(sessionId, known.cwd!);
    }
    const matches = (s: SessionSummary) => s.sessionId === sessionId && (s.source ?? 'claude') === source;
    const current = this.latestInventory.find(matches);
    if (!stamp || !current || (stamp.fileMtime ?? stamp.lastModified) <= replicaCursor(current)) return;
    this.turnEndMtimes.set(`${source}:${sessionId}`, stamp);
    // It is now the newest session, and the list is newest-first: move it to
    // the front, so replication (which walks the list in order) syncs it first
    // instead of after every older row that also owes a sync.
    const bump = (list: SessionSummary[]) => {
      const hit = list.find(matches);
      return hit ? [stamped(hit, stamp), ...list.filter((s) => !matches(s))] : list;
    };
    this.latestInventory = bump(this.latestInventory);
    this.fullInventory = bump(this.fullInventory);
    this.send({ type: 'inventory', sessions: this.latestInventory, complete: this.lastInventoryComplete });
    this.replicator.queue();
  }

  /** A walk never moves a turn-end cursor backwards; once a walk has seen the
   *  file at least that new, the override is spent and the walk's own numbers
   *  (the sort key settled past any bookkeeping written since) stand. */
  private keepTurnEndMtimes(sessions: SessionSummary[]): SessionSummary[] {
    if (!this.turnEndMtimes.size) return sessions;
    return sessions.map((s) => {
      const key = `${s.source ?? 'claude'}:${s.sessionId}`;
      const published = this.turnEndMtimes.get(key);
      if (published === undefined) return s;
      if (replicaCursor(s) >= (published.fileMtime ?? published.lastModified)) {
        this.turnEndMtimes.delete(key);
        return s;
      }
      return stamped(s, published);
    });
  }

  private async pushInventory(): Promise<void> {
    // One build at a time. `buildInventory` walks the whole corpus (on a box
    // with ~5k transcripts that is seconds, not milliseconds), and the debounce
    // is shorter than the walk — so triggers arriving mid-build used to start a
    // SECOND full walk over the same disk, and the two made each other slower.
    // A trigger during a build is remembered and collapsed into one run after
    // it, which is the same answer sooner.
    if (this.inventoryInFlight) {
      this.inventoryQueued = true;
      return;
    }
    this.inventoryInFlight = true;
    try {
      // includeProgrammatic: cc-remote is a monitor/control plane, not an IDE
      // `/resume` picker — sessions CREATED through it must show in the list,
      // else a phone/web-created session is written to disk but filtered out
      // and appears to "vanish" after a reconnect. Still needed after
      // OWN_ENTRYPOINT: it covers sessions written by older builds (`sdk-ts`)
      // and by any other SDK tool on this machine.
      const all = await buildInventory({ limit: this.cfg.inventoryLimit, includeProgrammatic: true });
      this.fullInventory = all;
      // The owner's choice of what leaves this machine (policy.ts). A session
      // outside it is not listed at all — no title, no cwd — and one the hub
      // already holds is forgotten there, history included.
      // A retention period (policy.ts) works the same way: a session nobody
      // has written to for longer is not offered to the hub again — the hub
      // purges its copy — unless something is running in it right now.
      const running = new Set(this.runManager.liveRuns().map((r) => r.sessionId));
      const sessions = this.keepTurnEndMtimes(
        all.filter(
          (s) =>
            syncsCwd(s.cwd) &&
            (withinRetention(s.lastModified) || running.has(s.sessionId) || s.livePid !== undefined || s.active === true),
        ),
      );
      this.forgetUnsynced(all);
      this.latestInventory = sessions;
      // «Complete» makes the hub archive every session missing from the list.
      // On a «selected» machine, before the replica catalog arrived, a missing
      // one may be a session we still have to tell it to FORGET — archiving it
      // first would take it out of the catalog, and then no forget ever reaches
      // it. So complete only once forgetting has had its chance.
      const complete = this.cfg.inventoryLimit === undefined && (policy().sync === 'all' || this.replicator.catalogReady);
      this.lastInventoryComplete = complete;
      this.send({ type: 'inventory', sessions, complete });
      this.replicator.queue();
      this.maybeReconcileMemories();
    } catch (err) {
      console.error('[agent] inventory error:', err);
    } finally {
      this.inventoryInFlight = false;
      if (this.inventoryQueued) {
        this.inventoryQueued = false;
        this.scheduleInventory(INVENTORY_FAST_MS);
      }
    }
  }

  /**
   * Is this session one the owner lets leave the machine? Judged by where the
   * session REALLY is — its cwd in the on-disk inventory, looked up by id — not
   * by the cwd the hub sent along, which a hub could set to any synced folder
   * while naming a session from another (security review 28.09.2026). Only a
   * session the inventory has not seen yet (started seconds ago) falls back
   * to the cwd it came with.
   */
  private sessionSynced(sessionId: string, source: string | undefined, claimedCwd: string | undefined): boolean {
    if (policy().sync === 'all') return true;
    const real = this.fullInventory.find(
      (s) => s.sessionId === sessionId && (source === undefined || (s.source ?? 'claude') === source),
    );
    return syncsCwd(real ? real.cwd : claimedCwd);
  }

  /** A resume/takeover of a session whose folder the owner does not sync —
   *  the hub cannot have learned its id from us, so this is a guess or a stale
   *  list; either way the answer is no, in words the client shows. */
  private refuseUnsynced(runId: string, sessionId: string): void {
    this.send({
      type: 'run_status',
      runId,
      sessionId,
      state: 'error',
      code: 'resume_refused',
      error: 'This session is in a folder this machine does not sync (~/.cc-remote/policy.json).',
    });
  }

  /**
   * Tell the hub to drop what it holds of sessions the owner no longer syncs —
   * a folder taken off the list, or a machine switched from «all» to
   * «selected». Only sessions the hub's catalog actually has, so a machine
   * that never synced them sends nothing. Taken out of the local catalog at
   * once: if the folder is picked again, they upload from scratch.
   */
  private forgetUnsynced(all: SessionSummary[]): void {
    if (policy().sync === 'all' || !this.replicator.catalogReady) return;
    const forget: { source: 'claude' | 'codex'; sessionId: string }[] = [];
    for (const s of all) {
      if (syncsCwd(s.cwd)) continue;
      const source = s.source ?? 'claude';
      if (!this.replicator.forget(source, s.sessionId)) continue;
      forget.push({ source, sessionId: s.sessionId });
    }
    if (forget.length) {
      console.log(`[agent] sync: asking the hub to forget ${forget.length} session(s) outside the synced folders`);
      this.send({ type: 'sync_forget', sessions: forget });
    }
  }

  /** Inventory fires on every debounced watcher event; memory changes far more
   *  slowly than transcripts do, so reconciling on each one would shell out to
   *  git and re-read the corpus for nothing. */
  private maybeReconcileMemories(): void {
    if (!MEMORY_SYNC_ENABLED) return;
    if (!this.memoryCatalog.length && !this.projectKeys.size) return;
    const now = Date.now();
    if (now - this.lastMemoryReconcile < MEMORY_RECONCILE_MS) return;
    this.lastMemoryReconcile = now;
    void this.reconcileMemories();
  }

  /**
   * Bring this machine's memory files and the hub's copy into agreement.
   *
   * Deliberately asymmetric: every local file is offered upward, and only paths
   * this machine is MISSING are requested downward. Claude Code's own harness
   * writes these files, so the hub is a backup and a courier, never an author —
   * anything else would put two writers on one file.
   */
  /** Which scope key a locally-named note belongs under. `fleet` notes are
   *  owned by the user and pinned to nothing; `machine` notes to this host. */
  private scopeKeyFor(scope: 'fleet' | 'machine' | 'project', projectKey: string): string {
    if (scope === 'fleet') return '';
    return scope === 'machine' ? this.cfg.machineId : projectKey;
  }

  private reconcileMemories(): Promise<void> {
    return this.runMemoryJob(() => this.reconcileMemoriesNow());
  }

  /** Persist the sync state without letting a disk problem take the agent
   *  down. Nothing sent to the hub depends on it; the cost of a miss is a
   *  re-derivation from older history on the next pass. */
  private async saveMemorySyncState(state: Parameters<typeof writeSyncState>[0]): Promise<void> {
    try {
      await writeSyncState(state);
    } catch (err) {
      console.warn(`[agent] memory sync state not saved: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async reconcileMemoriesNow(): Promise<void> {
    const cwds = [
      ...new Set(
        this.latestInventory
          .map((s) => s.cwd)
          .filter((cwd): cwd is string => typeof cwd === 'string' && cwd.length > 0),
      ),
    ];
    const projects = new Map<string, string>();
    const state = await readSyncState();
    let stateDirty = false;
    // Deduped: one fetch entry can be wanted by several directories at once,
    // because fleet notes live in every project's memory dir.
    const wanted = new Map<string, { scope: MemoryScope; scopeKey: string; path: string }>();

    const remoteByKey = new Map(
      this.memoryCatalog.map((m) => [syncStateKey(m.scope, m.scopeKey, m.path), m] as const),
    );

    for (const cwd of cwds) {
      let key = this.projectKeys.get(cwd);
      if (key === undefined) {
        key = await projectKeyFor(cwd);
        this.projectKeys.set(cwd, key);
      }
      // No git remote means no identity that survives the trip to another
      // machine. Falling back to the path would drop these notes into an
      // unrelated directory on any box with a different layout.
      if (!key) continue;
      projects.set(key, cwd);

      const local = await readLocalMemories(cwd);
      const localByPath = new Map(local.map((f) => [f.path, f] as const));

      for (const file of local) {
        const scopeKey = this.scopeKeyFor(file.scope, key);
        const stateId = syncStateKey(file.scope, scopeKey, file.path);
        const remote = remoteByKey.get(stateId);

        // Deleted elsewhere: retire our copy instead of offering it back up.
        if (remote?.deleted) {
          if (await quarantineMemory(cwd, file.path, scopeKey || file.scope)) {
            console.log(`[agent] memory retired (deleted on the hub): ${file.path}`);
          }
          if (state[stateId]) {
            delete state[stateId];
            stateDirty = true;
          }
          continue;
        }

        // Every note on disk must be reachable from the index, as an invariant
        // of reconciling rather than a side effect of arriving. Notes that
        // landed before this rule existed — or while the index was being
        // rewritten — are otherwise on disk and referenced by nothing. Cheap
        // and idempotent: it appends only what is genuinely missing.
        if (await appendIndexEntry(memoryDirFor(cwd), file.path, file.content)) {
          console.log(`[agent] memory indexed: ${file.path} -> ${cwd}`);
        }

        if (remote && remote.sha256 === file.sha256) {
          if (state[stateId]?.sha !== file.sha256) {
            state[stateId] = { sha: file.sha256, revision: remote.revision };
            stateDirty = true;
          }
          continue;
        }

        // The two sides differ. Whether that means "the hub has something
        // newer" or "somebody edited this here" is invisible from the shas
        // alone — the last agreed sha is what separates them.
        if (remote) {
          const last = state[stateId];
          if (last && last.sha === file.sha256) {
            // Untouched here since we last agreed, so the change came from
            // another machine. This is the only case that may overwrite.
            wanted.set(stateId, { scope: file.scope, scopeKey, path: file.path });
            continue;
          }
          if (last && last.revision !== remote.revision) {
            // Both sides moved. Local wins — losing a human's edit is worse
            // than a stale hub row — but this must not happen silently.
            console.warn(
              `[agent] memory conflict on ${file.path}: edited here and on another machine; keeping the local copy`,
            );
          }
        }

        this.send({
          type: 'memory_push',
          scope: file.scope,
          scopeKey,
          path: file.path,
          content: file.content,
        });
        state[stateId] = { sha: file.sha256, revision: remote?.revision ?? 0 };
        stateDirty = true;
      }

      // Anything the hub holds for this directory that is not on disk here.
      // Fleet notes apply to every project dir, machine notes to this host's,
      // project notes only to their own repository.
      for (const entry of this.memoryCatalog) {
        if (entry.deleted) continue;
        // Older hubs still hold index rows from before it was excluded;
        // pulling one down would overwrite this machine's own view.
        if (entry.path === INDEX_FILE) continue;
        const applies =
          entry.scope === 'fleet' ||
          (entry.scope === 'machine' && entry.scopeKey === this.cfg.machineId) ||
          (entry.scope === 'project' && entry.scopeKey === key);
        if (!applies || localByPath.has(entry.path)) continue;
        wanted.set(syncStateKey(entry.scope, entry.scopeKey, entry.path), {
          scope: entry.scope,
          scopeKey: entry.scopeKey,
          path: entry.path,
        });
      }
    }

    this.memoryProjects = projects;
    if (stateDirty) await this.saveMemorySyncState(state);

    // The protocol caps a fetch at 100 entries; a first sync on a fresh machine
    // can exceed that, so ask in batches rather than silently losing the tail.
    const batch = [...wanted.values()];
    for (let i = 0; i < batch.length; i += 100) {
      this.send({ type: 'memory_fetch', want: batch.slice(i, i + 100) });
    }
  }

  /** Directories a delivered memory belongs in. A project note has exactly one
   *  home; fleet and machine notes go into every project directory, because
   *  Claude Code only ever loads `projects/<slug>/memory` — a note kept
   *  anywhere else would replicate perfectly and never be read. */
  private targetDirsFor(scope: MemoryScope, scopeKey: string): string[] {
    if (scope === 'project') {
      const cwd = this.memoryProjects.get(scopeKey);
      return cwd ? [cwd] : [];
    }
    if (scope === 'machine' && scopeKey !== this.cfg.machineId) return [];
    return [...this.memoryProjects.values()];
  }

  /** Land memories the hub had and this machine did not — or had in an older
   *  version it has not touched since. */
  private applyDeliveredMemories(
    memories: Array<{ scope: MemoryScope; scopeKey: string; path: string; content: string }>,
  ): Promise<void> {
    return this.runMemoryJob(() => this.applyDeliveredMemoriesNow(memories));
  }

  private async applyDeliveredMemoriesNow(
    memories: Array<{ scope: MemoryScope; scopeKey: string; path: string; content: string }>,
  ): Promise<void> {
    const state = await readSyncState();
    let stateDirty = false;
    for (const memory of memories) {
      // A hub that still holds index rows must not be able to plant one here.
      if (memory.path === INDEX_FILE) continue;
      const stateId = syncStateKey(memory.scope, memory.scopeKey, memory.path);
      const remote = this.memoryCatalog.find(
        (m) => syncStateKey(m.scope, m.scopeKey, m.path) === stateId,
      );
      for (const cwd of this.targetDirsFor(memory.scope, memory.scopeKey)) {
        try {
          if (await writeMemoryIfAbsent(cwd, memory.path, memory.content)) {
            // A note nothing points at is a note nobody reads: the harness loads
            // the index every session and recalls the rest through it, so
            // replicating the file without an entry leaves it on disk and
            // invisible. Append-only, so a concurrent harness write is never
            // lost — at worst a line is duplicated.
            const listed = await appendIndexEntry(
              memoryDirFor(cwd),
              memory.path,
              memory.content,
            );
            console.log(
              `[agent] memory restored: ${memory.path} -> ${cwd}${listed ? ' (indexed)' : ''}`,
            );
          } else {
            // The file is already there. Re-check the untouched condition HERE
            // rather than trusting the decision made before the round trip —
            // the harness may have written to it while we were asking.
            const current = await readLocalMemories(cwd);
            const onDisk = current.find((f) => f.path === memory.path);
            const untouched = !!onDisk && state[stateId]?.sha === onDisk.sha256;
            if (!untouched) continue;
            if (onDisk.sha256 === sha256Hex(memory.content)) continue; // already equal
            if (await overwriteMemory(cwd, memory.path, memory.content)) {
              console.log(`[agent] memory updated: ${memory.path} -> ${cwd}`);
            }
          }
          state[stateId] = {
            sha: sha256Hex(memory.content),
            revision: remote?.revision ?? 0,
          };
          stateDirty = true;
        } catch (err) {
          console.error(`[agent] memory write failed for ${memory.path}:`, err);
        }
      }
    }
    if (stateDirty) await this.saveMemorySyncState(state);
  }

  // ---------------------------------------------------------------- commands
  private onMessage(raw: string): void {
    let msg: CentralToAgent;
    try {
      msg = decodeCentralToAgent(raw);
    } catch (err) {
      console.error('[agent] bad command:', err);
      return;
    }
    const priv = e2ee();
    // A machine that is no longer private still opens what a paired browser
    // seals (its key wins there); it just does not insist on it.
    const sealer = priv ?? e2eeOpener();
    if (sealer) {
      const opened = sealer.openIncoming(msg as unknown as Record<string, unknown>, {
        acceptPlaintext: !priv || policy().acceptPlaintextInput === true,
        sessionOfRun: (runId) => this.runManager.sessionOf(runId),
      });
      if (opened.refusal) {
        this.refuseE2e(msg, opened.refusal);
        return;
      }
      msg = opened.msg as unknown as CentralToAgent;
      // The hub holds no cwd for a private machine's sessions (it is sealed in
      // the summary), so it sends none: the folder of a session id is read from
      // this machine's own inventory, which is also the only source worth
      // trusting for where a session lives.
      if (priv && (msg.type === 'resume' || msg.type === 'takeover' || msg.type === 'mirror_open')) {
        const sessionId = msg.sessionId;
        const real = this.fullInventory.find((s) => s.sessionId === sessionId);
        if (real?.cwd) msg = { ...msg, cwd: real.cwd };
      }
    }
    switch (msg.type) {
      case 'resume':
        if (!this.sessionSynced(msg.sessionId, msg.source, msg.cwd)) {
          this.refuseUnsynced(msg.runId, msg.sessionId);
          break;
        }
        void this.runManager.resume(msg.runId, msg.sessionId, msg.cwd, msg.source, { model: msg.model, effort: msg.effort, runBy: msg.runBy });
        break;
      case 'new_session':
        // Starting work in a folder from a phone IS choosing to see it there:
        // on a «selected» machine the folder joins the synced list. Not on a
        // chat-only one: there only the owner widens it, on the machine.
        try {
          if (!policy().chatOnly && addSyncProject(msg.cwd)) {
            console.log(`[agent] sync: ${msg.cwd} added — a session was started there`);
            this.scheduleInventory(INVENTORY_FAST_MS);
          }
        } catch (err) {
          console.error(`[agent] sync: could not record ${msg.cwd}: ${(err as Error).message}`);
        }
        this.runManager.startNew(
          msg.runId,
          msg.cwd,
          msg.message,
          msg.images,
          msg.source,
          { permissionMode: msg.permissionMode, model: msg.model, effort: msg.effort, requireGateway: msg.requireGateway, runBy: msg.runBy },
          msg.files,
        );
        break;
      case 'takeover':
        // Takeover kills every writer of the session — the person's own editor
        // included. On a chat-only machine the hub does not get to do that.
        if (policy().chatOnly || !this.sessionSynced(msg.sessionId, msg.source, msg.cwd)) {
          this.refuseUnsynced(msg.runId, msg.sessionId);
          break;
        }
        void this.runManager.takeover(msg.runId, msg.sessionId, msg.cwd, msg.message, msg.images, msg.source, msg.files, {
          model: msg.model,
          effort: msg.effort,
          runBy: msg.runBy,
        });
        break;
      case 'input':
        this.runManager.input(msg.runId, msg.text, msg.images, msg.files, msg.by);
        break;
      case 'interrupt':
        this.runManager.interrupt(msg.runId);
        break;
      case 'register_ack':
        this.onRegisterAck(msg.adoptedRunIds);
        this.startUsage(msg.claudeUsageEnabled);
        break;
      case 'session_origin_ack':
        try { this.sessionOrigins.acknowledge(msg.runId); }
        catch { console.warn('[agent] could not acknowledge session origin; will replay on reconnect'); }
        break;
      case 'agent_superseded':
        // Another daemon process now holds this machineId, and the hub has
        // handed it the machine. Reconnecting would only take it back and start
        // a tug of war in which BOTH processes keep appending to the same
        // transcripts — the one thing the single-writer rule exists to prevent.
        // Stand down for good: close the runs this process still drives (their
        // subprocesses are the actual writers) and let the supervisor keep the
        // winner. An orphan with no supervisor simply dies here, which is the
        // point.
        console.warn(
          `[agent] superseded on ${msg.machineId} by a newer agent process — standing down`,
        );
        this.stop(
          'Эту машину взял на себя другой процесс агента — текущий ход прерван. Сессия поднимется сама через несколько секунд.',
        );
        this.onStandDown?.();
        break;
      case 'compact':
        void this.runManager.compact(msg.runId);
        break;
      case 'close':
        this.runManager.end(msg.runId, 'ended');
        break;
      case 'end_external_session':
        // SIGTERM to a session the person runs outside Hegai Code: chat-only
        // refuses it like `proc.kill`, and an unsynced one is not ours to see.
        if (policy().chatOnly || !this.sessionSynced(msg.sessionId, undefined, undefined)) break;
        void this.runManager.endExternalSession(msg.sessionId);
        break;
      case 'tool_decision':
        this.runManager.decideTool(msg.requestId, {
          allow: msg.allow,
          updatedInput: msg.updatedInput,
          permissionMode: msg.permissionMode,
          message: msg.message,
        }, msg.by);
        break;
      case 'rescan':
        void this.pushInventory();
        break;
      case 'session_sync_catalog':
        this.replicator.setCatalog(msg.sessions);
        // Now we know what the hub holds: forget what the owner no longer
        // syncs, then send the inventory that may finally be «complete».
        if (policy().sync !== 'all') {
          this.forgetUnsynced(this.fullInventory);
          this.scheduleInventory(INVENTORY_FAST_MS);
        }
        this.replicator.queue();
        break;
      case 'session_sync_ack':
        this.replicator.onAck(msg);
        break;
      case 'memory_catalog':
        // Accept and drop when not opted in: the hub sends this to everyone,
        // and an unparsed message would just be logged as a bad command.
        // Not on a machine that holds a content key: the sync uploads memory
        // files (and loads the hub's into local sessions).
        if (!MEMORY_SYNC_ENABLED || e2eeOpener()) break;
        this.memoryCatalog = msg.memories;
        this.lastMemoryReconcile = Date.now();
        void this.reconcileMemories();
        break;
      case 'memory_deliver':
        // Memory files load into every local session — the owner's own ones
        // included. Chat-only takes none from the hub.
        if (!MEMORY_SYNC_ENABLED || policy().chatOnly || e2eeOpener()) break;
        void this.applyDeliveredMemories(msg.memories);
        break;
      case 'rpc_request':
        void this.handleRpc(msg.requestId, msg.method, msg.params);
        break;
      case 'term_open': {
        const termId = msg.termId;
        this.send({ type: 'term_opened', termId });
        if (policy().chatOnly) {
          this.send({ type: 'term_data', termId, data: `\r\n[${chatOnlyRefusal('The terminal')}]\r\n` });
          this.send({ type: 'term_exit', termId });
          break;
        }
        void this.terminals
          .open(
            termId,
            msg.cwd,
            // Drop terminal output while the uplink is backed up — it's
            // regenerable and the user isn't seeing a stalled stream live anyway.
            (data) => {
              if (!this.uplinkBackedUp) this.send({ type: 'term_data', termId, data });
            },
            (code) => this.send({ type: 'term_exit', termId, code }),
          )
          .then((res) => {
            if (!res.ok) {
              this.send({ type: 'term_data', termId, data: `\r\n[terminal unavailable: ${res.error}]\r\n` });
              this.send({ type: 'term_exit', termId });
            }
          })
          .catch((err: unknown) => {
            // open() reports failures as `ok: false`; this is the backstop for
            // anything it did not foresee, so the client never keeps a phantom.
            const reason = err instanceof Error ? err.message : String(err);
            this.send({ type: 'term_data', termId, data: `\r\n[terminal unavailable: ${reason}]\r\n` });
            this.send({ type: 'term_exit', termId });
          });
        break;
      }
      case 'term_input':
        this.terminals.input(msg.termId, msg.data);
        break;
      case 'term_resize':
        this.terminals.resize(msg.termId, msg.cols, msg.rows);
        break;
      case 'term_close':
        this.terminals.close(msg.termId);
        break;
      case 'mirror_open':
        if (!this.sessionSynced(msg.sessionId, undefined, msg.cwd)) {
          this.send({ type: 'mirror_data', mirrorId: msg.mirrorId, replace: true, messages: [] });
          break;
        }
        void this.mirrors.open(msg.mirrorId, msg.sessionId, msg.cwd, (replace, messages) =>
          this.send({ type: 'mirror_data', mirrorId: msg.mirrorId, replace, messages }),
        );
        break;
      case 'mirror_close':
        this.mirrors.close(msg.mirrorId);
        break;
      case 'set_model':
        this.runManager.setModel(msg.runId, msg.model);
        break;
      case 'set_permission_mode':
        this.runManager.setPermissionMode(msg.runId, msg.mode);
        break;
      case 'set_effort':
        this.runManager.setEffort(msg.runId, msg.effort, msg.ultracode);
        break;
    }
  }

  /**
   * The composer's «/» menu. A session with a live run here answers from the
   * runtime (built-ins, skills, plugins — `supportedCommands()`); anything else
   * falls through to the on-disk scan in rpc-dispatch (slash-commands.ts).
   * Lives here rather than in dispatchRpc because only the client holds runs.
   */
  private async listCommands(params: Record<string, unknown>): Promise<unknown> {
    const a = RpcParams['commands.list'].parse(params);
    if (a.source !== 'codex' && a.sessionId) {
      const live = await this.runManager.supportedCommands(a.sessionId);
      if (live?.length) return RpcResultSchemas['commands.list'].parse({ commands: live });
    }
    return dispatchRpc('commands.list', params);
  }

  /** A private machine got content it cannot read or must not take in the
   *  clear. Say why to whoever is waiting, and do nothing else. */
  private refuseE2e(msg: CentralToAgent, reason: string): void {
    const text = `Private machine: ${reason}. Pair this device (Ввести код пары) and try again.`;
    console.warn(`[agent] e2ee: refused ${msg.type}: ${reason}`);
    switch (msg.type) {
      case 'input':
        this.send({ type: 'stream', sessionId: '', runId: msg.runId, event: { kind: 'error', code: 'turn_failed', text } });
        break;
      case 'new_session':
      case 'takeover':
        this.send({ type: 'run_status', sessionId: '', runId: msg.runId, state: 'error', error: text, code: 'e2e_required' });
        break;
      case 'term_input':
        this.send({ type: 'term_data', termId: msg.termId, data: `\r\n[${text}]\r\n` });
        break;
      case 'rpc_request':
        this.send({ type: 'rpc_response', requestId: msg.requestId, ok: false, error: text });
        break;
      default:
        break;
    }
  }

  private async handleRpc(requestId: string, method: string, params: Record<string, unknown>): Promise<void> {
    const noted = e2ee()?.noteRpc(requestId, method);
    // A second request under an id still in flight is dropped (answering it
    // would hand the first requester an error); a full table is refused.
    if (noted === 'duplicate') return;
    if (noted === 'full') {
      this.send({ type: 'rpc_response', requestId, ok: false, error: 'too many requests in flight' });
      return;
    }
    // Nobody may still be writing a transcript we are about to delete, or the
    // writer re-creates it; nobody may start one until it is gone
    // (`RunManager.releaseForDelete`).
    const deleting =
      method === 'session.delete' && typeof params['sessionId'] === 'string' ? params['sessionId'] : undefined;
    const unlockUnit =
      deleting && typeof params['cwd'] === 'string' ? this.runManager.lockUnitForDelete(params['cwd'] as string) : () => {};
    try {
      if (deleting) await this.runManager.releaseForDelete(deleting);
      let result =
        method === 'commands.list' ? await this.listCommands(params) : await dispatchRpc(method, params);
      // The on-demand history read is the same transcript the replica carries.
      if (REDACT && (method === 'session.messages' || method === 'session.subagent')) {
        const r = result as { messages: HistoryMessage[] };
        result = { ...r, messages: redactMessages(r.messages) };
      }
      this.send({ type: 'rpc_response', requestId, ok: true, result });
      // A commit made through cc-remote's own Git panel runs in the agent (no
      // Claude-session Bash tool → the on-machine hook can't fire), so surface it
      // here too. The panel passes its sessionId so the nudge lands on that card.
      if (
        method === 'git.commit' &&
        (result as { ok?: boolean } | undefined)?.ok &&
        typeof params['sessionId'] === 'string' &&
        params['sessionId']
      ) {
        const cwd = typeof params['cwd'] === 'string' ? (params['cwd'] as string) : undefined;
        this.send({ type: 'session_committed', sessionId: params['sessionId'] as string, cwd });
        this.runManager.noteExternalCommit(params['sessionId'] as string, cwd);
      }
    } catch (err) {
      this.send({ type: 'rpc_response', requestId, ok: false, error: (err as Error).message });
    } finally {
      if (deleting) this.runManager.finishDelete(deleting);
      unlockUnit();
    }
  }

  /** Told to leave for good: the process must exit rather than reconnect. Set by
   *  `main.ts`, which owns process lifetime. */
  onStandDown?: () => void;

  stop(
    notice = 'Агент этой машины перезапускается — текущий ход прерван. Сессия поднимется сама через несколько секунд.',
  ): void {
    this.closing = true;
    this.stopKeepalive();
    this.cancelRunGrace();
    this.stopUsage();
    this.stopStats();
    this.stopContext();
    if (this.profileTimer) clearInterval(this.profileTimer);
    if (this.watcherRestartTimer) clearTimeout(this.watcherRestartTimer);
    this.watcher?.close();
    this.yieldWatcher?.close();
    this.commitWatcher?.close();
    this.terminals.closeAll();
    this.mirrors.closeAll();
    // Before `reset()` — it clears the run table, and the goodbye needs it.
    this.runManager.announceShutdown(notice);
    this.runManager.reset('Agent stopped before approval was answered.');
    this.partials.flushAll();
    this.partials.clear();
    this.ws?.close();
  }
}
