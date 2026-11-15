/**
 * Agent daemon entry point. Dials out to the central service, registers this
 * machine, keeps the session inventory fresh, and serves resume/input/
 * interrupt/close/tool commands by driving Claude Code sessions locally.
 *
 * Config via env: CENTRAL_URL (default ws://127.0.0.1:4319), CC_REMOTE_TOKEN.
 */
import { AgentClient } from './client.js';
import { AGENT_VERSION, loadConfig, releasePidFile, writePidFile } from './config.js';
import { runPairCli } from './e2ee.js';
import { loopWatchdogSeconds, startLoopWatchdog } from './loop-watchdog.js';
import { startChildNice } from './child-nice.js';
import { EDITION_MARKER } from './edition.js';
import { runPolicyCli } from './policy-cli.js';
import { closeUploads } from './rpc-dispatch.js';

// If the agent was launched from inside an editor's Claude environment (a VSCode
// terminal, a Claude Code Bash tool), it inherits CLAUDE_CODE_ENTRYPOINT —
// and every `claude` child the SDK spawns re-registers its liveness file with
// that entrypoint (e.g. "claude-vscode"). The single-writer yield guard exempts
// only entrypoints it recognises as our own, so a poisoned value makes a run
// yield AGAINST ITSELF seconds after starting. Session runs now pin the value
// explicitly (OWN_ENTRYPOINT in sessions.ts); this still covers every other
// `claude` we spawn for product sessions, so keep it.
delete process.env['CLAUDE_CODE_ENTRYPOINT'];

// Stay alive through transient faults (e.g. node-pty helper hiccups on Windows,
// transient SDK/stream errors). A daemon must not die on a stray exception.
process.on('uncaughtException', (err) => {
  console.error('[agent] uncaughtException:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[agent] unhandledRejection:', reason);
});

// Publish our pid where a supervisor can read it across a session boundary —
// see `pidFile()` for why the obvious command-line scan does not work. Written
// before the client starts: the window this closes is exactly «supervisor polls
// while the agent is still coming up».
// `--self-test`: the whole module graph above has already loaded and linked
// against this machine's node_modules by the time this line runs, which is the
// thing a self-update needs to know before it swaps a bundle in. Say so and
// leave before touching the pid file or the network.
if (process.argv.includes('--self-test')) {
  console.log(`self-test ok ${AGENT_VERSION} ${EDITION_MARKER}`);
  process.exit(0);
}

// `policy …`: the owner's switches (policy-cli.ts). A one-shot command, not a
// daemon — it must not claim the pid file or dial the hub.
if (process.argv[2] === 'policy') {
  process.exit(runPolicyCli(process.argv.slice(3)));
}

// `--pair [--rotate]`: print the code that pairs a device with a private
// machine (e2ee.ts). One-shot, like `policy`.
if (process.argv[2] === '--pair' || process.argv[2] === 'pair') {
  process.exit(runPairCli(process.argv.slice(3), loadConfig().machineId));
}

writePidFile();
process.on('exit', () => releasePidFile());

// A process that is alive but whose event loop has stopped is invisible to
// every supervisor we have — and it happened twice on the Mac mini. See
// loop-watchdog.ts; `CC_REMOTE_LOOP_WATCHDOG_SEC=0` turns it off.
startLoopWatchdog({ stallSec: loopWatchdogSeconds() });

// Sessions' builds and tests must not starve the agent's own event loop (history
// reads, replication, the hub socket). See child-nice.ts; `CC_REMOTE_CHILD_NICE=0`
// turns it off.
startChildNice();

const client = new AgentClient();
// The hub hands a machineId to one process at a time. A daemon it supersedes
// exits here instead of reconnecting — see `agent_superseded`. Same quarter
// second as a signal shutdown, for the same reason: the goodbye frames need a
// tick to leave.
client.onStandDown = () => setTimeout(() => process.exit(0), 250);
client.onRestartForUpdate = () => setTimeout(() => process.exit(0), 500);
void client.start();

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    console.log(`\n[agent] ${sig} — shutting down`);
    client.stop();
    // Exiting in the same tick closed the socket with the goodbye frames still
    // queued, so the restart stayed invisible to whoever was watching the run.
    // A quarter-second is free: systemd waits 90s for a stop by default. The
    // upload handles (and their `.part` files) are closed in that same window
    // — awaited, so a slow disk gets up to a second, never more.
    const goodbye = new Promise<void>((done) => setTimeout(done, 250));
    const uploads = closeUploads().catch(() => undefined);
    const ceiling = new Promise<void>((done) => setTimeout(done, 1_000));
    void Promise.race([Promise.all([goodbye, uploads]), ceiling]).then(() => process.exit(0));
  });
}
