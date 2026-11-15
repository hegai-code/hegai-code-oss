/**
 * Private machine (docs/E2EE.md), end to end: a THROWAWAY hub and a REAL agent
 * whose `policy.json` says `{"private": true}`, on a synthetic home with one
 * synthetic session. It answers the only question that matters:
 *
 *   - what the hub stores and relays for a private machine is ciphertext
 *     (the marker text appears NOWHERE in the hub's database, WAL or log, nor
 *     in a single frame a viewer without the key receives);
 *   - a viewer WITH the key (the pairing code the agent prints, opened by the
 *     web's own WebCrypto code) reads the history, a directory listing and a
 *     file;
 *   - a viewer WITHOUT the key gets envelopes and the placeholder title;
 *   - plaintext sent into a private machine is refused by the hub;
 *   - a FORGED hub (a stand-in speaking the agent protocol) that adds its own
 *     clear `data`/`text` to a genuine envelope, or replays an envelope, gets
 *     nothing typed into the terminal and no turn started.
 *
 *   npm run build --workspace shared && cargo build --manifest-path server-rs/Cargo.toml
 *   npx tsx server/src/cli/private-machine-smoke.ts
 *
 * Everything lives under /tmp/ccr-private-smoke (removed at the end). No real
 * transcript, token or network is touched. deploy/SMOKE-TESTS.md,
 * «private-machine-smoke».
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { WebSocketServer, type WebSocket as Ws } from 'ws';
import {
  aadFor,
  withMachine,
  collectOpen,
  collectOpenSummary,
  collectSeal,
  decodeCentralToBrowser,
  parsePairingCode,
  type E2eEnvelope,
  type MachineSnapshot,
} from '@cc-remote/shared';
import { connectUi, fail, rpc, sleep, step } from './_harness.js';

const ROOT = '/tmp/ccr-private-smoke';
const HOME = path.join(ROOT, 'home');
const STATE = path.join(ROOT, 'state');
const PROJECT = path.join(ROOT, 'proj');
const DB = path.join(ROOT, 'hub.sqlite3');
const PORT = 4392;
const BASE = `ws://127.0.0.1:${PORT}`;
const TOKEN = 'dev-token';
const MACHINE = 'private-smoke';

// Synthetic. Appears in the transcript and in a file; must never reach the hub.
const MARK_CHAT = 'SYNTHETIC-CHAT-MARKER-7f3a9c';
const MARK_FILE = 'SYNTHETIC-FILE-MARKER-51d0e2';
const MARK_TITLE = 'SYNTHETIC-TITLE-MARKER-aa91';

const repo = path.resolve(import.meta.dirname, '../../..');
const children: ChildProcess[] = [];

// The paired viewer, written independently of the agent's own cipher: the same
// envelope (AES-256-GCM, kid as AAD) opened with plain Node crypto and the
// shared traversal. The web's WebCrypto is held to the same bytes by
// shared/test/e2e-vectors.json.
type Frame = Record<string, unknown>;
/** The machine every envelope is bound to; the agent under test announces it. */
let AAD_MACHINE = '';
function openEnvelope(key: Buffer, env: E2eEnvelope, bind: string): unknown {
  const raw = Buffer.from(env.c, 'base64');
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(env.n, 'base64'));
  d.setAAD(Buffer.from(aadFor(env.kid, withMachine(AAD_MACHINE, bind))));
  d.setAuthTag(raw.subarray(raw.length - 16));
  return JSON.parse(Buffer.concat([d.update(raw.subarray(0, raw.length - 16)), d.final()]).toString('utf8'));
}
function openFor(key: Buffer, frame: Frame): Frame {
  const { frame: out, jobs } = collectOpen(frame, { dir: 'a2c' });
  for (const j of jobs) j.put(openEnvelope(key, j.env, j.bind));
  return out;
}
/** What a paired client sends to the agent: content sealed client-to-agent. */
function clientSeal(key: Buffer, frame: Frame, epoch: string): Frame {
  const kid = createHash('sha256').update(key).digest('hex').slice(0, 16);
  const { frame: out, jobs } = collectSeal(frame, { dir: 'c2a', epoch });
  for (const j of jobs) {
    const nonce = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', key, nonce);
    c.setAAD(Buffer.from(aadFor(kid, withMachine(AAD_MACHINE, j.bind))));
    const body = Buffer.concat([c.update(JSON.stringify(j.secret), 'utf8'), c.final(), c.getAuthTag()]);
    j.put({ e2e: 1, kid, n: nonce.toString('base64'), c: body.toString('base64') });
  }
  return out;
}
function openSummaryFor(key: Buffer, s: Frame): Frame {
  const { summary, jobs } = collectOpenSummary(s);
  for (const j of jobs) j.put(openEnvelope(key, j.env, j.bind));
  return summary;
}

