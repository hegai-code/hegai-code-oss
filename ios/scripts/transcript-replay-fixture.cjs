// Deliberately race an optimistic send / replay against its saved history.
// Local only: no real agent, hub, account or transcript is touched.
const http = require('http');
const { WebSocketServer } = require('ws');
const port = Number(process.env.CC_FIXTURE_PORT || 18788);
const prompt = 'Почини и что с редизайном от фейбл?';
const opening = 'Исправлю сбой конвейера, проверю регрессионным тестом и доставлю фикс на production.';
const continuation = 'Рецензия Fable уже получена.';
let started = false;
let sentAt = Date.now();
let reconnects = 0;
let replays = 0;
const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (req.url === '/test/reconnect') {
    reconnects++;
    for (const socket of wss.clients) socket.close();
    res.end('{}');
  } else if (req.url === '/test/state') {
    res.end(JSON.stringify({ started, reconnects, replays }));
  } else { res.statusCode = 404; res.end('{}'); }
});
const wss = new WebSocketServer({ server });
wss.on('connection', socket => {
  const send = frame => { if (socket.readyState === 1) socket.send(JSON.stringify(frame)); };
  const event = (kind, text) => send({ type: 'stream', runId: 'r-s0', sessionId: 's0', event: { kind, text } });
  const pending = [];
  const history = requestId => send({ type: 'rpc_response', requestId, ok: true, result: { messages: [
    { type: 'user', uuid: 'u', ts: sentAt, blocks: [{ kind: 'text', text: prompt }] },
    { type: 'assistant', uuid: 'a', ts: sentAt + 1, blocks: [{ kind: 'text', text: opening }] },
  ] } });
  send({ type: 'snapshot', machines: [{
    machine: { machineId: 'm', name: 'Fixture Mac', os: 'mac', agentVersion: '1' },
    online: true, canControl: true, canStart: true, lastSeen: sentAt,
    sessions: [{ sessionId: 's0', title: 'Проверка повторов', project: 'Demo', cwd: '/projects/demo',
      source: 'codex', lastModified: sentAt }],
  }], activeRuns: [{ runId: 'r-s0', machineId: 'm', sessionId: 's0', state: 'working', since: sentAt }] });
  socket.on('message', raw => {
    const msg = JSON.parse(raw);
    if (msg.type === 'subscribe') {
      send({ type: 'opened', runId: msg.runId, machineId: 'm', sessionId: 's0' });
      send({ type: 'run_settings', runId: msg.runId, sessionId: 's0', model: 'gpt-6-astra', activeModel: 'gpt-6-astra', effort: 'medium' });
      if (started) { replays++; event('assistant', opening + '\n\n' + continuation + '\n\nПосле переподключения ответ продолжается.'); }
    } else if (msg.type === 'input') {
      started = true;
      sentAt = Date.now();
      event('assistant', opening + '\n\n' + continuation);
      setTimeout(() => pending.splice(0).forEach(history), 250);
    } else if (msg.type === 'rpc_request') {
      if (msg.method === 'session.messages' && !msg.params.head) {
        if (started) history(msg.requestId);
        else pending.push(msg.requestId);
      } else {
        const result = msg.method === 'models.list'
          ? { models: [{ id: 'gpt-6-astra', name: '6 Astra', resolved: 'gpt-6-astra' }] }
          : msg.method === 'projects.list' ? { projects: [] } : { messages: [] };
        send({ type: 'rpc_response', requestId: msg.requestId, ok: true, result });
      }
    } else if (msg.type === 'enrich_request') {
      send({ type: 'enrich_result', requestId: msg.requestId, ok: true, enrichment: {} });
    } else if (msg.type === 'ping') send({ type: 'pong' });
  });
});
server.listen(port, '127.0.0.1', () => console.log(`Transcript replay fixture: ${port}`));
