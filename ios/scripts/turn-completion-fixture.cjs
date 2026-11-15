// Synthetic finished subtask -> explicit continuation. Never touches a real session.
const http = require('http');
const { WebSocketServer } = require('ws');
const port = Number(process.env.CC_FIXTURE_PORT || 18792);
let phase = 'working';
let since = Date.now();
let inputs = [];
let editor = false;
const mirrors = new Map();
const viewer = { userId: `completion-fixture-${Date.now()}`, fullName: 'Тестировщик', platformAdmin: false,
  workspace: { workspaceId: 'fixture', name: 'Мои проекты', kind: 'personal', role: 'owner' }, workspaces: [] };
const answer = 'Нашёл звонок с Дмитрием: 1 ч 10 мин. Учтём отдельной строкой в разделе «Встречи».';
const history = () => [
  { type: 'user', uuid: 'u', ts: since - 10, blocks: [{ kind: 'text', text: 'Пересчитай весь отчёт за сентябрь, включая встречи.' }] },
  { type: 'assistant', uuid: 'a', ts: since - 5, blocks: [{ kind: 'text', text: answer },
    { kind: 'tool_use', id: 't', name: 'exec_command', input: { cmd: 'lookup fixture' } }] },
];
const runs = () => editor ? [] : [{ runId: 'r', machineId: 'm', sessionId: 's0', state: phase, since, preview: answer }];
const snapshot = () => ({ type: 'snapshot', machines: [{
  machine: { machineId: 'm', name: 'Fixture Mac', os: 'mac', agentVersion: '1' },
  online: true, canControl: true, canStart: true, lastSeen: since,
  sessions: [{ sessionId: 's0', title: 'Отчёт за сентябрь', project: 'Demo', cwd: '/projects/demo', source: 'codex', lastModified: since,
    ...(editor ? { livePid: 42, liveStatus: phase === 'working' ? 'busy' : 'idle' } : {}) }],
}], activeRuns: runs(), viewer });
const send = (socket, frame) => { if (socket.readyState === 1) socket.send(JSON.stringify(frame)); };
const broadcast = frame => { for (const s of wss.clients) send(s, frame); };
const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (req.url === '/test/finish') {
    phase = 'idle'; since = Date.now();
    broadcast({ type: 'stream', runId: 'r', sessionId: 's0', event: { kind: 'assistant', text: answer } });
    broadcast({ type: 'stream', runId: 'r', sessionId: 's0', event: { kind: 'result' } });
    broadcast({ type: 'activity', runs: runs() });
    if (editor) {
      for (const [socket, mirrorId] of mirrors) send(socket, { type: 'mirror_data', mirrorId, replace: true, messages: history() });
      broadcast(snapshot());
    }
    res.end('{}');
  } else if (req.url === '/test/editor') {
    editor = true; phase = 'working'; since = Date.now();
    res.end('{}');
  } else if (req.url === '/test/app') {
    editor = false; phase = 'working'; since = Date.now(); inputs = [];
    res.end('{}');
  } else if (req.url === '/test/state') res.end(JSON.stringify({ phase, inputs }));
  else { res.statusCode = 404; res.end('{}'); }
});
const wss = new WebSocketServer({ server });
wss.on('connection', socket => {
  send(socket, snapshot());
  socket.on('close', () => mirrors.delete(socket));
  socket.on('message', raw => {
    const msg = JSON.parse(raw);
    if (msg.type === 'subscribe') send(socket, { type: 'opened', runId: 'r', machineId: 'm', sessionId: 's0' });
    else if (msg.type === 'mirror_open') {
      mirrors.set(socket, msg.mirrorId);
      send(socket, { type: 'mirror_opened', mirrorId: msg.mirrorId, machineId: 'm' });
      send(socket, { type: 'mirror_data', mirrorId: msg.mirrorId, replace: true, messages: history() });
    }
    else if (msg.type === 'input') {
      inputs.push(msg.text); phase = 'working'; since = Date.now();
      broadcast({ type: 'activity', runs: runs() });
      send(socket, { type: 'stream', runId: 'r', sessionId: 's0', event: { kind: 'assistant', text: 'Продолжаю пересчёт всего отчёта.' } });
    } else if (msg.type === 'rpc_request') {
      const result = msg.method === 'session.messages' ? { messages: history() }
        : msg.method === 'projects.list' ? { projects: [] }
          : msg.method === 'models.list' ? { models: [] } : {};
      send(socket, { type: 'rpc_response', requestId: msg.requestId, ok: true, result });
    } else if (msg.type === 'enrich_request') send(socket, { type: 'enrich_result', requestId: msg.requestId, ok: true, enrichment: {} });
    else if (msg.type === 'ping') send(socket, { type: 'pong' });
  });
});
server.listen(port, '127.0.0.1', () => console.log(`Turn completion fixture: ${port}`));
