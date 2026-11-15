/**
 * Start-up reconciliation for children that outlived the agent that spawned
 * them.
 *
 * A `claude --resume=<id>` child is not in our process group's fate: when the
 * agent dies outside a clean systemd/launchd stop (OOM, SIGKILL, a crash, a
 * `kill -9` from a human tidying up), the child keeps running and keeps
 * appending to its transcript. The new agent process starts with an empty run
 * registry, `register`s with no `liveRuns`, and the hub — correctly, by its own
 * lights — fails every run of the previous life
 * (`fail_run(.., "agent reconnected without this run")`, `server-rs/src/hub.rs`).
 * From then on the work is invisible: it is still editing files and writing
 * commits, while every observer sees a dead session.
 *
 * The one thing we CANNOT do is take it back over. The SDK talks to that child
 * through stdin/stdout pipes whose other ends were owned by the dead parent;
 * there is no way to send it a turn or read one out. So "adoption" is not on
 * the table and this module does not pretend otherwise. What is on the table:
 *
 *   1. FIND them at start — this file.
 *   2. NAME them in the log, loudly, with pid, session and age. On the night
 *      this cost three hours, seven of them had accumulated in one worktree
 *      without a single line of log between them.
 *   3. TELL the hub the session is taken. No new protocol is needed for this:
 *      an orphan already fails `isOwnChild` (its `startedAt` precedes ours), so
 *      `readLiveSessions` counts it as a live writer and `buildInventory`
 *      publishes it as `livePid` + `entrypoint` on the session summary. The hub
 *      overlays that onto the catalog (`overlay_liveness`) and refuses a
 *      non-forced `open` with «Session is live in … refusing to open a second
 *      writer». Adding a field to say the same thing twice would only give the
 *      two copies a chance to disagree.
 *   4. OFFER the session back through the path the product already has —
 *      force-takeover, which kills the writer and confirms it died
 *      (`RunManager.takeover` → `terminatePid`). `npm run orphans --workspace
 *      agent -- --release <pid>` is the same thing from a terminal, for a
 *      session too old to be on the board.
 *
 * What this module deliberately does NOT do is kill anything by itself — see
 * `WHY_WE_DO_NOT_KILL` below.
 */
import {
  OWN_ENTRYPOINT,
  isOwnChild,
  isPidAlive,
  readLivenessRecords,
  sameProcess,
  stillSameProcess,
  type LivenessReadOptions,
  type LivenessRecord, isValidPid } from './sessions.js';

/** A `claude` child of a PREVIOUS agent process, still running. */
export interface OrphanChild {
  pid: number;
  sessionId: string;
  cwd?: string;
  entrypoint?: string;
  /** From the liveness file; ms since epoch. Always present on an orphan —
   *  a record without it cannot be shown to predate us, so it is not one. */
  startedAt: number;
  /** The CLI's process fingerprint from the liveness file, if it wrote one.
   *  `--release` hands it to `terminatePid` so a signal never reaches a pid that
   *  has been reused since. */
  procStart?: string;
}

/**
 * Why an orphan is never killed automatically, not even a "hung" one.
 *
 * The tempting rule is «its stdin is dead, so it can no longer be doing
 * anything useful — reap it». Every part of that is wrong in a way we watched
 * happen: an orphan finishes the turn it was in the middle of, and finishing a
 * turn means editing files and writing commits. Killing it mid-turn leaves a
 * half-applied edit in a worktree nobody is watching.
 *
 * The next temptation is a factual "hung" test instead of a clock. There isn't
 * one from outside the process:
 *   - Broken stdin is true of EVERY orphan, the busy ones included, so it
 *     selects nothing.
 *   - Idle CPU and a transcript that has not grown is exactly what a turn
 *     waiting on the model API looks like, and that wait is routinely minutes.
 *   - `/proc` would not help even if it were portable, and the machine this
 *     happened on is a Mac.
 * Age alone is not a fact about the process — a long run is normal here.
 *
 * So the asymmetry decides it: leaving an orphan costs a session that reads as
 * busy until a human force-takes it, which is recoverable and now visible in
 * the log; killing one silently destroys work that nobody asked us to end and
 * that nobody can reconstruct. We name them and let a person pull the trigger.
 */
