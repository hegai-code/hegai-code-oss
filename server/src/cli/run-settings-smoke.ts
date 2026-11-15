/**
 * Run-controls readback smoke. `set_model` and `set_effort` travel one way, so
 * for a long time the composer's pickers had nothing to read: every reload reset
 * them to "default" for a session that was on something else. `run_settings`
 * closes that loop, and this checks the whole of it against a live agent:
 *   1. models.list carries the alias mapping (`resolved`) and the effort levels
 *   2. a fresh run reports `activeModel` on its own — what "default" resolves to
 *   3. set_model / set_effort are echoed back as run_settings
 *   4. a LATE subscriber is replayed the current settings by the hub
 *   5. clearing the model reports it as absent, never null
 *
 * Starts a NEW session in a scratch cwd (never resumes one), so it is safe to
 * run against a dev hub on a machine that also carries a fleet agent.
 *
 * Usage: tsx server/src/cli/run-settings-smoke.ts [ws://127.0.0.1:4319] [token] [machineFilter]
 * Env fallbacks: CC_SMOKE_URL, CC_REMOTE_TOKEN, CC_SMOKE_MACHINE.
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { decodeCentralToBrowser, type ModelsResult, type MachineSnapshot } from '@cc-remote/shared';
import { connectUi, machineFilterArg } from './_harness.js';

const { ws, send } = connectUi(process.argv);
const machineFilter = machineFilterArg(process.argv);
const cwd = mkdtempSync(path.join(tmpdir(), 'cc-run-settings-'));
const modelsReq = randomUUID();
/** Second ask, once the run has named its model — see the note in `start`. */
const modelsReq2 = randomUUID();

const checks = {
  'models.list carries resolved + efforts': false,
  'a fresh run reports its active model': false,
  'set_model is echoed back': false,
  'set_effort is echoed back': false,
  'a late subscriber is replayed the settings': false,
  'clearing the model reports it absent, not null': false,
};

let started = false;
let runId: string | null = null;
let models: ModelsResult['models'] = [];
let machineId: string | null = null;
/** Which step's echo we are waiting for, so one handler can drive the sequence. */
let stage: 'active' | 'model' | 'effort' | 'replay' | 'clear' | 'done' = 'active';

ws.on('open', () => console.log('[run-settings-smoke] connected'));
ws.on('message', (data: Buffer) => {
  const msg = decodeCentralToBrowser(data.toString());
  switch (msg.type) {
    case 'snapshot':
      if (!started) {
        started = true;
        void start(msg.machines);
      }
      break;
    case 'rpc_response':
      if (msg.requestId !== modelsReq && msg.requestId !== modelsReq2) break;
      models = (msg.result as ModelsResult | undefined)?.models ?? [];
      checks['models.list carries resolved + efforts'] ||=
        models.some((m) => !!m.resolved) && models.some((m) => !!m.efforts?.length);
      console.log(`[run-settings-smoke] models: ${models.map((m) => m.id).join(', ')}`);
      break;
    case 'opened':
      runId = msg.runId;
      console.log(`[run-settings-smoke] run ${runId} opened in ${cwd}`);
      break;
    case 'run_settings': {
      const shown = JSON.stringify(msg);
      console.log(`[run-settings-smoke] <- ${shown}`);
      if (stage === 'active' && msg.activeModel) {
        checks['a fresh run reports its active model'] = true;
        stage = 'model';
        // The agent learns the runtime's model list on the same context poll
        // that names the model, so an earlier ask can only get the fallback —
        // which is why the web re-asks at exactly this point too.
        if (machineId) send({ type: 'rpc_request', requestId: modelsReq2, machineId, method: 'models.list', params: {} });
        // Pick any row that is not the runtime's own "default".
        const pick = models.find((m) => m.id !== 'default');
        if (pick && runId) send({ type: 'set_model', runId, model: pick.id });
        else finish();
      } else if (stage === 'model' && msg.model) {
        checks['set_model is echoed back'] = true;
        stage = 'effort';
        if (runId) send({ type: 'set_effort', runId, effort: 'low' });
      } else if (stage === 'effort' && msg.effort === 'low') {
        checks['set_effort is echoed back'] = true;
        stage = 'replay';
        // A reload, in miniature: drop the subscription and take it again. The
        // hub must hand the settings back without the agent saying anything.
        if (runId) {
          send({ type: 'unsubscribe', runId });
          send({ type: 'subscribe', runId });
        }
      } else if (stage === 'replay') {
        checks['a late subscriber is replayed the settings'] =
          msg.effort === 'low' && !!msg.model;
        stage = 'clear';
        if (runId) send({ type: 'set_model', runId });
      } else if (stage === 'clear') {
        checks['clearing the model reports it absent, not null'] =
          !('model' in msg) || msg.model === undefined;
        finish();
      }
      break;
    }
    case 'error':
      console.log(`[run-settings-smoke] hub error: ${msg.message}`);
      break;
  }
});

async function start(machines: MachineSnapshot[]): Promise<void> {
  const m = machines.find(
    (x) =>
      x.online &&
      (!machineFilter || x.machine.name.toLowerCase().includes(machineFilter.toLowerCase())),
  );
  if (!m) {
    console.log('[run-settings-smoke] no online machine — nothing to test');
    ws.close();
    process.exitCode = 1;
    return;
  }
  console.log(`[run-settings-smoke] machine ${m.machine.name}`);
  machineId = m.machine.machineId;
  send({ type: 'rpc_request', requestId: modelsReq, machineId: m.machine.machineId, method: 'models.list', params: {} });
  send({ type: 'new_session', machineId: m.machine.machineId, cwd });
  // A runtime that never reports (too old, or a source with no init message)
  // must not hang the smoke.
  setTimeout(() => finish(), 90_000);
}

function finish(): void {
  if (stage === 'done') return;
  stage = 'done';
  // Always release the session — a run left open holds the hub's writer lock.
  if (runId) send({ type: 'close', runId });
  setTimeout(() => {
    console.log('\n=== RESULT ===');
    let ok = true;
    for (const [name, pass] of Object.entries(checks)) {
      if (!pass) ok = false;
      console.log(`  [${pass ? 'PASS' : 'FAIL'}] ${name}`);
    }
    console.log(ok ? '\nRUN SETTINGS OK' : '\nFAIL');
    if (!ok) process.exitCode = 1;
    ws.close();
  }, 1000);
}