function cleanup(): void {
  for (const c of children) {
    try {
      c.kill('SIGTERM');
    } catch {
      /* already gone */
    }
  }
}
process.on('exit', cleanup);

function seed(): string {
  rmSync(ROOT, { recursive: true, force: true });
  for (const d of [HOME, STATE, PROJECT]) mkdirSync(d, { recursive: true });
  writeFileSync(path.join(PROJECT, 'note.txt'), `${MARK_FILE} - a file the agent can list and read\n`);
  const sessionId = randomUUID();
  const dir = path.join(HOME, '.claude', 'projects', PROJECT.replace(/[/.]/g, '-'));
  mkdirSync(dir, { recursive: true });
  const now = Date.now();
  const base = { sessionId, cwd: PROJECT, version: '2.1.0', userType: 'external', isSidechain: false };
  const lines = [
    {
      ...base,
      type: 'user',
      uuid: randomUUID(),
      parentUuid: null,
      timestamp: new Date(now - 60_000).toISOString(),
      message: { role: 'user', content: `${MARK_TITLE}: please summarise the project (${MARK_CHAT})` },
    },
  ];
  const parent = lines[0]!.uuid;
  lines.push({
    ...base,
    type: 'assistant',
    uuid: randomUUID(),
    parentUuid: parent,
    timestamp: new Date(now - 50_000).toISOString(),
    message: {
      role: 'assistant',
      model: 'claude-synthetic',
      content: [{ type: 'text', text: `Here is the summary. ${MARK_CHAT}` }],
    },
  } as never);
  writeFileSync(path.join(dir, `${sessionId}.jsonl`), `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
  writeFileSync(path.join(STATE, 'policy.json'), JSON.stringify({ private: true }));
  return sessionId;
}

const agentEnv = (): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env['CC_REMOTE_DEFAULT_PERMISSION_MODE'];
  return {
    ...env,
    HOME,
    CC_REMOTE_STATE_DIR: STATE,
    CENTRAL_URL: BASE,
    CC_REMOTE_TOKEN: TOKEN,
    MACHINE_NAME: MACHINE,
    CC_REMOTE_AUTO_UPDATE: '0',
    CC_REMOTE_FILES_ROOTS: ROOT,
  };
};

function startHub(): void {
  const bin = path.join(repo, 'server-rs/target/debug/cc-remote-server');
  if (!existsSync(bin)) fail(`${bin} is missing - cargo build --manifest-path server-rs/Cargo.toml`);
  const log = path.join(ROOT, 'hub.log');
  writeFileSync(log, '');
  const child = spawn(bin, [], {
    cwd: repo,
    env: {
      ...process.env,
      CC_REMOTE_TOKEN: TOKEN,
      CC_REMOTE_SSO_SECRET: 'smoke-sso-secret-0123456789-0123456789',
      CC_REMOTE_PLATFORM_ADMIN_IDS: 'legacy-owner',
      CC_REMOTE_PUBLIC_URL: `http://127.0.0.1:${PORT}`,
      CC_REMOTE_DB_PATH: DB,
      PORT: String(PORT),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const append = (b: Buffer) => writeFileSync(log, b, { flag: 'a' });
  child.stdout?.on('data', append);
  child.stderr?.on('data', append);
  children.push(child);
}

function startAgent(): void {
  const log = path.join(ROOT, 'agent.log');
  writeFileSync(log, '');
  const child = spawn(process.execPath, ['--import', 'tsx', 'agent/src/main.ts'], {
    cwd: repo,
    env: agentEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const append = (b: Buffer) => writeFileSync(log, b, { flag: 'a' });
  child.stdout?.on('data', append);
  child.stderr?.on('data', append);
  children.push(child);
}

/** The code the machine's owner would read off the terminal. */
function pairingCode(): string {
  const r = spawnSync(process.execPath, ['--import', 'tsx', 'agent/src/main.ts', '--pair'], {
    cwd: repo,
    env: agentEnv(),
    encoding: 'utf8',
  });
  if (r.status !== 0) fail(`--pair failed: ${r.stderr}`);
  const code = r.stdout.split('\n').find((l) => l.startsWith('hcp1.'));
  if (!code) fail(`--pair printed no code: ${r.stdout}`);
  return code.trim();
}

/** Every file of the hub's database, byte for byte - what a stolen disk shows. */
function hubBytes(): Buffer[] {
  return readdirSync(ROOT)
    .filter((f) => f.startsWith('hub.sqlite3') || f === 'hub.log')
    .map((f) => readFileSync(path.join(ROOT, f)));
}

const countIn = (haystacks: Buffer[], needle: string): number =>
  haystacks.reduce((n, h) => n + (h.includes(needle) ? 1 : 0), 0);

/**
 * A hub that is the attacker. A second REAL private agent (same key, own state)
 * dials a stand-in server that speaks the hub's side of the protocol. The
 * stand-in has seen a genuine sealed terminal command go by, and now tries:
 * the envelope plus its own clear `data`; the same for `input`; and replaying
 * the genuine envelope. Only the genuine command, once, may run.
 */
async function forgedHubAttack(key: Buffer): Promise<void> {
  step('ATTACK: a forged hub replays a genuine envelope with its own clear payload');
  const FPORT = PORT + 1;
  const state2 = path.join(ROOT, 'state-forged');
  mkdirSync(state2, { recursive: true });
  copyFileSync(path.join(STATE, 'e2ee.key'), path.join(state2, 'e2ee.key'));
  writeFileSync(path.join(state2, 'policy.json'), JSON.stringify({ private: true }));

  const wss = new WebSocketServer({ port: FPORT });
  const got: Frame[] = [];
  let agent: Ws | undefined;
  wss.on('connection', (sock) => {
    agent = sock;
    sock.on('message', (d) => {
      try {
        got.push(JSON.parse(d.toString()) as Frame);
      } catch {
        /* ignore */
      }
    });
  });
  const log = path.join(ROOT, 'agent-forged.log');
  writeFileSync(log, '');
  const child = spawn(process.execPath, ['--import', 'tsx', 'agent/src/main.ts'], {
    cwd: repo,
    env: { ...agentEnv(), CC_REMOTE_STATE_DIR: state2, CENTRAL_URL: `ws://127.0.0.1:${FPORT}`, MACHINE_NAME: 'forged-smoke' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const append = (b: Buffer) => writeFileSync(log, b, { flag: 'a' });
  child.stdout?.on('data', append);
  child.stderr?.on('data', append);
  children.push(child);

  const until = async (what: string, ok: () => boolean, ms = 30_000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (ok()) return;
      await sleep(200);
    }
    fail(`timed out waiting for: ${what}`);
  };
  const tx = (f: Frame) => agent!.send(JSON.stringify(f));

  await until('the agent to register at the forged hub', () => got.some((f) => f['type'] === 'register'));
  const epochOf = (): string => {
    const reg = [...got].reverse().find((f) => f['type'] === 'register') as { machine?: { e2eEpoch?: string } } | undefined;
    const e = reg?.machine?.e2eEpoch;
    if (!e) fail('the private agent announced no e2eEpoch in its register');
    return e;
  };
  const epoch1 = epochOf();
  const forgedMachine = ([...got].reverse().find((f) => f['type'] === 'register') as { machine: { machineId: string } }).machine.machineId;
  const mainMachine = AAD_MACHINE;
  AAD_MACHINE = forgedMachine;
  tx({ type: 'register_ack', adoptedRunIds: [] });
  tx({ type: 'term_open', termId: 't1', cwd: PROJECT });
  await until('the terminal to open', () => got.some((f) => f['type'] === 'term_opened'));
  await sleep(1500); // let the shell start

  const attacked = path.join(ROOT, 'attacked');
  const count = path.join(ROOT, 'count');
  const lines = () => (existsSync(count) ? readFileSync(count, 'utf8').split('\n').filter(Boolean).length : 0);
  const refusals = () =>
    got
      .filter((f) => f['type'] === 'term_data' || f['type'] === 'stream')
      .map((f) => JSON.stringify(openFor(key, f)))
      .filter((t) => t.includes('must be encrypted'));

  // The genuine command the hub has seen (the person typed it).
  const genuine = clientSeal(key, { type: 'term_input', termId: 't1', data: `echo x >> ${count}\r` }, epoch1);
  // 1. Its envelope with the hub's own clear payload.
  tx({ ...genuine, data: `touch ${attacked}\r` });
  await until('a refusal for the forged terminal input', () => refusals().length >= 1);
  await sleep(1000);
  if (existsSync(attacked)) fail('the forged clear terminal input was typed into the shell');
  console.log('ok  envelope + clear data: refused, nothing typed');

  // 2. The same for input: no turn may start from the hub's text.
  const genuineInput = clientSeal(key, { type: 'input', runId: 'r1', text: 'hello' }, epoch1);
  tx({ ...genuineInput, text: 'ATTACK: run the forged prompt' });
  await until('a refusal for the forged input', () => refusals().length >= 2);
  console.log('ok  envelope + clear text on input: refused');

  // 3. The genuine command still works, once.
  tx(genuine);
  await until('the genuine command to run', () => lines() === 1, 15_000);
  console.log('ok  the genuine sealed command ran');
  tx(genuine);
  tx(genuine);
  await sleep(2000);
  if (lines() !== 1) fail(`a replayed envelope ran again (${lines()} lines)`);
  if (existsSync(attacked)) fail('the attack file appeared');
  console.log('ok  the same envelope replayed twice: refused, still one line');

  // 4. A terminal envelope lifted onto another terminal does not open.
  const other = clientSeal(key, { type: 'term_input', termId: 't9', data: `touch ${attacked}\r` }, epoch1) as { e2e: unknown };
  tx({ type: 'term_input', termId: 't1', data: '', e2e: other.e2e });
  await sleep(1500);
  if (existsSync(attacked)) fail('an envelope for terminal t9 was accepted on t1');
  console.log('ok  an envelope bound to another terminal: refused');

  // 4b. A command sealed for ANOTHER machine (same key, same epoch, same terminal
  //     id) does not run here: envelopes are bound to the machine id.
  AAD_MACHINE = mainMachine;
  const otherMachine = clientSeal(key, { type: 'term_input', termId: 't1', data: `touch ${attacked}\r` }, epoch1);
  AAD_MACHINE = forgedMachine;
  tx(otherMachine);
  await sleep(1500);
  if (existsSync(attacked)) fail('an envelope sealed for another machine was accepted');
  console.log('ok  an envelope bound to another machine id: refused');

  // 5. The agent restarts (a new process, a new epoch): a recorded command
  //    that was genuine and never answered is dead now.
  const recorded = clientSeal(key, { type: 'term_input', termId: 't1', data: `echo restarted >> ${count}\r` }, epoch1);
  child.kill('SIGTERM');
  await sleep(1500);
  got.length = 0;
  const child2 = spawn(process.execPath, ['--import', 'tsx', 'agent/src/main.ts'], {
    cwd: repo,
    env: { ...agentEnv(), CC_REMOTE_STATE_DIR: state2, CENTRAL_URL: `ws://127.0.0.1:${FPORT}`, MACHINE_NAME: 'forged-smoke' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child2.stdout?.on('data', append);
  child2.stderr?.on('data', append);
  children.push(child2);
  await until('the restarted agent to register', () => got.some((f) => f['type'] === 'register'));
  const epoch2 = epochOf();
  if (epoch2 === epoch1) fail('the agent kept its epoch across a restart');
  tx({ type: 'register_ack', adoptedRunIds: [] });
  tx({ type: 'term_open', termId: 't1', cwd: PROJECT });
  await until('the terminal to reopen', () => got.some((f) => f['type'] === 'term_opened'));
  await sleep(1500);
  tx(recorded);
  await until('a refusal for the replayed recording', () => refusals().length >= 1 || got.some((f) => f['type'] === 'term_data'));
  await sleep(1500);
  if (lines() !== 1) fail(`a command recorded before the restart ran after it (${lines()} lines)`);
  console.log('ok  a genuine envelope recorded before an agent restart: refused (new epoch)');
  tx(clientSeal(key, { type: 'term_input', termId: 't1', data: `echo fresh >> ${count}\r` }, epoch2));
  await until('a command sealed for the new epoch to run', () => lines() === 2, 15_000);
  console.log('ok  a command sealed for the new epoch runs');

  child2.kill('SIGTERM');
  wss.close();
  AAD_MACHINE = mainMachine;
}

async function main(): Promise<void> {
  step('seed a synthetic home, state and project');
  const sessionId = seed();

  step('pair code from the machine (also creates its key and id)');
  const code = pairingCode();
  const parsed = parsePairingCode(code);
  if (!parsed) fail(`not a pairing code: ${code}`);
  const machineId = parsed.machineId;
  AAD_MACHINE = machineId;
  console.log(`ok  code for machine ${machineId}`);

  step('throwaway hub + real private agent');
  startHub();
  for (let i = 0; i < 100 && spawnSync('curl', ['-sf', `http://127.0.0.1:${PORT}/health`]).status !== 0; i++) await sleep(200);
  startAgent();

  const { ws, send } = connectUi(['x', 'y', BASE, TOKEN]);
  const raw: string[] = [];
  let machines: MachineSnapshot[] = [];
  ws.on('message', (data: Buffer) => {
    const text = data.toString();
    raw.push(text);
    try {
      const msg = decodeCentralToBrowser(text);
      if (msg.type === 'snapshot') machines = msg.machines;
      else if (msg.type === 'machine_sessions') {
        machines = machines.some((m) => m.machine.machineId === msg.machine.machine.machineId)
          ? machines.map((m) => (m.machine.machineId === msg.machine.machine.machineId ? msg.machine : m))
          : [...machines, msg.machine];
      }
    } catch {
      /* not for us */
    }
  });
  await new Promise<void>((resolve) => ws.once('open', () => resolve()));

  const mine = () => machines.find((m) => m.machine.machineId === machineId && m.online);
  async function waitFor(what: string, ok: () => boolean, ms = 60_000): Promise<void> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (ok()) return;
      await sleep(300);
    }
    fail(`timed out waiting for: ${what}`);
  }

  step('a private machine registers, and its session is listed without content');
  await waitFor('the machine online with a session', () => !!mine() && mine()!.sessions.length > 0);
  const m = mine()!;
  if (m.machine.private !== true) fail('the hub did not relay private:true to viewers');
  const summary = m.sessions.find((s) => s.sessionId === sessionId);
  if (!summary) fail('the synthetic session is not listed');
  if (summary.title !== 'Зашифровано') fail(`title in the clear: ${JSON.stringify(summary.title)}`);
  if (summary.cwd || summary.project) fail('cwd/project in the clear');
  if (!summary.titleE2e || !summary.cwdE2e) fail('the sealed title/cwd are missing from the summary');
  console.log('ok  title is the placeholder, cwd is sealed, private:true reached the viewer');

  step('replica rows are ciphertext');
  let messages: Array<Record<string, unknown>> = [];
  for (let i = 0; i < 60; i++) {
    const r = await rpc(ws, machineId, 'session.messages', { cwd: PROJECT, sessionId, source: 'claude', limit: 100 }, 30_000);
    if (r.ok) {
      messages = ((r.result as { messages?: Array<Record<string, unknown>> }).messages) ?? [];
      if (messages.length >= 2) break;
    }
    await sleep(1000);
  }
  if (messages.length < 2) fail(`expected 2 history messages, got ${messages.length}`);
  if (!messages.every((x) => x['e2e'] && Array.isArray(x['blocks']) && (x['blocks'] as unknown[]).length === 0)) {
    fail('a history message carries blocks in the clear');
  }
  console.log(`ok  ${messages.length} history messages, all envelopes`);

  step('a directory listing and a file read come back sealed');
  const rpcWithId = async (method: string, params: Record<string, unknown>) => {
    const requestId = randomUUID();
    const reply = new Promise<{ ok: boolean; result?: unknown; error?: string }>((resolve) => {
      const on = (d: Buffer) => {
        try {
          const v = JSON.parse(d.toString()) as Record<string, unknown>;
          if (v['type'] === 'rpc_response' && v['requestId'] === requestId) {
            ws.off('message', on);
            resolve({ ok: v['ok'] === true, result: v['result'], error: v['error'] as string | undefined });
          }
        } catch {
          /* ignore */
        }
      };
      ws.on('message', on);
    });
    ws.send(JSON.stringify({ type: 'rpc_request', requestId, machineId, method, params }));
    return { requestId, ...(await reply) };
  };
  const listing = await rpcWithId('fs.list', { cwd: PROJECT });
  const read = await rpcWithId('fs.read', { cwd: PROJECT, path: 'note.txt' });
  if (!listing.ok || !read.ok) fail(`fs rpc failed: ${listing.error ?? read.error}`);
  for (const [name, r] of [['fs.list', listing], ['fs.read', read]] as const) {
    const keys = Object.keys((r.result ?? {}) as object);
    if (keys.length !== 1 || keys[0] !== 'e2e') fail(`${name} result is not a bare envelope: ${keys.join(',')}`);
  }
  console.log('ok  fs.list and fs.read results are bare envelopes');

  step('plaintext into a private machine is refused by the hub');
  const errors: Array<Record<string, unknown>> = [];
  ws.on('message', (d: Buffer) => {
    try {
      const v = JSON.parse(d.toString()) as Record<string, unknown>;
      if (v['type'] === 'error') errors.push(v);
    } catch {
      /* ignore */
    }
  });
  send({ type: 'open', machineId, sessionId, message: `typed in the clear ${MARK_CHAT}` });
  await waitFor('the hub to refuse the plaintext open', () => errors.some((e) => e['code'] === 'private_machine'), 10_000);
  console.log('ok  open with a plaintext message -> private_machine');

  step('WITHOUT the key: no marker in any frame this viewer received');
  const withoutKey = raw.join('\n');
  for (const mark of [MARK_CHAT, MARK_FILE, MARK_TITLE]) {
    if (withoutKey.includes(mark)) fail(`${mark} reached a viewer that holds no key`);
  }
  console.log(`ok  ${raw.length} frames, none contains a marker`);

  step('WITH the key (the pairing code, opened by an independent Node viewer): history, listing and file read');
  const key = Buffer.from(parsed.key, 'base64url');
  const kid = createHash('sha256').update(key).digest('hex').slice(0, 16);
  console.log(`ok  key id ${kid}`);

  const opened = openFor(key, { type: 'rpc_response', requestId: 'x', ok: true, result: { messages } });
  const text = JSON.stringify(opened);
  if (!text.includes(MARK_CHAT) || !text.includes(MARK_TITLE)) fail('the paired viewer cannot read the history');
  console.log('ok  history opens: the user turn and the answer are readable');

  const list = openFor(key, { type: 'rpc_response', requestId: listing.requestId, ok: true, result: listing.result });
  if (!JSON.stringify(list['result']).includes('note.txt')) fail('the paired viewer cannot read the listing');
  const file = openFor(key, { type: 'rpc_response', requestId: read.requestId, ok: true, result: read.result }) as {
    result: { content?: string };
  };
  if (!file.result.content?.includes(MARK_FILE)) fail('the paired viewer cannot read the file');
  console.log('ok  fs.list names note.txt, fs.read returns the file content');

  const t = openSummaryFor(key, summary as unknown as Frame) as { title: string; cwd?: string };
  if (t.cwd !== PROJECT || t.title === 'Зашифровано') fail(`sealed summary did not open: ${JSON.stringify(t)}`);
  console.log(`ok  summary opens: cwd=${t.cwd}, title="${t.title.slice(0, 40)}…"`);

  step('the wrong key opens nothing');
  let opens = 0;
  try {
    openFor(Buffer.alloc(32, 7), { type: 'rpc_response', requestId: 'x', ok: true, result: { messages } });
    opens = 1;
  } catch {
    /* GCM refuses */
  }
  if (opens) fail('a wrong key opened the history');
  console.log('ok  a wrong key is refused by the authentication tag');
  // The right key, the wrong request: an rpc result lifted onto another answer.
  let lifted = 0;
  try {
    openFor(key, { type: 'rpc_response', requestId: 'another-request', ok: true, result: read.result });
    lifted = 1;
  } catch {
    /* bound to its request: GCM refuses */
  }
  if (lifted) fail('an rpc result opened under another requestId');
  console.log('ok  a result lifted onto another requestId is refused (envelope bound to its request)');

  step('resume with a first message and an attachment, sealed, through the real hub');
  const epoch = mine()!.machine.e2eEpoch;
  if (!epoch) fail('the hub did not relay the agent e2eEpoch to the viewer');
  const framesBefore = raw.length;
  const openFrame = clientSeal(
    key,
    { type: 'open', machineId, sessionId, message: `sealed first message ${MARK_CHAT}`, images: [{ media_type: 'image/png', data: 'AAAA' }] },
    epoch,
  );
  ws.send(JSON.stringify({ ...openFrame, turnE2e: clientSeal(key, { type: 'open', machineId, sessionId, message: 'x' }, epoch)['e2e'] }));
  await sleep(10_000);
  const after = raw.slice(framesBefore);
  const refused = after
    .map((t) => {
      try {
        return JSON.stringify(openFor(key, JSON.parse(t) as Frame));
      } catch {
        return '';
      }
    })
    .filter((t) => /could not decrypt|must be encrypted|made for another|malformed nonce|unknown key/.test(t));
  if (refused.length) fail(`the agent refused the sealed first message: ${refused[0]}`);
  if (after.some((t) => t.includes(MARK_CHAT))) fail('the first message reached the viewer in the clear');
  const agentLog = readFileSync(path.join(ROOT, 'agent.log'), 'utf8');
  if (/e2ee: refused/.test(agentLog)) fail(`the agent log shows a refusal:\n${agentLog.split('\n').filter((l) => l.includes('e2ee: refused')).join('\n')}`);
  console.log(`ok  the agent opened the sealed first message (${after.length} frames after it, no refusal, no marker)`);

  await forgedHubAttack(key);

  step('the hub stored no plaintext: database, WAL and log');
  await sleep(1500);
  const bytes = hubBytes();
  for (const mark of [MARK_CHAT, MARK_FILE, MARK_TITLE]) {
    const n = countIn(bytes, mark);
    if (n !== 0) fail(`${mark} found in ${n} hub file(s)`);
  }
  console.log(`ok  ${bytes.length} hub files (${bytes.reduce((n, b) => n + b.length, 0)} bytes): marker count 0`);
  if (!bytes.some((b) => b.includes('"e2e"'))) fail('the replica holds no envelopes at all - nothing was synced');
  console.log('ok  and the replica does hold envelopes (the check is not vacuous)');

  console.log('\nprivate-machine-smoke: PASS');
  ws.close();
  cleanup();
  await sleep(1500); // a resumed run may still be writing its transcript
  rmSync(ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  cleanup();
  process.exit(1);
});
