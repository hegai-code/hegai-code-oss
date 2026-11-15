/**
 * agent-run: drive ONE Claude/Codex session on a fleet machine from here.
 *
 * `term-run.ts` gives a shell on a machine we cannot SSH to; this gives an
 * AGENT SESSION on the same in-band route — open a new session in a chosen
 * directory, with a chosen model/effort/permission mode, stream its output back
 * verbatim, answer its tool requests by a declared policy, and (optionally)
 * keep handing it follow-up turns. It exists because a long build like the iOS
 * rebuild is run by an agent ON the Mac mini, and the orchestrator lives here.
 *
 * This ACTS AS a person, exactly as term-run does: the hub session is minted
 * with the hub's own SSO secret for `CC_SMOKE_ADMIN_ID`, and the audit log
 * records the session under their name. Use it at that person's request.
 *
 *   CC_SMOKE_URL=wss://code.acme.test \
 *   CC_REMOTE_SSO_SECRET=<hub's> CC_SMOKE_ADMIN_ID=<id> CC_SMOKE_ADMIN_EMAIL=<email> \
 *   tsx server/src/cli/agent-run.ts --machine dev-mac-mini-001 --cwd /tmp/hegai-rebuild \
 *     --model opus --effort high --permission-mode acceptEdits \
 *     --allow-file /tmp/allow.txt --idle-exit --prompt-file /tmp/phase0.md
 *
 * TOOL POLICY (`--allow-file`, one prefix per line, `#` comments):
 *   Edit/Write/Read/Glob/Grep are allowed when every path argument sits under
 *   `--cwd`; Bash is allowed only when the command matches a line of the allow
 *   file as a literal prefix. Everything else is DENIED with a message telling
 *   the agent to ask the orchestrator. There is deliberately no "allow because
 *   the cwd looks right" rule for Bash: a shell line can carry `git -C`, a
 *   redirect, a symlink or an external script, so the cwd proves nothing.
 *   Without `--allow-file` every tool request is denied (safe default).
 *
 * RECONNECT: a dropped socket is re-dialled and the run is re-SUBSCRIBED, never
 * re-started — `new_session` twice would be two sessions and, worse, two
 * writers. If the run is gone after a reconnect the CLI says so and exits 2
 * rather than quietly starting another one.
 *
 * RESUME (`--session <id>`): reopens an EXISTING session instead of starting a
 * new one. A socket reconnect is not the only way to lose a run — when the
 * machine's own agent restarts it comes back with an empty inventory, the hub
 * declares every run of the previous life errored, and the turn is gone while
 * the transcript on disk is not. That is the normal end of a long phase on a
 * laptop, so picking the session back up has to be one flag rather than a
 * rewrite: the session keeps its history, and the prompt only has to say what
 * is left to do.
 *
 * Exit: 0 when the run reached a non-error terminal state (or `--idle-exit` and
 * the turn went idle), 2 on a refused/errored run, 1 on a usage/transport error.
 */
import { readFileSync } from 'node:fs';
import { decodeCentralToBrowser, type BrowserToCentral } from '@cc-remote/shared';
import { adminLogin, connectUiAs, fail, nextBrowserFrame, sendUi, sleep, smokeTarget, type SsoSession } from './_harness.js';
import type { WebSocket } from 'ws';

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const has = (name: string): boolean => argv.includes(name);

const machineWanted = flag('--machine') ?? fail('--machine <name|id> is required');
/** Resume this session instead of starting a new one (`open`, not `new_session`). */
const resumeSession = flag('--session');
/** Watch a run that is already going, read-only — no prompt, no writer claim. */
const attachOnly = process.argv.includes('--attach');
/**
 * Go in by force: kill whatever writes this session, then resume.
 *
 * Needed because "the hub says a run is active" is not the same as "something
 * is writing". A run record outlives its process — the writer can die without
 * the run being closed — and then `input` is delivered to nobody at all. That
 * state is indistinguishable from a busy session from the outside, and it cost
 * an evening: three separate prompts went into a run whose process had been
 * gone for an hour.
 *
 * Check on the MACHINE that nobody is writing before reaching for this: the
 * whole single-writer invariant exists because two writers corrupt a
 * transcript, and this flag is the one sanctioned way past it.
 */
const forceTakeover = process.argv.includes('--takeover');
const cwd = resumeSession
  ? (flag('--cwd') ?? '/')
  : (flag('--cwd') ?? fail('--cwd <dir on that machine> is required'));
const model = flag('--model');
const effort = flag('--effort') as 'low' | 'medium' | 'high' | 'xhigh' | undefined;
const permissionMode = flag('--permission-mode') as
  | 'default' | 'plan' | 'acceptEdits' | 'bypassPermissions' | 'dontAsk' | 'auto' | undefined;
