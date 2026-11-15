// Local quota + tool-only replay fixture. No fleet agent or real transcript.
const http = require('http');
const { WebSocketServer } = require('ws');
const port = Number(process.env.CC_FIXTURE_PORT || 18789);
const prompt = 'Слушай, есть мысль сделать оркестрирующего агента, который будет принимать задачи и работать со всеми серверами и проектами. Давай посмотрим, как лучше устроить такой интерфейс в мобильном приложении и на вебе.';
const sentAt = Date.now();
const resetsAt = Math.floor(sentAt / 1000) + 48 * 3600;
let percent = 91;
let replays = 0;
let reconnects = 0;
const send = (socket, frame) => { if (socket.readyState === 1) socket.send(JSON.stringify(frame)); };
const warning = socket => send(socket, { type: 'stream', runId: 'r-s0', sessionId: 's0', event: {
  kind: 'status', code: 'rate_limit', text: `raw quota warning ${percent}%`, data: {
    status: percent >= 100 ? 'rejected' : 'allowed_warning', rateLimitType: 'seven_day', utilization: percent / 100, resetsAt,
  },
} });
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  res.setHeader('Content-Type', 'application/json');
  if (url.pathname === '/test/reconnect') {
    reconnects++;
    for (const socket of wss.clients) socket.close();
  } else if (url.pathname === '/test/reset') {
    reconnects = 0; replays = 0; percent = 91;
  } else if (url.pathname === '/test/warning') {
    percent = Number(url.searchParams.get('percent') || 91);
    for (const socket of wss.clients) warning(socket);
  } else if (url.pathname !== '/test/state') res.statusCode = 404;
  res.end(JSON.stringify({ replays, percent }));
});
const wss = new WebSocketServer({ server });
wss.on('connection', socket => {
  send(socket, { type: 'snapshot', machines: [{
    machine: { machineId: 'm', name: 'Fixture Mac', os: 'mac', agentVersion: '1' },
    online: true, canControl: true, canStart: true, lastSeen: sentAt,
    sessions: [{ sessionId: 's0', title: 'Оркестратор задач', project: 'Demo', cwd: '/projects/demo',
      source: 'claude', lastModified: sentAt }],
  }], activeRuns: [{ runId: 'r-s0', machineId: 'm', sessionId: 's0', state: 'working', since: sentAt }] });
  socket.on('message', raw => {
    const msg = JSON.parse(raw);
    if (msg.type === 'subscribe') {
      replays++;
      send(socket, { type: 'opened', runId: 'r-s0', machineId: 'm', sessionId: 's0' });
      send(socket, { type: 'user_turn', runId: 'r-s0', sessionId: 's0', turnId: 'u0', text: prompt, ts: sentAt });
      for (let i = 0; i < 21; i++) send(socket, { type: 'stream', runId: 'r-s0', sessionId: 's0', event: { kind: 'tool_use', text: `Read {"file_path":"part-${i}.swift"}` } });
      for (let i = 0; i < 3; i++) warning(socket);
      if (reconnects > 0) send(socket, { type: 'stream', runId: 'r-s0', sessionId: 's0', event: {
        kind: 'assistant', text: 'Продолжаю после переподключения.',
      } });
      send(socket, { type: 'run_settings', runId: 'r-s0', sessionId: 's0', model: 'claude-opus-5-5', activeModel: 'claude-opus-5-5' });
    } else if (msg.type === 'rpc_request') {
      const messages = [
        { type: 'user', uuid: 'u', ts: sentAt + 250, blocks: [{ kind: 'text', text: prompt }] },
        { type: 'assistant', uuid: 'a', ts: sentAt + 300, blocks: [{ kind: 'tool_use', id: 't', name: 'Read', input: { file_path: 'part-0.swift' } }] },
      ];
      const result = msg.method === 'session.messages' ? { messages }
        : msg.method === 'models.list' ? { models: [{ id: 'claude-opus-5-5', name: 'Opus 5.5' }] }
        : msg.method === 'projects.list' ? { projects: [] } : {};
      send(socket, { type: 'rpc_response', requestId: msg.requestId, ok: true, result });
    } else if (msg.type === 'enrich_request') {
      send(socket, { type: 'enrich_result', requestId: msg.requestId, ok: true, enrichment: {} });
    } else if (msg.type === 'ping') send(socket, { type: 'pong' });
  });
});
server.listen(port, '127.0.0.1', () => console.log(`Limit notice fixture: ${port}`));