export const WHY_WE_DO_NOT_KILL =
  'an orphan still finishes its turn (files, commits) and nothing observable ' +
  'from outside distinguishes "wedged" from "waiting on the model" — so it is ' +
  'named here and ended only by an explicit force-takeover';

/**
 * Which liveness records describe an orphaned child of OURS.
 *
 * Three conditions, and each one is a way this has been got wrong:
 *   - the entrypoint is one we stamp (`cc-remote`) or the SDK's default
 *     (`sdk-*`). An editor or a terminal `/resume` is somebody else's process
 *     and never ours to reason about, let alone offer up for killing.
 *   - the pid is alive. A liveness file outlives its process; the directory is
 *     full of dead ones.
 *   - it is not a child of THIS process — i.e. `isOwnChild` says no. That is
 *     the same predicate the single-writer guard uses, on purpose: "orphan"
 *     and "live writer I must not collide with" have to be one judgement, or
 *     the inventory and this report will disagree about the same pid.
 *
 * A record with no `startedAt` (an older CLI) is NOT reported. `isOwnChild`
 * reads that as ours, and the two must agree; guessing the other way here
 * would announce an agent's own healthy children as orphans on every start.
 *
 * `alive` is a synchronous probe, so this stays pure. Whether the live pid is
 * STILL the process that wrote the record (pid reuse) is asked afterwards, by
 * `findOrphanedChildren`, with `sameProcess` — the same check the single-writer
 * guard uses, so the report and the inventory cannot disagree about a pid.
 */
export function selectOrphans(
  records: LivenessRecord[],
  agentStartedAt: number,
  alive: (pid: number) => boolean = isPidAlive,
): OrphanChild[] {
  const out: OrphanChild[] = [];
  for (const record of records) {
    const { pid, sessionId, entrypoint, startedAt, cwd, procStart } = record;
    if (!isValidPid(pid) || typeof sessionId !== 'string' || !sessionId) continue;
    if (typeof entrypoint !== 'string') continue;
    if (!(entrypoint.startsWith('sdk-') || entrypoint === OWN_ENTRYPOINT)) continue;
    if (typeof startedAt !== 'number') continue;
    if (isOwnChild(entrypoint, startedAt, agentStartedAt)) continue;
    if (!alive(pid)) continue;
    out.push({
      pid,
      sessionId,
      entrypoint,
      startedAt,
      ...(typeof cwd === 'string' && cwd ? { cwd } : {}),
      ...(typeof procStart === 'string' && procStart.trim() !== '' ? { procStart } : {}),
    });
  }
  return out.sort((a, b) => a.startedAt - b.startedAt);
}

/** When THIS agent process started, ms since epoch. */
export function agentStartedAt(): number {
  return Date.now() - Math.round(process.uptime() * 1000);
}

/**
 * Read the liveness directory and return our orphaned children.
 *
 * Selection first (pure, a signal-0 probe per candidate), then the process-
 * identity check on what survived: only a record that could be reported is
 * worth a `/proc` read or a `ps` fork, and our own children never are. A record
 * whose pid now belongs to another process is dropped like a dead one — see
 * `sameProcess`. The result is the same set as filtering the records before
 * selection, with far fewer probes.
 */
export async function findOrphanedChildren(
  startedAt: number = agentStartedAt(),
  options: LivenessReadOptions = {},
): Promise<OrphanChild[]> {
  const candidates = selectOrphans(await readLivenessRecords(options.dir), startedAt);
  const out: OrphanChild[] = [];
  for (const orphan of candidates) {
    if (await stillSameProcess(orphan, options.sameProcess ?? sameProcess)) out.push(orphan);
  }
  return out;
}