const source = flag('--source') as 'claude' | 'codex' | undefined;
const category = flag('--category');
const allowFile = flag('--allow-file');
const idleExit = has('--idle-exit');
const maxMinutes = Number(flag('--max-minutes') ?? '180');

const promptFile = flag('--prompt-file');
const promptArg = flag('--prompt');
const prompt = promptFile ? readFileSync(promptFile, 'utf8') : promptArg;
if (!prompt && !attachOnly) fail('--prompt <text> or --prompt-file <path> is required');
if (attachOnly && !resumeSession) fail('--attach needs --session <id>: it watches an existing run rather than starting one');

/** Bash command prefixes the agent may run unattended. */
const bashAllow: string[] = allowFile
  ? readFileSync(allowFile, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
  : [];

/** Tools whose path arguments are checked against --cwd instead of a prefix list. */
const PATH_TOOLS = new Set(['Edit', 'Write', 'Read', 'NotebookEdit', 'Glob', 'Grep', 'MultiEdit']);
const PATH_KEYS = ['file_path', 'path', 'notebook_path'];

function decide(tool: string, input: Record<string, unknown>): { allow: boolean; why: string } {
  if (PATH_TOOLS.has(tool)) {
    const paths = PATH_KEYS.map((k) => input[k]).filter((v): v is string => typeof v === 'string');
    // Glob/Grep may carry no path at all — they then run in the session cwd.
    if (paths.length === 0) return { allow: true, why: 'no explicit path (runs in session cwd)' };
    const outside = paths.filter((p) => !p.startsWith(`${cwd}/`) && p !== cwd);
    if (outside.length > 0) return { allow: false, why: `path outside ${cwd}: ${outside.join(', ')}` };
    return { allow: true, why: `under ${cwd}` };
  }
  if (tool === 'Bash') {
    const command = typeof input['command'] === 'string' ? input['command'] : '';
    const hit = bashAllow.find((p) => command.startsWith(p));
    if (hit) return { allow: true, why: `matches allow prefix «${hit}»` };
    return { allow: false, why: 'no allow-file prefix matches this command' };
  }
  if (tool === 'TodoWrite' || tool === 'Task') return { allow: true, why: 'bookkeeping tool' };
  return { allow: false, why: `tool ${tool} is not in the policy` };
}

const target = smokeTarget([process.argv[0]!, process.argv[1]!]);
const hardStop = setTimeout(() => {
  console.error(`[agent-run] hard timeout after ${maxMinutes} min`);
  process.exit(1);
}, maxMinutes * 60_000);
hardStop.unref();

let runId: string | undefined;
let sessionId: string | undefined;
let machineId: string | undefined;
let sawStream = false;
let finished = false;

function report(state: string, why: string): void {
  if (finished) return;
  finished = true;
  clearTimeout(hardStop);
  console.log(`\n[agent-run] ${state}: ${why}`);
  console.log(`[agent-run] session ${sessionId ?? '(none)'} on ${machineWanted}, run ${runId ?? '(none)'}`);
  process.exit(state === 'DONE' ? 0 : 2);
}


/**
 * The runId of a session's live run, from the snapshot.
 *
 * `activeRuns` hangs off the SNAPSHOT, not off the machine and not off the
 * session — the board and the attention counter read the fleet's open runs as
 * one list. Looking for it under the machine finds nothing and reads exactly
 * like "no live run", which is the opposite of the truth.
 */
function findActiveRun(snap: unknown, sessionId: string): string | undefined {
  const runs = (snap as { activeRuns?: { runId?: string; sessionId?: string }[] }).activeRuns ?? [];
  return runs.find((r) => r.sessionId === sessionId)?.runId;
}

/** Wire one socket's frames to the run: stream out, tools decided, status read. */
function attach(ws: WebSocket): void {
  ws.on('message', (raw: Buffer) => {
    let msg;
    try {
      msg = decodeCentralToBrowser(raw.toString());
    } catch {
      return;
    }
    switch (msg.type) {
      case 'opened':
        runId = msg.runId;
        sessionId = msg.sessionId || sessionId;
        console.log(`[agent-run] run ${runId} opened`);
        break;
      case 'session_started':
        if (msg.runId !== runId) break;
        sessionId = msg.sessionId;
        console.log(`[agent-run] session id ${sessionId}`);
        break;
      case 'stream': {
        if (msg.runId !== runId) break;
        const ev = msg.event;
        if (ev.kind === 'partial' || ev.kind === 'assistant') sawStream = true;
        if (ev.kind === 'partial') process.stdout.write(ev.text ?? '');
        else if (ev.kind === 'result') console.log(`\n[agent-run] ■ ${ev.text ?? ''}`);
        else console.log(`\n[agent-run] [${ev.kind}${ev.code ? `/${ev.code}` : ''}] ${(ev.text ?? '').slice(0, 400)}`);
        break;
      }
      case 'tool_request': {
        if (msg.runId !== runId) break;
        const { allow, why } = decide(msg.tool, msg.input);
        const shown = JSON.stringify(msg.input).slice(0, 200);
        console.log(`\n[agent-run] tool ${msg.tool} ${allow ? 'ALLOW' : 'DENY'} (${why}) ${shown}`);
        sendUi(ws, {
          type: 'tool_decision',
          runId: msg.runId,
          requestId: msg.requestId,
          allow,
          message: allow ? undefined : `Denied by the orchestrator: ${why}. Ask the orchestrator instead of retrying.`,
        } as BrowserToCentral);
        break;
      }
      case 'run_status': {
        if (msg.runId !== runId) break;
        console.log(`\n[agent-run] run_status ${msg.state}${msg.error ? ` (${msg.error})` : ''}${msg.code ? ` [${msg.code}]` : ''}`);
        if (msg.state === 'error') report('FAILED', msg.error ?? 'run errored');
        else if (msg.state === 'ended') report(sawStream ? 'DONE' : 'FAILED', 'run ended');
        else if (msg.state === 'yielded') report('FAILED', 'run yielded — another writer took the session');
        else if (msg.state === 'idle' && idleExit) report(sawStream ? 'DONE' : 'FAILED', 'turn finished (idle)');
        break;
      }
      case 'error':
        console.log(`\n[agent-run] hub error: ${msg.message}`);
        break;
    }
  });
}

async function connect(me: SsoSession): Promise<WebSocket> {
  const ws = await connectUiAs(target.ws, me);
  attach(ws);
  return ws;
}

async function main(): Promise<void> {
  if (!target.ssoSecret) fail('CC_REMOTE_SSO_SECRET is not set (must match the hub)');
  const me = await adminLogin(target.http, target.ssoSecret);
  console.log(`[agent-run] signed in as ${me.userId} on ${target.http}`);
  if (bashAllow.length === 0) console.log('[agent-run] no --allow-file: every Bash request will be denied');

  let ws = await connect(me);
  sendUi(ws, { type: 'hello', client: 'web' } as BrowserToCentral);
  const snap = await nextBrowserFrame(ws, 'snapshot', () => true, 20_000);
  const found = snap.machines.find(
    (m) => m.machine.machineId === machineWanted || m.machine.name === machineWanted,
  );
  if (!found) {
    fail(`no machine «${machineWanted}»; have: ${snap.machines.map((m) => `${m.machine.name} (${m.online ? 'online' : 'offline'})`).join(', ')}`);
  }
  if (!found.online) fail(`${found.machine.name} is offline right now`);
  machineId = found.machine.machineId;

  // ATTACH: watch a run that is ALREADY going, without becoming its writer.
  // A client dying does not stop the work — the agent holds the run — so the
  // usual way back in is to find that run in the snapshot and subscribe. It has
  // to be `subscribe` and not `open`: the hub refuses `open` for a session that
  // has a live writer, and rightly so, since two writers corrupt one transcript.
  if (attachOnly) {
    const activeRun = findActiveRun(snap, resumeSession!);
    if (!activeRun) fail(`session ${resumeSession} has no live run on ${found.machine.name} — it has finished or died; use --session to resume it with a prompt`);
    runId = activeRun;
    sessionId = resumeSession!;
    console.log(`[agent-run] attaching to live run ${runId} of session ${resumeSession} — read-only, not taking the writer`);
    sendUi(ws, { type: 'subscribe', runId } as BrowserToCentral);
  } else {
  // The hub answers a refused open with an `error` frame and nothing else, so
  // waiting for `opened` alone turns a clear refusal into a blind timeout. Race
  // the two and say which arrived.
  const openOrRefusal = async (): Promise<string | null> =>
    Promise.race([
      nextBrowserFrame(ws, 'opened', () => true, 60_000).then(() => null),
      nextBrowserFrame(ws, 'error', () => true, 60_000).then(
        (f) => String((f as { message?: unknown }).message ?? 'refused'),
      ),
    ]);
  let openedAck: Promise<string | null> | Promise<unknown> = openOrRefusal();
  if (resumeSession) {
    sessionId = resumeSession;
    console.log(`[agent-run] ${found.machine.name} (${found.machine.os}) online — resuming session ${resumeSession}`);
    sendUi(ws, { type: 'open', machineId, sessionId: resumeSession, message: prompt } as BrowserToCentral);
    const refusal = await openedAck as string | null;
    if (refusal) {
      // "Session is live in X (pid N); refusing to open a second writer." — the
      // hub is right to refuse, and usually right about the writer too: after a
      // dropped run the child often outlives the run that owned it. Its own
      // inventory can also be stale by seconds. Either way the sanctioned way
      // in is the one the product already has — kill the writers, confirm they
      // are gone, resume — and the session being killed here is OUR phase's.
      if (forceTakeover) {
        console.log(`[agent-run] хаб отказал: ${refusal}`);
        console.log('[agent-run] --takeover: забираю сессию силой');
        openedAck = openOrRefusal();
        sendUi(ws, { type: 'takeover', machineId, sessionId: resumeSession, message: prompt } as BrowserToCentral);
        const forced = await openedAck as string | null;
        if (forced) fail(`перехват отклонён: ${forced}`);
      } else if (/already has an active run/i.test(refusal)) {
        // The previous client lost its socket; the RUN did not stop. Nothing to
        // resume and nothing to kill — the phase is still being worked on, so
        // the honest move is to watch it to the end rather than fight the hub
        // for a session that is already busy doing what we asked.
        const live = findActiveRun(snap, resumeSession);
        if (!live) fail(`хаб говорит «прогон уже идёт», но в снимке его нет — подожди и повтори`);
        runId = live;
        // A run stays OPEN after its turn goes idle: `--idle-exit` ends the
        // client, not the run. So "already has an active run" covers two very
        // different states, and the difference decides whether a prompt is
        // delivered or silently dropped.
        //
        // Watching is right only when there is nothing to say. With a prompt in
        // hand the honest move is the one the browser makes: speak into the run
        // that is already there. Attaching and staying quiet looked identical
        // to working — the client sat there for minutes reporting a healthy
        // connection while the task it was given had gone nowhere.
        sendUi(ws, { type: 'subscribe', runId } as BrowserToCentral);
        if (prompt) {
          console.log(`[agent-run] прогон ${runId} уже открыт — говорю в него, а не открываю заново`);
          sendUi(ws, { type: 'input', runId, text: prompt } as BrowserToCentral);
        } else {
          console.log(`[agent-run] прогон ${runId} ещё идёт — подключаюсь наблюдателем`);
        }
      } else if (/second writer|is live in/i.test(refusal)) {
        console.log(`[agent-run] хаб отказал: ${refusal}`);
        console.log('[agent-run] захожу перехватом — писатель этой сессии наш же, осиротевший');
        openedAck = openOrRefusal();
        sendUi(ws, { type: 'takeover', machineId, sessionId: resumeSession, message: prompt } as BrowserToCentral);
        const second = await openedAck as string | null;
        if (second) fail(`перехват тоже отклонён: ${second}`);
      } else {
        fail(`хаб отказал открыть сессию: ${refusal}`);
      }
    }
    openedAck = Promise.resolve(null);
  } else {
    console.log(`[agent-run] ${found.machine.name} (${found.machine.os}) online — starting a session in ${cwd}`);
    sendUi(ws, {
      type: 'new_session',
      machineId,
      cwd,
      message: prompt,
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      ...(permissionMode ? { permissionMode } : {}),
      ...(source ? { source } : {}),
      ...(category ? { category } : {}),
    } as BrowserToCentral);
  }
  await openedAck;
  }

  // Reconnect loop: re-dial and RE-SUBSCRIBE. Never re-send new_session — that
  // would be a second session and a second writer.
  ws.on('close', () => {
    if (finished) return;
    void (async () => {
      for (let attempt = 1; attempt <= 10 && !finished; attempt++) {
        await sleep(Math.min(30_000, 2_000 * attempt));
        try {
          ws = await connect(me);
          sendUi(ws, { type: 'hello', client: 'web' } as BrowserToCentral);
          await nextBrowserFrame(ws, 'snapshot', () => true, 20_000);
          if (!runId) return report('FAILED', 'socket dropped before the run was acknowledged');
          sendUi(ws, { type: 'subscribe', runId } as BrowserToCentral);
          console.log(`\n[agent-run] reconnected and re-subscribed to ${runId}`);
          return;
        } catch (e) {
          console.log(`[agent-run] reconnect ${attempt} failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      if (!finished) report('FAILED', 'could not reconnect to the hub');
    })();
  });
}

main().catch((e) => fail(e instanceof Error ? e.stack ?? e.message : String(e)));
