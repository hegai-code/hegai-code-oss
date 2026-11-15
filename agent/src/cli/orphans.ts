/**
 * List — and, on request, end — `claude` children that outlived the agent
 * process that spawned them.
 *
 * The agent names these at every start (see `orphans.ts`), but a machine whose
 * agent is wedged, or a session long past the inventory cap, needs a way to
 * look without waiting for a restart. This is that way, and it is deliberately
 * the ONLY killing this feature offers: a human types the pid.
 *
 *   npm run orphans --workspace agent
 *   npm run orphans --workspace agent -- --release 41203
 *
 * `--release` reuses the takeover kill loop (`kill-pid.ts`): SIGTERM, SIGKILL
 * after ~4s, and it reports success only once the pid is actually gone. It
 * refuses any pid that is not on the list above — releasing a session is not a
 * general-purpose kill, and a mistyped pid must not take out live work. Before
 * each signal it also re-checks the process's start time against the liveness
 * record, so a pid the kernel has handed to someone else in the meantime is left alone.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { pidFile } from '../config.js';
import { terminatePidOutcome } from '../kill-pid.js';
import { processStartToken } from '../proc-start.js';
import { isPidAlive } from '../sessions.js';
import { WHY_WE_DO_NOT_KILL, describeAge, findOrphanedChildren, parseEtime } from '../orphans.js';

const { values } = parseArgs({ options: { release: { type: 'string' } } });

/**
 * The cutoff «started before the agent that owns this machine now».
 *
 * `process.uptime()` is the agent's answer and is wrong here: it would measure
 * THIS command, born a second ago, and every healthy child of the running agent
 * would date from before it and be offered up for killing.
 *
 * Three honest outcomes:
 *   - no agent is running (no pid file, or its pid is dead) → nothing here owns
 *     any of these children, so all of them are orphans: cut off at now.
 *   - an agent is running and `ps` dates it → cut off at its start.
 *   - an agent is running and `ps` will not say → undefined. List everything,
 *     flag it, and refuse `--release`. Killing on a cutoff we could not
 *     establish is how this tool would end the work it exists to protect.
 */
function cutoff(): { at: number; sure: boolean } {
  let pid: number;
  try {
    pid = Number(readFileSync(pidFile(), 'utf8').trim());
  } catch {
    return { at: Date.now(), sure: true }; // no agent has claimed this machine
  }
  if (!Number.isFinite(pid) || pid <= 0 || !isPidAlive(pid)) {
    return { at: Date.now(), sure: true }; // stale claim; the agent is gone
  }
  try {
    const elapsed = parseEtime(execFileSync('ps', ['-o', 'etime=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }));
    if (elapsed === undefined) return { at: Date.now(), sure: false };
    return { at: Date.now() - elapsed, sure: true };
  } catch {
    return { at: Date.now(), sure: false };
  }
}

const { at, sure } = cutoff();
const orphans = await findOrphanedChildren(at);

if (orphans.length === 0) {
  console.log('No orphaned cc-remote `claude` children on this machine.');
  process.exit(0);
}

const now = Date.now();
console.log(`${orphans.length} orphaned cc-remote \`claude\` child process(es):\n`);
for (const o of orphans) {
  console.log(`  pid ${o.pid}  ${o.sessionId}`);
  console.log(`     running ${describeAge(now - o.startedAt)}  ${o.cwd ?? '?'}  (${o.entrypoint})`);
}

if (values.release === undefined) {
  console.log(
    `\nNothing is killed automatically: ${WHY_WE_DO_NOT_KILL}.\n` +
      'Taking the session over in the web/app does the same thing with the work in front of you.\n' +
      'From here:  npm run orphans --workspace agent -- --release <pid>',
  );
  if (!sure) {
    console.log(
      '\n⚠ An agent IS running but `ps` would not say since when, so this list may include\n' +
        '  its own healthy children. --release is disabled until that can be established.',
    );
  }
  process.exit(0);
}

if (!sure) {
  console.error(
    '\nRefusing --release: an agent is running and `ps` would not date it, so a child of\n' +
      'the LIVE agent is indistinguishable here from an orphan. Stop the agent first, or\n' +
      'take the session over from the web/app, where the agent itself makes the call.',
  );
  process.exit(1);
}

const pid = Number(values.release);
const target = orphans.find((o) => o.pid === pid);
if (!target) {
  console.error(`\npid ${values.release} is not one of the orphans listed above — refusing.`);
  process.exit(1);
}

console.log(`\nEnding pid ${target.pid} (session ${target.sessionId})…`);
// The record's own fingerprint if the CLI wrote one; otherwise the process as
// it stands right now, which `findOrphanedChildren` has just judged to be the
// recorded one. Either way a reused pid is caught between SIGTERM and SIGKILL.
const expectedStart = target.procStart ?? (await processStartToken(target.pid, { fresh: true }));
const outcome = await terminatePidOutcome(
  target.pid,
  {
    killProcess: (p, signal) => process.kill(p, signal),
    pidIsAlive: isPidAlive,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  },
  expectedStart,
);
if (outcome === 'reused') {
  console.error(
    `pid ${target.pid} is another process now (its start time no longer matches the record) — ` +
      'no further signal was sent to it. The orphan itself is gone; re-run the list.',
  );
  process.exit(1);
}
if (outcome === 'survived') {
  console.error(`pid ${target.pid} survived SIGKILL — the session is still held. Do NOT resume it.`);
  process.exit(1);
}
console.log(`pid ${target.pid} is gone; session ${target.sessionId} can be resumed now.`);