/**
 * `ps -o etime=` → milliseconds of elapsed time, or undefined if it is not a
 * reading at all.
 *
 * A tool that asks from OUTSIDE the agent (the `orphans` CLI) cannot use
 * `process.uptime()` — that measures itself, and every child of every agent
 * would then date from before it and read as orphaned. It has to ask how long
 * the running agent has been up, and `etime` is the one spelling both Linux's
 * procps and macOS's BSD ps agree on. `etimes` (seconds, convenient) is GNU
 * only and is silently absent on the Mac this bug happened on.
 *
 * Formats: `MM:SS`, `HH:MM:SS`, `DD-HH:MM:SS`, leading spaces. Anything else
 * returns undefined — a caller that cannot date the agent must say so, not
 * guess, because guessing low here marks live work as abandoned.
 */
export function parseEtime(raw: string): number | undefined {
  const text = raw.trim();
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d{1,2}):(\d{2})$/.exec(text);
  if (!m) return undefined;
  const [, days, hours, minutes, seconds] = m;
  return (
    ((Number(days ?? 0) * 24 + Number(hours ?? 0)) * 60 + Number(minutes)) * 60_000 +
    Number(seconds) * 1000
  );
}

/** «3h 12m» / «47m» / «19s» — how long an orphan has been running. */
export function describeAge(ms: number): string {
  if (ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

/** One log line per orphan: everything needed to find and end it by hand. */
export function describeOrphan(o: OrphanChild, now = Date.now()): string {
  return (
    `[agent] orphaned child: pid ${o.pid} session ${o.sessionId} ` +
    `running ${describeAge(now - o.startedAt)}${o.cwd ? ` in ${o.cwd}` : ''} ` +
    `(${o.entrypoint ?? '?'}) — left alive; it holds the session, take it over to end it`
  );
}

/**
 * How to name the process holding a session, in a refusal a person reads.
 *
 * «session is live in cc-remote (pid 41203)» was true and useless: `cc-remote`
 * is OUR stamp, so the message read as though the control plane were fighting
 * itself, and the actual instruction — force-takeover will end it — was
 * nowhere. An editor still gets named as an editor; only an orphan is called
 * one, because only for an orphan is «nobody is sitting behind this» a fact.
 */
export function describeWriter(
  hit: { pid: number; entrypoint?: string; startedAt?: number },
  startedAt: number = agentStartedAt(),
  now = Date.now(),
): string {
  const ours =
    typeof hit.entrypoint === 'string' &&
    (hit.entrypoint.startsWith('sdk-') || hit.entrypoint === OWN_ENTRYPOINT);
  if (ours && typeof hit.startedAt === 'number' && !isOwnChild(hit.entrypoint, hit.startedAt, startedAt)) {
    return (
      `a leftover ${hit.entrypoint} child of a previous agent ` +
      `(pid ${hit.pid}, running ${describeAge(now - hit.startedAt)})`
    );
  }
  return `${hit.entrypoint ?? 'an editor'} (pid ${hit.pid})`;
}

/**
 * The start-up scan. Logs what it found and returns it.
 *
 * Never throws: an unreadable liveness directory is a reason to say so, not a
 * reason for the daemon to fail to come up. The inventory path reads the same
 * directory and DOES surface that failure where it matters (a resume refuses
 * rather than risk a second writer) — this report is the loud half, not the
 * enforcing half.
 */
export async function reportOrphanedChildren(
  startedAt: number = agentStartedAt(),
): Promise<OrphanChild[]> {
  let orphans: OrphanChild[];
  try {
    orphans = await findOrphanedChildren(startedAt);
  } catch (error) {
    console.warn(
      `[agent] could not scan for orphaned children: ${(error as Error).message} — ` +
        'a session held by one will still refuse to resume',
    );
    return [];
  }
  if (!orphans.length) return orphans;
  const now = Date.now();
  console.warn(
    `[agent] ${orphans.length} child process(es) outlived a previous agent and are still ` +
      'writing their transcripts. They cannot be resumed (their pipes died with their ' +
      `parent) and are NOT killed here: ${WHY_WE_DO_NOT_KILL}.`,
  );
  for (const orphan of orphans) console.warn(describeOrphan(orphan, now));
  return orphans;
}
