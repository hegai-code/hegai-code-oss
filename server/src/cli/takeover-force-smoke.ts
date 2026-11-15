/**
 * Force-takeover smoke: covers the KILL-AND-CONFIRM branch of the agent's
 * takeoverRun — the invariant-critical path that releases a live editor writer
 * before resuming as the sole writer (single-writer rule).
 *
 * Simulates the "live in an editor" state the same way yield-smoke does: spawn
 * a harmless long-lived child process, write a fake ~/.claude/sessions/<pid>.json
 * claiming a dormant session with the child's pid, rescan until the snapshot
 * shows the session live, then send 'takeover'. PASS requires: the child pid is
 * actually killed, the resumed run streams a reply, and the run reaches idle.
 *
 * Usage: tsx server/src/cli/takeover-force-smoke.ts [ws://127.0.0.1:4319] [token] [machineFilter=os.hostname()]
 * Env fallbacks: CC_SMOKE_URL, CC_REMOTE_TOKEN, CC_SMOKE_MACHINE.
 * NOTE: must target the LOCAL machine — the fake sessions file and the child
 * process live on THIS host, so only the local agent can see (and kill) them.
 */
import os from 'node:os';
import { spawn, type ChildProcess } from 'node:child_process';
import { rmSync } from 'node:fs';
import { decodeCentralToBrowser, type MachineSnapshot } from '@cc-remote/shared';
import { connectUi, machineFilterArg, pickSession, dormantWithCwd, writeFakeLiveSession } from './_harness.js';

const { ws, send } = connectUi(process.argv);
const machineFilter = machineFilterArg(process.argv, os.hostname());

let child: ChildProcess | undefined;
let fakeFile: string | undefined;
let targetSessionId = '';
let started = false;
let takenOver = false;
let done = false;
let runId: string | undefined;
let childDead = false;
let sawReply = false;
let rescanTimer: NodeJS.Timeout | undefined;

function cleanup(): void {
  if (rescanTimer) clearInterval(rescanTimer);
  if (fakeFile) {
    try { rmSync(fakeFile); } catch { /* ignore */ }
  }
  if (child?.pid && !childDead) {
    try { process.kill(child.pid); } catch { /* already gone */ }
  }
}
process.on('exit', cleanup);

function finish(ok: boolean, why: string): void {
  if (done) return;
  done = true;
  console.log(`\n=== RESULT ===`);
  console.log(ok ? `PASS — ${why}` : `FAIL — ${why}`);
  cleanup();
  if (runId) send({ type: 'close', runId });
  setTimeout(() => process.exit(ok ? 0 : 1), 300);
}

ws.on('open', () => console.log('[force-smoke] connected to /ui'));

ws.on('message', (data: Buffer) => {
  const msg = decodeCentralToBrowser(data.toString());
  switch (msg.type) {
    case 'snapshot': {
      if (!started) {
        started = true;
        begin(msg.machines);
        break;
      }
      if (takenOver || !child?.pid) break;
      const pid = child.pid;
      // Waiting for the agent's rescan to report our fake writer as live.
      const target = msg.machines
        .flatMap((m) => m.sessions.map((s) => ({ machineId: m.machine.machineId, s })))
        .find((x) => x.s.sessionId === targetSessionId);
      if (target && target.s.livePid === pid) {
        takenOver = true;
        if (rescanTimer) clearInterval(rescanTimer);
        console.log(`[force-smoke] session now live (pid ${pid}) — sending takeover`);
        send({
          type: 'takeover',
          machineId: target.machineId,
          sessionId: targetSessionId,
          message: 'Reply with exactly: FORCE-OK (no tools)',
        });
        // The agent must SIGTERM the fake writer before resuming; watch it die.
        const poll = setInterval(() => {
          try {
            process.kill(pid, 0);
          } catch {
            childDead = true;
            console.log(`[force-smoke] child pid ${pid} is dead (writer released)`);
            clearInterval(poll);
          }
        }, 250);
        poll.unref();
      }
      break;
    }
    case 'opened':
      runId = msg.runId;
      console.log(`[force-smoke] opened run ${runId}`);
      break;
    case 'stream':
      if (msg.event.kind === 'partial' || msg.event.kind === 'assistant') {
        if ((msg.event.text ?? '').trim()) sawReply = true;
        if (msg.event.kind === 'partial') process.stdout.write(msg.event.text ?? '');
      } else {
        console.log(`\n[force-smoke] [${msg.event.kind}] ${msg.event.text ?? ''}`);
      }
      break;
    case 'tool_request':
      if (runId) send({ type: 'tool_decision', runId, requestId: msg.requestId, allow: false, message: 'smoke deny' });
      break;
    case 'run_status':
      console.log(`\n[force-smoke] run_status: ${msg.state}${msg.error ? ` (${msg.error})` : ''}`);
      if (msg.state === 'error') finish(false, `run errored: ${msg.error ?? 'unknown'}`);
      else if (msg.state === 'idle' || msg.state === 'ended') {
        if (childDead && sawReply) finish(true, 'writer killed, reply streamed, run idle');
        else finish(false, `${childDead ? '' : 'child pid still alive; '}${sawReply ? '' : 'no reply streamed; '}state=${msg.state}`);
      }
      break;
    case 'error':
      finish(false, `hub error: ${msg.message}`);
  }
});

function begin(machines: MachineSnapshot[]): void {
  // Optional session pin (argv[5] / CC_SMOKE_SESSION, id prefix ok): the default
  // "most recent dormant" pick tends to hit whatever the human touched last —
  // on a dev machine that session can get re-opened in the editor mid-smoke.
  const sessionPin = process.argv[5] ?? process.env['CC_SMOKE_SESSION'];
  const pred = sessionPin
    ? (s: Parameters<typeof dormantWithCwd>[0]) => dormantWithCwd(s) && s.sessionId.startsWith(sessionPin)
    : dormantWithCwd;
  const hit = pickSession(machines, machineFilter, pred);
  if (!hit) {
    console.log(`FAIL: no dormant cwd session on a machine matching "${machineFilter}"${sessionPin ? ` with id ${sessionPin}*` : ''}`);
    process.exit(1);
  }
  const { machine: m, session: sess } = hit;
  targetSessionId = sess.sessionId;
  console.log(`[force-smoke] target: ${m.machine.name} session ${sess.sessionId.slice(0, 8)}`);

  // Harmless long-lived stand-in for the editor's writer process.
  child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1e9)'], { stdio: 'ignore' });
  child.unref();
  if (!child.pid) {
    console.log('FAIL: could not spawn child process');
    process.exit(1);
  }
  fakeFile = writeFakeLiveSession(child.pid, sess.sessionId);
  console.log(`[force-smoke] wrote fake live record ${fakeFile} (pid ${child.pid})`);

  // Nudge the agent until the snapshot reflects the fake writer.
  send({ type: 'rescan', machineId: m.machine.machineId });
  rescanTimer = setInterval(() => send({ type: 'rescan', machineId: m.machine.machineId }), 2000);
  rescanTimer.unref();
}

ws.on('error', (e) => {
  console.error('[force-smoke] ws error:', (e as Error).message);
  cleanup();
  process.exit(1);
});

setTimeout(() => {
  console.error('[force-smoke] timeout');
  cleanup();
  process.exit(1);
}, 120_000).unref();
