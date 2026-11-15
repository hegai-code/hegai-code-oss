/**
 * Start-time run settings: the three picks a start screen makes BEFORE a
 * session exists (`model`, `effort`, `permissionMode` on `new_session`).
 *
 * `run-settings-smoke.ts` covers the mid-session half of this — the `set_`
 * controls and their readback. This covers the half that cannot use them,
 * because there is no run to send them to yet, and it checks the two properties
 * that make the feature safe rather than merely present:
 *
 *   1. a session started WITH the three opens on them — the agent reports the
 *      model and effort back as `run_settings`, and `plan` as `run_mode`, so
 *      the picker is not claiming a setting the run never had
 *   2. a pick the wire does not recognise costs the PICK and not the SESSION.
 *      This is the one that matters: the agent parses `new_session` as a single
 *      zod object, so a field it refuses takes the whole start with it, and the
 *      browser sees a session that silently never appears. The hub drops what
 *      it cannot validate (`start_settings` in server-rs/src/hub.rs) — here we
 *      send junk on purpose and require a working session anyway.
 *
 * Starts NEW sessions in scratch cwds (never resumes one), so it is safe to run
 * against a dev hub on a machine that also carries a fleet agent.
 *
 * Usage: tsx server/src/cli/start-settings-smoke.ts [ws://127.0.0.1:4319] [token] [machineFilter]
 * Env fallbacks: CC_SMOKE_URL, CC_REMOTE_TOKEN, CC_SMOKE_MACHINE.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { decodeCentralToBrowser, type MachineSnapshot } from '@cc-remote/shared';
import { connectUi, machineFilterArg } from './_harness.js';

const { ws } = connectUi(process.argv);
const machineFilter = machineFilterArg(process.argv);

const checks = {
  'a session opens on the picked model': false,
  'a session opens on the picked effort': false,
  'a session opens in the picked mode': false,
  'an unrecognised pick does not cost the session': false,
};

/** Which phase we are in: the honest picks, then the junk ones. */
let phase: 'good' | 'junk' | 'done' = 'good';
let started = false;
let machineId: string | null = null;
/** The run each phase is watching. Set by the empty-id `opened` ack. */
let runId: string | null = null;

/** A model every Claude machine answers to, and an effort every model takes. */
const WANT_MODEL = 'sonnet';
const WANT_EFFORT = 'high';

function scratch(tag: string): string {
  return mkdtempSync(path.join(tmpdir(), `cc-start-${tag}-`));
}

/**
 * Sent RAW rather than through the harness's typed `send`.
 *
 * Deliberate: half this smoke's job is to send what a typed client could never
 * produce — a mode off the enum, a model of the wrong type — because that is
 * exactly what an older build or a hand-made frame looks like, and it is the
 * case the hub's validation exists for. Typing the call would make the test
 * unable to express its own subject.
 */
function openSession(fields: Record<string, unknown>): void {
  if (!machineId) return;
  ws.send(JSON.stringify({ type: 'new_session', machineId, cwd: scratch(phase), ...fields }));
}

ws.on('open', () => console.log('[start-settings-smoke] connected'));
ws.on('message', (data: Buffer) => {
  const msg = decodeCentralToBrowser(data.toString());
  switch (msg.type) {
    case 'snapshot':
      if (started) break;
      started = true;
      start(msg.machines);
      break;

    case 'opened':
      // The hub acks a brand-new session with an empty session id; the agent
      // mints the real one later. The RUN id is what the settings arrive on.
      runId = msg.runId;
      break;

    case 'run_settings': {
      if (msg.runId !== runId || phase !== 'good') break;
      if (msg.model === WANT_MODEL) checks['a session opens on the picked model'] = true;
      if (msg.effort === WANT_EFFORT) checks['a session opens on the picked effort'] = true;
      maybeAdvance();
      break;
    }

    case 'run_mode':
      if (msg.runId !== runId || phase !== 'good') break;
      if (msg.mode === 'plan') checks['a session opens in the picked mode'] = true;
      maybeAdvance();
      break;

    case 'run_status':
      // Phase two asks only one question: does a session exist at all? A junk
      // pick must be dropped by the hub, never forwarded into a zod object the
      // agent will refuse whole.
      if (phase === 'junk' && msg.runId === runId && msg.state === 'started') {
        checks['an unrecognised pick does not cost the session'] = true;
        finish();
      }
      break;

    case 'error':
      console.error('[start-settings-smoke] hub refused:', msg.message);
      break;
  }
});

function start(machines: MachineSnapshot[]): void {
  const online = machines.filter(
    (m) => m.online && (!machineFilter || m.machine.machineId.includes(machineFilter)),
  );
  const target = online[0];
  if (!target) {
    console.error('[start-settings-smoke] no online machine to start on');
    process.exit(1);
  }
  machineId = target.machine.machineId;
  console.log(`[start-settings-smoke] machine ${machineId}`);
  // No message: the session opens and reports, without spending a turn. The
  // settings are applied at LAUNCH, so they are readable before any input.
  openSession({ model: WANT_MODEL, effort: WANT_EFFORT, permissionMode: 'plan' });
}

function maybeAdvance(): void {
  const good = [
    'a session opens on the picked model',
    'a session opens on the picked effort',
    'a session opens in the picked mode',
  ] as const;
  if (phase !== 'good' || !good.every((k) => checks[k])) return;
  phase = 'junk';
  runId = null;
  // Every field wrong in a different way: a mode off the enum, an effort the
  // CLI knows but our wire does not ('max'), and a model of the wrong type.
  openSession({ permissionMode: 'yolo', effort: 'max', model: 42 });
}

function finish(): void {
  phase = 'done';
  let ok = true;
  for (const [name, passed] of Object.entries(checks)) {
    console.log(`${passed ? '  ok ' : ' FAIL'} ${name}`);
    ok &&= passed;
  }
  ws.close();
  process.exit(ok ? 0 : 1);
}

setTimeout(() => {
  console.error('[start-settings-smoke] timed out');
  finish();
}, 90_000).unref?.();
