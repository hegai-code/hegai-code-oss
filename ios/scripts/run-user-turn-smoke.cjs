// Fake agent + desktop peer against a REAL disposable hub, never a fleet agent.
// HOST=127.0.0.1 PORT=18949 CC_REMOTE_TOKEN=dev-token
// CC_REMOTE_DB_PATH=/tmp/ios-user-turn.sqlite3 <hub binary>
// NODE_PATH=<repo>/node_modules node ios/scripts/run-user-turn-smoke.cjs
// Run UserTurnUITests with TEST_RUNNER_CC_USER_TURN_SMOKE=1. Start a fresh
// disposable hub DB + this fixture and a freshly installed simulator app before
// each complete UI journey (fixed session IDs otherwise reuse the old cache).
// Catalog cwd is deliberately outside /tmp: scratch sessions are hidden by iOS.
// These paths are metadata only; this fake agent never reads/writes them.
const { WebSocket } = require('ws');
const { randomUUID } = require('crypto');
const http = require('http');
const base = 'ws://127.0.0.1:18949';
const machineId = 'ios-user-turn-smoke';
const sessions = ['claude', 'codex'].map(source => ({ sessionId: `s-${source}`, source,
  title: `Реплики с других устройств · ${source}`, project: 'Smoke', cwd: `/Users/smoke/work/smoke-${source}`, lastModified: Date.now() }));
const runs = new Map(), history = new Map(), frames = [], inputs = [];
const send = (ws, frame) => ws.send(JSON.stringify(frame));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const open = path => new Promise((resolve, reject) => {
  const ws = new WebSocket(`${base}/${path}?token=dev-token`);
  ws.once('open', () => resolve(ws)); ws.once('error', reject);
});
const record = (type, text) => ({ type, uuid: randomUUID(), ts: Date.now(), blocks: [{ kind: 'text', text }] });
let agent;
const desktops = new Map();
function event(runId, code, text, kind = 'status') {
  send(agent, { type: 'stream', runId, sessionId: runs.get(runId), event: { kind, code, text } });
}
function answer(runId, text, persist = true) {
  const sessionId = runs.get(runId);
  inputs.push({ sessionId, text });
  send(agent, { type: 'run_status', runId, sessionId, state: 'started' });
  if (persist) history.get(sessionId).push(record('user', text));
  setTimeout(() => {
    const reply = text.startsWith('Длинная вставка') ? 'Длинный текст принят.' : `Принято: ${text}`;
    event(runId, undefined, reply, 'assistant');
    if (persist) history.get(sessionId).push(record('assistant', reply));
  }, 150);
}
async function main() {
  agent = await open('agent');
  agent.on('message', raw => {
    const m = JSON.parse(raw);
    if (m.type === 'resume') {
      runs.set(m.runId, m.sessionId);
      if (m.message) answer(m.runId, m.message);
    } else if (m.type === 'input') {
      answer(m.runId, m.text, !m.text.startsWith('Длинная вставка'));
    } else if (m.type === 'rpc_request') {
      const result = m.method === 'session.messages' ? { messages: history.get(m.params.sessionId) || [] }
        : m.method === 'projects.list' ? { projects: [{ label: 'Smoke', cwd: '/Users/smoke/work/smoke-claude', lastModified: Date.now(), count: 1 }] }
        : m.method === 'models.list' ? { models: [{ id: 'gpt-6-astra', name: '6 Astra' }] } : {};
      send(agent, { type: 'rpc_response', requestId: m.requestId, ok: true, result });
    } else if (m.type === 'compact') {
      event(m.runId, 'compact_started', 'compacting context… (queued behind the current turn)');
      event(m.runId, 'compact_started', 'compacting context…');
      event(m.runId, 'compact_started', 'compacting context…');
    }
  });
  send(agent, { type: 'register', protocol: 1, agentInstanceId: randomUUID(),
    machine: { machineId, name: 'iOS Smoke', os: 'mac', agentVersion: 'smoke' } });
  await sleep(200);
  send(agent, { type: 'inventory', sessions, complete: true });
  sessions.forEach(s => history.set(s.sessionId, [record('user', 'Предыдущий вопрос'), record('assistant', 'Предыдущий ответ сохранён.')]));
  await sleep(200);
  for (const session of sessions) {
    const desktop = await open('ui');
    desktops.set(session.sessionId, desktop);
    desktop.on('message', raw => { frames.push(JSON.parse(raw)); });
    send(desktop, { type: 'open', ref: session.sessionId, machineId, sessionId: session.sessionId, message: 'С десктопа: проверь CI' });
  }
  for (let i = 0; i < 100 && runs.size < 2; i++) await sleep(50);
  if (runs.size !== 2) throw new Error(`Expected 2 opened runs; desktop frames: ${JSON.stringify(frames)}`);
  await sleep(300);
  if (frames.filter(f => f.type === 'user_turn').length < 2) throw new Error('Hub did not emit user_turn');
  http.createServer(async (req, res) => {
    let body = '';
    for await (const part of req) body += part;
    const data = body ? JSON.parse(body) : {};
    const runId = [...runs].find(([, session]) => session === (data.sessionId || 's-claude'))?.[0];
    const desktop = desktops.get(data.sessionId || 's-claude');
    if (req.url === '/remote') {
      send(desktop, { type: 'input', ref: data.sessionId || 's-claude', runId, text: data.text });
    } else if (req.url === '/compact') {
      send(desktop, { type: 'compact', ref: data.sessionId || 's-claude', runId });
    } else if (req.url === '/compact-done') {
      event(runId, 'compact_done', 'context compacted: 746k → 10k tokens');
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ inputs, userTurns: frames.filter(f => f.type === 'user_turn'),
      runs: Object.fromEntries(runs), machineId }));
  }).listen(18950, '127.0.0.1', () => console.log('READY: real hub :18949, controls :18950, two runtime sessions'));
}
main().catch(error => { console.error(error); process.exit(1); });
